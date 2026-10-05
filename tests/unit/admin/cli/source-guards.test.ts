/**
 * 源码级档：层不变量（零代理侧 import / 零 console / `argv: []`）+ 通道纪律 + 组合根零副作用
 *
 * @description
 * 「没 import 什么」运行期完全观测不到，而它一旦破了后果是 `user list` 占着一个监听端口 —— 这类断言
 * 只能读源码，且扫描范围必须**现列**（`sourceFiles`）并先断言它非空，否则两个 for 循环拿到空数组
 * 就整组恒绿。
 *
 * @module tests/unit/admin/cli
 * 共享的不变量（判据只有一份 / 坏内容硬失败 / 退出码三档语义 / 临时目录隔离）在 `./AGENTS.md`。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SRC_DIR, codeOf, sourceFiles, sourceOf } from "../../../helpers/source-scan.js";
import { run, writeUsers } from "./_admin-cli.js";

describe("proxy-cli 源码级护栏", () => {
  // `proxy-cli` 的**全部**源文件：传输层（`src/admin/`：解析 / 派发 / 渲染）与数据源操作层
  // （`src/ops/`：装配 / 读 / 写 / 账本读 / 配置事实）。两条禁令对两层**都**成立：ops 不启动
  // 代理（它只是不碰进程），它也必须零 console —— 否则「结构化返回、渲染归传输层」就是一句空话，
  // 而这条断言是那句话唯一的牙齿。
  // **列目录而不是写死文件名**：新增的文件必须自动进扫描范围，否则它对这两条护栏恒绿。
  const toolFiles = sourceFiles("admin", "ops");

  it("**绝不启动代理**：零 `@/core` / `@/runtime` / `@/server` import", () => {
    // ⚠️ **先证明扫描范围非空**：下面两个 for 循环若拿到空数组就**整组恒绿**——而那正是「护栏
    // 看起来在生效、实际什么都没扫」。判据取两个真实存在的文件（传输层与 ops 各一个）。
    expect(toolFiles).toContain("admin/index.ts");
    expect(toolFiles).toContain("ops/sources.ts");
    // 这条只能源码级：运行期完全观测不到「没 import 什么」，而它一旦破了后果是「管理工具把代理
    // 起起来了」——那会让一条 `user list` 占着一个监听端口。
    for (const file of toolFiles) {
      const code = codeOf(file);
      expect(code, `${file} 不许 import 代理侧`).not.toMatch(/from\s+"@\/(core|runtime|server)\//);
    }
    expect(codeOf("cli-admin.ts")).not.toMatch(/from\s+"@\/(core|runtime|server)\//);
    // 而组合根不许碰起进程的那些东西
    const root = codeOf("cli-admin.ts");
    expect(root).not.toMatch(/runServer|ProxyServer|createProxyRuntime/);
  });

  it("零 console / 零 process.*：写入面必须经 AdminIo 注入", () => {
    // ⚠️ **每条 for 循环型判据各自带一份扫描面下界**（共用一处就等于允许「删掉其中一条而另一条照样
    // 绿」）：下面两个 for 循环若拿到空数组就**整条恒绿** —— 而那正是「护栏看起来在生效、实际什么都没
    // 扫」。判据取两层各一个真实存在的文件（传输层与 ops 各一个）。
    expect(toolFiles).toContain("admin/index.ts");
    expect(toolFiles).toContain("ops/sources.ts");
    // 命令层要能在单测里直接断言输出；捕获 console 是一种会漏（异步交错、格式化被重定向）的
    // 间接做法，而 `.eslintrc.js` 的 `no-console` 在本目录同样是 error。ops 层连注入的面都没有，
    // 它只能返回结构化数据 —— 它一旦有 console，「渲染归传输层」当场失效。
    for (const file of toolFiles) {
      expect(codeOf(file), `${file} 不许有 console`).not.toMatch(/\bconsole\./);
      expect(codeOf(file), `${file} 不许碰 process`).not.toMatch(/\bprocess\./);
    }
    // 例外只有组合根：它**就是**宿主环境采集与进程退出的边界
    expect(codeOf("cli-admin.ts")).toMatch(/process\./);
  });

  it("argv 不进 loadConfig：那个调用点的 argv 必须是空数组", () => {
    // 混进同一条通路的两种做法都更坏（在未知键闸门前剥掉 ⇒ 自己的参数拼错零信号；把子命令词
    // 塞进 NON_CONFIG_ENV_KEYS ⇒ 那是配置键的容忍名单）。判据是「那一个调用点的 argv 形状」。
    const body = codeOf("ops/sources.ts");
    expect(body).toMatch(/argv:\s*\[\]/);
  });

  it("跳过启动期文件校验（否则「加第一个账号」在 basic + 空表时会被启动中止挡住）", () => {
    expect(codeOf("ops/sources.ts")).toMatch(/skipFileValidation:\s*true/);
  });

  it("config show 用的是与 CLI 同一份接线（不许自己折一份「哪个键装哪个驱动」）", () => {
    const body = codeOf("ops/sources.ts");
    expect(body).toMatch(/accountLocatorFor/);
    expect(body).toMatch(/aclLocatorFor/);
    expect(body).toMatch(/defaultEnvFileNames/);
  });
});

describe("proxy-cli：成功提示走 stderr，stdout 保持干净", () => {
  it("user list 的 stdout 里没有「已…」这类成功提示", async () => {
    // 运维常在管道里跑脚本；成功提示混进 stdout 会污染下游（`> list.txt` 之后再 `awk` 就炸了）。
    writeUsers([{ username: "alice", password: "pw1" }]);
    const { io } = await run(["user", "list"]);
    expect(io.out.join("\n")).not.toContain("已");
    expect(io.out.join("\n")).toContain("USERNAME");
  });

  it("写操作的提示落在 changed 通道（stderr 侧）", async () => {
    const { io } = await run(["user", "add", "alice", "pw1"]);
    expect(io.changes.join("\n")).toContain("已新建账号 alice");
    expect(io.out.join("\n")).toBe("");
  });
});

describe("proxy-cli 组合根（src/cli-admin.ts）", () => {
  it("import 本模块零副作用：不读 argv、不解析配置、不退出进程", () => {
    // 与 `src/cli.ts` 同纪律：只有 `require.main === module` 时才采集宿主来源。
    // 判据是「快照与 runAdminCli 都锁在那个门控里」——它在文件尾，故从门控起切到文件末。
    const code = codeOf("cli-admin.ts");
    const gate = code.indexOf("require.main === module");
    expect(gate).toBeGreaterThanOrEqual(0);
    const before = code.slice(0, gate);
    expect(before, "门控之前不许有 process.argv / process.env / process.cwd").not.toMatch(
      /process\.(argv|env|cwd)/,
    );
    expect(code).toMatch(/process\.exitCode/);
  });

  it("它与代理 CLI 是两个文件（两个组合根，一个进程一个）", () => {
    expect(fs.existsSync(path.join(SRC_DIR, "cli-admin.ts"))).toBe(true);
    expect(fs.existsSync(path.join(SRC_DIR, "cli.ts"))).toBe(true);
    // 名字对齐：组合根文件 → 产物名
    expect(sourceOf("cli-admin.ts")).toContain("proxy-cli");
  });
});
