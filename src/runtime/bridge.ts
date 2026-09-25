/**
 * @fileoverview core 内部事件 → 公共 `AppEventMap` 事件的桥接器
 * @module runtime/bridge
 * @description
 * `createProxyRuntime()` 原先只桥接了 `stateChange`（发 `runtime.*` / `lifecycle.changed`），
 * core 的 `auth` / `pipe` 事件从未进入公共 `EventHub`：库用户 `runtime.events.subscribe("auth.decided", …)`
 * 永远收不到东西。本文件把 core 事实翻译成公共事件补齐这条观察面。
 *
 * 边界（与 `src/server/index.ts:bindProxyEventLogs` 的区别）：
 * - server 侧是**日志面**（core 事件 → JSONL 落盘），本文件是**库事件面**（core 事件 → `AppEventMap`），
 *   两者互不 import、各自演进；本文件**不改** `bindProxyEventLogs`。
 * - 桥接是**纯观察**：`attach()` 之后 core 的 emit 行为、返回值与异常语义一字不变。
 *
 * 本波映射契约（core 事件 → 公共事件）：
 * - `auth` → `auth.decided`：`{ passed, user, attempted, reason }`
 * - `pipe: ip-denied` → `access.client-denied`：`{ client, reason }`
 * - `pipe: target-denied` → `access.target-denied`：`{ host, target, reason }`
 * - `pipe: route` → `route.selected`：`{ mode, route, reason? }`
 * - `pipe: target-unresolved` → `request.rejected`：`{ stage: "parse", reason: "target-unresolved" }`
 *
 * 本桥仍**刻意不桥接**（终态 publisher 已由 ErrorBoundary 负责，core 事件保持低层语义）：
 * - `forward`：它是「开始转发」信号，与 `request.completed`（终态事实）是两件事；本波不把它误译成完成，
 *   也不新增 `request.started`，保持公共契约最小。
 * - `forwardError` / `serverError` / `clientError`：不直接桥接；请求级 rejected/failed 由协议 guard 经
 *   本文件的 ErrorBoundary publisher 发布，避免低层错误事件重复成为公共终态。
 * - `pipe` 其余 10 个变体（`upstream-refused` / `upstream-error` / `upstream-timeout` / `loop-detected` /
 *   `socks` / `bad-request` / `dial` / `established` / `client-error` / `debug`）：转发与握手的内部细节，
 *   公共契约里没有对应形状（`request.failed` 需要 `stage` 语义），硬翻译只会造出半真事件。
 *
 * `requestId` / `connectionId` 本波**不生成**：core 当前没有 request 作用域概念（`EventContext` 的作用域
 * 由 `EventScope` 体系提供），要按请求串起 `auth → route → 转发终态` 需要先在 core 侧引入请求作用域，
 * 属于后续改造，桥接器不臆造 id。
 *
 * 零副作用：不读 env/文件、不注册 `process` 事件、不打日志、不碰 CLI 通道。
 */

import type http from "node:http";
import type { AclReason, EventContext, EventHub, EventSubscription } from "@/core/events/index.js";
import { ErrorBoundary } from "@/core/error-boundary.js";
import {
  registerRequestTerminalPublisher,
  requestTerminalSettled,
  type RequestTerminalPublisher,
} from "@/core/request-terminal.js";
import type {
  PipeEvent,
  PipeEventBase,
  ProxyAuthEvent,
  ProxyEventMap,
  ProxyProtocol,
} from "@/core/types/proxy.js";
import { getAuthority, getClientAddress } from "@/utils/ip.js";

/** 桥接器本波订阅的 core 事件名：只有这两个有公共事件契约。 */
export type BridgeableCoreEventName = "auth" | "pipe";

type BridgeablePayload<K extends BridgeableCoreEventName> = ProxyEventMap[K] extends [infer Data]
  ? Data
  : never;

/**
 * BaseProxy 的窄化强类型 emitter 端口。
 *
 * @description `BaseProxy extends EventEmitter<ProxyEventMap>`，但 `ProxyCore` 的公共接口刻意不暴露
 * EventEmitter（与 `src/runtime/runtime.ts:StatefulProxy`、`src/server/index.ts:ProxyEventSource` 同一手法）。
 * 这里只声明本桥接器订阅的两个事件，事件名与 payload 全部由 `ProxyEventMap` 派生：不用 `any`、
 * 不做字符串索引，调用点只需一次 `as unknown as` 窄化。
 */
