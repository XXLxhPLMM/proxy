import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codeOnly, REPO_ROOT } from "../../helpers/source-scan.js";

/**
 * 控制面 ↔ `@b-hole/proxy-tui` 的**端点表互锁**护栏
 *
 * @description
 * 本目录的跨档不变量（控制面这一族与 `packages/tui` 的分工）、判据形状、判据自检与刻意的口径收窄
 * 的理由归 `../AGENTS.md` 的「防假绿的位置」与「文件」两节；下面只留「这一档答什么」。
 *
 * **要防的事**：本仓有**两个包**，而它们对控制面 HTTP 契约的声明**各写了一份** ——
 * 服务端在 `src/manager/routes/*.ts` 的那批 `{ method, path }` 对象，
 * TUI 在 `packages/tui/src/api/endpoints/*.ts` 那批 `{ method, path }` 字面量（由该目录的 `index.ts`
 * 装配成一条平表 `ENDPOINTS`）。两侧漂了有**两个方向**，
 * 而两个方向的外部表现都是「两边都绿」：
 * - 控制面加了端点、漏改 TUI 侧 ⇒ TUI 少一个功能（用户看到的只是「这个功能没有」）。
 * - TUI 侧写了服务端没有的端点 ⇒ TUI 对着一个**永远 404** 的路径发请求。
 * 没有本档的话，这两种漂移都不会让任何东西变红。
 */
const ROOT = REPO_ROOT;

/** 服务端端点的**唯一**来源：现列 `src/manager/routes/`，不手写文件名清单 */
const ROUTES_DIR = path.join(ROOT, "src", "manager", "routes");

/**
 * TUI 侧端点表的**唯一**来源：现列 `packages/tui/src/api/endpoints/`，不手写文件名清单
 * @description
 * 与 {@link ROUTES_DIR} 同一口径：那一侧按服务端模块分了 `routes/{status,config,users,acl,usage}.ts`，
 * 这一侧同样按模块分成 `endpoints/` 下的同名子文件 + 一个把它们装配成平表的 `index.ts`。⚠️ **两边都现列**
 * 是这里的关键：手写一份文件名清单，等于把「新增一个模块文件」与「记得改本档」绑在一起 ——
 * 而漏改的后果是**静默少判一条**（集合相等那张核心档不会红，因为两侧只是都少了一条）。
 * 目录清空 / 路径写错由「覆盖面」那组立刻红。
 */
const TUI_ENDPOINTS_DIR = path.join(ROOT, "packages", "tui", "src", "api", "endpoints");

interface Endpoint {
  readonly method: string;
  readonly path: string;
}

/** 一条端点的判据键（集合比对的单位） */
const keyOf = (e: Endpoint): string => `${e.method} ${e.path}`;

/**
 * 探测器：从一段**源码原文**里抠出全部 `(method, path)` 端点
 *
 * @description
 * - **自带 `codeOnly`**（而不是让调用方记得调）：判据的正确性不该依赖「每一处调用点都记得
 *   先去注释」，漏一处就是静默少判 —— 而少判恰好落在「两侧集合相等」最难发现的形状上。
 * - **正则每次现构造**：全局正则的 `lastIndex` 是跨调用的可变状态，让它进判据等于埋一个
 *   「跑一次对、跑两次少一半」的地雷。
 * - **中间那段 tempered 窗口**（`(?:(?!method:)[\s\S]){0,80}?`）是「允许格式化换行」与
 *   「不许跨到下一个对象」这两个需求的交集：非贪婪取**最近的** `path:`，而否定向望保证那之前
 *   没有另一个 `method:`。
 * @param rawSource - 源码原文（注释会在内部被剥掉）
 */
function endpointsIn(rawSource: string): Endpoint[] {
  const re = new RegExp(
    String.raw`method:\s*"([A-Z]+)"\s*,?((?:(?!method:)[\s\S]){0,80}?)path:\s*"(\/[^"\s]*)"`,
    "g",
  );
  return [...codeOnly(rawSource).matchAll(re)].map((m) => ({ method: m[1], path: m[3] }));
}

/** 某个目录里此刻真实存在的全部 `*.ts`（现列，新增文件自动入扫描；两侧同一口径） */
const sourceFiles = (dir: string): string[] =>
  fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .sort();

