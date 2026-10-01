/**
 * manager 控制面的**子进程监管者** —— spawn 一个 `dist/app.js`、盯着它、优雅停机、重启。
 *
 * @description
 * ## 边界：它管的是一个**进程**，不是一个 HTTP 服务
 * 本文件零 `node:http`、零路由、零端口。它唯一的产出是「那个进程现在活着吗 / 换一个新的」。
 * 控制面把 HTTP 面挂在它外面；两者刻意不互相引用，于是本文件能被任何宿主单独用起来测。
 *
 * ## 子进程是谁
 * 代理进程是 `dist/app.js`（`src/cli.ts` 的产物）。它自己可能再 fork cluster workers
 * （`CLUSTER_WORKERS>1`），**但那些 worker 不是本监管者的对象** —— `app.js` 自己管它们
 * （SIGINT/SIGTERM → IPC 通知 workers → grace 超时 SIGKILL，见 `src/server/cluster.ts`）。
 * 于是「cluster 也能被干净停掉」不需要第二套 IPC：监管者只要保证**整棵进程树**死透。
 *
 * ## 三条 spawn 硬约束（每条都有代价，不是偏好）
 * 1. **`stdio: "inherit"`**：子进程自己的 `[config]` / `proxy started:` / banner / `[shutdown]`
 *    是运维唯一的观察面。改成 pipe 的话输出得由本文件转发（多一层可丢的缓冲），且子进程的
 *    `process.stdout.isTTY` 变 false → banner 与日志失去颜色。**这一条还顺带保住了 win32 上
 *    唯一的优雅通道**：子进程与监管者共享控制台，人才有的 Ctrl+C 才会广播到子进程。
 * 2. **`env` 原样透传**：子进程走 `loadConfig`，读的就是**宿主 env**。过滤或增删任何一个键，
 *    都会让「manager 看到的配置」与「proxy 看到的配置」漂移 —— 那是最贵的一种事故
 *    （manager 改的是 A、跑起来的是 B，而两边都报成功）。
 * 3. **`detached: false`**（Node 缺省，写出来是为了它被改掉时有人看见）：`true` 会让子进程
 *    脱离控制台组，上面那条 Ctrl+C 广播立刻断掉。
 *
 * ## 停机为什么在 win32 上「等得到的东西」和 POSIX 不一样
 * 实测（本机 Node 22 / Windows，探针见报告）：`child.kill("SIGINT"|"SIGTERM"|"SIGKILL")`
 * **一律是 `TerminateProcess`** —— 子进程里的 `process.on("SIGINT")` 处理器**根本不会执行**
 * （退出事件报 `signal=SIGINT`，而处理器一行都没跑）。`taskkill` 不带 `/F` 对 console 进程
 * 直接失败（「该进程只能被强制终止」），`child.kill("SIGBREAK")` 被 libuv 报成 `SIGKILL`。
 * 结论：**Windows 上没有「请求子进程排空」这条通道。**
 *
 * 由此 `stop()` 与 `restart()` 的宽限窗口是**两种不同东西**，这是本文件唯一一处刻意的平台不对称：
 * - **`stop()` 的窗口用来「不打断已经在进行的排空」**。人在控制台按 Ctrl+C 时 SIGINT 广播给
 *   整组，子进程立刻开始排空；监管者这时若抢先强杀，就把人刚启动的排空打掉了（数据面连接被
 *   腰斩、账本尾部未落盘）。所以 stop 必须等。
 * - **`restart()` 的窗口没有任何东西可等**。它由控制面（HTTP / CLI）触发，没有任何信号发给
 *   子进程，等下去只是白等 `restartGraceMs`。win32 上它直接强杀，并**如实 warn** 这条连接是被
 *   掐断的。POSIX 上它仍然先发 SIGTERM 走完排空。
 *
 * 强杀一律 **win32: `taskkill /PID <pid> /T /F`**。
 * `/T` 的理由**不是**「本机不写就会留孤儿」——实测**不带** `/T` 时 cluster workers 也会跟着
 * master 一起消失：非 detached 的子孙会在父进程退出后不久一并消失，`IsProcessInJob` 显示它们与
 * 父进程同处一个作业，而 `detached:true` 的子孙不在（故它活下来了）。
 * **那个连带机制本仓未查明，且换环境/换父子归属方式后未必成立**，因此不作为契约依赖；
 * `/T` 是唯一有文档、可移植的树杀手段。赌一个未查明的连带去换正确性，正是本仓拒绝的那种做法。
 * ⚠️ 平台边界：POSIX 上本文件**没有**进程组可杀（`detached: false` 是上面硬约束 ③），故 POSIX
 * 的强杀只覆盖 master；那条路径能走到强杀，说明 SIGTERM 连排空都没启动（配置错 / 卡死），
 * 而 workers 会残留。win32 不是这个问题的目标平台，真要在 POSIX 上也清干净，唯一的改法是给
 * 子进程建独立进程组（`detached: true`），代价是硬约束 ③ 失效。
 *
 * ## `restart()` 的 `ok` 到底保证了什么
 * `ok: true` = 旧进程**真的退出了**（`exit` 事件已到，不是 `kill()` 返回）+ 新进程**被 OS 接受**
 * （`spawn` 事件已到）+ 过了 settle 窗口它**还没自己退出**。
 * `ok: true` **不等于服务健康**：`dist/app.js` 只有 cluster worker 才发 IPC `ready`
 * （`src/server/index.ts` 的 `isWorker` 分支），单进程模式**没有任何 ready 信号**，而监管者用
 * `stdio: inherit` 拿不到子进程的 stdout。所以「端口已在监听、配置已加载成功」在本层**无法证明**；
 * 谁在 HTTP 面上写「重启成功」，都不能把它读成「服务已恢复」。
 * settle 窗口唯一的作用是抓**启动即崩**（`MODULE_NOT_FOUND` / 配置校验 abort / EADDRINUSE，
 * 都在 spawn 后一两百毫秒内退出），它让「spawn 返回了」与「还活着」之间不隔着一整个盲区。
 *
 * ## 什么时候算「成功」由接口形状决定，不由实现心情决定
 * - `restart()` 返回 `{ ok, … }`：**它是一个成功声明**，所以 settle 失败必须报 `ok:false`。
 * - `start()` 返回 `ChildStatus`：**它是一份快照，不是声明**。故它不 settle；「起来了没有」由
 *   `status().running` 逐次真读子进程的 `exitCode`/`signalCode` 给出（已退出即 `false`）。
 *   把它做成"启动即崩就抛错"会把这个接口变成半个 `restart()`，两份声明各有一半。
 * - 并发 `restart()` **拒绝**（`{ok:false}`），不排队：两次重启叠加的结果无法解释，
 *   而调用方重试一次比拿一个含混结果便宜。
 */

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LoggerImpl } from "@/utils/logger/index.js";

