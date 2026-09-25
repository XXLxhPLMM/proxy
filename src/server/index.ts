/**
 * ProxyServer - 代理服务端编排与进程生命周期
 * 职责：按 proxyProtocol 创建 HttpProxy/HttpsProxy/TlsProxy/SocksProxy，管理启停
 */

import cluster from "node:cluster";
import { get } from "@/config/store.js";
import { initConfig } from "@/config/loader.js";
import { createAuthFromConfig } from "@/core/auth.js";
import type { PipeEvent } from "@/core/types/pipe.js";
import type {
  ProxyAuthEvent,
  ProxyClientErrorEvent,
  ProxyCore,
  ProxyForwardErrorEvent,
  ProxyForwardEvent,
  ProxyOptions,
  ProxyServerErrorEvent,
  ProxyLifecycleErrorCode,
} from "@/core/types/proxy.js";
import { createProxy as createCoreProxy } from "@/core/server/factory.js";
import { shouldRunAsMaster, runAsMaster } from "./cluster.js";
import {
  DEFAULT_SERVER_STOP_GRACE_MS,
  STOP_HARD_EXIT_FLUSH_TIMEOUT_MS,
} from "./lifecycle-budget.js";
import { logger } from "@/utils/logger.js";
import {
  logBadRequest,
  logIpDenied,
  logLoopDetected,
  logTargetDenied,
  logTargetUnresolved,
  logUpstreamError,
  logUpstreamRefused,
  logUpstreamTimeout,
} from "@/server/log/events-log.js";
import { setupProcessGuards } from "@/utils/process-guards.js";
import { getClientAddress, getAuthority } from "@/utils/ip.js";
import { printBanner } from "@/utils/banner.js";
import { logConfig } from "./log/config-log.js";

/** forwardError 日志名前缀：kind -> 函数名，Record 保证新增 kind 时编译期必补 */
const FORWARD_ERROR_LABEL: Record<ProxyForwardErrorEvent["kind"], string> = {
  http: "forwardHttp",
  tunnel: "forwardTunnel",
  upgrade: "forwardUpgrade",
};

/** debug 头 dump 的敏感头（小写）：命中一律掩码，凭证/会话绝不出现在日志 */
const SENSITIVE_HEADERS = new Set(["proxy-authorization", "authorization", "cookie"]);

/** 启动失败时不让半启动 core 或日志 flush 把调用方永久挂住。 */
const START_FAILURE_CLEANUP_TIMEOUT_MS = 1000;
/** server 自己的优雅停机窗口；runtime service deadline 独立为 15000ms。 */
const DEFAULT_STOP_GRACE_MS = DEFAULT_SERVER_STOP_GRACE_MS;
/** rollback 视图耗尽后给真实 stop/日志收口留下的最后独立预算。 */
const ROLLBACK_HARD_EXIT_DELAY_MS = 5_000;

function normalizeStopGraceMs(graceMs: number): number {
  return Number.isFinite(graceMs) && graceMs > 0
    ? Math.max(1, Math.trunc(graceMs))
    : DEFAULT_STOP_GRACE_MS;
}

/** 生命周期代际失效只允许以固定错误拒绝，禁止伪装成成功启动。 */
class ProxyStartCancelledError extends Error {
  readonly code = "ERR_PROXY_START_CANCELLED" satisfies ProxyLifecycleErrorCode;

  constructor() {
    super("Proxy start cancelled");
    this.name = "ProxyStartCancelledError";
  }
}

function isProxyStartCancelledError(error: unknown): error is ProxyStartCancelledError {
  return error instanceof ProxyStartCancelledError;
}

/** 停机 ownership 尚未释放时禁止重新进入 core.start；调用方可在 full stop 后重试。 */
class ProxyStopInProgressError extends Error {
  readonly code = "ERR_PROXY_STOP_IN_PROGRESS" satisfies ProxyLifecycleErrorCode;

  constructor() {
    super("Proxy stop is still in progress");
    this.name = "ProxyStopInProgressError";
  }
}

type CleanupFailure = {
  operation: string;
  error: unknown;
};

type BoundedResult<T> =
  { kind: "fulfilled"; value: T } | { kind: "rejected"; error: unknown } | { kind: "timeout" };

/**
 * 清理 ownership 票据：start 失败回滚与 stop 共用同一把锁。
 * 票据在清理入口同步 claim、在清理临界区退出前释放，保证任一时刻只有一个清理 owner；
 * 后到者只能排队接管，绝不与在途回滚并行 proxy.stop / flush / 释放宿主资源。
 */
type CleanupOwner = {
  kind: "start-failure" | "stop";
  generation: number;
};

/**
 * 真实 core.stop 的独立 ownership。settled 是完整 stop Promise 的结构化结果，
 * late 只表示公开/回滚等待视图已超时，不代表真实 stop 已被放弃。
 */
type CoreStopOwnership = {
  proxy: ProxyCore;
  token: symbol;
  settled: Promise<CoreStopResult>;
  result?: CoreStopResult;
  late: boolean;
  lateFailureReported: boolean;
};

type CoreStopResult = { kind: "fulfilled" } | { kind: "rejected"; error: unknown };

/** 一轮 stop 的绝对 deadline、公开等待视图与 hard-exit 计时器。 */
type StopRound = {
  token: symbol;
  startedAt: number;
  graceMs: number;
  deadline: number;
  coreStopRequired: boolean;
  coreStopTokenAtRequest: symbol | null;
  fullSettled: boolean;
  waitSettled: boolean;
  timedOut: boolean;
  waitTimer?: ReturnType<typeof setTimeout>;
  hardExitTimer?: ReturnType<typeof setTimeout>;
  hardExitArmed: boolean;
  hardExitInvoked: boolean;
  resolveWait: () => void;
  rejectWait: (error: unknown) => void;
};

/** 启动失败回滚的独立 hard-exit 票据；full cleanup settle 后必须 identity 清理。 */
type RollbackHardExit = {
  token: symbol;
  settled: boolean;
  invoked: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

/** 队列链尾吸收 settled 结果用：既不吞错误，也不把 rejection 传给下一个 owner。 */
function ignoreSettled(): void {}

/**
 * 给清理动作加硬上限；底层 Promise 仍会被观察，迟到的 rejection 不会变成
 * unhandledRejection。返回结构化结果，调用方决定如何记录，不把超时伪装成成功。
 */
async function runBounded<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<BoundedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const settled = Promise.resolve()
    .then(operation)
    .then(
      (value: T): BoundedResult<T> => ({ kind: "fulfilled", value }),
      (error: unknown): BoundedResult<T> => ({ kind: "rejected", error }),
    );

  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function cleanupAggregate(failures: CleanupFailure[]): unknown {
  const errors = failures.map(({ error }) => error);
  return errors.length === 1 ? errors[0] : new AggregateError(errors, "multiple cleanup failures");
}

function cleanupError(failures: CleanupFailure[]): Error {
  const errors = failures.map(({ error }) =>
    error instanceof Error ? error : new Error(`cleanup failed: ${String(error)}`),
  );
  return errors.length === 1 ? errors[0] : new AggregateError(errors, "multiple cleanup failures");
}

/** logger 契约是永不抛；这里再包一层，避免异常清理路径被日志器二次打断。 */
function reportCleanupFailures(scope: string, failures: CleanupFailure[]): void {
  if (failures.length === 0) {
    return;
  }
  for (const { operation, error } of failures) {
    try {
      logger.error(`[lifecycle] ${scope} cleanup ${operation} failed:`, error);
    } catch {
      // logger 失效时仍保留 aggregate 记录路径；不让日志失败跳过其它清理。
    }
  }
  if (failures.length > 1) {
    try {
      logger.error(`[lifecycle] ${scope} cleanup failures:`, cleanupAggregate(failures));
    } catch {
      // 同上：记录失败不能覆盖主错误。
    }
  }
}

/** 不替换主错误对象，只在可扩展对象上附上清理错误聚合。 */
function attachCleanupFailures(primary: unknown, failures: CleanupFailure[]): void {
  if (failures.length === 0 || (typeof primary !== "object" && typeof primary !== "function")) {
    return;
  }
  if (primary === null) {
    return;
  }
  try {
    Object.defineProperty(primary, "cleanupFailures", {
      configurable: true,
      enumerable: false,
      value: cleanupAggregate(failures),
      writable: false,
    });
  } catch {
    // 病态 Error 对象可能禁止扩展；逐项日志仍已保留清理失败。
  }
}

type SignalHandlers = {
  onSignal: () => void;
  onMessage?: (message: unknown) => void;
  hasSigbreak: boolean;
};

/**
 * 掩码敏感请求头 - debug 级 headers dump 防凭证泄漏
 * @description `proxy-authorization` / `authorization` / `cookie`（大小写不敏感，值可为数组）
 * 一律替换为 `"***"`，其余头原样保留
 * @param headers - req.headers 原文
 * @returns 掩码后的新对象（不改动入参）
 */
function maskSensitiveHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const masked: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "***" : value;
  }
  return masked;
}