/** 服务端侧现取的端点集合（读盘一次） */
const serverEndpoints = (): Endpoint[] =>
  sourceFiles(ROUTES_DIR).flatMap((name) =>
    endpointsIn(fs.readFileSync(path.join(ROUTES_DIR, name), "utf8")),
  );

/**
 * TUI 侧现取的端点集合（读盘一次）
 * @description ⚠️ `index.ts` 也进扫描（服务端那侧的 barrel 同样进）：它是「平表从哪几个模块装配来」的
 * 唯一说明处，而它本身只展开那些常量、不声明字面量 —— 万一将来有人在里面手写一条，那**应该**被本档看见。
 */
const tuiEndpoints = (): Endpoint[] =>
  sourceFiles(TUI_ENDPOINTS_DIR).flatMap((name) =>
    endpointsIn(fs.readFileSync(path.join(TUI_ENDPOINTS_DIR, name), "utf8")),
  );

/** 集合差：只出现在 `left` 里的那些（逐条可读，失败信息直接能指出缺了哪条端点） */
const onlyIn = (left: readonly Endpoint[], right: readonly Endpoint[]): string[] => {
  const seen = new Set(right.map(keyOf));
  return [...new Set(left.map(keyOf))].filter((k) => !seen.has(k)).sort();
};

