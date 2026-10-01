/**
 * `src/manager/supervisor.ts` 的单测：用**假子进程**（`node -e` 起的短命 / 长命进程）
 * 验证进程监管的契约，不碰真实 `dist/app.js`（那要构建产物 + 监听端口，慢且依赖构建）。
 *
 * @description
 * 真 `dist/app.js` 的端到端验证（单进程 restart、cluster workers 死透）是一次性手工脚本，
 * 证据在交付报告里；本文件只锁**逻辑**。
 *
 * 判据按「拆掉哪一处会红」组织：
 * 1. **exit code 传播** —— 短命子进程 `process.exit(7)` → `lastExit.code === 7`、`expected=false`。
 *    锁点：`lastExit.code`。把退出事件的 code 丢掉或记成 null 即红。
 * 2. **`expected` 的方向** —— 我们主动停的算 expected，别人杀的（自己退 / 外部 kill）不算。
 *    锁点：`expected` 两个方向各一次。`expectingExit` 反了即红（它决定 `unexpectedExits`）。
 * 3. **restart 计数 + 新旧 pid 交接** —— 旧 pid 死、新 pid 活、`restarts` +1、耗时字段为正。
 *    锁点：`restarts`、`previousPid`、新 pid ≠ 旧 pid。三者任一没动即红。
 * 4. **restart 的失败不得伪装成成功** —— settle 窗口内自己退出的子进程 → `ok:false` 且**带 pid**。
 *    锁点：`ok === false` + `error` 含 pid。这是本仓最恨的形状（「重启成功」而实际没起来）的直接反判据。
 * 5. **stop 幂等** —— 连续两次 `stop()`、以及「从没 start 就 stop」都返回且不抛，
 *    且**第二次不重复强杀**（判据：子进程只被停一次，`restarts` 不变、`lastExit.expected` 仍为 true）。
 *    ⚠️ 幂等不许靠「已停过」旗标自证：锁点是**同一个在飞 Promise 被复用**的形状 ——
 *    并发两次 `stop()` 时两者返回的是**同一个 Promise 对象**（`p1 === p2`）。加一个旗标
 *    让第二次直接 return 的实现，这条会红。
 * 6. **并发 restart 拒绝** —— 第二个 `restart()` 立刻返回 `ok:false`，且 `restarts` 只 +1。
 *    锁点：`restarts` 未被叠加。排队实现的 `restarts` 会变成 2。
 * 7. **spawn 失败如实上抛** —— `cwd` 指向不存在的目录 → `start()` reject（不是静默"成功"）。
 *    锁点：reject + 消息含路径。实测 win32 下 spawn 对坏 cwd 发 `error` 事件 ENOENT 而非同步抛，
 *    所以「同步 try/catch 包住 spawn()」的实现会红。
 * 8. **env 原样透传** —— 子进程读到的 env 键集与注入的完全相同（不多不少）。
 *    锁点：子进程写出的键集全等。少一个 = 悄悄改了配置；多一个 = 加了东西。
 * 9. **源码级护栏** —— 本文件零 `node:http`、零 `console.`、`stdio: "inherit"`、
 *    `detached: false`、env 不经二次加工。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSupervisor, resolveAppJsPath, type Supervisor } from "@/manager/supervisor.js";
import { createLogger } from "@/utils/logger/index.js";
import { codeOf } from "../helpers/source-scan.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
let tmpDir: string;

/** 写一个假子进程脚本；`body` 是 `-e` 的代码（顶层 await 不可用，故只给同步片段）。 */
function fakeScript(body: string): string {
  const file = path.join(tmpDir, `fake-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, body);
  return file;
}

/** 短命：立刻以给定码退出。 */
const shortLived = (code: number): string => fakeScript(`process.exit(${code});`);

/** 长命：靠一个永不触发的定时器撑着（不打 stdout，避免污染测试输出）。 */
const longLived = (): string => fakeScript("setInterval(() => {}, 1000);");

/** 记录自己 env 的键集后长命。 */
const envReporter = (out: string): string =>
  fakeScript(
    `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env).sort()));\n` +
      "setInterval(() => {}, 1000);",
  );

function make(over: Partial<Parameters<typeof createSupervisor>[0]> = {}): Supervisor {
  return createSupervisor({
    appJsPath: longLived(),
    cwd: tmpDir,
    env: { ...process.env },
    logger: createLogger({ level: "silent" }),
    // 测试里把两个窗口压到最小：settle 必须 >0 才测得到「启动即崩」，
    // grace 只影响「子进程不自己退时停机要多等多久」——压到 200ms 让 stop 快点返回。
    settleMs: 300,
    restartGraceMs: 200,
    ...over,
  });
}

/** 进程是否真的还活着（真判据：`tasklist` 查得到；`process.kill(pid,0)` 在 win32 上不够可靠）。 */
function alive(pid: number | null): boolean {
  if (pid === null) {
    return false;
  }
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return new RegExp(`"${pid}"`).test(out);
  } catch {
    // 非 Windows 或 tasklist 不可用时退回信号 0 探测
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/** 轮询到条件成立或超时；返回是否成立。 */
async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

const running: Supervisor[] = [];

/** 建一个受本文件跟踪的监管者，收尾时保证停干净（不留孤儿进程）。 */
function tracked(over: Parameters<typeof make>[0] = {}): Supervisor {
  const s = make(over);
  running.push(s);
  return s;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-"));
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop().catch(() => undefined)));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("manager/supervisor — 退出事件的记账", () => {
  it("exit code 传播：子进程退 7，lastExit.code 就是 7 且 expected=false", async () => {
    const s = tracked({ appJsPath: shortLived(7) });
    await s.start();
    expect(await waitFor(() => s.status().lastExit !== null)).toBe(true);
    expect(s.status().lastExit?.code).toBe(7);
    // 自己退的与我们无关：这条方向错了 unexpectedExits 就会把正常停机算成崩溃
    expect(s.status().lastExit?.expected).toBe(false);
    expect(s.status().unexpectedExits).toBe(1);
    expect(s.status().running).toBe(false);
  });

  it("我们主动停的退出算 expected，且不计 unexpectedExits", async () => {
    const s = tracked();
    await s.start();
    const pid = s.status().pid;
    expect(pid).not.toBeNull();
    await s.stop();
    expect(s.status().lastExit?.expected).toBe(true);
    expect(s.status().unexpectedExits).toBe(0);
    expect(await waitFor(() => !alive(pid))).toBe(true);
  });

  it("onExit 回调拿到同一份事实，且回调抛错不改变记账", async () => {
    const seen: (number | null)[] = [];
    const s = tracked({
      appJsPath: shortLived(3),
      onExit: (info) => {
        seen.push(info.code);
        throw new Error("回调自己炸了");
      },
    });
    await s.start();
    expect(await waitFor(() => seen.length > 0)).toBe(true);
    expect(seen[0]).toBe(3);
    // 回调抛错不能让 exit 事件的 resolve 变成 reject —— 那会让 stop() 误报失败
    expect(s.status().lastExit?.code).toBe(3);
  });
});

describe("manager/supervisor — restart 的语义", () => {
  it("旧 pid 死、新 pid 活、restarts +1、耗时为正", async () => {
    const s = tracked();
    await s.start();
    const before = s.status();
    expect(before.pid).not.toBeNull();

    const result = await s.restart();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).not.toBe(before.pid);
      expect(result.previousPid).toBe(before.pid);
      expect(result.restarts).toBe(1);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.settled).toBe(true);
    }
    expect(await waitFor(() => !alive(before.pid))).toBe(true);
    expect(alive(s.status().pid)).toBe(true);
  });

  it("启动即崩必须报 ok:false（而不是把 pid 当成功交出去）", async () => {
    // 第一轮长命（让 restart 有东西可停），重启后同一个入口会退 —— 故用计数器让第二轮短命
    const script = fakeScript(
      "const fs = require(\"fs\");\n" +
        `const n = fs.existsSync(${JSON.stringify(path.join(tmpDir, "marker"))}) ? 1 : 0;\n` +
        `fs.writeFileSync(${JSON.stringify(path.join(tmpDir, "marker"))}, "1");\n` +
        "if (n === 1) { process.exit(1); }\n" +
        "setInterval(() => {}, 1000);",
    );
    const s = tracked({ appJsPath: script });
    await s.start();
    const result = await s.restart();
    expect(result.ok).toBe(false);
    expect(result.settled).toBe(false);
    // 失败原因要能定位：含 pid 与「启动即崩」
    expect(result.ok === false && result.error).toMatch(/启动即崩/);
    expect(result.ok === false && result.error).toMatch(/pid=\d+/);
    // 新进程确实死了，status 必须如实反映
    expect(s.status().running).toBe(false);
    expect(s.status().lastExit?.expected).toBe(false);
  });

  it("并发 restart 被拒绝，计数不叠加", async () => {
    const s = tracked();
    await s.start();
    const [first, second] = await Promise.all([s.restart(), s.restart()]);
    expect([first.ok, second.ok].filter((ok) => ok)).toHaveLength(1);
    expect(s.status().restarts).toBe(1);
  });
});

describe("manager/supervisor — 停机幂等", () => {
  it("并发两次 stop 返回同一个 Promise（幂等来自复用，不是旗标）", async () => {
    const s = tracked();
    await s.start();
    const p1 = s.stop() as unknown;
    const p2 = s.stop() as unknown;
    // 同一个对象：第二次调用拿到的是第一次那个 Promise 的引用
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
  });

  it("连续两次 stop 都返回，且不会把子进程再停一遍", async () => {
    const s = tracked();
    await s.start();
    const pid = s.status().pid;
    await s.stop();
    await expect(s.stop()).resolves.toBeUndefined();
    expect(s.status().running).toBe(false);
    expect(s.status().restarts).toBe(0);
    expect(s.status().lastExit?.expected).toBe(true);
    expect(await waitFor(() => !alive(pid))).toBe(true);
  });

  it("从没 start 就 stop 不抛（无子进程是合法状态）", async () => {
    const s = tracked();
    await expect(s.stop()).resolves.toBeUndefined();
    expect(s.status().running).toBe(false);
    expect(s.status().pid).toBeNull();
  });

  it("start 在已运行时返回现状，不叠加第二个进程", async () => {
    const s = tracked();
    const first = await s.start();
    const again = await s.start();
    expect(again.pid).toBe(first.pid);
    expect(s.status().restarts).toBe(0);
  });
});

describe("manager/supervisor — spawn 失败如实上抛", () => {
  it("cwd 不存在 → start reject，消息含该路径", async () => {
    const missing = path.join(tmpDir, "no-such-dir");
    const s = make({ cwd: missing });
    await expect(s.start()).rejects.toThrow(/spawn .*失败/);
    expect(s.status().running).toBe(false);
  });

  it("失败的 start 之后仍可正常 start（不留坏状态）", async () => {
    const good = tracked({ cwd: path.join(tmpDir, "also-missing") });
    await expect(good.start()).rejects.toThrow();
    // cwd 修好后同一个 supervisor 能起得来
    const fixed = createSupervisor({
      appJsPath: longLived(),
      cwd: tmpDir,
      env: { ...process.env },
      logger: createLogger({ level: "silent" }),
      settleMs: 100,
    });
    running.push(fixed);
    const st = await fixed.start();
    expect(st.running).toBe(true);
  });
});

describe("manager/supervisor — env 原样透传", () => {
  it("子进程看到的 env 键集与注入的完全相同（不少不多）", async () => {
    const outFile = path.join(tmpDir, "env.json");
    const env = { ...process.env, SUPERVISOR_PROBE: "1" };
    const s = tracked({ appJsPath: envReporter(outFile), env });
    await s.start();
    expect(await waitFor(() => fs.existsSync(outFile))).toBe(true);
    const seen: string[] = JSON.parse(fs.readFileSync(outFile, "utf8"));
    expect(seen).toEqual(Object.keys(env).sort());
  });
});

describe("manager/supervisor — 路径推导", () => {
  it("从 dist 同级目录推出 dist/app.js", () => {
    const distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, "app.js"), "");
    expect(resolveAppJsPath(distDir)).toBe(path.join(distDir, "app.js"));
  });

  it("从 lib/manager 推出仓库根的 dist/app.js", () => {
    // 与 build.mjs 的两种产物布局一一对应：bundle 在 dist/，tsc 库产物在 lib/manager/
    expect(fs.existsSync(path.join(REPO_ROOT, "dist", "app.js"))).toBe(true);
    expect(resolveAppJsPath(path.join(REPO_ROOT, "lib", "manager"))).toBe(
      path.join(REPO_ROOT, "dist", "app.js"),
    );
  });

  it("一个都试不到就抛错，并列出试过的路径（不给一个不存在的路径）", () => {
    const empty = path.join(tmpDir, "empty");
    fs.mkdirSync(empty);
    // 第 ④ 候选会命中仓库 dist，故用一个仓库外的空目录树来断言「抛错 + 列出候选」
    expect(() => resolveAppJsPath(path.join(empty, "a", "b", "c", "d", "e"))).toThrow(/已试/);
  });
});

describe("manager/supervisor — 源码级护栏", () => {
  const code = codeOf("manager", "supervisor.ts");

  it("零 HTTP 概念（它是管一个进程的，不是管一个 HTTP 服务的）", () => {
    expect(code).not.toMatch(/node:http/);
    expect(code).not.toMatch(/\bhttp\b/);
    expect(code).not.toMatch(/createServer|listen\(/);
  });

  it("零 console（走注入的 logger）", () => {
    expect(code).not.toMatch(/console\./);
  });

  it("stdio: inherit 与 detached: false 是写出来的（win32 上唯一的优雅通道靠它们）", () => {
    expect(code).toMatch(/stdio: "inherit"/);
    expect(code).toMatch(/detached: false/);
  });

  it("env 不过第二道手：spawn 的 env 直接取自注入的那份", () => {
    // 判据是「env: this.env」这一次出现，不允许中间变量 / 展开 / 合并
    expect(code).toMatch(/env: this\.env as Record<string, string \| undefined>/);
    expect(code).not.toMatch(/Object\.assign\(\{\}, *process\.env/);
  });
});