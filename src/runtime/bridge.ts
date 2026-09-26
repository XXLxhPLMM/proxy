/**
 * @fileoverview core 管道事实 → 公共 `AppEventMap` 事件的桥接器
 * @module runtime/bridge
 * @description
 * Phase 1.3a 之后 core **直接**把请求期事实发布到注入的 `EventHub`，`auth.decided` 与
 * `request.started` 都不再需要桥接。本文件因此缩到只剩一件事：把 `pipe` 的三个公开形状
 * 翻译成对应的公共事件。
 *
 * 边界（与 `src/server/index.ts:bindProxyEventLogs` 的区别）：
 * - server 侧是**日志面**（core 事实 → JSONL 落盘），本文件是**库事件面**（`pipe` → `AppEventMap`），
 *   两者互不 import、各自演进。
 * - 桥接是**纯观察**：`attach()` 之后 core 的发布行为、返回值与异常语义一字不变。
 *
 * 本波映射契约（`pipe` → 公共事件，3 条，无其它）：
 * - `pipe: ip-denied` → `access.client-denied`：`{ client, reason }`
 * - `pipe: target-denied` → `access.target-denied`：`{ host, target, reason, source? }`
 * - `pipe: route` → `route.selected`：`{ mode, route, reason? }`
 *
 * **本文件已不再桥接**的事实（core 自己直接发，桥一遍只会重复）：
 * - `auth` → `auth.decided`：`BaseProxy.authorize` 直接发布 `auth.decided`
 *   （`{ passed, user, attempted, reason, tag }`，身份维度进 context）。
 * - `forward` → `request.started`：`core/server/http.ts:handleForward` 直接发布
 *   `{ kind }`（唯一的非终态请求级事件），身份维度进 context。
 * - `forwardError` / `serverError` / `clientError` → `forward.error` / `server.error` /
 *   `server.client-error`：core 直发；请求级 rejected/failed 仍由协议 guard 经本文件的
 *   ErrorBoundary publisher 发布，避免低层错误事件重复成为公共终态。
 * - `pipe: target-unresolved`：**曾经**桥成 `request.rejected(stage:"parse")`，现已删除。协议入口
 *   （`core/forward/channel/http.ts`）在发这条 pipe 事件前就已经 `requestTerminal.reject(..., "parse", 400)`，
 *   终态 publisher 会发布那唯一的一条 `request.rejected`；再桥一遍只会在同一请求上重复发布，
 *   过去靠「反查请求是否已结算」去重，现在那条去重通路（`requestTerminalSettled`）也一并删掉。
 * - `pipe` 其余 10 个变体（`upstream-refused` / `upstream-error` / `upstream-timeout` / `loop-detected` /
 *   `socks` / `bad-request` / `dial` / `established` / `client-error` / `debug`）：转发与握手的内部细节，
 *   公共契约里没有对应形状（`request.failed` 需要 `stage` 语义），硬翻译只会造出半真事件。
 *
 * `requestId` / `connectionId` **不由本文件生成**，只从 pipe 事件载荷读取（`core/scope-ids.ts` 在协议入口
 * 注入 id，`identityOf` 负责带出）：core 直构（无入口注入）时缺失即不带，桥接器不臆造 id。终态 publisher
 * 则沿用 `RequestTerminal` 传入的作用域，因此 `route.selected` / `access.*` 与
 * `request.completed|rejected|failed` 能按同一 requestId 串成一条完整链。
 *
 * 零副作用：不读 env/文件、不注册 `process` 事件、不打日志、不碰 CLI 通道。
 */

import type http from "node:http";
import type { AclReason, EventContext, EventHub, EventSubscription } from "@/core/events/index.js";
import type { CoreContext } from "@/core/context.js";
import { ErrorBoundary } from "@/core/error-boundary.js";
import {
  registerRequestTerminalPublisher,
  type RequestTerminalPublisher,
} from "@/core/request-terminal.js";
import type { PipeEvent, PipeEventBase, ProxyProtocol, AclSource } from "@/core/types/proxy.js";
import { getAuthority, getClientAddress } from "@/utils/ip.js";

/** 桥接器构造选项。 */
export interface CoreEventBridgeOptions {
  /** 公共事件总线：桥接结果全部发布到这里（库用户只通过 `runtime.events` 观察）。 */
  hub: EventHub;
  /** 协议，写进每个事件的 context（pipe 事件载荷本身不带协议维度）。 */
  protocol: ProxyProtocol;
  /** 把 pipe 事件里 `req` 的 client 提取注入；缺省 `getClientAddress`（XFF → X-Real-IP → Forwarded → socket）。 */
  extractClient?: (req: http.IncomingMessage) => string;
  /** 把 pipe 事件里 `req` 的 target 提取注入；缺省 `getAuthority`（CONNECT 取 url，其余取 Host）。 */
  extractTarget?: (req: http.IncomingMessage) => string | undefined;
}

/** 公共契约要求必填、而 pipe 事件可能缺失的 client 哨兵（沿用 `getSocketAddress` 的 "unknown" 约定）。 */
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
 *
 * **这也是 `reason` 绝不许写成 `"user:blacklist"` 的原因**：那会让 `aclReason` 返回 undefined，
 * `access.target-denied` **静默不发布**——安全事实凭空消失。分层信息走独立的 `source` 字段。
 */
