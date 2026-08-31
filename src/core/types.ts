/**
 * 代理核心共享类型
 * 职责：定义所有代理实现共同遵守的契约，保持 core 层类型一致
 */

/**
 * 支持的代理协议 - 双端生效，需同时约束客户端握手与服务端监听
 * - http:  客户端用 HTTP 明文（GET http://host/ + Host）及 CONNECT host:port 建隧道；服务端用 http.Server 解析 request/connect
 * - https: 客户端先 TLS 握手再发 HTTP/CONNECT（隧道路由与 http 一致）；服务端在 http 之上叠加 tls 证书
 * - socks: 客户端按 SOCKS5（RFC1928）帧（VER/CMD/ATYP）发起；服务端按 SOCKS5 握手后透传 TCP
 * - tls:   客户端与服务端均需 mTLS 双向证书，握手成功后透传原始 TCP，不解析应用层
 * 该类型与 src/config/store.ts 的 ProxyProtocol 同源，由 get("proxyProtocol") 驱动工厂选择
 */
export type ProxyProtocol = "http" | "https" | "socks" | "tls";

/**
 * 代理通用启动选项
 * 说明：所有 Proxy 实现均通过此选项初始化，不直接读取 process.env，
 *       由上层（如 src/config/store.ts 的 get("port")）显式注入，保持可测试性
 */
export interface ProxyOptions {
  /** 监听端口，未传则由 BaseProxy 归一为 3000 */
  port?: number;
  /** 监听地址，未传则归一为 0.0.0.0（全网卡） */
  host?: string;
  /** 可选鉴权提供者，未传则默认 AllowAll（始终通过），由 BaseProxy 持有 */
  auth?: import("./auth.js").AuthProvider;
  /** 上游超时 ms，默认 10000 */
  upstreamTimeout?: number;
  /** TLS 配置，https/socks/tls 时由上层注入，避免 core 直读 store */
  tls?: { key?: string; cert?: string; ca?: string; passphrase?: string };
}

/**
 * 代理运行态统计快照
 * 用途：供管理面（manager）或日志输出展示当前实例状态
 */
export interface ProxyStats {
  /** 实例所属协议 */
  protocol: ProxyProtocol;
  /** 实际监听端口 */
  port: number;
  /** 实际监听地址 */
  host: string;
  /** 是否处于 listening 状态 */
  running: boolean;
  /** 最近一次 start() 成功的时间戳（毫秒），未启动或已停止则为 undefined */
  startedAt?: number;
}

/**
 * 生命周期状态机 - 显式描述服务从创建到销毁的每个阶段
 * - idle:     初始态，未调用 start
 * - starting: 正在执行 onBeforeStart -> start
 * - running:  已完成 onStarted，处于 listening
 * - stopping: 正在执行 onBeforeStop -> stop
 * - stopped:  已完成 onStopped，可重入 start
 * - error:    启动/运行期异常，需人工介入或重试
 */
export type LifecycleState = "idle" | "starting" | "running" | "stopping" | "stopped" | "error";

/**
 * 生命周期钩子 - 供 BaseProxy 及上层 ProxyApp 编排
 * 每个钩子均为可选异步，异常会使状态机进入 error 并向上抛出
 */
export interface Lifecycle {
  /** start 前置：校验配置/加载证书/预热资源 */
  onBeforeStart?(): Promise<void>;
  /** start 后置：注册路由/探针/日志 */
  onStarted?(): Promise<void>;
  /** stop 前置：优雅排空/拒绝新连接 */
  onBeforeStop?(): Promise<void>;
  /** stop 后置：清理资源/重置状态 */
  onStopped?(): Promise<void>;
}

/**
 * 代理核心接口 - 所有代理实现必须满足的最小行为集合
 * 设计要点：
 * - 仅约束生命周期与可观测性，不约束内部转发细节，子类可自由选择 http/net/tls 实现
 * - 返回 Promise 以支持异步建服（如 TLS 证书异步加载）
 * - 继承 Lifecycle，子类可覆盖钩子实现定制化初始化
 */
export interface ProxyCore extends Lifecycle {
  /** 协议标识，只读，由子类构造时确定 */
  readonly protocol: ProxyProtocol;
  /** 归一化后的启动选项，只读 */
  readonly options: Required<ProxyOptions>;
  /** 当前生命周期状态 */
  readonly state: LifecycleState;
  /** 启动服务，幂等：已在运行则直接返回；内部按 beforeStart->start->started 推进状态机 */
  start(): Promise<void>;
  /** 停止服务，幂等：未运行则直接返回；内部按 beforeStop->stop->stopped 推进状态机 */
  stop(): Promise<void>;
  /** 是否正在监听 */
  isRunning(): boolean;
  /** 获取运行态快照 */
  getStats(): ProxyStats;
}
