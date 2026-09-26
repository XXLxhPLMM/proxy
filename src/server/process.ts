/**
 * 进程策略端口——「谁拥有这个进程」的可装配声明面。
 *
 * @description
 * **这个端口回答的问题只有一个：本进程归谁管？** `ProxyServer` 侧的信号、进程守卫、
 * banner、`process.exit` 全部由它给出，`ProxyServer` 那三个方法退化成调用位。
 *
 * **为什么端口只长在 `server/` 侧（不扩到 `runtime/`）**：分界线是「谁声明拥有这个进程」。
 * `ProxyServer` = 进程壳 → exit/信号/守卫/banner 就是它的职责，做成注入位是诚实的；
 * `ProxyRuntime` = 库门面 → 继续零 `process`、零 `exit`、零 cluster。把 `forceExit` 塞进
 * runtime 选项就等于让库调用方拿到一把上膛的枪（一个 `process.exit(0)` 藏在「配置」里）。
 *
 * **两个现成实现**（否则「可拆」只是把责任踢给调用方）：
 * - {@link cliProcessPolicy}：CLI 的现状行为**逐字**保留（信号、守卫、banner、`exit`）。
 * - {@link managedProcessPolicy}：宿主已拥有进程时的诚实档（什么都不装、什么都不退）。
 *
 * 依赖纪律：本文件是 `server/` 目录里**唯一** import `./process-guards.js` 的地方（守卫安装
 * 属于策略行为，不属于 `ProxyServer`）；`banner` 的**策略侧**调用也只在这里（`cluster.ts`
 * 那个 master 汇总 banner 是另一处调用点，master 分支不归本端口管，故保持原样）。
 * `process-guards` 保持**惰性动态 import** —— import 期零副作用是硬不变量；
 * `config-log` 同理（它不是进程策略，是配置快照打印，动态 import 留在 `index.ts`）。
 */

import type { StartupPreset } from "@/runtime/index.js";
import type { LoggerImpl } from "@/utils/logger/index.js";
import { printBanner } from "./banner.js";

/**
 * 信号宿主：装信号那一侧能拿到的**全部**事实。
 *
 * @description
 * 四个成员**逐个对应装信号那一侧真实用到的那些值**（`this.stop()` /
 * `this.shuttingDown` / `this.isWorker()` / 那两行 `[shutdown]` 日志），一个不多一个不少：
 * 端口不是「把 server 整个递出去」，而是「把回调方真正需要的那几样交出去」。
 *
 * 成员语义：
 * - `gracefulStop()`：**幂等**排空（排空在途连接 + 落配额账本 + flush 日志）。返回 Promise 是因为
 *   「排空完成 → 退进程」这个次序是策略的职责（CLI 策略在 finally 里退），宿主不该替它决定。
 * - `forceStopNow()`：放弃排空立刻强退。**日志行由宿主打**（`[shutdown]` 前缀是 CLI 的落盘文本
 *   契约，不该跟着进程策略搬家），策略只拿到「退不退」这个动作。
 * - `isShuttingDown()`：停机防重入 + 「二次信号可否强退」的判据。
 * - `isWorker()`：cluster worker 的信号来自控制台广播、无法与 master 的 IPC 区分，所以
 *   **worker 永不强退**——这条规则的判据必须由宿主回答（它才知道自己是不是 worker）。
 */
export interface SignalHost {
  /** 幂等排空入口；重复触发不得打断在途排空。 */
  gracefulStop(): Promise<void>;
  /** 放弃排空、立刻强退（宿主先打 `[shutdown]` 日志，再交给策略执行退出）。 */
  forceStopNow(): void;
  /** 本进程是否正在停机。 */
  isShuttingDown(): boolean;
  /** 本进程是否按 cluster worker 运行。 */
  isWorker(): boolean;
}