export interface NodeEventEmitterWithProxyEvents {
  on<K extends BridgeableCoreEventName>(
    name: K,
    listener: (data: BridgeablePayload<K>) => void,
  ): unknown;
  off<K extends BridgeableCoreEventName>(
    name: K,
    listener: (data: BridgeablePayload<K>) => void,
  ): unknown;
  /** BaseProxy 的配置访问器；仅用于把协议终态接到当前 runtime 的公共 hub。 */
  options?: { readonly config?: object };
}

/** 桥接器构造选项。 */
export interface CoreEventBridgeOptions {
  /** 公共事件总线：桥接结果全部发布到这里（库用户只通过 `runtime.events` 观察）。 */
  hub: EventHub;
  /** 协议，写进每个事件的 context（core 事件本身不带协议维度）。 */
  protocol: ProxyProtocol;
  /** 把 core 事件里 `req` 的 client 提取注入；缺省 `getClientAddress`（XFF → X-Real-IP → Forwarded → socket）。 */
  extractClient?: (req: http.IncomingMessage) => string;
  /** 把 core 事件里 `req` 的 target 提取注入；缺省 `getAuthority`（CONNECT 取 url，其余取 Host）。 */
  extractTarget?: (req: http.IncomingMessage) => string | undefined;
}

/** 公共契约要求必填、而 core 事件可能缺失的 client 哨兵（沿用 `getSocketAddress` 的 "unknown" 约定）。 */
const UNKNOWN_CLIENT = "unknown";

/** 从 pipe 事件里提取的身份维度（缺失即 undefined，不臆造）。 */
interface PipeIdentity {
  client?: string;
  user?: string;
  target?: string;
  requestId?: string;
  connectionId?: string;
}