/**
 * 协议工厂 - 按 store 中的 proxyProtocol 选择具体代理实现
 * 所有实现共享同一组选项：端口、鉴权提供者、上游超时、TLS 证书路径
 * （TLS 配置对 http/socks 等协议是惰性字段，仅在需要时被读取）
 */
function createProxy(isWorker = false): ProxyCore {
  const protocol = get("proxyProtocol");
  const auth = createAuthFromConfig();
  const baseOpts: ProxyOptions = {
    host: get("host"),
    port: get("port"),
    upstreamTimeout: get("upstreamTimeout"),
    tls: {
      key: get("tlsKey"),
      cert: get("tlsCert"),
      ca: get("tlsCa"),
      passphrase: get("tlsPassphrase"),
    },
    auth,
    isWorker,
  };
  return createCoreProxy(protocol, baseOpts);
}

/** ProxyServer 的进程所有权选项；库默认不替宿主杀进程，CLI 显式 opt-in。 */
export interface ProxyServerOptions {
  /**
   * 是否允许所有 server-owned `process.exit` 路径：rollback hard-exit、stop hard-exit、
   * signal graceful `exit(0)`、stop failure/二次 signal `exit(1)`。
   * 默认 false：公共库消费方只收到 stop/日志，不会被 server 杀掉；CLI 显式传 true
   * 保留进程退出兜底。cluster worker 的 IPC/message 通信不受此 gate 影响。
   */
  readonly allowProcessExit?: boolean;
}

/**
 * 代理服务端编排器 - 进程级生命周期入口
 * 职责：装配配置 -> 工厂建代理 -> 启动 -> 信号处理 -> 优雅停止
 * 与 BaseProxy 的分工：本类只管「进程与编排」，协议内部状态机由 ProxyCore 子类负责
 */
export class ProxyServer {
  /** 进程 hard-exit ownership；库默认关闭，CLI/宿主显式 opt-in。 */
  private readonly allowProcessExit: boolean;
  /** 同一实例只允许一次真正 process.exit，避免 stop/signal/rollback 竞态重复退出。 */
  private processExitRequested = false;

  constructor(options: ProxyServerOptions = {}) {
    this.allowProcessExit = options.allowProcessExit === true;
  }

  /** 当前运行的代理实例，start 成功后非空 */
  private proxy: ProxyCore | null = null;
  /** 停机防重入标记，避免多次 SIGINT 触发重复 stop */
  private shuttingDown = false;
  /** 进程 guard lease；stop/启动失败时归还，避免宿主进程残留 handler */
  private processGuardDisposer: (() => void) | null = null;
  /** 具名保存 signal/cluster IPC listener，stop 时按引用移除 */
  private signalHandlers: SignalHandlers | null = null;
  /** proxy 事件日志只绑定一次；ProxyCore 重启时复用同一实例 */
  private proxyEventsBound = false;
  private lifecycleLogBound = false;
  /** 串行化重复 start/stop，避免资源装配与清理交错 */
  private startPromise: Promise<ProxyCore> | null = null;
  /** 最近一次 start 请求的代际；已被新 stop 取消的请求不能被后续 start 复用。 */
  private startPromiseGeneration: number | null = null;
  /** 已进入 core.start 的执行；stop 只等待这一集合，不等待尚未开始的请求。 */
  private readonly activeStartExecutions = new Set<Promise<ProxyCore>>();
  /** 清理 ownership 票据；非空表示 start 失败回滚或 stop 正在独占清理。 */
  private cleanupOwner: CleanupOwner | null = null;
  /** 清理串行队列；后到的 owner 排队进入临界区，互斥不依赖任何 await 之后的再检查。 */
  private cleanupQueue: Promise<void> = Promise.resolve();
  /** 真实 core.stop 的独立 ownership；公开等待超时只改变等待视图，不释放它。 */
  private coreStopOwnership: CoreStopOwnership | null = null;
  /** 已 full settle 的同一 core stop 记录：只用于 join，不重新触发 stop；新 start/释放时清掉。 */
  private settledCoreStop: CoreStopOwnership | null = null;
  /** 完整停机 ownership；有界等待超时后仍保留到真实 core.stop 与后续清理 settle。 */
  private stopPromise: Promise<void> | null = null;
  /** 同一轮 stop 的有界公开等待视图；重复 stop 复用，不代替 full ownership。 */
  private stopWaitPromise: Promise<void> | null = null;
  /** 当前 stop 轮的绝对 deadline 与计时器；重入只收紧、不延长。 */
  private stopRound: StopRound | null = null;
  /** 已公开 timeout 且 hard-exit 已 arm 的轮次；避免 signal 失败路径重复退出。 */
  private stopHardExitRound: StopRound | null = null;
  /** 启动失败回滚的独立 hard-exit 票据；不回滚 core/guard ownership。 */
  private rollbackHardExit: RollbackHardExit | null = null;
  /** 每次 start/stop 意图递增；较新的 stop 会使在途旧 start 失效。 */
  private lifecycleGeneration = 0;
  /** listener/guard 清理失败时保留引用，下一次 start 先修复而不是误判为已绑定。 */
  private signalCleanupPending = false;
  private processGuardCleanupPending = false;

