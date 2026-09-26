import type {
  AclSource,
  LifecycleState,
  PipeEvent,
  ProxyForwardKind,
  ProxyProtocol,
} from "@/core/types/proxy.js";
import type { ConfigKey } from "@/config/index.js";
import type { TrafficDirection, TrafficScope } from "@/core/traffic/index.js";

/** 事件关联上下文：runtime 必填，connection/request 作用域可选 */
export interface EventContext {
  runtimeId: string;
  connectionId?: string;
  requestId?: string;
  protocol?: ProxyProtocol;
  client?: string;
  user?: string;
  target?: string;
  /**
   * 客户端请求方法（入站 HTTP 方法原文，如 `GET`/`POST`/`CONNECT`）。
   *
   * 与 `user`/`target` 同属「跨事件复用的身份维度」：日志面要还原 `[forward]` 行的 method，
   * 而事件载荷里刻意不携带原始 `IncomingMessage`（它带 socket 与全部请求头），故方法单独走 context。
   * SOCKS 等无 HTTP 方法的入口不带此维度。
   */
  method?: string;
}

/** 从事件参数元组取出的实际 payload 类型；无参数事件为 undefined。 */
export type EventData<K extends keyof AppEventMap> = AppEventMap[K] extends [data: infer Data]
  ? Data
  : undefined;

/** 事件信封：事件名、关联上下文、事实数据和发布时间。 */
export interface EventEnvelope<K extends keyof AppEventMap = keyof AppEventMap> {
  readonly name: K;
  readonly context: EventContext;
  readonly data: EventData<K>;
  readonly timestamp: number;
}

export type EventListener<K extends keyof AppEventMap> = (e: EventEnvelope<K>) => void;

/** 事件名联合 */
export type EventName = keyof AppEventMap;

export interface AppEventMap {
  "runtime.starting": [data: { host: string; port: number; protocol: ProxyProtocol }];
  "runtime.started": [data: { host: string; port: number; protocol: ProxyProtocol }];
  "runtime.stopping": [];
  "runtime.stopped": [];
  "runtime.error": [data: { error: unknown }];
  /**
   * 运行时依赖被换掉：配置访问器 / 日志端口 / 事件总线三者之一（`kind` 标明是哪一件）。
   *
   * 消费者据此重新绑定依赖（例如把注入到组件里的 logger 换成新实例）。事件在**交换完成
   * 之后**由新的事件总线发布，同一实例重复设置不发布（幂等无噪音）。
   */
  "runtime.dependencies-changed": [data: { kind: "config" | "logger" | "events" }];
  "lifecycle.changed": [data: { next: LifecycleState; prev: LifecycleState }];
  "config.loaded": [data: { source: string }];
  "config.changed": [data: { keys: ConfigKey[] }];
  "config.restart-required": [data: { keys: ConfigKey[] }];
  "config.file-error": [data: { path: string; error: unknown }];
  "config.file-recovered": [data: { path: string }];
  "config.file-reloaded": [data: { path: string }];
  "auth.decided": [
    data: { passed: boolean; user?: string; attempted?: string; reason?: string; tag?: string },
  ];
  "access.client-denied": [data: { client: string; reason: AclReason }];
  /**
   * 目标被名单拒绝。
   *
   * `source` 是**可选增量契约**（Phase 4b）：`"global"` = 全局 `acl.json` 拒的，
   * `"user"` = 该用户 `users.json` 的个人名单拒的。缺失即「来源未知」，消费方不得臆造。
   * 不加它运维看到 403 无法判断该改 `acl.json` 还是 `users.json`。
   * `reason` 仍**只有** `whitelist|blacklist` 两值——分层信息绝不塞进 `reason`
   * （桥接器的 `aclReason` 只认闭合集合，表外值会**静默丢掉整条事件**）。
   */
  "access.target-denied": [
    data: { host: string; target: string; reason: AclReason; source?: AclSource },
  ];
  "route.selected": [
    data: { mode: "server" | "client"; route: "direct" | "upstream"; reason?: string },
  ];
  /**
   * 请求开始转发（准入三关全过、即将委派给 forwarder）。
   *
   * 这是**唯一的非终态请求级事件**：没有它，server 模式直连 + 关闭鉴权的部署下公共事件面
   * 只剩终态，长连接/慢上游场景无法判断请求卡在哪一步。`kind` 标明通道（http/tunnel/upgrade），
   * 身份维度走 context，按 `requestId` 与终态事件串联。
   */
  "request.started": [data: { kind: ProxyForwardKind }];
  "request.completed": [data: { status?: number }];
  "request.rejected": [data: { stage: RequestStage; status?: number; reason?: string }];
  "request.failed": [data: { stage: RequestStage; error: unknown }];

