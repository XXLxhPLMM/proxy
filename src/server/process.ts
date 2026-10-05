/**
 * 进程策略端口——「本进程归谁管」的可装配声明面。
 *
 * `ProxyServer` 的信号、进程守卫、banner、`process.exit` 全部由本端口给出，
 * `ProxyServer` 那三个方法退化成调用位。
 *
 * 成员：`installSignals?` / `installGuards?` / `installExceptionMonitor?` / `printReady?`
 * 四项**省略即不装**，`forceExit` 必填。两个实现：`cliProcessPolicy` 拥有本进程（信号 / 守卫 /
 * banner / 退出），`managedProcessPolicy` 把这些交给宿主。
 *
 * 边界：本端口只存在于 `server/` 侧；`ProxyRuntime` 保持零 `process`、零 `exit`。
 *
 * `process-guards` 与 `log/config-log` 走惰性动态 import（import 期零副作用），形态与理由见
 * `tests/library/entry.test.ts`。
 */

import type { StartupPreset } from "@/runtime/index.js";
import type { LoggerImpl } from "@/utils/logger/index.js";
import { printBanner } from "./banner.js";

/**
 * 信号宿主：装信号那一侧能拿到的**全部**事实，逐个对应，不多不少。
 *
 * - `gracefulStop()`：**幂等**排空（排空在途连接 + 落配额账本 + flush 日志）。返回 Promise 是
 *   因为「排空完成 → 退进程」这个次序是策略的职责（CLI 策略在 finally 里退）。
 * - `forceStopNow()`：放弃排空立刻强退。**日志行由宿主打**（`[shutdown]` 前缀是 CLI 的落盘文本
 *   契约，不该跟着进程策略搬家），策略只拿到「退不退」这个动作。
 * - `isShuttingDown()`：停机防重入 + 「二次信号可否强退」的判据。
 */
export interface SignalHost {
  gracefulStop(): Promise<void>;
  forceStopNow(): void;
  isShuttingDown(): boolean;
}

/**
 * 进程策略：进程壳上全部「进程级」动作的注入位。
 *
 * @description
 * 三个可选成员 + 一个必填成员，是**故意不对称**的：可选项全部**省略即不装**（managed 档就是
 * 三项全省），「装不装」本身就是策略的表达；`forceExit` 必填，因为**停机超时兜底在任何策略下
 * 都必须有答案**——哪怕答案是「我不接管，交给宿主」（见 {@link managedProcessPolicy}）。留成可选
 * 等于允许「超时后什么都不做」，那正是长连接把停机永久挂死的那条路。**它是该端口唯一必填成员。**
 *
 * `installGuards` 的返回类型是 `void | Promise<void>`：CLI 策略要在**调用时**才
 * `import("./process-guards.js")`（import 期零副作用），那是 Promise；同步实现直接返回 `void`。
 *
 * ⚠️ **独立成第四个成员，不要并进 `installGuards`**：`installGuards` 在 `start()` 的第一步
 * 调，本监听器装在最后一步（ready 面之后），并进去会改变「`runtime.start()` 抛错时它装没装」。
 */
