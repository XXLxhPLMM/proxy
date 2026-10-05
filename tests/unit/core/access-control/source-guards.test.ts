/**
 * 源码级：`core/` 一律经 `AccessControl` 端口判定，全仓只有那两个合法出口
 *
 * 这一档的每一条都是**源码文本事实**（某个构造调用出现在哪个函数体里），运行期形状看不见
 * 这件事。⚠️ 负向断言的锚必须落在**今天仍存在的形状**上，且每条「零命中」都要配一条
 * **正向面**证明锚点真的存在 —— 判据口径与自检三条逐字归 `./AGENTS.md`，这里不复制。
 *
 * @module tests/unit/core/access-control/source-guards
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_DIR, codeOnly, offendingLines, sourceOf } from "../../../helpers/source-scan.js";

describe("源码级：core 一律经 AccessControl 端口判定（锚在今天仍存在的形状上）", () => {
  /** 递归列出 `src/core/**` 下所有 .ts */
  function coreSourceFiles(): string[] {
    const srcRoot = path.join(SRC_DIR, "core");
    return fs
      .readdirSync(srcRoot, { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".ts"))
      .map((f) => path.join("core", f));
  }

  /** 判定层自己（唯一持有实现的地方；它内部的 `function checkClient(` 是**定义**不是调用） */
  const JUDGEMENT_FILE = path.join("core", "access-control.ts");

  /**
   * 端口**类型**的声明处，与判定层同构地合法。
   *
   * @description 三个判定名在 `core/types/proxy.ts` 里出现，是因为那里声明 `AccessControl`
   * 这个**端口本身**的方法签名（`checkClient(input: AccessClientInput): AccessDecision;`）——
   * 那是接口声明，不是调用。**它与 `access-control.ts` 是同一组「合法的家」**：
   * 端口的类型声明处 + 端口的唯一内置实现处。`core/**` 里第三处出现这三个名字才是绕过端口。
   *
   * 逐条写明而不是「过滤掉就算了」——本仓既有纪律（`inbound-dispatch` 的第 ⑨ 条同款）。
   * 若哪天端口类型搬出 `types/proxy.ts`，本档会红，届时把这一条改成新位置或删掉。
   */
  const PORT_TYPE_FILE = path.join("core", "types", "proxy.ts");

  it("判定层工厂与三个判定：core/ 里零自造、零绕过端口的直调", () => {
    // ⚠️ 负向源码断言的锚必须落在**今天仍存在的形状**上：锚成已删除的导出名时，它在 `src/**`
    // 的命中全在注释里，`codeOnly` 剥成空格后「零调用」恒成立——护栏看着在、实际已经没有
    // 要防的东西。下面的「防假绿的正向面」就是堵这个：先证明锚点存在，再谈零命中。

    // ── 防假绿的正向面：先证明锚点真的存在，否则下面两条「零命中」没有指称对象 ──
    // （锚点哪天被改名或搬走，本条必须红，而不是安静地继续绿）
    const judgement = codeOnly(sourceOf("core", "access-control.ts"));
    expect(
      judgement,
      "锚点失效：判定层不再导出唯一出口 createFileAccessControl（core/ 的零调用断言随即失去指称对象）",
    ).toContain("export function createFileAccessControl(");
    for (const name of ["checkClient", "checkTarget", "checkRoute"] as const) {
      expect(judgement, `锚点失效：判定层不再有模块私有的 ${name} 实现`).toMatch(
        new RegExp(`function ${name}\\(`),
      );
    }

    const files = coreSourceFiles();
    expect(files.length).toBeGreaterThan(20);

    for (const rel of files) {
      if (rel === JUDGEMENT_FILE || rel === PORT_TYPE_FILE) {
        continue;
      }
      const code = codeOnly(sourceOf(...rel.split(path.sep)));

      // ① core 内部**不得自己造一份判定**：工厂的唯一合法调用点是唯一组装根
      //    `runtime/services.ts:buildDefaultServices`。core 里再造一份 = 「同一部署两套名单判定」。
      expect(
        offendingLines(code, /\bcreateFileAccessControl\s*\(/),
        `${rel} 不得自己造 AccessControl 判定：唯一组装根在 runtime/services.ts:buildDefaultServices`,
      ).toEqual([]);

      // ② core 内部**不得绕过端口直调判定函数**。
      //    判据刻意用**否定前置断言** `(?<!\.)` 而不是裸名字：`access.checkTarget({…})` 是
      //    **合法**的端口消费形态（`helpers/predial.ts` / `server/admission.ts` /
      //    `helpers/route.ts` 各一处），裸名字会把它们一起判红；而 `checkTarget({…})` 这种
      //    **无接收者**的调用，在 core 内部只可能来自「把这个判定从 access-control.ts 直接
      //    import 出来用」—— 那正是端口被绕过的形态（注入的替身只管一部分请求路径）。
      //    跨行也安全：`access\n  .checkTarget(` 的第二行仍以 `.` 开头，前置断言照样成立。
      //    （唯一被排除的合法出现是 `PORT_TYPE_FILE` 里的端口接口声明，理由见该常量注释。）
      for (const name of ["checkClient", "checkTarget", "checkRoute"] as const) {
        expect(
          offendingLines(code, new RegExp(`(?<!\\.)\\b${name}\\s*\\(`)),
          `${rel} 出现了无接收者的 ${name}(…) 调用：core 必须经 AccessControl 端口判定，`
            + "绕过端口等于「注入的替身只管一部分请求路径」",
        ).toEqual([]);
      }
    }
  });

  it("全 src/ 里 `createFileAccessControl(` 恰好两处：定义 + 唯一组装根（core/ 之外的版本）", () => {
    // 上一条的 ① 只覆盖 `core/**`。这条把它扩到**全 `src/**`**，抓的是另一种回流：
    // 有人在 `server/` 或 `runtime/` 里**第二个**组装点造一份判定（症状是「配了 acl.json 却
    // 名单时灵时不灵」——两份判定各读各的编译缓存）。合法命中恰好两条，位置写死：
    // 定义在 `core/access-control.ts`、唯一调用点在 `runtime/services.ts:buildDefaultServices`。
    //
    // 注意 `src/index.ts` 的 re-export **不算命中**：它是 `createFileAccessControl,`
    // （无调用括号），这正是判据要带 `(` 的原因 —— 只判名字会把合法的再导出一起判红。
    const files = fs
      .readdirSync(SRC_DIR, { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".ts"));
    const hits: string[] = [];

    for (const rel of files) {
      const code = codeOnly(sourceOf(...rel.split(path.sep)));
      // 标签统一成 posix 分隔符：断言文本要跨平台可读（Windows 上 path.join 给的是 `\`）
      const label = rel.split(path.sep).join("/");
      for (const line of offendingLines(code, /\bcreateFileAccessControl\s*\(/)) {
        hits.push(`${label}: ${line}`);
      }
    }

    // 防假绿：真的扫到了，且两条都在预期位置
    expect(hits).toHaveLength(2);
    expect(hits.some((h) => h.startsWith("core/access-control.ts:"))).toBe(true);
    expect(
      hits.some((h) => h.startsWith("runtime/services.ts:")),
      `唯一调用点必须在 runtime/services.ts:buildDefaultServices，实际命中：\n${hits.join("\n")}`,
    ).toBe(true);
  });

  it("全 src/ 里 import 自 `@/core/access-control.js` 的**只有**端口与观察面两个出口", () => {
    // 判定面收成端口之后，从任何地方 import 这个模块的合法理由只剩两类：
    // ① 拿 `createFileAccessControl`（唯一组装根 `runtime/services.ts:buildDefaultServices`）；
    // ② 拿 `bindAclFileEvents`（订阅注册的唯一入口，同在 runtime 里）。
    // 任何第三个名字（尤其是裸判定函数）出现即红。
    //
    // 扫描范围是 `src/**` 而不是 `core/**` —— 因为按设计**core 内部零调用点**
    // （`admission.ts` / `forward/base.ts` 只经 `CoreServices` 拿端口，注释里提到
    // 「不再 import …/access-control.js」是散文不是 import）。这也正是它与上一条的分工：
    // 上一条钉「core 一律走端口」，本条钉「全仓只有那两个出口能 import 实现」。
    const files = fs
      .readdirSync(SRC_DIR, { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".ts"));
    const names: string[] = [];

    for (const rel of files) {
      const code = codeOnly(sourceOf(...rel.split(path.sep)));
      for (const m of code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@\/core\/access-control\.js"/g)) {
        for (const n of (m[2] ?? "").split(",")) {
          const name = n.trim();
          if (name) {
            names.push(`${rel}: ${name}`);
          }
        }
      }
    }

    // 防假绿：真的扫到了东西，且那两个出口各自都在
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => n.endsWith(": createFileAccessControl"))).toBe(true);
    for (const entry of names) {
      expect(
        /: (createFileAccessControl|bindAclFileEvents)$/.test(entry),
        `${entry} 不是合法的访问控制出口：判定面只许经 AccessControl 端口`
          + "（createFileAccessControl），观察面只许经 bindAclFileEvents",
      ).toBe(true);
    }
  });

  it("记忆模块 `@/core/acl-memo.js`：全 `src/` 里零 import 面（判定层是它唯一的读者）", () => {
    // `compiled` / `compiledUserTarget` 是**记忆面**而不是判定面，而上面那条 import 白名单只扫
    // `@/core/access-control.js`。记忆面住在另一个模块路径上，于是「直接 import 编译缓存绕过
    // `AccessControl` 端口」这件事今天是零成本的：五条断言一条都不会红。
    // 判据收在**模块路径**上而不是符号名上——符号改名时本条跟着红，而「谁在读记忆面」与名字无关。

    // ── 防假绿的正向面：先证明记忆面今天真的可 import，否则下面那条「零命中」是空集上的空话 ──
    // （模块被删或改名时，零命中恒成立，护栏看着在、实际已经没有要防的东西）
    const memo = codeOnly(sourceOf("core", "acl-memo.ts"));
    for (const name of ["compiled", "compiledUserTarget", "bindAclFileEvents"] as const) {
      expect(memo, `锚点失效：记忆模块不再导出 ${name}`).toMatch(
        new RegExp(`export function ${name}\\(`),
      );
    }

    const files = fs
      .readdirSync(SRC_DIR, { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(20);

    const reads: string[] = [];
    for (const rel of files) {
      const code = codeOnly(sourceOf(...rel.split(path.sep)));
      // 标签统一成 posix 分隔符：断言文本要跨平台可读（Windows 上 path.join 给的是 `\`）
      const label = rel.split(path.sep).join("/");
      // 模块路径两种拼法都收：`@/core/acl-memo.js`（跨目录）与 `./acl-memo.js`（同目录）。
      // 唯一合法的那一处用后者（判定层与它同在 `src/core/`），故按**文件**判而不是按拼法判。
      for (const line of offendingLines(code, /from\s+"(?:@\/core\/|\.\/)?acl-memo\.js"/)) {
        reads.push(`${label}: ${line}`);
      }
    }

    // 正向面续：真的扫到了，且判定层那份同目录相对 import 在里面
    expect(reads.length).toBeGreaterThan(0);
    expect(
      reads.some((r) => r.startsWith("core/access-control.ts:")),
      `记忆面今天必须真的有人读（否则下面那条零命中没有指称对象），实际命中：\n${reads.join("\n")}`,
    ).toBe(true);

    // 负向面：记忆面只有一个读者
    expect(
      reads.filter((r) => !r.startsWith("core/access-control.ts:")),
      "记忆面只有判定层一个读者：绕过 `AccessControl` 端口直接 import 编译缓存，"
        + "等于注入的替身只管一部分请求路径（名单时灵时不灵）",
    ).toEqual([]);
  });

  it("判定面真的只有一个出口 `createFileAccessControl`（三个判定都是模块私有）", () => {
    const code = codeOnly(sourceOf("core", "access-control.ts"));

    expect(code).toContain("export function createFileAccessControl(");
    // 三个判定不带 export（藏进 class / 深层闭包会让「个人名单不越界」那组源码断言失去锚点）
    expect(code).toMatch(/function checkClient\(/);
    expect(code).toMatch(/function checkTarget\(/);
    expect(code).toMatch(/function checkRoute\(/);
    expect(code).not.toMatch(/export\s+function\s+checkClient/);
    expect(code).not.toMatch(/export\s+function\s+checkTarget/);
    expect(code).not.toMatch(/export\s+function\s+checkRoute/);
    // 工厂返回的是对象字面量（不是 class 实例）—— 保持三个判定体在模块级，锚点可切
    expect(code).toMatch(/return\s*\{\s*checkClient:\s*\(input\)/);
  });

  it("helpers 层对访问控制只 type-only（运行期零依赖边，工具层不压在策略层上面）", () => {
    // `route.ts` 与 `predial.ts` 是「helpers/ 不得反向依赖策略层」这条纪律的两个落点。
    // 它们要的是**端口类型**（`AccessControl` / `AccessRouteDecision`），不是实现。
    //
    // 断言用 `codeOnly`（去注释）而不是原文：`route.ts` 的文件头**故意**点名了
    // 「别在这里运行期 import `@/core/access-control.js`」——那是解释「为什么现在只剩
    // type-only」的历史记录，正是这类注释存在的理由。拿原文断言会让它变成「不许记录
    // 自己改过什么」，而正确动作恰恰相反。
    for (const f of ["route.ts", "predial.ts"] as const) {
      const code = codeOnly(sourceOf("core", "helpers", f));
      expect(code, `${f} 不得 import access-control 的实现`).not.toContain(
        "@/core/access-control.js",
      );
      expect(code, `${f} 必须 type-only 引端口类型`).toMatch(
        /import\s+type\s+\{[^}]*AccessControl/,
      );
    }
  });
});