/** 子进程退出后本监管者保留的那份事实；`expected` = 是我们主动要它退的。 */
export interface ChildExitInfo {
  readonly pid: number | undefined;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** true = 本监管者请求的停机；false = 它自己没的（崩溃 / 外部 kill）。 */
  readonly expected: boolean;
}

export interface ChildStatus {
  readonly running: boolean;
  /** 运行中的子进程 pid；不在运行时为 null。 */
  readonly pid: number | null;
  /** 当前这一轮启动的时刻（epoch ms）；不在运行时为 null。 */
  readonly startedAt: number | null;
  /** 当前这一轮已运行时长（ms）；不在运行时为 null。 */
  readonly uptimeMs: number | null;
  /** 成功拉起过几轮新进程（`start()` 不计数）。见文件头关于它的用途。 */
  readonly restarts: number;
  /** 退出时我们没在等它的次数：崩溃的正面证据，`restarts` 的对照项。 */
  readonly unexpectedExits: number;
  readonly lastExit: ChildExitInfo | null;
  readonly lastExitAt: number | null;
}

export type RestartResult =
  | {
      readonly ok: true;
      /** 新子进程 pid。它活着 ≠ 服务在监听（见文件头）。 */
      readonly pid: number;
      readonly previousPid: number | null;
      readonly restarts: number;
      readonly durationMs: number;
      /** settle 窗口结束时它还活着（`ok:true` 时恒 true；写出来是为了让调用方无法假装没看见这个限定）。 */
      readonly settled: boolean;
    }
  | {
      readonly ok: false;
      /** 人读的失败原因（已含 pid / 等待时长 / 退出码）。 */
      readonly error: string;
      readonly previousPid: number | null;
      readonly restarts: number;
      readonly durationMs: number;
      readonly settled: false;
    };

