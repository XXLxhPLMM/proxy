/**
 * `isProxyCredentialValue` 从 `src/` 全仓消失（含注释面的逐条登记）
 *
 * @description
 * 旧判据从 `authEnabled` / `authType` / `jwtSecret` + users.json 去**猜**「哪个 `Authorization`
 * 是本代理的」；身份可插值之后它必然失配，而失配的方向是**代理自己的凭证被原样转发给目标站**。
 * 故那个符号整个消失，判据内化进 `IdentityProvider.isOwnCredential`。
 *
 * ⚠️ **这一档是「负向源码断言」的自检样板**：锚是一个**已被删掉的符号名**，按根 `AGENTS.md`
 * 「写护栏时（负向断言的假绿）」它天生**恒真而不是失败**。牙齿靠两件事撑着：① 第一条先报
 * 「扫到几个文件」，证明扫描面非空；② 第四条**反过来**断言「提到它的地方逐条登记在清单内」
 * —— 有人重新引入它时，无论落在代码还是注释，那条都会红。理由见 `AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import { codeOnly, offendingLines, sourceOf } from "../../../helpers/source-scan.js";
import { srcFilesRecursive } from "../../../helpers/src-files.js";

describe("isProxyCredentialValue：从 src/ 全仓消失（判据已内化进身份插件）", () => {
  /** `src/` 下所有 `.ts` 的相对路径（`sourceOf(...)` 收的就是这个形态） */
  function allSourceFiles(): string[] {
    return srcFilesRecursive();
  }

  it("零代码命中：零 `export function`、零 import、零调用", () => {
    const files = allSourceFiles();
    expect(files.length).toBeGreaterThan(30);

    for (const rel of files) {
      const code = codeOnly(sourceOf(...rel.split("/")));
      expect(
        offendingLines(code, /isProxyCredentialValue/),
        `${rel} 不得再出现 isProxyCredentialValue：从配置猜「哪个 Authorization 是代理的」`
          + "这条路径在身份可插值后必然失配，代价是代理凭证被转发给目标站",
      ).toEqual([]);
    }
  });

  it("零 `export function isProxyCredentialValue` 声明", () => {
    for (const rel of allSourceFiles()) {
      const code = codeOnly(sourceOf(...rel.split("/")));
      expect(code).not.toMatch(/export\s+function\s+isProxyCredentialValue/);
    }
  });

  it("零 `import ... isProxyCredentialValue`", () => {
    for (const rel of allSourceFiles()) {
      const code = codeOnly(sourceOf(...rel.split("/")));
      expect(code).not.toMatch(/import\s[^;]*isProxyCredentialValue/);
    }
  });

  it("全仓（含注释）只在**契约注释**里点名，且位置逐条登记", () => {
    // 为什么这条比上面三条更严：上面三条用 `codeOnly` 去掉了注释，所以它们只锁「代码面」。
    // 但**注释面**同样有牙齿：注释是下一个读代码的人的唯一线索，它说「这里有个函数」而代码里
    // 已经没有，会让人去找一个不存在的东西（或者更糟：照着它去实现一个）。
    //
    // 允许点名的只有一类：**「它曾经是 X」这种解释判据来源变迁的契约注释**。
    // 不允许的是把它当**现存 API** 引用（「调 `isProxyCredentialValue(...)`」）。
    // 下面这条例外清单就是本仓当前允许点名的全部位置，逐条写明文件与理由 —— 往里加一行都
    // 必须同时说明「为什么这行注释里出现一个不存在的 API 是必要的」。
    //
    // 注：`src/**/*.md`（AGENTS.md）不在扫描范围内 —— 那里是**历史记录**的正确容身处，
    // 「曾经是」的措辞本来就该留在那里。
    const ALLOWED_MENTIONS: readonly { file: string; reason: string }[] = [
      {
        file: "core/helpers/headers.ts",
        reason:
          "文件头解释「凭证判据不在本文件」这条分层事实时点名了它（判据搬到了 core/identity/）。"
          + "删掉这个名字，下一个人会以为 headers.ts 只是漏实现了判据、于是把它加回来。",
      },
      {
        file: "core/helpers/credentials.ts",
        reason:
          "六处全是「**不再**由本文件派生、旧判据已移走」的方向性说明（模块文件头 + "
          + "`credentialIndexesFor` / `verifyHs256Jwt` 的契约注释）。它们的作用是阻止"
          + "「凭据原语层顺手把配置读取也做了」这条回退。",
      },
      {
        file: "core/types/proxy.ts",
        reason:
          "`IdentityProvider.isOwnCredential` 的契约注释记录判据的来源变迁（从 config 猜 → 插件自述），"
          + "并解释为什么失配的代价是凭证泄漏。**这是最该保留的一处**：自定义身份插件的作者"
          + "只读这一段契约注释。",
      },
      {
        file: "core/identity/file-account.ts",
        reason:
          "`isOwnCredential` 的实现注释记录判据的来源变迁与「密钥两份真相」那个真问题，"
          + "并说明 jwt 分支为何走内置 HS256。删掉它，这条边界会被人当成疏忽去「修」。",
      },
      {
        file: "index.ts",
        reason:
          "库入口的「不留兼容层」清单：明确声明旧名**一律不导出、不加别名**。"
          + "这正是「它是旧 API」这一事实的权威出处。",
      },
    ];

    for (const rel of allSourceFiles()) {
      const raw = sourceOf(...rel.split("/"));
      if (!raw.includes("isProxyCredentialValue")) {
        continue;
      }
      const allowed = ALLOWED_MENTIONS.find((a) => rel.endsWith(a.file));
      expect(
        allowed,
        `${rel} 提到了 isProxyCredentialValue，但不在本档的「契约注释」允许清单里。`
          + "要么它是代码（上面三条立刻红），要么它是注释而你刚加的 —— "
          + "请先判断它属于「解释判据来源变迁的契约注释」还是「当现存 API 引用」，"
          + "后者必须改写成不点名的说法。历史记录请写进 src/**/*.md 而不是函数契约注释。",
      ).toBeDefined();
    }
  });
});