function aclReason(raw: string | undefined): AclReason | undefined {
  return raw === "whitelist" || raw === "blacklist" ? raw : undefined;
}

/**
 * 拒绝来源只认两个判定层（Phase 4b）；其它值/缺失一律 undefined（消费方不写该键）
 * @description 与 `aclReason` 同一「缺失即不臆造」纪律：`source` 是可选增量字段，
 * 判不出的来源**宁可不带**（订阅者据此知道「未知」），也不倒填成 `"global"`——
 * 倒填会把「个人名单拒的」伪装成「全局拒的」，运维去改错文件。
 */
function aclSource(raw: string | undefined): AclSource | undefined {
  return raw === "global" || raw === "user" ? raw : undefined;
}

/** `PipeEventBase.req` 声明为 `unknown`；这里只按「有 headers 的对象」收窄成 IncomingMessage。 */
function asIncomingMessage(value: unknown): http.IncomingMessage | undefined {
  if (typeof value !== "object" || value === null || !("headers" in value)) {
    return undefined;
  }
  return value as http.IncomingMessage;
}

/**
 * core 管道事实 → 公共 `AppEventMap` 的观察桥。
 *
 * 生命周期：`attach(ctx)` 在 core 的依赖上下文上订阅 `pipe` → 之后 core 每次发布都被翻译并
 * 发布到 hub → `subscription.dispose()`（幂等）解绑该订阅并停止发布。
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
   * 接到 core 的依赖上下文上，订阅它当前那条事件总线上的 `pipe` 事实并接上请求终态 publisher。
   *
   * @description 纯观察：不改 core 的发布行为，也不吞 core 的异常。已 dispose 后调用是安全空操作
   * （不重新挂监听），避免留下僵尸监听器。
   *
   * 总线取 `ctx.events` 而**不是**构造时的 `options.hub`：`RuntimeContext` 可以在运行期换总线
   * （`setEvents`），core 发布时读的也是 `ctx.events`。两者不一致会让「core 发新总线、桥接听旧总线」
   * ——事件静默丢失。退订时用**订阅那一刻**的 hub 实例，不用 hub 字段，故换总线也不会退错。
   *
   * accessor 取 `ctx.config`（必填字段，**强类型**，不是 duck-typed 的可选端口）：publisher 注册表
   * 按 accessor 隔离，写成可选端口的话「`ProxyOptions` 改名」不会报错、只会静默丢掉终态事件。
   *
   * @param ctx - core 的依赖上下文（`ProxyOptions.ctx` 那个对象，runtime 传 `RuntimeContext`）
   * @returns 统一解绑点（与 `this.subscription` 同一个对象）
   */
  public attach(ctx: CoreContext): EventSubscription {
    if (this.state.disposed) {
      return this.subscription;
    }
    this.observePipe(ctx.events);
    this.unbind.push(
      registerRequestTerminalPublisher(ctx.config, this.protocol, this.createTerminalPublisher()),
    );
    return this.subscription;
  }

  /** 解绑全部 core 监听与终态 publisher；幂等，dispose 之后不再发布任何事件。 */
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
   * 订阅一条总线上的 `pipe` 事实并登记退订。
   *
   * @description 回调体整体 try/catch：`EventHub` 已隔离单个 listener 的异常，但桥接器自身
   * （提取函数、身份组装、发布）也不能把观察者的异常带回 core 的转发主流程。
   * 退订动作闭包持有**订阅时那个 hub**，`dispose()` 只对那条总线生效（换总线也不会退错对象）。
   */
  private observePipe(events: EventHub): void {
    const listener = (e: { readonly data: PipeEvent }): void => {
      if (this.state.disposed) {
        return;
      }
      try {
        this.onPipe(e.data);
      } catch {
        // 桥接是旁路观察：core 主流程的语义优先于事件翻译。
      }
    };
    const subscription = events.subscribe("pipe", listener);
    this.unbind.push(() => {
      subscription.dispose();
    });
  }

  /**
   * 构造 core 终态发布器。
   *
   * rejected/failed 经过 ErrorBoundary，保留分类、脱敏与观察者隔离；completed 没有
   * ErrorBoundary 对应入口，直接发布既有 request.completed 契约。无 HTTP 状态的 SOCKS
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
        const source = aclSource(event.source);
        this.hub.publish(
          "access.target-denied",
          {
            host,
            target: present(event.target) ?? host,
            reason,
            // 判不出的来源不写该键（不倒填成 global）
            ...(source === undefined ? {} : { source }),
          },
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
      default: {
        // 本波刻意不桥接的 11 个变体：转发/握手内部细节，等 ForwardPlan 与 ErrorBoundary 收口。
        // 显式列出而非留空，是为了新增变体时仍在编译期强制表态。
        // `target-unresolved` 也在其中：它的事实已由 `core/forward/channel/http.ts` 的
        // `requestTerminal.reject(..., "parse", 400)` 经终态 publisher 发布过一次，
        // 这里再桥一遍只会在同一请求上造出第二条 `request.rejected`。
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
          case "target-unresolved":
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
   * 使 `route.selected` / `access.*` 等 mid-flight 事件与 `request.completed` 终态共享 requestId。
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