export interface SupervisorOptions {
  /** 被监管的入口脚本绝对路径（生产上 = {@link resolveAppJsPath} 的结果）。 */
  readonly appJsPath: string;
  readonly cwd: string;
  /** 原样透传给子进程，**不过滤、不增删**（见文件头硬约束 ②）。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: LoggerImpl;
  /**
   * 停机宽限期（ms），缺省 10000。
   * @description win32 上它是「别打断已经在排空的子进程」的等待预算；
   * POSIX 上它是 SIGTERM 之后等排空完成的预算（`restart()` 也走这条）。
   */
  readonly restartGraceMs?: number;
  /** spawn 之后抓「启动即崩」的观察窗口（ms），缺省 300。`restart()` 用。 */
  readonly settleMs?: number;
  readonly onExit?: (info: ChildExitInfo) => void;
}

export interface Supervisor {
  start(): Promise<ChildStatus>;
  stop(): Promise<void>;
  restart(): Promise<RestartResult>;
  status(): ChildStatus;
}

/** 与 `ProxyServer.stop(graceMs = 10000)` 同档：两处不同数量级就谈不上「排得干净」。 */
const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_SETTLE_MS = 300;
/** 强杀之后再等一次的窗口：进程已被 TerminateProcess，内核收尾要一点时间。 */
const FORCE_EXIT_WAIT_MS = 5_000;

const IS_WINDOWS = process.platform === "win32";

/**
 * 模块级的「监管者自己猝死时」兜底集合。
 * @description 监管者被 `kill -9` / 断电 / 一次 `process.exit()` 打断时，`stop()` 的 Promise
 * 没人等，子进程就变成占着监听端口的孤儿（下一个 manager 起来时症状是 EADDRINUSE，与「端口真被
 * 占用」无法区分）。`exit` 处理器是同步的、拿不到 Promise，故兜底动作只能是同步的 taskkill/SIGKILL。
 *
 * **进程级监听器只装一个**（装在第一次 spawn 时，且用模块级集合而不是每个 supervisor 一份）：
 * 否则一份 supervisor 的测试集会把监听器堆到 MaxListeners 警告，而那警告与真问题无关。
 */
const liveChildren = new Set<ChildProcess>();
let exitBackstopInstalled = false;

function forceKillSync(pid: number): void {
  try {
    if (IS_WINDOWS) {
      // 没有 taskkillSync；exit 处理器里等不了 Promise，只能同步等它
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // 进程已经没了 = 目标已达成，这里没有别的可做的事
  }
}

function armExitBackstop(): void {
  if (exitBackstopInstalled) {
    return;
  }
  exitBackstopInstalled = true;
  process.on("exit", () => {
    for (const child of liveChildren) {
      // exitCode 与 signalCode 都为 null 才表示「还在跑」
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        forceKillSync(child.pid);
      }
    }
  });
}

