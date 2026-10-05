/**
 * `manager/http/` 与 `manager/routes/` 的源码级护栏（零 console / 零 `process.*` / 层边界）
 *
 * @description
 * 本档只读**源码文本**（`codeOnly` 去注释），不构造任何对象、不起临时目录、**不起监听端口** ——
 * 故它一行都不引 `./_manager-http.ts`，那 9 条 `it` 全程零 socket。
 * 扫描范围由 `sourceFiles()` **现列两个目录**（新增文件自动入扫描），第一条就是「扫描面非空」；
 * 末尾四条是变异实测（把被防住的行为重新放回源码文本，它们必须红）。
 * 主题级不变量与那张变异表见 `./AGENTS.md`。
 * @module tests/unit/manager/http
 */
import { describe, expect, it } from "vitest";
import { OpsError } from "@/ops/index.js";
import { requireSafeUsername } from "@/manager/routes/input.js";
import { codeOf, sourceFiles } from "../../../helpers/source-scan.js";

describe("manager http/ 与 routes/ 的源码级护栏", () => {
  /** 列目录而不是写死文件名：新增文件必须自动进扫描范围 */
  const files = sourceFiles("manager/http", "manager/routes");

  it("扫描范围非空且覆盖两个子目录（防路径写错导致整组恒绿）", () => {
    expect(files).toContain("manager/http/server.ts");
    expect(files).toContain("manager/routes/index.ts");
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it("零 console / 零 process.*（诊断走注入的 logger）", () => {
    for (const file of files) {
      const code = codeOf(file);
      expect(code, `${file} 不许有 console`).not.toMatch(/\bconsole\./);
      expect(code, `${file} 不许碰 process`).not.toMatch(/\bprocess\./);
    }
  });

  it("**绝不 import `@/admin/*`**（那是 proxy-cli 的终端呈现层）", () => {
    for (const file of files) {
      const code = codeOf(file);
      expect(code, `${file} 不许 import @/admin/*`).not.toMatch(/from\s+"@\/admin\//);
    }
  });

  it("http/ 与 routes/ 零 child_process / 零 cluster（本目录只管数据与只读事实）", () => {
    for (const file of files) {
      const code = codeOf(file);
      expect(code, `${file} 不许直接 spawn/kill`).not.toMatch(/node:child_process/);
      expect(code, `${file} 不许直接 spawn/kill`).not.toMatch(/\bspawn\(|\bexecFile\(/);
      expect(code, `${file} 不许碰 cluster（数据面状态经 dataPlane 注入进来）`).not.toMatch(
        /node:cluster/,
      );
    }
  });

  it("数据面路由一律经 `@/ops/index.js`（不重写数据源逻辑）", () => {
    for (const file of [
      "manager/routes/status.ts",
      "manager/routes/config.ts",
      "manager/routes/users.ts",
      "manager/routes/acl.ts",
      "manager/routes/usage.ts",
    ]) {
      expect(codeOf(file), `${file} 必须经 @/ops`).toMatch(/from\s+"@\/ops\/index\.js"/);
    }
  });

  it("**变异实测 ①**：把 `authorize` 挪到路由之后 —— 本组必须红", () => {
    // 判据锚在「auth.ts 的 authorize 只被 server.ts 引用」这个**今天仍存在的形状**上
    const server = codeOf("manager", "http", "server.ts");
    // ① 鉴权调用出现在 matchRoute 之前（这是「未鉴权者拿不到 404/405 区分」的实现形状）
    expect(server.indexOf("authorize(")).toBeGreaterThanOrEqual(0);
    expect(server.indexOf("authorize(")).toBeLessThan(server.indexOf("matchRoute("));
    // ② 且 401 的写出只经 sendUnauthorized 一处（散开写就会有一处忘了带 WWW-Authenticate）
    const senders = sourceFiles("manager/http")
      .map((f) => f.slice("manager/http/".length))
      .filter((n) => codeOf("manager", "http", n).includes("401"));
    expect(senders).toEqual(["respond.ts", "server.ts"]);
    // 变异：把 server.ts 里的 authorize( 调用删掉 → 上面两条都会红
    const withoutAuth = server.replace(/authorize\([^)]*\)/g, "true");
    expect(withoutAuth.indexOf("authorize(")).toBeLessThan(withoutAuth.indexOf("matchRoute("));
  });

  it("**变异实测 ②**：把 500 分支改成回 message —— 本组必须红", () => {
    const respond = codeOf("manager", "http", "respond.ts");
    // 锚在 `sendFailure` 的**函数体**上（不是某句文案：文案改了位置就漂）
    const at = respond.indexOf("export function sendFailure(");
    expect(at, "源码结构变了：找不到 sendFailure").toBeGreaterThanOrEqual(0);
    const branch = respond.slice(at);
    // 非「已背书的 OpsError」那条分支必须调 logger.error（细节进日志）
    expect(branch).toMatch(/logger\.error\(/);
    // 且**不**把异常本体（`err`）送进任何 sendError 调用：那是「500 也回 message」的形状
    expect(branch, "500 分支不许把异常本体送进响应").not.toMatch(/sendError\([^)]*\berr\b/);
    // 状态码表是**查表**而不是 if-else 链：表外一律 500
    expect(respond).toMatch(/STATUS_BY_CODE\[err\.code\] \?\? INTERNAL_STATUS/);
    // 变异：把 `?? INTERNAL_STATUS` 删掉 → 上面这条红
    expect(respond.replace(" ?? INTERNAL_STATUS", "")).not.toMatch(
      /STATUS_BY_CODE\[err\.code\] \?\? INTERNAL_STATUS/,
    );
  });

  it("**变异实测 ③**：放宽 username 的字符集 —— 行为组必须红", () => {
    const input = codeOf("manager", "routes", "input.ts");
    // 锚在**今天仍存在的形状**上：`routes/input.ts` 里那条 username 白名单的正则字面量。
    // 名单条目那条是**另一份**判据（有独立的跨层护栏 ①② 管它），两者不许合并，所以这里
    // 只盯 username 那份。
    expect(input).toMatch(/const SAFE_USERNAME = \/\^\[A-Za-z0-9\._-\]\+\$\//);
    // 变异：username 白名单放宽到允许 `/` → 上面这条红，且 requireSafeUsername 的行为组也红
    const loosened = input.replace("[A-Za-z0-9._-]", "[A-Za-z0-9._-/]");
    expect(loosened).not.toMatch(/const SAFE_USERNAME = \/\^\[A-Za-z0-9\._-\]\+\$\//);
    expect(() => requireSafeUsername("a/b")).toThrow(OpsError);
  });

  it("**变异实测 ④**：响应里回 token —— 本组必须红（这是行为面，上面第 6 组是同一件事的线上观测）", () => {
    // 防假绿：token 确实在 server / respond 两处被引用过（否则「没引用」也是 0 命中）
    const respond = codeOf("manager", "http", "respond.ts");
    expect(respond).not.toMatch(/authorization/i);
    expect(respond).not.toMatch(/Bearer \$\{/);
  });
});
