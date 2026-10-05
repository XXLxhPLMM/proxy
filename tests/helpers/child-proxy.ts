import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "./source-scan.js";

/**
 * 「spawn 真 `dist/app.js` 子进程」这一套的公共面（构建保鲜 / 起停 / 等端口 / CLI 前缀）
 *
 * @description
 * 子进程就是独立进程，**不与测试进程共享 store** —— 这正是生产上「代理套代理」的真实形态，
 * 任何 in-process 装配都测不到串联时才会出现的那几类形状（配置只从一个入口进、
 * 前级解析出的目标交给后级再解析一次、鉴权头在前级就被剥掉）。
 *
 * ### 两道隔离，缺一不可
 *
 * **① cwd 必须在仓库之外**（{@link SPAWN_CWD}）：`loadConfig` 的 env 候选名
 * （`.env.production` / `.env.development` / `.env.<NODE_ENV>`）是相对路径、按 configDir
 * 解析，而 configDir 缺省 = cwd —— cwd 在仓库里就等于每次 spawn 都吃开发者本地的
 * `.env.development`（真实账号表、socks4、仓库内日志与账本目录），**且没有任何提示**。
 * CLI 覆盖只能压住被显式覆盖的那几个键，剩下那些（比如字段已删的孤儿键）照样被静默吃进去。
 * 放在 tempdir 下那三个候选名一个都找不到，配置**只**来自调用点传的 CLI 与绝对路径。
 *
 * **② 按需剔除宿主 `process.env` 里恰好同名的键**（`spawnProxy` 的 `stripEnv`）：那是真实
 * 宿主环境的风险，与 env 文件是两回事 —— cwd 挪到仓库外**挡不住**它，因为 env 是继承来的。
 * 哪些键要剔由调用点自己申报（它才知道自己会传 `--auth-type` / `--proxy-mode` 这类 CLI 覆盖）：
 * 不设 `stripEnv` 就是「全盘继承」，这与「主动剔除」是两个不同的选择，不许混成默认行为。
 * - 真的**改得掉行为**的是「本档没有用 CLI 覆盖到的那几个键」（`UPSTREAM_PROTOCOL` 就是：
 *   {@link baseArgs} 覆盖了 host / port / 协议 / workers / 日志 / 鉴权开关，没覆盖上游形态）：
 *   优先级是 `CLI > 显式 env > env 文件 > defaults`，这类继承键会**静默生效**，症状是
 *   「代理起来了，但上游走的不是我写的那条」。而像 `PORT` / `PROXY_MODE` 这种已被 CLI 覆盖的键，
 *   申报它们是**双保险**（CLI 本来就压得住）—— 列不列都不改变结论，但列上更省心。
 *
 * ⚠️ 传参一律走 CLI（`--port` / `--proxy-mode` / …），CLI 优先级最高。
 *
 * ⚠️ **「CLI 优先」不等于「env 文件不干扰」** —— 这一条是隔离 ① 的**理由**，不能拿
 * 「参数都走 CLI」顶替：优先级里 env 文件**始终**被读入（`loadConfig` 无条件走
 * `readEnvFiles`），只是被 CLI 覆盖的那几个键不出声。**没**被覆盖的键照单全收，而那种偏差是
 * 静默的 —— 子进程照常起来，只是 workers 数、监听协议、账号表路径不是你写的那份。
 * 所以正确做法是让那三个候选名**根本找不到**（隔离 ①），而不是靠「多覆盖几个键」祈祷没漏。
 *
 * ⚠️ 别把「env 文件里的孤儿键会被静默吃进去」当隔离 ① 的论据：**现在的判据是 fail-fast**
 * （`assertKnownKeys`，`argv` 与 env 文件里出现 `FIELDS` 之外的键一律让启动失败，
 * 见 `src/config/load.ts`）。已删除的旧键写在 `.env.development` 里，子进程是**起不来**而不是
 * 起歪 —— 那是有声音的失败，恰恰**不是** ① 要防的那一类。① 防的是「键名合法、值不是你想要的」
 * （`UPSTREAM_PROTOCOL=socks4` / `AUTH_TYPE=uid` 这类），那种一律无声。
 */