/** 异步强杀整棵进程树（win32 走 `taskkill /T /F`，其余平台走 SIGKILL，见文件头）。 */
function forceKillTree(child: ChildProcess, pid: number): Promise<void> {
  if (!IS_WINDOWS) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已经退出
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

/**
 * 推导 `dist/app.js` 的位置。
 * @description esbuild 把每个入口打成 `dist/<name>.js` 的 CJS 单文件，故 bundle 内的
 * `__dirname` 就是 `dist/`，候选 ① 命中；`tsc` 的库产物（`lib/manager/supervisor.js`）里它是
 * `lib/manager`，候选 ④ 命中仓库根的 `dist/`。两条路径都试，且**试不到就抛错并列出试过的路径** ——
 * 静默返回一个不存在的路径只会换来一次 `MODULE_NOT_FOUND`，而那条错误离真因（三层目录错了）很远。
 */
export function resolveAppJsPath(fromDir: string = __dirname): string {
  const candidates = [
    path.join(fromDir, "app.js"),
    path.join(fromDir, "..", "app.js"),
    path.join(fromDir, "..", "dist", "app.js"),
    path.join(fromDir, "..", "..", "dist", "app.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }
  throw new Error(
    `找不到被监管的代理入口 dist/app.js。已试：${candidates.join(" | ")}。` +
      "先跑 pnpm build，或显式给 SupervisorOptions.appJsPath。",
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 等待一个退出事件：它先到返回 true，定时器先到返回 false。定时器必清，不给事件循环留尾巴。 */
function raceExit(exited: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([exited.then(() => true), timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

class ChildSupervisor implements Supervisor {
  private readonly appJsPath: string;
  private readonly cwd: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly logger: LoggerImpl;
  private readonly graceMs: number;
  private readonly settleMs: number;
  private readonly onExitCb?: (info: ChildExitInfo) => void;

  private child: ChildProcess | null = null;
  /**
   * 当前这一轮的退出 Promise。
   * @description **必须在 spawn 之后同步创建**，不能等到要等它时才 `new Promise`：短命子进程
   * （配置错 → 两百毫秒内 `exit(1)`）会在我们第一个 await 之前就把事件发完，那时再挂监听就
   * 永远等不到 —— 表现为 stop/restart 永久挂死（实测踩过）。
   */
  private exitPromise: Promise<ChildExitInfo> | null = null;
  private startedAt: number | null = null;
  private restarts = 0;
  private unexpectedExits = 0;
  private lastExit: ChildExitInfo | null = null;
  private lastExitAt: number | null = null;
  /** 本监管者是否正在要求当前子进程退出（决定退出事件的 `expected`）。 */
  private expectingExit = false;
  /** 停机在飞：第二次 `stop()` 复用**同一个 Promise**，这就是幂等的机制（不是「已停过」旗标）。 */
  private stopInFlight: Promise<void> | null = null;
  /** 变更类操作（restart）在飞：并发 restart 据此拒绝，并发 stop 据此让路。 */
  private mutateInFlight: Promise<unknown> | null = null;

  constructor(options: SupervisorOptions) {
    this.appJsPath = options.appJsPath;
    this.cwd = options.cwd;
    this.env = options.env;
    this.logger = options.logger;
    this.graceMs = options.restartGraceMs ?? DEFAULT_GRACE_MS;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.onExitCb = options.onExit;
  }

  status(): ChildStatus {
    const child = this.child;
    // 「在跑」读子进程自己的 exitCode/signalCode：进程退了这两个会被填上，故这不是我们自己
    // 记的旗标，子进程猝死时它立刻为 false（旗标要等 exit 事件才更新，中间有个空窗）
    const running = child !== null && child.exitCode === null && child.signalCode === null;
    return {
      running,
      pid: running ? (child?.pid ?? null) : null,
      startedAt: running ? this.startedAt : null,
      uptimeMs: running && this.startedAt !== null ? Date.now() - this.startedAt : null,
      restarts: this.restarts,
      unexpectedExits: this.unexpectedExits,
      lastExit: this.lastExit,
      lastExitAt: this.lastExitAt,
    };
  }

  async start(): Promise<ChildStatus> {
    if (this.status().running) {
      // 已在运行就返回现状：start() 不是「重启」，那是 restart() 的事
      return this.status();
    }
    await this.spawnChild();
    return this.status();
  }

  /**
   * 停机。**故意不是 `async`**：并发两次调用必须拿到**同一个 Promise 对象**，
   * 那样「第二次不重复停一次」就是可观测的形状，而不是一句内部的 `if (flag) return`。
   * @description 幂等由「复用同一个在飞 Promise」提供。清引用也在同一条支线上完成，
   * 且必须挂 rejection handler —— 否则这里会凭空多出一个未处理拒绝。
   */
  stop(): Promise<void> {
    const existing = this.stopInFlight;
    if (existing) {
      return existing;
    }
    const task = this.doStop();
    this.stopInFlight = task;
    void task.catch(() => undefined).finally(() => {
      // 清的是在飞的那个 Promise 自己（谁在飞谁清），不留「已停过」旗标
      if (this.stopInFlight === task) {
        this.stopInFlight = null;
      }
    });
    return task;
  }

  private async doStop(): Promise<void> {
    // 有 restart 在飞时让路：否则会把「刚拉起来的新进程」当成要停的那个，
    // 而监管者正在退出 ⇒ 最终状态不可解释。等它落地再停，语义变成「重启完成后确实停住」。
    if (this.mutateInFlight) {
      await this.mutateInFlight.catch(() => undefined);
    }
    await this.terminate("stop");
  }

  async restart(): Promise<RestartResult> {
    if (this.mutateInFlight) {
      return this.failRestart(
        "已有一次 restart 在进行中，并发重启被拒绝（两次重启叠加的结果无法解释，故不排队）",
        0,
      );
    }
    const task = this.doRestart();
    this.mutateInFlight = task;
    try {
      return await task;
    } finally {
      if (this.mutateInFlight === task) {
        this.mutateInFlight = null;
      }
    }
  }

  private async doRestart(): Promise<RestartResult> {
    const began = Date.now();
    const previousPid = this.status().pid;

    try {
      await this.terminate("restart");
    } catch (err) {
      return this.failRestart(
        `停旧进程失败: ${err instanceof Error ? err.message : String(err)}`,
        Date.now() - began,
        previousPid,
      );
    }

    try {
      await this.spawnChild();
    } catch (err) {
      return this.failRestart(
        `拉起新进程失败: ${err instanceof Error ? err.message : String(err)}`,
        Date.now() - began,
        previousPid,
      );
    }

    this.restarts += 1;
    const pid = this.child?.pid ?? -1;

    if (!(await this.settle())) {
      // 起来就退了 —— 这才是「重启成功但实际没起来」的真身，如实报失败而不是把 pid 交出去
      const exit = this.lastExit;
      return this.failRestart(
        `新进程 pid=${pid} 在 ${this.settleMs}ms 内自己退出了（code=${exit?.code ?? "null"} ` +
          `signal=${exit?.signal ?? "null"}），启动即崩`,
        Date.now() - began,
        previousPid,
      );
    }

    const durationMs = Date.now() - began;
    this.logger.notice(
      "info",
      `[supervisor] restart 完成 pid=${pid} previousPid=${previousPid ?? "null"} ` +
        `restarts=${this.restarts} 用时=${durationMs}ms（注意：pid 活着不等于服务已恢复）`,
    );
    return { ok: true, pid, previousPid, restarts: this.restarts, durationMs, settled: true };
  }

  private failRestart(error: string, durationMs: number, previousPid = this.status().pid): RestartResult {
    this.logger.error(`[supervisor] restart 失败: ${error}`);
    return { ok: false, error, previousPid, restarts: this.restarts, durationMs, settled: false };
  }

  /** spawn 一个子进程并把这一轮的监听全部挂好；`spawn` 事件之前的一切失败都如实抛出。 */
  private async spawnChild(): Promise<void> {
    const child = spawn(process.execPath, [this.appJsPath], {
      cwd: this.cwd,
      // 原样透传：不加不减（硬约束 ②）
      env: this.env as Record<string, string | undefined>,
      // 子进程日志与 banner 直接落到监管者的输出，且共享控制台是 win32 唯一那条优雅路径（硬约束 ①）
      stdio: "inherit",
      // 与监管者同属一个控制台组（硬约束 ③）
      detached: false,
      windowsHide: false,
    });

    this.child = child;
    this.startedAt = Date.now();
    this.expectingExit = false;

    const exited = new Promise<ChildExitInfo>((resolve) => {
      child.once("exit", (code, signal) => {
        const info: ChildExitInfo = {
          pid: child.pid,
          code,
          signal: signal as NodeJS.Signals | null,
          expected: this.expectingExit,
        };
        liveChildren.delete(child);
        if (this.child === child) {
          this.child = null;
          this.startedAt = null;
        }
        this.lastExit = info;
        this.lastExitAt = Date.now();
        if (info.expected) {
          this.logger.notice(
            "info",
            `[supervisor] 子进程已退出 pid=${info.pid} code=${info.code} signal=${info.signal}`,
          );
        } else {
          this.unexpectedExits += 1;
          this.logger.error(
            `[supervisor] 子进程意外退出 pid=${info.pid} code=${info.code} signal=${info.signal} ` +
              `（累计 unexpectedExits=${this.unexpectedExits}）`,
          );
        }
        try {
          this.onExitCb?.(info);
        } catch (err) {
          // 回调是宿主给的观察钩子，它抛错不该改变监管者对进程状态的记账
          this.logger.error("[supervisor] onExit 回调抛错:", err);
        }
        resolve(info);
      });
    });
    this.exitPromise = exited;

    liveChildren.add(child);
    armExitBackstop();

    // `spawn` 事件 = OS 收下了这个进程（pid 已分配）。在它之前只有 `error`
    // （cwd 不存在 / execPath 没了，实测都是 error 事件 ENOENT 而不是同步抛），
    // 且 error 之后 **exit 不会来** —— 故成败必须在这里分，不能拖到等 exit 时才知道。
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        liveChildren.delete(child);
        if (this.child === child) {
          this.child = null;
          this.startedAt = null;
        }
        reject(new Error(`spawn ${this.appJsPath} 失败: ${err.message}`));
      };
      child.once("spawn", () => {
        child.removeListener("error", onError);
        resolve();
      });
      child.once("error", onError);
    });

    this.logger.notice(
      "info",
      `[supervisor] 子进程已启动 pid=${child.pid} app=${this.appJsPath} cwd=${this.cwd}`,
    );
  }

  /**
   * 停机：请求排空 → 等 → 强杀整棵树 → 再等。
   * @description `reason` 决定 win32 上**等不等**（见文件头）：`stop` 等（别打断已在进行的排空），
   * `restart` 不等（没有任何信号发出去，等下去只是白等）。
   */
  private async terminate(reason: "stop" | "restart"): Promise<void> {
    const child = this.child;
    if (!child || !this.status().running) {
      this.logger.notice("info", `[supervisor] ${reason}: 没有在运行的子进程，无需停机`);
      return;
    }
    const pid = child.pid;
    const exited = this.exitPromise;
    if (pid === undefined || !exited) {
      // 没有 pid = 进程没被 OS 接受（或已经没了），本轮没有可停的东西
      this.child = null;
      this.startedAt = null;
      this.exitPromise = null;
      return;
    }

    this.expectingExit = true;
    const began = Date.now();
    this.logger.notice("info", `[supervisor] ${reason}: 停机开始 pid=${pid}`);

    if (IS_WINDOWS) {
      // 没有可送达的信号：child.kill 是 TerminateProcess，子进程的信号处理器不执行（见文件头）
      this.logger.info(
        `[supervisor] pid=${pid}: Windows 上无法请求子进程排空，信号不会进它的处理器`,
      );
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        // 已经退出
      }
    }

    // 只有 stop 才等宽限窗口；restart 不等（理由见文件头）。
    // POSIX 上这条分支不成立：restart 在上面已经 SIGTERM 过，子进程可能正在排空，
    // 掐断它与 kill(SIGKILL) 没有区别。
    const shouldWait = reason === "stop" || !IS_WINDOWS;
    if (!shouldWait) {
      this.logger.warn(
        `[supervisor] pid=${pid} restart: 无信号可投递，无法请求排空，直接强杀整棵进程树` +
          "（数据面在途连接被掐断、账本尾部未落盘）",
      );
    } else if (await raceExit(exited, this.graceMs)) {
      this.logger.notice("info", `[supervisor] pid=${pid} 已退出（宽限 ${Date.now() - began}ms）`);
      return;
    }

    await this.killAndAwait(child, pid, exited, began);
  }

  /** 强杀整棵树（win32 走 `taskkill /T /F`），再等它落地；不落地就抛（不许谎报停机成功）。 */
  private async killAndAwait(
    child: ChildProcess,
    pid: number,
    exited: Promise<ChildExitInfo>,
    began: number = Date.now(),
  ): Promise<void> {
    // /T 是「有文档、可移植的树杀」那一档，不靠某个未查明的连带机制（见文件头）
    this.logger.warn(`[supervisor] pid=${pid} 强杀整棵进程树`);
    await forceKillTree(child, pid);
    if (await raceExit(exited, FORCE_EXIT_WAIT_MS)) {
      this.logger.notice("warn", `[supervisor] pid=${pid} 已被强杀（总用时 ${Date.now() - began}ms）`);
      return;
    }
    // 强杀之后还不退：返回「停好了」就是本仓最恨的形状（命令成功、结果没变、零信号）
    throw new Error(
      `子进程 pid=${pid} 强杀后 ${FORCE_EXIT_WAIT_MS}ms 内仍未退出（已等 ${Date.now() - began}ms）。` +
        "停机没有完成，不要把这次操作当成成功。",
    );
  }

  /** 观察窗口：抓「启动即崩」。false = 它已经退了，调用方必须当失败报。 */
  private async settle(): Promise<boolean> {
    if (this.settleMs <= 0) {
      return this.status().running;
    }
    await sleep(this.settleMs);
    return this.status().running;
  }
}

/** 造一个子进程监管者。 */
export function createSupervisor(options: SupervisorOptions): Supervisor {
  return new ChildSupervisor(options);
}