/**
 * 进程策略：进程壳上全部「进程级」动作的注入位。
 *
 * @description
 * 三个可选成员 + 一个必填成员，是**故意不对称**的：
 * - 可选项全部**省略即不装**（managed 档就是三项全省），「装不装」本身就是策略的表达；
 * - `forceExit` 必填，因为**停机超时兜底在任何策略下都必须有答案**——哪怕答案是
 *   「我不接管，交给宿主」（见 {@link managedProcessPolicy}）。留成可选等于允许「超时后什么都不做」，
 *   那正是长连接把停机永久挂死的那条路。
 *
 * `installGuards` 的返回类型是 `void | Promise<void>`：CLI 策略要在**调用时**才
 * `import("./process-guards.js")`（import 期零副作用），那是 Promise；同步实现直接返回 `void`。
 *
 * ⚠️ **`installExceptionMonitor` 为什么是第四个可选成员、而不是并进 `installGuards`**：
 * 裸调 `process.on("uncaughtExceptionMonitor", …)` 既不在端口内、也不受任何幂等旗标保护
 * → `start → stop → start` 会在进程上多挂一个闭包，每个闭包持有 `this.logger`（泄漏）。
 * 并进 `installGuards` 看起来更省一个成员，但那是**换掉行为**：`installGuards` 在 `start()`
 * 的**第一步**调，而监听器现状装在**最后一步**（ready 面之后）。
 * 挪位置意味着「`runtime.start()` 抛错时监听器到底装没装」这件事变了。独立成第四个成员让
 * **调用位置逐字不动**、只把「装不装」这件事收进端口。
 */
export interface ProcessPolicy {
  /**
   * 装信号处理（SIGINT/SIGTERM/win32 SIGBREAK，worker 另加 master 的 shutdown IPC）。
   * @returns 幂等退订函数；重复调用无副作用。
   */
  readonly installSignals?: (host: SignalHost) => () => void;
  /** 装进程级容错守卫（未处理异常/rejection/warning：保活优先于 fail-fast）。 */
  readonly installGuards?: (logger: LoggerImpl) => void | Promise<void>;
  /**
   * 装 `uncaughtExceptionMonitor`（**只观察、不改变进程行为**的那一个：Node 在
   * `uncaughtException` 之前先发它，标准输出里那段 stack 就是它打出来的）。
   * @description
   * **与 `installGuards` 刻意分开**：现状它在 `ProxyServer.start()` 的**最后一步**装
   * （ready 面之后），不在 `installGuards`（第一步）里——见类型注释里「为什么不并进去」。
   *
   * **幂等由调用方的旗标保证**（`ProxyServer` 的 `exceptionMonitorDisposer`，与 `signalDisposer`
   * 同形）：重复 `start()` 不得在进程上叠加监听。端口这一侧只负责「装一次 + 给出退订函数」。
   *
   * @returns 幂等退订函数（`process.off` 按函数引用摘除，重复调用是空操作）。
   */
  readonly installExceptionMonitor?: (logger: LoggerImpl) => () => void;
  /** 就绪后打 banner（NO_COLOR 由调用方从宿主快照显式传入）。 */
  readonly printReady?: (logger: LoggerImpl, noColor: boolean) => void;
  /** 停机超时 / 二次信号的兜底：强制结束本进程。**必填**（理由见类型注释）。 */
  forceExit(code: number): void;
}

/**
 * 启动预设 + 进程策略：`StartupPreset` 的**进程侧扩展**。
 *
 * @description
 * `StartupPreset`（`@/runtime/presets.ts`）刻意**没有** `process` 字段——它是库那一侧的装配件
 * （协议 / 服务替身 / 上游连接器），而 `ProcessPolicy` 住在 `src/server/`。让库层的公开类型里
 * 出现进程层类型会留下阅读陷阱（`runtime → server` 是被禁的依赖方向），所以进程位由本文件
 * 在**允许的那一侧**补上：`server → runtime` 单向，两边都不将就。
 *
 * 取值与展开规则**一律以 `StartupPreset` 为准**（本类型只多一个可选键，不另写一份规则）。
 */
export interface ProcessStartupPreset extends StartupPreset {
  /** 本预设的进程面；省略 = 由调用方单独注入 `processPolicy` 或落到缺省档。 */
  readonly process?: ProcessPolicy;
}