const DIST_APP = path.join(REPO_ROOT, "dist", "app.js");

/** 子进程 cwd：在临时目录里，让 `.env*` 文件与仓库内相对路径**都**落在代理之外 */
export const SPAWN_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-child-cwd-"));

/** 收掉 {@link SPAWN_CWD}（含调用点写进去的账号表等产物）；`afterAll` 末尾调一次 */
export function disposeSpawnCwd(): void {
  fs.rmSync(SPAWN_CWD, { recursive: true, force: true });
}

/** 目录 `dir` 下最新 `.ts` 的 mtime（毫秒；空目录返回 0） */
function newestSrcMtime(dir: string): number {
  let max = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      max = Math.max(max, newestSrcMtime(p));
    } else if (entry.name.endsWith(".ts")) {
      max = Math.max(max, fs.statSync(p).mtimeMs);
    }
  }
  return max;
}

/**
 * dist 产物不存在或比 `src/` 下任意源码旧时先构建
 *
 * @description
 * Windows + esbuild 的退出码 `STATUS_STACK_BUFFER_OVERRUN` 是已知现象（产物照样写出），
 * 所以**以 `dist/app.js` 的 mtime 是否刷新为准，不迷信 exit code**。
 */
export async function ensureDistBuilt(): Promise<void> {
  const srcMtime = Math.max(
    newestSrcMtime(path.join(REPO_ROOT, "src")),
    fs.statSync(path.join(REPO_ROOT, "build.mjs")).mtimeMs,
  );
  if (fs.existsSync(DIST_APP) && fs.statSync(DIST_APP).mtimeMs >= srcMtime) return;
  const before = fs.existsSync(DIST_APP) ? fs.statSync(DIST_APP).mtimeMs : 0;
  await new Promise<void>((resolve) => {
    execFile(process.execPath, ["build.mjs"], { cwd: REPO_ROOT }, () => resolve());
  });
  if (!fs.existsSync(DIST_APP) || fs.statSync(DIST_APP).mtimeMs <= before) {
    throw new Error("构建 dist/app.js 失败，子进程代理无法启动");
  }
}

export interface SpawnOptions {
  /**
   * 从继承来的 `process.env` 里剔掉的键
   *
   * @description
   * 缺省**不剔**（全盘继承）。这是个显式选择而不是「默认干净」：调用点知道自己会传哪些
   * CLI 覆盖，那些同名 env 键必须由它自己点名剔除，见文件头的隔离 ②。
   */
  stripEnv?: readonly string[];
}

/** 起一个真 `dist/app.js` 子进程（调用点自己负责在 `afterAll` 里 {@link stopChild}） */
export function spawnProxy(args: readonly string[], opts: SpawnOptions = {}): ChildProcess {
  const env = { ...process.env };
  for (const key of opts.stripEnv ?? []) delete env[key];
  return spawn(process.execPath, [DIST_APP, ...args], { cwd: SPAWN_CWD, env, stdio: "ignore" });
}

/** 公共 CLI 前缀：单进程 + 静音 + 关鉴权，避免 env 里的 workers/日志/鉴权配置污染子进程 */
export function baseArgs(port: number): string[] {
  return [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--proxy-protocol",
    "http",
    "--cluster-workers",
    "1",
    "--log-level",
    "silent",
    "--log-file",
    "",
    "--auth-enabled",
    "false",
  ];
}

/** 轮询端口直至能连上（代理监听成功），超时抛错 */
export function waitForPort(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`等待端口 ${port} 超时`));
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

/** 停子进程：先 `kill()`，3 秒内没退出就 `SIGKILL`；已退出直接返回（幂等） */
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}