  /**
   * 代理事件日志订阅 - server/core 层只抛不记，日志收拢于此（http/https 链经此记，socks/tls 自记）
   * 订阅不分 worker：单进程与 worker 的转发日志行为一致
   */
  private bindProxyEventLogs(): void {
    const proxy = this.proxy as unknown as import("node:events").EventEmitter;
    const on = (event: string, listener: (...args: any[]) => void): void => {
      proxy.on?.(event, listener);
    };
    on("forward", ((e: ProxyForwardEvent) => {
      // 懒求值：client/target/headers 只在真正要打日志时才解析 req
      const client = getClientAddress(e.req);
      const target = getAuthority(e.req) || "-";
      const headers = e.req.headers;
      // 查询维度进结构化字段，msg 只留可读文本，避免 client/target/user 在 msg 里重复
      switch (e.kind) {
        case "http":
        case "tunnel":
        case "upgrade": {
          // 三种 kind 仅 method 有差异：tunnel 恒 CONNECT，其余取请求行方法
          const method = e.kind === "tunnel" ? "CONNECT" : (e.req.method ?? "GET");
          logger.debug(`[${e.kind}] headers`, {
            client,
            target,
            headers: maskSensitiveHeaders(headers),
            user: e.username,
          });
          logger.info("[forward]", {
            kind: e.kind,
            client,
            target,
            method,
            user: e.username,
          });
          break;
        }
        default: {
          e.kind satisfies never;
          break;
        }
      }
    }) as (...args: any[]) => void);
    on("forwardError", ((e: ProxyForwardErrorEvent) => {
      const label = FORWARD_ERROR_LABEL[e.kind] ?? "forwardUnknown";
      logger.error(`${label} error`, e.error);
    }) as (...args: any[]) => void);
    on("serverError", ((e: ProxyServerErrorEvent) => {
      logger.error(`server error (${e.host}:${e.port}):`, e.error);
    }) as (...args: any[]) => void);
    on("clientError", ((e: ProxyClientErrorEvent) => {
      logBadRequest(logger, `client error: ${e.error.message}`);
    }) as (...args: any[]) => void);
    on("auth", ((e: ProxyAuthEvent) => {
      // allow 是逐请求的常规成功（与 [forward] 成功行重复）-> debug；deny 是预期内拒绝，info 留审计
      if (e.passed) {
        logger.debug("[auth] allow", {
          user: e.user,
          client: e.client,
          target: e.target,
          tag: e.tag,
        });
      } else {
        // expected 字段已由 core 层移除，不再引用；attempted/reason 进结构化字段（undefined 自动跳过）
        logger.info("[auth] deny", {
          client: e.client,
          target: e.target,
          attempted: e.attempted,
          reason: e.reason,
        });
      }
    }) as (...args: any[]) => void);
    on("listening", ((e: { host: string; port: number }) => {
      logger.debug(`listening on ${e.host}:${e.port}`);
    }) as (...args: any[]) => void);
    on("close", (() => {
      logger.debug("server closed");
    }) as (...args: any[]) => void);
    on("pipe", ((e: PipeEvent) => {
      // 该 PipeEvent 上的查询维度统一透传为结构化字段
      const fields = { user: e.user, client: e.client, target: e.target };
      switch (e.type) {
        case "target-unresolved": {
          logTargetUnresolved(logger, e.url as string | undefined, fields);
          break;
        }
        case "loop-detected": {
          const req = e.req as { method?: string; url?: string } | undefined;
          logLoopDetected(logger, `${req?.method} ${req?.url} -> ${e.target as string}`, fields);
          break;
        }
        case "upstream-refused": {
          logUpstreamRefused(logger, e.statusLine as string, fields);
          break;
        }
        case "upstream-error": {
          // 转发层 502 的成因（TLS 校验失败 / ECONNREFUSED / DNS 等）必须落到 warn 级，
          // 否则默认分支的 debug 会把「为什么 502」淹掉
          logUpstreamError(logger, (e.message as string) ?? "upstream error", e.err, fields);
          break;
        }
        case "upstream-timeout": {
          logUpstreamTimeout(logger, (e.message as string) ?? "upstream timeout", fields);
          break;
        }
        case "route": {
          // route 事件与 [route] 行 1:1（core 在 server 模式短路处不发）；字段形态是 jq 契约、勿动
          logger.info("[route]", {
            target: e.target,
            route: e.route,
            ...(e.reason ? { reason: e.reason } : {}),
          });
          break;
        }
        case "ip-denied": {
          logIpDenied(
            logger,
            `${e.protocol as string} 客户端 ${e.client as string} 拒绝 reason=${e.reason as string}`,
            { client: e.client, reason: e.reason, protocol: e.protocol, user: e.user },
          );
          break;
        }
        case "target-denied": {
          logTargetDenied(logger, `${e.target as string} 拒绝 reason=${e.reason as string}`, {
            target: e.target,
            host: e.host,
            reason: e.reason,
            user: e.user,
            client: e.client,
          });
          break;
        }
        case "socks": {
          logger.info(e.message as string, { user: e.user, client: e.client, target: e.target });
          break;
        }
        case "debug": {
          logger.debug(e.message as string);
          break;
        }
        default: {
          (e as { type: string }).type satisfies string;
          logger.debug((e.message as string) ?? String((e as Record<string, unknown>).type));
          break;
        }
      }
    }) as (...args: any[]) => void);
  }

  /**
   * 启动流程：
   * 1) 先绑定进程信号（worker 尽早接住 master shutdown），再初始化配置
   * 2) 安装可释放的进程级容错守卫（未捕获异常仅记日志不退出）
   * 3) 打印脱敏后的配置快照（密码/密钥以 *** 代替），并对常见误配给出告警
   * 4) 工厂创建代理实例，订阅 stateChange 输出生命周期日志，随后启动并输出运行态
   *
   * start/stop 的宿主 listener 与 guard 都由同一实例持有；启动失败会归还资源，重复 start
   * 复用同一个在途 Promise，避免重复绑定。
   */
  async start(): Promise<ProxyCore> {
    // 只有当前代际仍在有效时才复用；被新 stop 取消的旧请求不能挡住新的 start。
    if (this.startPromise && this.startPromiseGeneration === this.lifecycleGeneration) {
      return this.startPromise;
    }

    // public stop 的有界等待超时不会释放底层 ownership；start 失败回滚期间同样持有 ownership。
    // 该窗口禁止碰仍 stopping 的 core，也禁止与在途回滚并行装配。
    if (
      this.stopPromise ||
      this.stopHardExitRound ||
      this.cleanupOwner ||
      this.coreStopOwnership ||
      this.proxy?.state === "stopping" ||
      (this.settledCoreStop?.proxy === this.proxy &&
        (this.proxy?.state === "error" || this.settledCoreStop.result?.kind === "rejected"))
    ) {
      throw new ProxyStopInProgressError();
    }

    // 先登记代际再进入微任务，避免同步初始化阶段与 stop 交错时出现空窗。
    const generation = ++this.lifecycleGeneration;
    this.ensureStartResultProxy();
    const resultProxy = this.proxy;
    if (!resultProxy) {
      throw new Error("start result proxy was not created");
    }
    const promise = Promise.resolve().then(() => this.startExecution(generation, resultProxy));
    this.startPromise = promise;
    this.startPromiseGeneration = generation;
    try {
      return await promise;
    } finally {
      if (this.startPromise === promise) {
        this.startPromise = null;
        this.startPromiseGeneration = null;
        // start execution 落地后才允许丢弃已停止/未启动的 core；回滚超时期间
        // coreStopOwnership 会阻断此处的 release。
        this.releaseCoreIfDiscardable(this.proxy);
      }
    }
  }

  /** 在 start 请求登记时保留一个稳定 core；取消路径不把它伪装成成功结果。 */
  private ensureStartResultProxy(): void {
    if (this.proxy) {
      return;
    }
    initConfig();
    const proxy = createProxy(cluster.isWorker === true);
    this.proxy = proxy;
  }

  /** 同步 claim 清理 ownership；已被占用说明更新一代已接管，调用方必须放弃自身清理。 */
  private claimCleanup(kind: CleanupOwner["kind"], generation: number): CleanupOwner | null {
    // 旧代 start 的 catch 一旦发现 generation 已变化，连票据都不能拿；这是
    // 「判定 + claim」无 await 间隙的同步闸门，避免 stop 接管后旧代自行 rollback。
    if (kind === "start-failure" && generation !== this.lifecycleGeneration) {
      return null;
    }
    if (this.cleanupOwner) {
      return null;
    }
    const owner: CleanupOwner = { kind, generation };
    this.cleanupOwner = owner;
    return owner;
  }

  /** identity 比对：迟到结果只能释放自己的票据，不得清掉后续 owner 的 ownership。 */
  private releaseCleanup(owner: CleanupOwner): void {
    if (this.cleanupOwner === owner) {
      this.cleanupOwner = null;
    }
  }