/** CLI 档的强制退出：直落 `process.exit`（现状行为逐字保留）。 */
const forceExitProcess = (code: number): void => {
  process.exit(code);
};

/**
 * CLI 进程策略 —— **现状行为逐字保留**。
 *
 * @description
 * 这三条逻辑分别对应 `ProxyServer.start()`（守卫、banner、`uncaughtExceptionMonitor`）、
 * 绑信号那一步（信号、防重入、二次信号强退、worker IPC）与 `stop()`（超时 `exit(1)`）。
 * 本对象把它们整体搬过来，行为一字未改，包括那些**看起来可疑但确实必要**的细节：
 * - 首次信号 → 幂等排空 → `exit(0)`（**在 finally 里退**，保证排空失败也退）；
 * - 停机中再收信号 → 只有**单进程**才强退；worker 的信号来自控制台广播、会与 master 的 IPC
 *   同时到达，无法区分「同一次 Ctrl+C」与用户二次按键，兜底交 master 的 grace SIGKILL 与
 *   `stop()` 自身超时；
 * - worker 另挂 `message:{type:"shutdown"}`，与信号等价且**只触发幂等排空、绝不强退**。
 *
 * 退订函数是端口**额外要求**的能力（监听装上就再也不摘是「装完就算」的老形态）：端口要求返回它，
 * server 在 `stop()` 收尾时调用，因此「同一个 server 对象 stop→start→stop」不再叠加监听。
 */
export const cliProcessPolicy: ProcessPolicy = {
  installSignals: (host) => {
    // 优雅停机入口：幂等。信号与 master IPC 可能同时到达（同一次 Ctrl+C 的控制台广播 + IPC 扇出），
    // 重复触发不得打断排空
    const graceful = (): void => {
      if (host.isShuttingDown()) {
        return;
      }
      void host.gracefulStop().finally(() => forceExitProcess(0));
    };

    const onSignal = (): void => {
      // 单进程场景：停机中再次收到信号（用户二次 Ctrl+C）→ 放弃排空强退。
      // cluster worker 不做强退：worker 的信号来自控制台广播、会与 master 的 IPC 同时到达，
      // 无法区分「同一次 Ctrl+C」与用户二次按键，兜底交给 master 的 grace SIGKILL 与 stop() 自身超时
      if (host.isShuttingDown() && !host.isWorker()) {
        host.forceStopNow();
      }
      graceful();
    };

    // master 的停机指令与信号等价：只触发幂等排空，绝不强退
    const onMessage = (msg: unknown): void => {
      if (
        typeof msg === "object" &&
        msg !== null &&
        (msg as { type?: string }).type === "shutdown"
      ) {
        graceful();
      }
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    if (process.platform === "win32") {
      process.on("SIGBREAK", onSignal);
    }
    if (host.isWorker()) {
      process.on("message", onMessage);
    }

    // 幂等：`process.off` 按函数引用摘除，重复调用第二次是空操作
    return () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (process.platform === "win32") {
        process.off("SIGBREAK", onSignal);
      }
      if (host.isWorker()) {
        process.off("message", onMessage);
      }
    };
  },
  installGuards: async (logger) => {
    // 惰性 import：守卫安装是显式动作，模块顶层不得有副作用
    const { setupProcessGuards } = await import("./process-guards.js");
    setupProcessGuards(logger);
  },
  installExceptionMonitor: (logger) => {
    // ⚠️ 现状行为逐字保留：`ProxyServer.start()` 末尾那一行 `process.on` 整体搬到这里，
    // **调用位置也逐字不动**（仍在 ready 面之后的最后一步，见 `ProxyServer.start()`）。
    // 变的只有一件事：它从裸调用变成端口成员，于是**受 `ProxyServer` 的幂等旗标保护**，
    // `start → stop → start` 不再一层层叠加闭包（每个旧闭包都持有 `this.logger`）。
    const onMonitor = (err: Error): void => {
      logger.error("[monitor] 异常监控:", err);
    };
    process.on("uncaughtExceptionMonitor", onMonitor);
    // 幂等退订：按函数引用摘除，重复调用是空操作
    return () => {
      process.off("uncaughtExceptionMonitor", onMonitor);
    };
  },
  printReady: (logger, noColor) => {
    printBanner(logger, noColor);
  },
  forceExit: forceExitProcess,
};

