import { createAuthFromConfig } from "@/core/auth.js";
import type { ConfigAccessor, UserQuota } from "@/config/index.js";
import { loadAuthUsers, loadUserQuota } from "@/config/index.js";
import {
  MemoryTrafficAccount,
  quotaWindow,
  type QuotaWindow,
  type TrafficLedgerController,
  type TrafficLedgerError,
  type TrafficWindowSource,
} from "@/core/traffic/index.js";
import { JsonlTrafficLedger } from "@/core/traffic/index.js";
import type { AuthProvider } from "@/core/types/proxy.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";
import type { RuntimeServices } from "./types.js";

/**
 * 落盘账本的装配位参数（`buildDefaultServices` 的第四个形参）
 * @description
 * **这一层是「core 不读 process.env」那条铁律的兑现点**：槽位号必须由 **CLI 的 env 快照**
 * 显式传进来（`src/cli.ts:main()` → `runServer(..., workerSlot)` → `ProxyServer` →
 * `createProxyRuntime({ trafficWorkerSlot })` → 这里的 `host.slot`），谁也不许自己去读
 * `process.env`。理由与其它 config 端口同源，但在这里更硬：槽位**会被拼进文件路径**，
 * 一次「猜来源」就是一次「写错文件/读别人的账」。
 */
export interface TrafficLedgerHost {
  /**
   * cluster 注入的 worker 槽位（`PROXY_WORKER_SLOT` 的值）。**稳定序号**：单进程/库模式
   * 缺省或非法一律归一为 `"0"`，cluster worker 为 `1..N`。
   */
  readonly slot?: string;
  /**
   * 写盘/压缩失败的旁路。runtime 注入它去发 `traffic.ledger-error` 公共事件（CLI 侧由
   * `bindProxyEventLogs` 落 error 日志）。**刻意不传 logger**：日志落盘是 server 层的职责，
   * 库模式下宿主可能只订阅事件、不想要任何输出。
   */
  readonly onLedgerError?: (event: TrafficLedgerError) => void;
}

/**
 * 账号表里是否至少有一个**非全 0** 的 `quota`（= 真配了上限）
 * @description
 * 这是**落盘账本的零成本判据**（也是 `runtime.start()` 里 `quota-inert` 告警的判据，两者
 * 必须是**同一个**函数 —— 两处各写一份，迟早会出现「告警说没配、账本说配了」）。
 *
 * 全 0 的 `quota` 按契约等于「不限流」，与「没配」在语义上完全一样，故不计入。
 * 走 `loadAuthUsers`（与 `loadUserQuota` 同一条 1s 节流读取路径），启动期读一次不额外碰盘。
 * **判据是文件事实而不是配置猜测**：关鉴权 / 目录没配 都不影响「有没有人真被限流」。
 */
export function hasConfiguredQuota(
  config: ConfigAccessor,
  onFileEvent?: (event: JsonFileEvent) => void,
): boolean {
  const accounts = loadAuthUsers(config, onFileEvent);
  for (let i = 0; i < accounts.length; i++) {
    const q = accounts[i].quota;
    if (q !== undefined && (q.bytesUp > 0 || q.bytesDown > 0 || q.bytesTotal > 0)) {
      return true;
    }
  }
  return false;
}

/**
 * 装配 runtime 的默认服务。
 *
 * 默认 auth 是动态 provider：它持有传入的配置访问器，后续配置变更可被 core
 * 在请求时读到；调用方显式注入的 auth 优先，且不会为了被覆盖的默认实现多做
 * 任何装配工作。
 *
 * **默认 traffic 是内存账本**（读同一份 `users.json` 的 `quota`）：这是全项目**唯一**解析
 * 默认流量配额服务的地方——`ProxyOptions.traffic` 未注入时 core 只拿到**显式禁用档**
 * （见 `BaseProxy`），故库调用方经 `services.traffic` 注入的替身一定是原样生效的。
 * 配额解析经 `loadUserQuota` 走账号表**同一条** 1s 节流读取路径（与 `loadUserPolicy` 同一套
 * 性能论证：文件 IO 被摊薄到每文件最多 1s 一次 stat，`consume` 每 chunk 调一次也不碰盘）。
 *
 * **窗口口径（Phase 5b-1）也在这里注入**：`quotaResetHour` 是 **runtime 相位**字段，故经同一
 * `configAccessor` **现读**（闭包每次调用都取一次）——热改 `store` 立即生效、不必重启。
 * 时钟源 `Date.now` 保持默认：账本内部只用它算窗口键，且窗口滚动是**惰性**的（每次访问槽位
 * 时比对），故既不需要注入时钟、也不需要任何定时器（见 `core/traffic/memory.ts` 文件头）。
 *
 * **落盘账本（Phase 5b-2）也只在这里解析，且与默认内存账本同生共死**：调用方**显式注入**
 * `services.traffic` 时账本**一律不建**（`trafficLedger: undefined`）——替身意味着「这一本
 * 账由你管」，我们既不该把它的 delta 写进文件、也不该在它上面挂定时器。注入本类构造**零
 * 副作用**：只算出一个文件路径，目录/句柄/定时器全部由 `runtime.start()` 触发的
 * `ledger.open()` 创建。
 */
export function buildDefaultServices(
  configAccessor: ConfigAccessor,
  overrides: Partial<RuntimeServices> = {},
  onFileEvent?: (event: JsonFileEvent) => void,
  host: TrafficLedgerHost = {},
): RuntimeServices {
  const auth: AuthProvider = overrides.auth ?? createAuthFromConfig(configAccessor, onFileEvent);
  const window: TrafficWindowSource = { resetHour: () => configAccessor.get("quotaResetHour") };

  if (overrides.traffic !== undefined) {
    // 注入替身 = 这一本账归调用方：不解析默认账本、不建落盘副本、不起定时器
    return Object.freeze({ auth, traffic: overrides.traffic, trafficLedger: undefined });
  }

  const resolve = (user: string): UserQuota | undefined =>
    loadUserQuota(user, configAccessor, onFileEvent);
  const traffic = new MemoryTrafficAccount(resolve, window);

  // 落盘副本：窗口口径与判定侧**同一份**（`quotaWindow` + 现读 `quotaResetHour`），
  // 否则恢复出来的用量会算到与判定不同的窗口里。
  const ledger = new JsonlTrafficLedger({
    dir: configAccessor.get("quotaLedgerDir"),
    slot: host.slot,
    flushMs: () => configAccessor.get("quotaFlushInterval"),
    resetHour: () => configAccessor.get("quotaResetHour"),
    windowFor: (user: string): QuotaWindow => quotaWindow(resolve(user)?.window),
    enabled: () => hasConfiguredQuota(configAccessor, onFileEvent),
    onRestore: (restored) => traffic.seed(restored),
    onError: host.onLedgerError,
  });
  // 两步绑定（账本要回注恢复结果给账本的对象 → 先建对象再建账本，最后把账本挂上去）
  traffic.bindSink(ledger);

  return Object.freeze({
    auth,
    traffic,
    trafficLedger: ledger as TrafficLedgerController,
  });
}