describe("控制面 ↔ TUI 端点表契约", () => {
  describe("判据自检（防「探测器写坏了 → 两侧集合相等变成空集相等」）", () => {
    it("合成脏文本里那 3 条端点真的被抠出来（探测器看得见，不是恒返回空）", () => {
      const dirty = [
        '{ method: "GET", path: "/api/dirty-a" },',
        '{ method: "POST", path: "/api/dirty-b" },',
        '{ method: "DELETE", path: "/api/dirty-c" },',
      ].join("\n");
      expect(endpointsIn(dirty).map(keyOf)).toEqual([
        "GET /api/dirty-a",
        "POST /api/dirty-b",
        "DELETE /api/dirty-c",
      ]);
    });

    it("被换行拆开的 method / path 仍然抠得出来（跨行那一档不是死代码）", () => {
      // 服务端今天就是这个排版：prettier 会把 `{ method: "…", path: "…" }` 折成两行
      const wrapped = [
        "{",
        '  method: "PUT",',
        '  path: "/api/wrapped",',
        "  handler: noop,",
        "},",
      ].join("\n");
      expect(endpointsIn(wrapped).map(keyOf)).toEqual(["PUT /api/wrapped"]);
    });

    it("缺 path 的 method 不会与后一条的 path 配成一对（配对窗口不许跨过下一个 method:）", () => {
      // 没有这条，窗口就会把第一个 method 配到第二个对象的 path 上 ——
      // 表格条数看着对、方法名却是错的，而**没有任何一处会红**
      const halfTyped = [
        '{ method: "GET", handler: () => reply(200, {}) },',
        '{ method: "PUT", path: "/api/typed" },',
      ].join("\n");
      expect(endpointsIn(halfTyped).map(keyOf)).toEqual(["PUT /api/typed"]);
    });

    it("注释里写的端点不参与判定（codeOnly 真的在生效）", () => {
      // `src/manager/routes/index.ts` 的文件头里就有一张端点表的 markdown：它必须被剥掉，
      // 否则它会变成第二个真相源，而「端点表写错了但没人发现」正是本档要防的那类事故
      const annotated = [
        "// | `GET` | `/api/documented` | — | 200 |",
        '/* { method: "GET", path: "/api/blocked" }, */',
        '{ method: "GET", path: "/api/live" },',
      ].join("\n");
      expect(endpointsIn(annotated).map(keyOf)).toEqual(["GET /api/live"]);
    });

    it("空文本抠出零条（证明上面几条不是恒返回非空）", () => {
      expect(endpointsIn("")).toEqual([]);
      expect(endpointsIn("export interface Endpoint {\n  readonly method: Method;\n}")).toEqual([]);
    });
  });

  describe("覆盖面：两侧今天都真的被读到了（这一组是「空集相等」的解药）", () => {
    it("TUI 侧端点表目录存在（路径锚点是今天真实存在的那份文本）", () => {
      expect(fs.existsSync(TUI_ENDPOINTS_DIR), `${TUI_ENDPOINTS_DIR} 不存在`).toBe(true);
    });

    it("src/manager/routes/ 现列至少 5 个 *.ts（目录被清空 / 路径写错会立刻红）", () => {
      const files = sourceFiles(ROUTES_DIR);
      expect(
        files.length,
        `src/manager/routes/ 只列到 ${files.length} 个文件`,
      ).toBeGreaterThanOrEqual(5);
    });

    it("packages/tui/src/api/endpoints/ 现列至少 5 个 *.ts（目录被清空 / 路径写错会立刻红）", () => {
      // 与服务端那条**成对**：一侧现列而另一侧不现列，那不对称本身就是要藏「少判一条」的形状
      const files = sourceFiles(TUI_ENDPOINTS_DIR);
      expect(
        files.length,
        `packages/tui/src/api/endpoints/ 只列到 ${files.length} 个文件`,
      ).toBeGreaterThanOrEqual(5);
    });

    it(`服务端现取到至少 10 条端点（实际 ${serverEndpoints().length} 条）`, () => {
      // 下界不是定数：加端点不该变成「改一次测试」的噪音；下界只挡住「探测器整体失灵」
      expect(serverEndpoints().length).toBeGreaterThanOrEqual(10);
    });

    it(`TUI 侧现取到至少 10 条端点（实际 ${tuiEndpoints().length} 条）`, () => {
      expect(tuiEndpoints().length).toBeGreaterThanOrEqual(10);
    });

    it("报出本档此刻的覆盖面（两侧各取到几条、差集是什么）", () => {
      const server = serverEndpoints();
      const tui = tuiEndpoints();
      process.stderr.write(
        [
          `端点契约护栏：服务端 ${server.length} 条 / TUI ${tui.length} 条 —— 判据是两侧源码文本里现取的 (method, path) 集合相等`,
          `  只有服务端有：${onlyIn(server, tui).join("、") || "无"}`,
          `  只有 TUI 有：${onlyIn(tui, server).join("、") || "无"}`,
          "",
        ].join("\n"),
      );
      expect(server.length).toBeGreaterThan(0);
      expect(tui.length).toBeGreaterThan(0);
    });
  });

  describe("1 契约：两侧 (method, path) 集合相等（双向）", () => {
    it("只有服务端有的端点是零条（TUI 漏抄 = 它对着一个不存在的功能发请求）", () => {
      const missing = onlyIn(serverEndpoints(), tuiEndpoints());
      expect(
        missing,
        `控制面提供了而 TUI 端点表里没有：\n${missing.map((k) => `  ${k}`).join("\n")}\n\n` +
          "修法：在 packages/tui/src/api/endpoints/ 下**与服务端同名**的那个模块文件里补上这几条" +
          "（`status.ts` / `config.ts` / `users.ts` / `acl.ts` / `usage.ts`；表是手抄的，漏抄不会有任何东西自动报错）。",
      ).toEqual([]);
    });

    it("只有 TUI 有的端点是零条（TUI 多抄 = 它对着一个永远 404 的路径发请求）", () => {
      const extra = onlyIn(tuiEndpoints(), serverEndpoints());
      expect(
        extra,
        `TUI 端点表里写了控制面没有的端点：\n${extra.map((k) => `  ${k}`).join("\n")}\n\n` +
          "修法：删掉 packages/tui/src/api/endpoints/ 里这几条。" +
          "若这是「控制面还没写」的需求，先加服务端路由（src/manager/routes/<模块>.ts），再加 TUI 这条。",
      ).toEqual([]);
    });

    it("两侧的路径都以 /api/ 开头（控制面只在 /api/ 下暴露资源端点）", () => {
      // 锚在「今天仍然存在的形状」（路径字面量本身）而不是某个符号名
      for (const e of [...serverEndpoints(), ...tuiEndpoints()]) {
        expect(e.path, `${keyOf(e)} 的路径不在 /api/ 下`).toMatch(/^\/api\//);
      }
    });

    it("服务端一侧没有重复的 (method, path)（路由取第一条命中，重复只会让「哪条生效」取决于顺序）", () => {
      // 这条是服务端自己的不变式（`src/manager/routes/index.ts` 的装配处点名了它），
      // 放在本档是因为**重复会同时污染两侧的集合比对**（TUI 抄一条 vs 服务端两条）
      const keys = serverEndpoints().map(keyOf);
      const dup = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
      expect(dup, `服务端有重复的 (method, path)：${dup.join("、")}`).toEqual([]);
    });
  });
});