/**
 * 受管进程策略 —— 宿主已拥有这个进程时的诚实档。
 *
 * @description
 * **它解决的真痛点**：Electron 主进程 / CLI 框架 / 测试 runner / 已有优雅停机的主服务，
 * 想用本库的代理能力时，现状下只有两条烂路：① 吞掉 banner 与配置日志（因为它们写死在
 * `start()` 里）；② 绕过整个 `server/` 层、把 `createProxyRuntime` + 自己的事件订阅 + 自己的
 * 日志接线**重写一遍**。本档让「要代理能力、不要进程副作用」变成一行注入。
 *
 * 三项全省略的语义即「不装」：不抢 SIGINT/SIGTERM（宿主自己那套优雅停机说了算）、不装
 * uncaughtException/unhandledRejection/warning 守卫（宿主多半已经有了，再装一份只会让日志
 * 翻倍）、不打 banner（宿主的窗口/终端自己有标题栏）。**`uncaughtExceptionMonitor` 同样不装**
 * （第四个可选成员省略即不装）——它只影响标准输出里那段 stack 由谁打，宿主自己那份进程级
 * 诊断一定已经在打了。**「装不装」由策略说了算**：`managed` 档选择不装 —— 这是本端口
 * **唯一**一处两种实现行为面不同的地方（理由：它只决定异常 stack 由谁
 * 打进 stderr，而「不拥有进程」的前提正意味着那份诊断归宿主；两个策略各装一份只会让同一段
 * stack 出现两次）。
 *
 * ⚠️ **代价：停机超时不能变成永久挂死。** `forceExit` 的实现是「打一条警告说明本策略不接管
 * 退出、交给宿主」——因为 `process.exit` 在这个前提下**根本不归我们叫**。于是：嵌入方若不
 * 自己兜底，一条长连接会让 `stop()` 一直挂着（`ProxyServer.stop()` 的 grace 定时器到点后只发
 * 这条警告就返回，事件循环被活着的 socket 撑着不退出）。**那是「进程所有权在宿主」这个前提的
 * 必然代价，不是 bug**：要强退就写 `managed: { ...managedProcessPolicy, forceExit: (c) => process.exit(c) }`
 * —— 显式覆盖永远比「库偷偷替你退进程」诚实。
 */
export const managedProcessPolicy: ProcessPolicy = {
  forceExit: (code) => {
    process.emitWarning(
      `managedProcessPolicy 收到强制退出请求（exit=${code}），但本策略不拥有本进程：信号、进程守卫与 banner 全部交给宿主。停机会一直挂到宿主自己收尾为止——若宿主不兜底，长连接会让 stop() 永不返回；要强退请显式覆盖 forceExit。`,
      "ProxyManagedProcess",
    );
  },
};

/**
 * CLI 预设 —— 「库默认件的完整组装」。
 *
 * @description
 * 这个函数是**「CLI 就是库预设的一次组装」这个命题的代码落点**：CLI 相对纯库调用方多出来的
 * 东西只有一条 —— **它拥有这个进程**，所以整份预设里只有 `process` 一个字段非空；协议、身份 /
 * 访问控制 / 流量配额服务、上游连接器全部走库默认件（缺省由 `createProxyRuntime` 的
 * `buildDefaultServices` 与 `createConnectorSource` 解析）。
 *
 * **刻意不钉 `protocol`**：CLI 的入站协议是**配置事实**（`proxyProtocol`，argv/env 都能改），
 * 预设里写死一份会让 `--protocol` 覆盖失效——那是「预设压过显式配置」的第二真相源。
 * 同理不钉 `services`/`connectors`：那份库已经能解析出正确的默认，钉一份只会多一处要同步的副本。
 */
export function cliPreset(): ProcessStartupPreset {
  return {
    name: "cli",
    description: "库默认件 + CLI 进程策略（拥有进程：信号/守卫/banner/退出）",
    process: cliProcessPolicy,
  };
}