/** 空串视为缺失：core 的 `getAuthority` 会返回 ""，它不是合法 target。 */
function present(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * 名单原因只认 acl 的闭合集合。
 *
 * `src/core/access-control.ts:AclReason` 只有 `whitelist | blacklist`；缺失或非名单语义一律返回 undefined，
 * 由调用方**跳过发布**——拒绝事实宁可不发，也不臆造成 `blacklist`。
 */
function aclReason(raw: string | undefined): AclReason | undefined {
  return raw === "whitelist" || raw === "blacklist" ? raw : undefined;
}

/** `PipeEventBase.req` 声明为 `unknown`；这里只按「有 headers 的对象」收窄成 IncomingMessage。 */
function asIncomingMessage(value: unknown): http.IncomingMessage | undefined {
  if (typeof value !== "object" || value === null || !("headers" in value)) {
    return undefined;
  }
  return value as http.IncomingMessage;
}

/**
 * core 事件 → 公共 `AppEventMap` 的观察桥。
 *
 * 生命周期：`attach(proxy)` 挂上 core 监听 → 之后 core 每次 emit 都被翻译并发布到 hub →
 * `subscription.dispose()`（幂等）解绑全部 core 监听并停止发布。
 */
export class CoreEventBridge {
  /** 全部 core 监听的统一解绑点；`attach()` 返回的也是它。 */
  public readonly subscription: EventSubscription;

  private readonly hub: EventHub;
  private readonly protocol: ProxyProtocol;
  private readonly extractClient: (req: http.IncomingMessage) => string;
  private readonly extractTarget: (req: http.IncomingMessage) => string | undefined;
  private readonly boundary: ErrorBoundary;
  private readonly unbind: Array<() => void> = [];
  /** 独立状态对象：聚合订阅的 `disposed` getter 需要在对象字面量里读到它（不 alias `this`）。 */
  private readonly state: { disposed: boolean } = { disposed: false };

  public constructor(options: CoreEventBridgeOptions) {
    this.hub = options.hub;
    this.protocol = options.protocol;
    this.extractClient = options.extractClient ?? getClientAddress;
    this.extractTarget = options.extractTarget ?? getAuthority;
    this.boundary = new ErrorBoundary({
      hub: this.hub,
      context: { protocol: this.protocol },
    });

    const state = this.state;
    this.subscription = {
      get disposed(): boolean {
        return state.disposed;
      },
      dispose: (): void => {
        this.detach();
      },
    };
  }

  /**
   * 订阅一个 `ProxyCore`（Node EventEmitter）的 core 事件，翻译后发布到 hub。
   *
   * @description 纯观察：不改 core 的 emit 行为，也不吞 core 的异常。已 dispose 后调用是安全空操作
   * （不重新挂监听），避免留下僵尸监听器。
   * @param proxy - core 事件源（`BaseProxy` 窄化视图）
   * @returns 统一解绑点（与 `this.subscription` 同一个对象）
   */
  public attach(proxy: NodeEventEmitterWithProxyEvents): EventSubscription {
    if (this.state.disposed) {
      return this.subscription;
    }
    this.observe(proxy, "auth", (event) => this.onAuth(event));
    this.observe(proxy, "pipe", (event) => this.onPipe(event));

    const config = proxy.options?.config;
    if (config !== undefined) {
      this.unbind.push(
        registerRequestTerminalPublisher(config, this.protocol, this.createTerminalPublisher()),
      );
    }
    return this.subscription;
  }

  /** 解绑全部 core 监听；幂等，dispose 之后不再发布任何事件。 */
  private detach(): void {
    if (this.state.disposed) {
      return;
    }
    this.state.disposed = true;
    for (const unbind of this.unbind.splice(0)) {
      try {
        unbind();
      } catch {
        // 退订失败不应阻断 stop/重试，也不能让解绑路径变成抛错路径。
      }
    }
  }

  /**
   * 挂一个 core 监听并登记退订。
   *
   * @description 回调体整体 try/catch：`EventHub` 已隔离单个 listener 的异常，但桥接器自身
   * （提取函数、身份组装、发布）也不能把观察者的异常带回 core 的鉴权/转发主流程。
   */
  private observe<K extends BridgeableCoreEventName>(
    proxy: NodeEventEmitterWithProxyEvents,
    name: K,
    handle: (event: BridgeablePayload<K>) => void,
  ): void {
    const listener = (event: BridgeablePayload<K>): void => {
      if (this.state.disposed) {
        return;
      }
      try {
        handle(event);
      } catch {
        // 桥接是旁路观察：core 主流程的语义优先于事件翻译。
      }
    };
    proxy.on(name, listener);
    this.unbind.push(() => {
      proxy.off(name, listener);
    });
  }

  /**
   * 构造 core 终态发布器。
   *
   * rejected/failed 经过 ErrorBoundary，保留分类、脱敏与观察者隔离；completed 没有
   * ErrorBoundary 对应入口，直接发布既有 AppEventMap 事件。无 HTTP 状态的 SOCKS
   * 拒绝不伪造 status，按公共契约省略该字段。
   */
  private createTerminalPublisher(): RequestTerminalPublisher {
    return {
      completed: (status, context) => {
        try {
          const data = status === undefined ? {} : { status };
          this.hub.publish("request.completed", data, this.terminalContext(context));
        } catch {
          // 公共观察面故障不能改变协议收尾。
        }
      },
      rejected: (reason, stage, status, context) => {
        if (status === undefined) {
          try {
            this.hub.publish("request.rejected", { stage, reason }, this.terminalContext(context));
          } catch {
            // 公共观察面故障不能改变协议收尾。
          }
          return;
        }
        this.boundary.rejectRequest(reason, stage, status, this.terminalContext(context));
      },
      failed: (error, stage, context) => {
        this.boundary.failRequest(error, stage, this.terminalContext(context));
      },
    };
  }

  /** 公共事件恒带协议；其它身份维度由协议层按实际已知事实补齐。 */
  private terminalContext(context: Partial<EventContext>): Partial<EventContext> {
    return { ...context, protocol: context.protocol ?? this.protocol };
  }

  /** `auth` → `auth.decided`（core 已给出 client/target，无需再解析 req） */
  private onAuth(event: ProxyAuthEvent): void {
    this.hub.publish(
      "auth.decided",
      {
        passed: event.passed,
        user: event.user,
        attempted: event.attempted,
        reason: event.reason,
      },
      this.contextOf({
        client: present(event.client),
        user: present(event.user),
        target: present(event.target),
        requestId: present(event.requestId),
        connectionId: present(event.connectionId),
      }),
    );
  }

  /** `pipe` 按 `type` 分发；未映射变体在 `default` 里显式列出并穷尽收口。 */
  private onPipe(event: PipeEvent): void {
    const identity = this.identityOf(event);
    switch (event.type) {
      case "ip-denied": {
        const reason = aclReason(event.reason);
        if (reason === undefined) {
          // 缺 reason 无法判定命中哪张名单：不臆造成 blacklist，放弃本次发布。
          return;
        }
        this.hub.publish(
          "access.client-denied",
          { client: identity.client ?? UNKNOWN_CLIENT, reason },
          this.contextOf(identity),
        );
        return;
      }
      case "target-denied": {
        const reason = aclReason(event.reason);
        const host = present(event.host);
        if (reason === undefined || host === undefined) {
          // reason 决定名单语义、host 是公共契约必填项：任一缺失都不足以复述这次拒绝。
          return;
        }
        this.hub.publish(
          "access.target-denied",
          { host, target: present(event.target) ?? host, reason },
          this.contextOf(identity),
        );
        return;
      }
      case "route": {
        this.hub.publish(
          "route.selected",
          { mode: event.mode, route: event.route, reason: present(event.reason) },
          this.contextOf(identity),
        );
        return;
      }
      case "target-unresolved": {
        // 真实 HTTP 请求会先由 RequestTerminal 抢占终态；这里只给没有 guard 关联的
        // 历史/fake core 事件保留旧桥接语义，避免一个请求同时收到两个 rejected。
        if (requestTerminalSettled(event.req)) {
          return;
        }
        this.hub.publish(
          "request.rejected",
          { stage: "parse", reason: "target-unresolved" },
          this.contextOf(identity),
        );
        return;
      }
      default: {
        // 本波刻意不桥接的 10 个变体：转发/握手内部细节，等 ForwardPlan 与 ErrorBoundary 收口。
        // 显式列出而非留空，是为了新增变体时仍在编译期强制表态。
        switch (event.type) {
          case "upstream-refused":
          case "upstream-error":
          case "upstream-timeout":
          case "loop-detected":
          case "socks":
          case "bad-request":
          case "dial":
          case "established":
          case "client-error":
          case "debug":
            return;
          default:
            event satisfies never;
            return;
        }
      }
    }
  }

  /**
   * 身份维度：事件自带字段优先，缺失时回落到注入的 `req` 提取器。
   *
   * @description 多数 pipe 变体（route / target-denied / upstream-*）只带 `target`/`user`，
   * `req` 只有部分变体携带；提取只在发布前对已映射变体按需发生。
   */
  private identityOf(event: PipeEventBase): PipeIdentity {
    const req = asIncomingMessage(event.req);
    const identity: PipeIdentity = {};
    const client =
      present(event.client) ?? (req === undefined ? undefined : present(this.extractClient(req)));
    if (client !== undefined) {
      identity.client = client;
    }
    const target =
      present(event.target) ?? (req === undefined ? undefined : present(this.extractTarget(req)));
    if (target !== undefined) {
      identity.target = target;
    }
    const user = present(event.user);
    if (user !== undefined) {
      identity.user = user;
    }
    // 请求/连接标识由协议入口注入事件载荷（handleForward 的逐请求事件槽 / socks 会话），
    // 缺失即不带：core 直构（无入口注入）或旧式 core 事件没有该维度。
    const requestId = present(event.requestId);
    if (requestId !== undefined) {
      identity.requestId = requestId;
    }
    const connectionId = present(event.connectionId);
    if (connectionId !== undefined) {
      identity.connectionId = connectionId;
    }
    return identity;
  }

  /**
   * 事件 context：`runtimeId` + `protocol` 恒在，身份维度有才带。
   *
   * @description `requestId` / `connectionId` 取自事件载荷（协议入口注入），
   * 使 `auth.decided` / `route.selected` 等 mid-flight 事件与 `request.completed` 终态共享 requestId。
   */
  private contextOf(identity: PipeIdentity): Partial<EventContext> {
    const context: Partial<EventContext> = {
      runtimeId: this.hub.runtimeId,
      protocol: this.protocol,
    };
    if (identity.client !== undefined) {
      context.client = identity.client;
    }
    if (identity.user !== undefined) {
      context.user = identity.user;
    }
    if (identity.target !== undefined) {
      context.target = identity.target;
    }
    if (identity.requestId !== undefined) {
      context.requestId = identity.requestId;
    }
    if (identity.connectionId !== undefined) {
      context.connectionId = identity.connectionId;
    }
    return context;
  }
}
