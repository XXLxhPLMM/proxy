import type { ConfigContext } from "@/config/index.js";
import type { AppConfig } from "@/config/index.js";
import type { EventHub } from "@/core/events/index.js";
import type { TrafficAccount, TrafficLedgerController } from "@/core/traffic/index.js";
import type { AuthProvider, ProxyCore, ProxyOptions, ProxyStats } from "@/core/types/proxy.js";
import type { Logger } from "@/utils/logger/index.js";

/** 库用户可覆盖的运行时服务（逐步扩展：access / routing / forwarding / errors）。 */
export interface RuntimeServices {
  readonly auth: AuthProvider;
  /**
   * 每用户流量配额服务。缺省 = 内存账本（现读 `users.json` 的 `quota`），在本目录
   * `services.ts:buildDefaultServices` 里解析——**全项目唯一**做这件事的地方。
   */
  readonly traffic: TrafficAccount;
  /**
   * `traffic` 的**落盘副本**（Phase 5b-2）：`runtime.start()` 开、`stop()` 收。
   *
   * **缺省即 undefined，且它与「默认内存账本」同生共死**：调用方显式注入 `services.traffic`
   * 时本字段恒为 undefined（那一本账归调用方管，我们不写它的文件、不给它起定时器）。
   * 没有配任何非全 0 `quota` 时 `open()` 会走**零成本档**（不建目录/不开句柄/不起定时器），
   * 但本字段**非 undefined** —— 「有没有账本对象」与「账本有没有真的启用」是两个问题，
   * 观测面靠 `open()` 之后的 `ledger.enabled` 回答。
   */
  readonly trafficLedger?: TrafficLedgerController;
}

interface ProxyRuntimeCommonOptions {
  /** 依赖注入：覆盖任意服务；不传则用当前 context 的默认实现。 */
  services?: Partial<RuntimeServices>;
  /** 外部事件总线；不传则 runtime 自建一个（每 runtime 独立）。 */
  events?: EventHub;
  /** 日志端口；不传则 createNoopLogger()（零副作用、零落盘）。 */
  logger?: Logger;
  /** 启动期告警回调（如 mTLS 配了但证书读不到），库模式不打印只回调。 */
  onWarning?: (w: RuntimeWarning) => void;
  /**
   * **流量配额账本的槽位号**（Phase 5b-2）。
   *
   * **它必须是显式参数，且 `runtime/**` 绝不读 `process.env`**：槽位会被拼进账本文件名
   * （`worker-<slot>.jsonl`），「自己猜来源」意味着「写错文件 / 读别人的账」。传递链是
   * `cli.ts` 的 env 快照 → `runServer(..., workerSlot)` → `ProxyServer` → 本选项 →
   * `services.ts` → `core/traffic/ledger.ts`。env 名 `PROXY_WORKER_SLOT` 的**唯一写入方**是
   * `server/cluster.ts` 的 fork（`core → server` 是被禁方向，所以这一环天然在 core 之外）。
   *
   * 省略 = 单进程/库模式（归一为 `"0"`）。非法值（非 `1..9999` 纯数字）同样归一为 `"0"`
   * —— 槽位会拼进文件路径，非数字内容一律按**路径穿越面**拒绝（见 `normalizeSlot`）。
   */
  trafficWorkerSlot?: string;
}

/**
 * runtime 构造来源二选一：
 * - `context`：直接复用 `await loadConfig()` 返回的 live store/accessor；
 * - `config`/`preset`：纯内存模式，runtime 内部新建私有 ConfigStore，不读任何来源；
 *   可传 `configDir` 作为所有相对路径的锚点（省略时仅捕获构造瞬间的 cwd）。
 */
export type ProxyRuntimeOptions = ProxyRuntimeCommonOptions &
  (
    | { context: ConfigContext; config?: never; preset?: never; configDir?: never }
    | { context?: never; config?: Partial<AppConfig>; preset?: string; configDir?: string }
  );

/** 启动期非控制流告警。 */
export interface RuntimeWarning {
  code: string;
  message: string;
}

/** 库运行时的公开门面。 */
export interface ProxyRuntime {
  readonly runtimeId: string;
  /** 本 runtime 的配置上下文；context 模式与调用方共享 store，纯内存模式由 runtime 自建。 */
  readonly context: ConfigContext;
  readonly events: EventHub;
  readonly logger: Logger;
  readonly services: Readonly<RuntimeServices>;
  readonly options: Readonly<Required<ProxyOptions>>;
  /** 幂等。 */
  start(): Promise<void>;
  /** 幂等；排空连接 + 释放事件订阅，绝不退出宿主进程。 */
  stop(): Promise<void>;
  isRunning(): boolean;
  getStats(): ProxyStats;
  /** 已构建的协议核心；start 前后都可取（供高级用户订阅内部事件）。 */
  getProxy(): ProxyCore;
}