  /**
   * 清理串行化入口：所有 proxy.stop / logger.flush / 宿主资源释放都必须经此队列。
   * 票据在临界区退出前释放，排队者接手时 ownership 必然空闲；前一个 owner 的成败都不阻断后一个。
   * owner 为 null 时仍受队列互斥保护，只是没有标记，调用方不得据此再释放一次票据。
   * operation 必须是「完整清理」而不是有界等待视图：视图超时由调用方处理，
   * 队列与 ownership 要一直占到 operation 真正 settle。
   */
  private runCleanupExclusive<T>(
    owner: CleanupOwner | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      try {
        return await operation();
      } finally {
        if (owner) {
          this.releaseCleanup(owner);
        }
      }
    };
    const result = this.cleanupQueue.then(run, run);
    this.cleanupQueue = result.then(ignoreSettled, ignoreSettled);
    return result;
  }

  /**
   * 取得（或建立）真实 core.stop ownership。所有真实 stop 路径统一经此，
   * 绝不直接调用 proxy.stop：公开等待超时只把 ownership 标成 late，不能清 token。
   */
  private beginCoreStop(proxy: ProxyCore, late = false): CoreStopOwnership {
    const current = this.coreStopOwnership;
    if (current) {
      if (current.proxy !== proxy) {
        throw new Error("core stop ownership belongs to another proxy instance");
      }
      if (late) {
        current.late = true;
      }
      return current;
    }
    const settledOwnership = this.settledCoreStop;
    if (
      settledOwnership &&
      settledOwnership.proxy === proxy &&
      (proxy.state === "stopped" || proxy.state === "stopping")
    ) {
      // 同一 core 的真实 stop 已 full settle；后续 stop 只能 join 这份结果，不能再发一次 stop。
      if (late) {
        settledOwnership.late = true;
      }
      return settledOwnership;
    }
    // error 表示上次 stop 失败：丢弃旧 join 票据，下一次 stop 必须重新触发真实 proxy.stop。
    if (settledOwnership?.proxy === proxy) {
      this.settledCoreStop = null;
    }

    const token = Symbol("proxy-core-stop");
    let settle!: (result: CoreStopResult) => void;
    const settled = new Promise<CoreStopResult>((resolve) => {
      settle = resolve;
    });
    const ownership: CoreStopOwnership = {
      proxy,
      token,
      settled,
      late,
      lateFailureReported: false,
    };
    if (this.settledCoreStop?.proxy === proxy) {
      this.settledCoreStop = null;
    }
    // 先登记 token，再触发真实 stop；这样同步抛错与极早 settle 都不会绕过 ownership。
    this.coreStopOwnership = ownership;
    void Promise.resolve()
      .then(() => proxy.stop())
      .then(
        () => settle({ kind: "fulfilled" }),
        (error: unknown) => settle({ kind: "rejected", error }),
      );
    void settled.then((result) => this.finishCoreStop(ownership, result));
    return ownership;
  }

  /** 等待视图超时后标记当前 core stop 为迟到路径；真实 settle 仍由 ownership 消费。 */
  private markCoreStopLate(proxy: ProxyCore | null): void {
    if (proxy && this.coreStopOwnership?.proxy === proxy) {
      this.coreStopOwnership.late = true;
    }
  }

  /** 所有 ProxyServer-owned process.exit 的唯一 gate；库默认只记录，不杀宿主。 */
  private exitProcessIfOwned(code: number): boolean {
    if (this.processExitRequested) {
      return false;
    }
    if (!this.allowProcessExit) {
      try {
        logger.notice(
          "warn",
          `[shutdown] process exit(${code}) suppressed: allowProcessExit=false`,
        );
      } catch {
        // 日志器异常不能阻断宿主 signal 语义。
      }
      return false;
    }
    this.processExitRequested = true;
    try {
      process.exit(code);
      return true;
    } catch (error) {
      // 退出调用本身失败时复位，避免一次异常把后续逃生路径永久封死。
      this.processExitRequested = false;
      try {
        logger.error(`[shutdown] process exit(${code}) failed:`, error);
      } catch {
        // 日志器异常不能反向制造未处理 rejection。
      }
      return false;
    }
  }

  /**
   * 回滚视图超时后的独立 hard-exit：只认本轮 identity，绝不释放 core/cleanup/signal/guard。
   * full cleanup settle 后由 continuation 清理 timer；进程退出失败也不回滚 ownership。
   */
  private armRollbackHardExit(rollback: RollbackHardExit): void {
    if (
      this.rollbackHardExit !== rollback ||
      rollback.settled ||
      rollback.invoked ||
      rollback.timer
    ) {
      return;
    }
    if (!this.allowProcessExit) {
      try {
        logger.error(
          "[lifecycle] startup rollback hard exit disabled; rebuild ProxyServer or handle the pending rollback explicitly",
        );
      } catch {
        // 日志器异常不能阻止 ownership 继续由 full cleanup 持有。
      }
      return;
    }
    rollback.timer = setTimeout(() => {
      if (
        this.rollbackHardExit !== rollback ||
        rollback.settled ||
        rollback.invoked
      ) {
        return;
      }
      rollback.invoked = true;
      void this.finishRollbackHardExit(rollback);
    }, ROLLBACK_HARD_EXIT_DELAY_MS);
  }

  /** hard-exit 前给日志一个有界兑现窗口；窗口内若 full rollback settle 就不再退出。 */
  private async finishRollbackHardExit(rollback: RollbackHardExit): Promise<void> {
    try {
      try {
        logger.notice(
          "warn",
          `[lifecycle] startup rollback hard exit token=${String(rollback.token)}`,
        );
      } catch {
        // 日志器异常不能阻止最后的 flush/exit 兜底。
      }
      await runBounded(() => logger.flush(), STOP_HARD_EXIT_FLUSH_TIMEOUT_MS);
      if (this.rollbackHardExit !== rollback || rollback.settled) {
        return;
      }
      rollback.invoked = true;
      this.exitProcessIfOwned(1);
    } catch (error) {
      try {
        logger.error("[lifecycle] startup rollback hard exit finalize failed:", error);
      } catch {
        // last-resort 记录失败也不能释放 core/cleanup ownership。
      }
    }
  }

  /** full rollback settle 后 identity 清理 hard-exit timer。 */
  private settleRollbackHardExit(rollback: RollbackHardExit): void {
    rollback.settled = true;
    if (rollback.timer) {
      clearTimeout(rollback.timer);
      rollback.timer = undefined;
    }
    if (this.rollbackHardExit === rollback) {
      this.rollbackHardExit = null;
    }
  }

  /**
   * full settle 后按 identity 清 token，再尝试丢弃 core；不能在 token 仍存续时
   * 释放引用，否则 stopped-but-unsettled 会让新 start 绕过 stop-in-progress 闸门。
   */
  private finishCoreStop(ownership: CoreStopOwnership, result: CoreStopResult): void {
    if (this.coreStopOwnership !== ownership) {
      return;
    }
    this.coreStopOwnership = null;
    ownership.result = result;
    this.settledCoreStop = ownership;
    if (ownership.late && result.kind === "rejected") {
      this.reportLateCoreStopFailure(ownership, result.error);
    }
    this.releaseCoreIfDiscardable(ownership.proxy);
  }

  /** 迟到的 core.stop 错误没有调用方可挂载，只能在这里按 owner 身份留下明确归属。 */
  private reportLateCoreStopFailure(ownership: CoreStopOwnership, error: unknown): void {
    if (ownership.lateFailureReported) {
      return;
    }
    ownership.lateFailureReported = true;
    try {
      logger.error(
        `[lifecycle] late core stop rejected protocol=${ownership.proxy.protocol} token=${String(ownership.token)}:`,
        error,
      );
    } catch {
      // logger 失效不能阻止 ownership 清理与 core 引用回收。
    }
  }

  /**
   * 只有确认 core 已不再监听、且没有 active cleanup/stop/start ownership 时才丢弃引用。
   * identity 比对保证不会误删新一代的 core。
   */
  private releaseCoreIfDiscardable(proxy: ProxyCore | null): void {
    if (!proxy || this.proxy !== proxy) {
      return;
    }
    if (
      this.coreStopOwnership ||
      this.stopPromise ||
      this.stopHardExitRound ||
      this.cleanupOwner ||
      this.startPromise ||
      this.activeStartExecutions.size > 0
    ) {
      return;
    }
    if (proxy.state !== "stopped" && !(proxy.state === "idle" && !proxy.isRunning())) {
      return;
    }
    this.proxy = null;
    if (this.settledCoreStop?.proxy === proxy) {
      this.settledCoreStop = null;
    }
    this.proxyEventsBound = false;
    this.lifecycleLogBound = false;
  }

  /** 在执行真正 core.start 前登记 active，stop 只等待这一集合，不等待尚未开始的请求。 */
  private startExecution(generation: number, resultProxy: ProxyCore): Promise<ProxyCore> {
    let resolveExecution!: (proxy: ProxyCore) => void;
    let rejectExecution!: (error: unknown) => void;
    const execution = new Promise<ProxyCore>((resolve, reject) => {
      resolveExecution = resolve;
      rejectExecution = reject;
    });
    this.activeStartExecutions.add(execution);
    void this.startInternal(generation, resultProxy).then(
      (proxy) => {
        this.activeStartExecutions.delete(execution);
        this.releaseCoreIfDiscardable(this.proxy);
        resolveExecution(proxy);
      },
      (error: unknown) => {
        this.activeStartExecutions.delete(execution);
        this.releaseCoreIfDiscardable(this.proxy);
        rejectExecution(error);
      },
    );
    return execution;
  }

  private async startInternal(generation: number, resultProxy: ProxyCore): Promise<ProxyCore> {
    const isWorker = cluster.isWorker === true;
    if (generation !== this.lifecycleGeneration) {
      throw new ProxyStartCancelledError();
    }
    if (
      this.proxy &&
      this.signalHandlers &&
      this.processGuardDisposer &&
      !this.signalCleanupPending &&
      !this.processGuardCleanupPending &&
      !this.settledCoreStop &&
      (this.proxy.isRunning() || this.proxy.state === "running")
    ) {
      return this.proxy;
    }
    try {
      // worker 可能在配置/建代理阶段就收到 shutdown，先装 listener 避免 IPC 竞态丢失。
      this.repairPendingProcessResources();
      this.bindSignals();
      initConfig();
      if (!this.processGuardDisposer) {
        this.processGuardDisposer = setupProcessGuards();
        this.processGuardCleanupPending = false;
      }

      if (!isWorker) {
        logConfig();
      }

      let proxy = this.proxy ?? resultProxy;
      if (!proxy) {
        proxy = createProxy(isWorker);
      }
      this.proxy = proxy;
      if (!this.proxyEventsBound) {
        this.bindProxyEventLogs();
        this.proxyEventsBound = true;
      }
      if (!isWorker && !this.lifecycleLogBound) {
        const onStateChange = (next: string, prev: string): void => {
          logger.debug(`[lifecycle] state ${prev} -> ${next} protocol=${proxy?.protocol}`);
        };
        (proxy as unknown as import("node:events").EventEmitter).on?.("stateChange", onStateChange);
        this.lifecycleLogBound = true;
      }

      // stop 意图已经到达时，不再偷偷建监听；真正的 stop 会负责释放刚装配的资源。
      if (generation !== this.lifecycleGeneration) {
        throw new ProxyStartCancelledError();
      }
      // 同一 core 若要重新 start，旧的 settled stop 记录不再代表当前运行代。
      if (this.settledCoreStop?.proxy === proxy) {
        this.settledCoreStop = null;
      }
      await proxy.start();

      // start 期间到达的 stop 仍必须等 BaseProxy 的在途 start；这里只抑制 ready/横幅，
      // 让 stop 接着完成最终 stopped 状态。
      if (generation !== this.lifecycleGeneration) {
        throw new ProxyStartCancelledError();
      }
      if (isWorker) {
        process.send?.({ type: "ready", pid: process.pid });
      } else {
        const stats = proxy.getStats();
        logger.notice(
          "info",
          `proxy started: ${stats.protocol}://${stats.host}:${stats.port} running=${stats.running} state=${proxy.state}`,
        );
        printBanner();
      }
      return proxy;
    } catch (error) {
      if (isProxyStartCancelledError(error)) {
        throw error;
      }
      // generation 判定与 claim 之间没有任何 await：此刻要么已有新 stop（跳过），
      // 要么本轮独占清理。放在 catch 入口同步完成，杜绝「入口检查通过、清理途中被新 stop 接管」。
      if (generation !== this.lifecycleGeneration) {
        // 较新生命周期意图已接管清理；旧 start 即使是 EADDRINUSE 等普通错误也不能双重回滚。
        throw error;
      }
      const owner = this.claimCleanup("start-failure", generation);
      if (!owner) {
        // 已有 owner（更新一代的 stop 或同代回滚）：本轮只原样 reject，不碰 core/宿主资源。
        throw error;
      }
      let cleanupFailures: CleanupFailure[] = [];
      const rollbackView: { timedOut: boolean } = { timedOut: false };
      const rollbackProxy = this.proxy;
      try {
        // 队列里跑的必须是完整回滚：外层只等待有界视图，视图超时也不释放 owner。
        const fullCleanup = this.runCleanupExclusive(owner, () =>
          this.cleanupAfterStartFailure(rollbackView),
        );
        const view = await runBounded(() => fullCleanup, START_FAILURE_CLEANUP_TIMEOUT_MS);
        if (view.kind === "fulfilled") {
          cleanupFailures = view.value;
        } else if (view.kind === "rejected") {
          // 防御性兜底：清理实现本身异常也不能覆盖启动主错误。
          cleanupFailures = [{ operation: "rollback", error: view.error }];
        } else {
          rollbackView.timedOut = true;
          this.markCoreStopLate(rollbackProxy);
          cleanupFailures = [
            {
              operation: "rollback",
              error: new Error(
                `startup rollback did not complete within ${START_FAILURE_CLEANUP_TIMEOUT_MS}ms`,
              ),
            },
          ];
          // 完整回滚继续持有 owner/core；迟到的成功与失败都必须被消费并留下归属。
          const rollbackExit: RollbackHardExit = {
            token: Symbol("proxy-start-rollback"),
            settled: false,
            invoked: false,
          };
          this.rollbackHardExit = rollbackExit;
          // 回滚预算已经耗尽，下一轮 timer 独立 hard-exit；不触碰 core/guard/signal ownership。
          this.armRollbackHardExit(rollbackExit);
          void fullCleanup.then(
            (failures) => {
              this.settleRollbackHardExit(rollbackExit);
              reportCleanupFailures("startup failure (late)", failures);
              this.releaseCoreIfDiscardable(rollbackProxy);
            },
            (error: unknown) => {
              this.settleRollbackHardExit(rollbackExit);
              reportCleanupFailures("startup failure (late)", [{ operation: "rollback", error }]);
              this.releaseCoreIfDiscardable(rollbackProxy);
            },
          );
        }
      } catch (cleanupError) {
        cleanupFailures = [{ operation: "rollback", error: cleanupError }];
      }
      reportCleanupFailures("startup failure", cleanupFailures);
      attachCleanupFailures(error, cleanupFailures);
      throw error;
    }
  }

  /**
   * 启动失败回滚：整段运行在清理临界区内，直到真实 core.stop 与 flush 完成才释放 owner。
   * 外层回滚视图超时只会把 late 标记传给 core ownership，绝不释放 core/cleanup ownership。
   */
  private async cleanupAfterStartFailure(view: { timedOut: boolean }): Promise<CleanupFailure[]> {
    const failures: CleanupFailure[] = [];
    const proxy = this.proxy;

    // 已有 core stop ownership 时必须 join（真实 stop 未 settle）；否则用 needs-stop 判据。
    // 括号不可展平：`state !== "stopped" && (state !== "idle" || isRunning())` 才等价于“该停”。
    const joinsCoreStop = proxy !== null && this.coreStopOwnership?.proxy === proxy;
    if (
      proxy &&
      (joinsCoreStop ||
        (proxy.state !== "stopped" && (proxy.state !== "idle" || proxy.isRunning())))
    ) {
      const ownership = this.beginCoreStop(proxy, view.timedOut);
      const result = await ownership.settled;
      if (result.kind === "rejected") {
        failures.push({ operation: "proxy.stop", error: result.error });
      }
    }

    // 保持进程保护直到 flush 也有界完成，避免“摘 guard 后无限等待”。
    const flushResult = await runBounded(() => logger.flush(), START_FAILURE_CLEANUP_TIMEOUT_MS);
    if (flushResult.kind === "rejected") {
      failures.push({ operation: "logger.flush", error: flushResult.error });
    } else if (flushResult.kind === "timeout") {
      failures.push({
        operation: "logger.flush",
        error: new Error(`logger.flush timed out after ${START_FAILURE_CLEANUP_TIMEOUT_MS}ms`),
      });
    }

    // 只有真实 core.stop settle 后才会走到这里；此时才允许归还宿主资源。
    failures.push(...this.disposeProcessResources());
    return failures;
  }

  /**
   * 优雅停止 - 公开有界等待视图 + 私有 full ownership。
   * 首次调用同步捕获绝对 deadline；公开视图到点先 settle/reject，之后才 arm hard-exit。
   * 真实 core.stop 与宿主清理未 settle 前，stopPromise/guard/core ownership 一律保留。
   */
  stop(graceMs = DEFAULT_STOP_GRACE_MS): Promise<void> {
    // 重入 stop 只能拿到同一公开 Promise，不推进 generation；新 grace 只允许收紧。
    if (this.stopPromise) {
      if (this.stopRound) {
        this.tightenStopDeadline(this.stopRound, graceMs);
      }
      return this.stopWaitPromise ?? this.stopPromise;
    }

    const boundedGraceMs = normalizeStopGraceMs(graceMs);
    const startedAt = Date.now();
    const deadline = startedAt + boundedGraceMs;
    ++this.lifecycleGeneration;
    this.shuttingDown = true;

    let resolveStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    let resolveWait!: () => void;
    let rejectWait!: (error: unknown) => void;
    const waitPromise = new Promise<void>((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });
    // 同步快照本次 stop 是否必须触达 core；异步临界区不能因为 state 恰好被
    // 子类/外部改成 stopped 就跳过已经在途的真实 stop。
    const proxyAtStop = this.proxy;
    const coreStopTokenAtRequest = this.coreStopOwnership?.token ?? null;
    const coreStopRequired =
      proxyAtStop !== null &&
      (this.coreStopOwnership?.proxy === proxyAtStop ||
        (proxyAtStop.state !== "stopped" &&
          (proxyAtStop.state !== "idle" || proxyAtStop.isRunning())));
    const round: StopRound = {
      token: Symbol("proxy-stop-round"),
      startedAt,
      graceMs: boundedGraceMs,
      deadline,
      coreStopRequired,
      coreStopTokenAtRequest,
      fullSettled: false,
      waitSettled: false,
      timedOut: false,
      hardExitArmed: false,
      hardExitInvoked: false,
      resolveWait: () => resolveWait(),
      rejectWait: (error: unknown) => rejectWait(error),
    };
    this.stopPromise = promise;
    this.stopWaitPromise = waitPromise;
    this.stopRound = round;
    // 公开等待视图的 rejection 由调用方决定如何处理；这里额外挂一个消费器，
    // 避免库调用方暂时不 await 时把进程打成 unhandledRejection。
    void waitPromise.catch(() => undefined);

    // 公开等待先到点：只结束等待视图，绝不碰 full ownership，也不释放 core/guard。
    this.scheduleStopWaitTimer(round);

    void this.stopInternal(
      deadline,
      round.token,
      boundedGraceMs,
      round.coreStopRequired,
      round.coreStopTokenAtRequest,
    ).then(
      () => {
        round.fullSettled = true;
        resolveStop();
      },
      (error: unknown) => {
        round.fullSettled = true;
        rejectStop(error);
      },
    );

    // 只有 full stop settle 才能清 stopPromise/等待视图/停机标记；identity 防止迟到结果覆盖新一轮。
    void promise.then(
      () => {
        if (this.stopPromise !== promise) {
          return;
        }
        this.finishStopRound(round, promise, true);
      },
      (error: unknown) => {
        if (this.stopPromise !== promise) {
          return;
        }
        this.finishStopRound(round, promise, false, error);
      },
    );
    return waitPromise;
  }

  private stopTimeoutError(round: StopRound): Error {
    const graceMs = Math.max(1, round.deadline - round.startedAt);
    return new Error(`Proxy stop did not complete within ${graceMs}ms`);
  }

  /** 结束公开等待视图；full ownership 仍由 stopPromise 持有。 */
  private settleStopWait(round: StopRound, fulfilled: boolean, error?: unknown): void {
    if (round.waitSettled) {
      return;
    }
    round.waitSettled = true;
    if (round.waitTimer) {
      clearTimeout(round.waitTimer);
      round.waitTimer = undefined;
    }
    if (fulfilled) {
      round.resolveWait();
    } else {
      round.rejectWait(error);
    }
  }

  /** 按绝对 deadline 安排公开等待；重复 stop 收紧时可安全重排。 */
  private scheduleStopWaitTimer(round: StopRound): void {
    if (this.stopRound !== round || round.fullSettled || round.waitSettled) {
      return;
    }
    if (round.waitTimer) {
      clearTimeout(round.waitTimer);
    }
    round.waitTimer = setTimeout(() => {
      if (this.stopRound !== round || round.fullSettled || round.waitSettled) {
        return;
      }
      round.timedOut = true;
      // 公开 Promise 先 reject，hard-exit 只能排在下一轮 timer。
      this.settleStopWait(round, false, this.stopTimeoutError(round));
      this.markCoreStopLate(this.proxy);
      this.armHardExit(round);
    }, Math.max(0, round.deadline - Date.now()));
  }

  /** 重复 stop 只收紧 deadline：更长 grace 明确告警，不静默假装参数生效。 */
  private tightenStopDeadline(round: StopRound, graceMs: number): void {
    if (round.fullSettled) {
      return;
    }
    const requestedGraceMs = normalizeStopGraceMs(graceMs);
    const requestedDeadline = Date.now() + requestedGraceMs;
    if (requestedDeadline >= round.deadline) {
      if (requestedGraceMs > round.graceMs) {
        try {
          logger.notice(
            "warn",
            `[shutdown] stop grace ignored: existing deadline ${round.deadline - round.startedAt}ms is not extended by ${requestedGraceMs}ms`,
          );
        } catch {
          // 日志器异常不能阻止 stop 的 identity 收口。
        }
      }
      return;
    }
    round.deadline = requestedDeadline;
    round.graceMs = Math.max(1, requestedDeadline - round.startedAt);
    this.scheduleStopWaitTimer(round);
  }

  /** 公开等待到点后才安装 hard-exit；库默认不 arm，避免超时后误杀宿主。 */
  private armHardExit(round: StopRound): void {
    if (
      this.stopRound !== round ||
      !round.waitSettled ||
      round.fullSettled ||
      round.hardExitInvoked ||
      round.hardExitTimer
    ) {
      return;
    }
    if (!this.allowProcessExit) {
      try {
        logger.error(
          "[shutdown] stop hard exit disabled; process owner must handle the pending full stop",
        );
      } catch {
        // 日志器异常不能阻断 stop 的公开 timeout 契约。
      }
      return;
    }
    round.hardExitArmed = true;
    this.stopHardExitRound = round;
    round.hardExitTimer = setTimeout(() => {
      if (round.hardExitInvoked) {
        return;
      }
      void this.finishStopHardExit(round);
    }, Math.max(0, round.deadline - Date.now()));
  }

  /** hard-exit 前给 stop 日志一个有界 flush 窗口；timeout 后即使 full settle 迟到也必须退出。 */
  private async finishStopHardExit(round: StopRound): Promise<void> {
    try {
      try {
        logger.notice("warn", "[shutdown] 优雅停止超时，强制退出");
      } catch {
        // 日志器异常不能阻止硬退出兜底。
      }
      await runBounded(() => logger.flush(), STOP_HARD_EXIT_FLUSH_TIMEOUT_MS);
      if (round.hardExitInvoked) {
        return;
      }
      round.hardExitInvoked = true;
      this.exitProcessIfOwned(1);
      if (this.stopHardExitRound === round) {
        this.stopHardExitRound = null;
      }
    } catch (error) {
      try {
        logger.error("[shutdown] stop hard exit finalize failed:", error);
      } catch {
        // 日志器异常不能打断 full ownership。
      }
    }
  }

  /** full stop settle 后按 identity 收口；已 timeout 的 hard-exit arm 仍保留到退出。 */
  private finishStopRound(
    round: StopRound,
    promise: Promise<void>,
    fulfilled: boolean,
    error?: unknown,
  ): void {
    if (this.stopPromise !== promise) {
      return;
    }
    if (round.waitTimer) {
      clearTimeout(round.waitTimer);
      round.waitTimer = undefined;
    }
    // 公开 wait 已 timeout 时 hard-exit 已 arm，full settle 迟到也不能把它清掉；
    // 否则会留下「wait 已 reject、进程永不退出」的空洞。成功/未超时路径仍清理 timer。
    if (round.hardExitTimer && !(round.timedOut && round.hardExitArmed)) {
      clearTimeout(round.hardExitTimer);
      round.hardExitTimer = undefined;
    }
    if (!round.waitSettled && Date.now() > round.deadline) {
      // full settle 也必须服从首次捕获的绝对 deadline；已经过期就只能以 timeout 视图结束。
      round.timedOut = true;
      this.settleStopWait(round, false, this.stopTimeoutError(round));
      this.markCoreStopLate(this.proxy);
      // 与 wait timer 分支保持同一契约：公开 reject 后仍由 process owner arm hard-exit。
      this.armHardExit(round);
    } else {
      this.settleStopWait(round, fulfilled, error);
    }
    round.fullSettled = true;
    this.stopPromise = null;
    this.stopWaitPromise = null;
    this.stopRound = null;
    this.shuttingDown = false;
    // full ownership 刚落地：这是 core 引用唯一可能真正被释放的时机。
    this.releaseCoreIfDiscardable(this.proxy);
  }

  private async stopInternal(
    deadline: number,
    roundToken: symbol,
    graceMs: number,
    coreStopRequired: boolean,
    coreStopTokenAtRequest: symbol | null,
  ): Promise<void> {
    const remainingMs = (): number => Math.max(0, deadline - Date.now());
    const cleanupFailures: CleanupFailure[] = [];
    let hasFailure = false;
    let failure: unknown;

    const recordUnexpected = (operation: string, error: unknown): void => {
      cleanupFailures.push({ operation, error });
    };

    try {
      // 只等待已经进入 core.start 的执行；尚未开始的请求不会被 stopPromise 反向等待。
      const activeStarts = [...this.activeStartExecutions];
      if (activeStarts.length > 0) {
        const startWait = await runBounded(() => Promise.allSettled(activeStarts), remainingMs());
        if (startWait.kind === "timeout") {
          recordUnexpected(
            "active start wait",
            new Error("active start wait exceeded stop deadline"),
          );
        } else if (startWait.kind === "rejected") {
          recordUnexpected("active start wait", startWait.error);
        }
      }

      // 清理串行化：旧代 start 失败回滚若仍在临界区，这里排队接管而不是并行清理。
      // 票据在入队点同步取：前一个 owner 必在队列推进前释放，取不到只失去标记，互斥仍由队列保证。
      await this.runCleanupExclusive(
        this.claimCleanup("stop", this.lifecycleGeneration),
        async () => {
          try {
            // core 快照必须在临界区内读取：前一个 owner 可能刚释放、保留或等待真实 stop settle。
            const proxy = this.proxy;
            // 已有 core stop ownership 时必须 join（真实 stop 未 settle）；否则用 needs-stop 判据。
            const joinsCoreStop = proxy !== null && this.coreStopOwnership?.proxy === proxy;
            const forceCoreStop =
              coreStopRequired &&
              (coreStopTokenAtRequest === null ||
                this.coreStopOwnership?.token === coreStopTokenAtRequest);
            if (
              proxy &&
              (forceCoreStop ||
                joinsCoreStop ||
                (proxy.state !== "stopped" && (proxy.state !== "idle" || proxy.isRunning())))
            ) {
              let result: CoreStopResult;
              try {
                const ownership = this.beginCoreStop(
                  proxy,
                  this.stopRound?.token === roundToken && this.stopRound.timedOut,
                );
                result = await ownership.settled;
              } catch (error) {
                result = { kind: "rejected", error };
              }
              if (result.kind === "rejected") {
                hasFailure = true;
                failure = result.error;
                try {
                  logger.error("[shutdown] 停止代理失败:", failure);
                } catch (stopLogError) {
                  recordUnexpected("stop error log", stopLogError);
                }
              } else {
                try {
                  logger.notice("info", "[shutdown] 代理已停止");
                } catch (error) {
                  recordUnexpected("stop completion log", error);
                }
              }
            }

            const flushResult = await runBounded(() => logger.flush(), remainingMs());
            if (flushResult.kind === "rejected") {
              recordUnexpected("logger.flush", flushResult.error);
            } else if (flushResult.kind === "timeout") {
              recordUnexpected(
                "logger.flush",
                new Error(`logger.flush timed out after ${graceMs}ms`),
              );
            }
          } finally {
            try {
              // flush 有界完成或失败后才归还 listener/guard，保证保护覆盖整个停机窗口。
              cleanupFailures.push(...this.disposeProcessResources());
            } catch (error) {
              recordUnexpected("process resources", error);
            }
          }
        },
      );
    } catch (error) {
      recordUnexpected("stop orchestration", error);
    }

    reportCleanupFailures("shutdown", cleanupFailures);
    if (hasFailure) {
      // stop 的主错误必须保持对象身份；清理失败只附着记录，不替换调用方错误。
      attachCleanupFailures(failure, cleanupFailures);
      throw failure;
    }
    if (cleanupFailures.length > 0) {
      // 没有 proxy.stop 主错误时，完整暴露清理错误聚合。
      throw cleanupError(cleanupFailures);
    }
  }

  /**
   * 等待当前真实 stop ownership settle；公开 `stopWaitPromise` 超时后也不会丢 full 事实。
   * 同一轮 stop 期间重复调用复用同一 full Promise；没有在途 stop 时立即 resolve。
   * 这是库调用方等待 core 真正收口的逃生口，不会重新触发 stop 或改变 grace 语义。
   */
  waitForStopSettled(): Promise<void> {
    const stop = this.stopPromise;
    if (stop) {
      return stop;
    }
    const coreStop = this.coreStopOwnership;
    if (coreStop) {
      return coreStop.settled.then((result) => {
        if (result.kind === "rejected") {
          throw result.error;
        }
      });
    }
    return Promise.resolve();
  }

  /** 获取当前代理实例（未启动为 null），供上层查询状态或注入 */
  getProxy(): ProxyCore | null {
    return this.proxy;
  }

  private repairPendingProcessResources(): void {
    if (this.signalCleanupPending) {
      const failures = this.unbindSignals();
      if (failures.length > 0) {
        reportCleanupFailures("signal retry", failures);
        throw cleanupError(failures);
      }
    }
    if (!this.processGuardCleanupPending) {
      return;
    }
    const release = this.processGuardDisposer;
    if (!release) {
      this.processGuardCleanupPending = false;
      return;
    }
    try {
      release();
      this.processGuardDisposer = null;
      this.processGuardCleanupPending = false;
    } catch (error) {
      const failures: CleanupFailure[] = [{ operation: "process guard retry", error }];
      reportCleanupFailures("process guard retry", failures);
      throw cleanupError(failures);
    }
  }

  /** 归还本实例持有的宿主资源；每个 disposer 独立收口并返回错误。 */
  private disposeProcessResources(): CleanupFailure[] {
    const failures: CleanupFailure[] = [];
    try {
      failures.push(...this.unbindSignals());
    } catch (error) {
      this.signalCleanupPending = true;
      failures.push({ operation: "signal listeners", error });
    }

    // 即使 signal/IPC listener 移除失败，也必须归还 guard lease；失败引用保留以便下次重试。
    const release = this.processGuardDisposer;
    if (!release) {
      this.processGuardDisposer = null;
      this.processGuardCleanupPending = false;
    } else {
      try {
        release();
        this.processGuardDisposer = null;
        this.processGuardCleanupPending = false;
      } catch (error) {
        this.processGuardCleanupPending = true;
        failures.push({ operation: "process guard lease", error });
      }
    }
    return failures;
  }

  /** 按保存的具名引用逐项移除 signal/cluster IPC listener。 */
  private unbindSignals(): CleanupFailure[] {
    const handlers = this.signalHandlers;
    if (!handlers) {
      this.signalCleanupPending = false;
      return [];
    }

    const failures: CleanupFailure[] = [];
    const removals: Array<[string, (...args: any[]) => void]> = [
      ["SIGINT", handlers.onSignal],
      ["SIGTERM", handlers.onSignal],
    ];
    if (handlers.hasSigbreak) {
      removals.push(["SIGBREAK", handlers.onSignal]);
    }
    if (handlers.onMessage) {
      removals.push(["message", handlers.onMessage]);
    }
    for (const [event, listener] of removals) {
      try {
        process.removeListener(event, listener);
      } catch (error) {
        failures.push({ operation: `${event} listener`, error });
      }
    }
    if (failures.length === 0) {
      this.signalHandlers = null;
      this.signalCleanupPending = false;
    } else {
      this.signalCleanupPending = true;
    }
    return failures;
  }

  /**
   * 绑定中断信号：Ctrl+C / kill 时先优雅停机再以 0 退出
   * 首次信号走 this.stop()（排空在途连接 + flush 日志）后退出；
   * 停机进行中再次收到信号则直接强退，避免排空挂死。
   * cluster worker 场景下 Windows 无法收到 master 转发的信号，
   * 故额外监听 IPC { type: "shutdown" } 消息触发同一条停机路径
   */
  private bindSignals(): void {
    if (this.signalHandlers && !this.signalCleanupPending) {
      return;
    }
    if (this.signalHandlers && this.signalCleanupPending) {
      const failures = this.unbindSignals();
      if (failures.length > 0) {
        reportCleanupFailures("signal retry", failures);
        throw cleanupError(failures);
      }
    }

    // 优雅停机入口：幂等。信号与 master IPC 可能同时到达（同一次 Ctrl+C 的控制台广播 + IPC 扇出），
    // 重复触发不得打断排空
    const graceful = (): void => {
      if (this.shuttingDown) {
        return;
      }
      // stop() 成功才允许信号路径 exit(0)；公开等待超时是「未完成停机」，
      // 绝不能在 finally 里伪装成成功退出，交给 stop() 自己的 hard-exit(1)。
      void this.stop().then(
        () => {
          this.exitProcessIfOwned(0);
        },
        (error: unknown) => {
          try {
            logger.error("[shutdown] signal/IPC graceful stop failed:", error);
          } catch {
            // 日志器异常不能制造未处理 rejection；stop() 已记录主错误。
          }
          // 公开 timeout 后 hard-exit 已接管，signal 失败不能抢第二次 exit；
          // 未 timeout 的真实 stop 失败才由当前 owner 立即以非零收口。
          if (!this.stopHardExitRound) {
            this.exitProcessIfOwned(1);
          }
        },
      );
    };

    const onSignal = (): void => {
      // 单进程场景：停机中再次收到信号（用户二次 Ctrl+C）→ 放弃排空强退。
      // cluster worker 不做强退：worker 的信号来自控制台广播、会与 master 的 IPC 同时到达，
      // 无法区分「同一次 Ctrl+C」与用户二次按键，兜底交给 master 的 grace SIGKILL 与 stop() 自身超时
      if (this.shuttingDown && !cluster.isWorker) {
        try {
          logger.notice("warn", "[shutdown] 停机中再次收到信号，强制退出");
        } catch {
          // 日志器异常不能阻断二次信号的逃生退出。
        }
        this.exitProcessIfOwned(1);
        return;
      }
      graceful();
    };

    const onMessage = (msg: unknown): void => {
      if (
        typeof msg === "object" &&
        msg !== null &&
        (msg as { type?: string }).type === "shutdown"
      ) {
        // master 的停机指令与信号等价：只触发幂等排空，绝不强退
        graceful();
      }
    };

    const handlers: SignalHandlers = {
      onSignal,
      onMessage: cluster.isWorker ? onMessage : undefined,
      hasSigbreak: process.platform === "win32",
    };

    // 先保存引用：若安装中途失败，外层 rollback 还能再次尝试移除残留 listener。
    this.signalHandlers = handlers;
    this.signalCleanupPending = false;
    try {
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      if (handlers.hasSigbreak) {
        process.on("SIGBREAK", onSignal);
      }
      if (handlers.onMessage) {
        process.on("message", onMessage);
      }
    } catch (error) {
      // 安装中途失败时逐项回滚；一个 removeListener 抛错不能跳过其它 listener。
      this.signalCleanupPending = true;
      const cleanupFailures: CleanupFailure[] = [];
      const removals: Array<() => void> = [
        () => process.removeListener("SIGINT", onSignal),
        () => process.removeListener("SIGTERM", onSignal),
      ];
      if (handlers.hasSigbreak) {
        removals.push(() => process.removeListener("SIGBREAK", onSignal));
      }
      const onMessage = handlers.onMessage;
      if (onMessage) {
        removals.push(() => process.removeListener("message", onMessage));
      }
      for (const remove of removals) {
        try {
          remove();
        } catch (cleanupError) {
          cleanupFailures.push({ operation: "signal install rollback", error: cleanupError });
        }
      }
      reportCleanupFailures("signal install rollback", cleanupFailures);
      throw error;
    }
  }
}

/**
 * 库兼容入口 - CLI 已改由 src/runtime/bootstrap.ts 接管单进程/worker 启动
 * clusterWorkers > 1 时以 master 身份 fork 并托管 worker，否则直接启动旧 ProxyServer。
 * 单进程/worker 返回已启动的 `ProxyServer` 句柄，调用方可 `await server.stop()`；
 * master 没有本地 ProxyServer，返回 `null`，worker 管理仍由 master 完成。
 */
export async function runServer(options: ProxyServerOptions = {}): Promise<ProxyServer | null> {
  initConfig();
  if (shouldRunAsMaster()) {
    await runAsMaster({ allowProcessExit: options.allowProcessExit });
    return null;
  }
  const app = new ProxyServer(options);
  await app.start();
  return app;
}