  /**
   * 每用户流量配额耗尽（`users.json` 的 `quota` 被突破），传输已被**硬切**。
   *
   * 这是**新公共契约**而非 pipe 细节：运维需要「谁、在哪个方向、撞了哪个上限、已用多少」
   * 来决定扩容还是加额度，而那四个数在落盘日志行里是人读的文本、不是可订阅的事实。
   *
   * 字段纪律：
   * - `user` **必填**（type 层收口）：无身份即不计量，所以这条事件**不可能**在无鉴权部署上出现；
   *   写成可选就等于允许消费方处理「配额是谁的」这个答不出来的问题。
   * - `scope` 是**被突破的那个上限**（`bytesUp` / `bytesDown` / `bytesTotal` 三者之一），
   *   与 `dir`（本次流动的方向）**刻意是两个维度**：一次下载可以撞上 `total`，
   *   两者相同纯属巧合，合并就丢了「是哪个上限」这个归因信息。
   * - `usage` / `limit` 照实给出（`usage` 可能**大于** `limit`：账本不截断到上限，见
   *   `core/traffic/memory.ts`），消费方可以据此算出「超了多少」。
   * - 身份维度 `user` 同时进 `EventContext`（与 `auth.decided` / `access.*` 同源）。
   */
  "traffic.quota-exceeded": [
    data: {
      user: string;
      dir: TrafficDirection;
      scope: TrafficScope;
      usage: number;
      limit: number;
    },
  ];
  /**
   * 流量配额账本**写盘/压缩失败**（Phase 5b-2）。
   *
   * 字段与 `config.file-error` 同形（`{ path, error }`）——它们是**同一类事实**：
   * 「某个本该持久的文件此刻不可写」。共用形状让消费方一套处理逻辑覆盖两处。
   *
   * **为什么必须有这条事件，而不是静默重试或直接失败**：
   * - 静默 = 运维以为配额持久化了，磁盘满了几天后重启才发现用量全丢（比不落盘更坏：
   *   不落盘是**已知**的降级，静默是**被误导**的降级）。
   * - 直接失败 = 「磁盘满 → 代理拒服务」。配额是增强功能，不该有能力打垮数据面。
   * 正确形态只有一种：**内存计数继续走 + 未落盘 delta 累积留待下次重试 + 一条可见事实**。
   *
   * `error` 是**原始异常**（消费方据此区分 `EACCES` 与 `ENOSPC`）；`path` 是出问题的账本
   * 文件（`<quotaLedgerDir>/worker-<slot>.jsonl`），运维据此知道该修哪个文件/哪个目录。
   */
  "traffic.ledger-error": [data: { path: string; error: unknown }];

  // -------------------------------------------------------------------------
  // core 直发事实（Phase 1.3a）
  // -------------------------------------------------------------------------
  // core（`core/server/*`）不再经自带 EventEmitter 中转，直接把已发生的请求期/服务期事实
  // 发布到注入的 `EventHub`。身份维度一律走 `EventContext`，payload 只留「本条事实独有的维度」。

  /** 转发委派阶段抛错（`handleForward` 的 catch）：通道 + 原始异常。请求级 failed 仍由终态守卫发。 */
  "forward.error": [data: { kind: ProxyForwardKind; error: unknown }];
  /**
   * 诊断细节事实：掩码后的入站请求头快照（`[{kind}] headers` 那行 debug 日志的数据来源）。
   *
   * 与 `pipe` 同级——**不是公共契约的一部分**，只为还原改造前那条 debug 级头 dump。
   * 掩码由 core 在 publish **之前**完成（`proxy-authorization` / `authorization` / `cookie`
   * 一律替换为 `"***"`），故原始凭证绝不允许跨进事件总线；`req` / `IncomingMessage`
   * 也绝不进入任何事件载荷（它带 socket 与全部请求头）。
   * 发布时机在 `request.started` **之前**，以保持落盘行序与改造前一致（headers 行在前）。
   */
  "forward.request-headers": [data: { kind: ProxyForwardKind; headers: Record<string, string> }];
  /** 底层服务 error（http/tls/net.Server 的 `error`）：错误 + 监听地址。 */
  "server.error": [data: { error: Error; host: string; port: number }];
  /** 客户端畸形请求（`clientError`）：core 已就地回 400 并结束 socket，此处只报错误本身。 */
  "server.client-error": [data: { error: Error }];
  /** 监听就绪：core 不打日志，CLI 落 `listening on host:port` debug 行。 */
  "server.listening": [data: { host: string; port: number }];
  /** 服务关闭：core 不打日志，CLI 落 `server closed` debug 行。 */
  "server.closed": [];
  /**
   * 管道/转发事实（`PipeEvent` 判别联合**原样**透传，14 变体一字不改）。
   *
   * 这是 CLI 日志面与库观察面共用的唯一通道：`data` 即 `PipeEvent`，消费方按 `type` 穷尽分派。
   * 身份维度（`user`/`requestId`/`connectionId`）由协议入口注入到 `PipeEvent` 自身字段，
   * 同时也带在 `EventContext` 上——两者同源，不是两套事实。
   */
  "pipe": [data: PipeEvent];
}

/**
 * 名单原因：命中黑名单 / 不在白名单内
 * @description 与 `src/core/access-control.ts:AclReason` **同形**（本模块另写一份是因为
 * 事件契约不得反向依赖判定层；改判定层那一处必须同步这里，否则事件面会出现半个旧联合）。
 * `acl/blacklist` 这类**分层前缀写法一律禁止**：桥接器的 `aclReason` 只认闭合集合。
 */
export type AclReason = "whitelist" | "blacklist";
export type RequestStage = "parse" | "auth" | "access" | "route" | "dial" | "forward" | "stream";