export interface ProcessPolicy {
  /**
   * 装信号处理（SIGINT/SIGTERM/win32 SIGBREAK）。
   * @returns 幂等退订函数；重复调用无副作用。
   */
  readonly installSignals?: (host: SignalHost) => () => void;
  /** 装进程级容错守卫（未处理异常/rejection/warning：保活优先于 fail-fast）。 */
  readonly installGuards?: (logger: LoggerImpl) => void | Promise<void>;
  /**
   * 装 `uncaughtExceptionMonitor`（**只观察、不改变进程行为**的那一个：Node 在
   * `uncaughtException` 之前先发它，标准输出里那段 stack 就是它打出来的）。
   * @description
   * **与 `installGuards` 刻意分开**（位置理由见类型注释）；**幂等由调用方的旗标保证**
   * （`ProxyServer` 的 `exceptionMonitorDisposer`，与 `signalDisposer` 同形）：重复 `start()`
   * 不得在进程上叠加监听。端口这一侧只负责「装一次 + 给出退订函数」。
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
 * `StartupPreset`（`@/runtime/presets.ts`）**没有** `process` 字段——它是库那一侧的装配件，
 * 而 `ProcessPolicy` 住在 `src/server/`；库层公开类型里出现进程层类型会留下阅读陷阱
 * （`runtime → server` 是被禁的依赖方向），所以进程位由本文件在**允许的那一侧**补上。
 * 取值与展开规则**一律以 `StartupPreset` 为准**（本类型只多一个可选键）。
 */
export interface ProcessStartupPreset extends StartupPreset {
  /** 本预设的进程面；省略 = 由调用方单独注入 `processPolicy` 或落到缺省档。 */
  readonly process?: ProcessPolicy;
}

/** CLI 档的强制退出：直落 `process.exit`。 */
const forceExitProcess = (code: number): void => {
  process.exit(code);
};

/**
 * CLI 档进程策略 —— 本进程归本策略所有。
 *
 * - 首次信号 → 幂等排空 → `exit(0)`，**在 finally 里退**（排空失败也退）；
 * - 停机中再收信号（用户二次 Ctrl+C）→ 放弃排空强退。
 *
 * `install*` 都返回幂等退订函数：server 在 `stop()` 收尾时调用，因此同一对象
 * `stop → start → stop` 不叠加监听。
 */
export const cliProcessPolicy: ProcessPolicy = {
  installSignals: (host) => {
    // 优雅停机入口：幂等。重复触发（同一次 Ctrl+C 的信号 + 断连重放）不得打断排空
    const graceful = (): void => {
      if (host.isShuttingDown()) {
        return;
      }
      void host.gracefulStop().finally(() => forceExitProcess(0));
    };

    const onSignal = (): void => {
      // 停机中再次收到信号（用户二次 Ctrl+C）→ 放弃排空强退
      if (host.isShuttingDown()) {
        host.forceStopNow();
      }
      graceful();
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    if (process.platform === "win32") {
      process.on("SIGBREAK", onSignal);
    }

    // 幂等：`process.off` 按函数引用摘除，重复调用第二次是空操作
    return () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (process.platform === "win32") {
        process.off("SIGBREAK", onSignal);
      }
    };
  },
  installGuards: async (logger) => {
    // 惰性 import：守卫安装是显式动作，模块顶层不得有副作用
    const { setupProcessGuards } = await import("./process-guards.js");
    setupProcessGuards(logger);
  },
  installExceptionMonitor: (logger) => {
    // 装在 `ProxyServer.start()` 的最后一步（ready 面之后）。退订函数是必需的：
    // 裸调 `process.on` 会让 `start → stop → start` 每轮在进程上多挂一个持有 `this.logger`
    // 的闭包。
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
 * 受管进程策略 —— 进程归宿主，四个可选成员全省略，即不抢信号、不装守卫、不打 banner、
 * 不装 `uncaughtExceptionMonitor`。
 *
 * ⚠️ **代价：停机超时不会变成强退。** `forceExit` 只发一条 `process.emitWarning`：本策略不拥有
 * 本进程，`process.exit` 归宿主叫。嵌入方不自己兜底时，一条长连接会让 `ProxyServer.stop()`
 * 的 grace 定时器到点后只发这条警告就返回，事件循环被活着的 socket 撑着不退出。
 * 要强退就显式覆盖：
 * `{ ...managedProcessPolicy, forceExit: (c) => process.exit(c) }`。
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
 * CLI 预设 —— 库默认件 + CLI 进程策略。整份预设只有 `process` 一个字段非空：入站协议是配置
 * 事实（`proxyProtocol`，argv/env 都能改），身份 / 访问控制 / 流量配额服务与上游连接器全部走库
 * 默认件（由 `createProxyRuntime` 的 `buildDefaultServices` 与 `createConnectorSource` 解析）。
 */
export function cliPreset(): ProcessStartupPreset {
  return {
    name: "cli",
    description: "库默认件 + CLI 进程策略（拥有进程：信号/守卫/banner/退出）",
    process: cliProcessPolicy,
  };
}
