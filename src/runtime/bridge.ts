/**
 * @fileoverview core 管道事实 → 公共 `AppEventMap` 事件的桥接器
 * @module runtime/bridge
 * @description
 * core **直接**把请求期事实发布到注入的 `EventHub`，`auth.decided` 与
 * `request.started` 都不经本文件桥接。本文件只做一件事：把 `pipe` 的三个公开形状
 * 翻译成对应的公共事件。与同目录 `./event-log.ts` 的分工：两张面、互不 import、各自演进。
 *
 * 映射契约（`pipe` → 公共事件，3 条，无其它）：
 * - `pipe: ip-denied` → `access.client-denied`：`{ client, reason }`
 * - `pipe: target-denied` → `access.target-denied`：`{ host, target, reason, source? }`
 * - `pipe: route` → `route.selected`：`{ mode, route, reason? }`
 *
 * ⚠️ **`reason` / `source` 一律原样透传**（`AppEventMap` 里这两个字段是自由 `string`，本文件
 * **不做闭合集收窄**），缺失即跳过、绝不臆造。core 直发的 8 个公共事件与 `pipe` 其余 11 个变体
 * （含 `target-unresolved`）刻意不桥接。断言点见 `tests/unit/core-event-bridge.test.ts`，
 * 来由与代价见下方 `passthroughReason`。
 *
 * `requestId` / `connectionId` **不由本文件生成**，只从 pipe 事件载荷读取（`core/scope-ids.ts` 在协议入口
 * 注入 id，`identityOf` 负责带出）：core 直构（无入口注入）时缺失即不带，桥接器不臆造 id。终态 publisher
 * 则沿用 `RequestTerminal` 传入的作用域，因此 `route.selected` / `access.*` 与
 * `request.completed|rejected|failed` 能按同一 requestId 串成一条完整链。
 *
 * 零副作用：不读 env/文件、不注册 `process` 事件、不打日志、不碰 CLI 通道。
 */

import type http from "node:http";
import type { EventContext, EventHub, EventSubscription } from "@/core/events/index.js";
import type { CoreContext } from "@/core/context.js";
import { ErrorBoundary } from "@/core/error-boundary.js";
import {
  registerRequestTerminalPublisher,
  type RequestTerminalPublisher,
} from "@/core/request-terminal.js";
import type { PipeEvent, PipeEventBase, ProxyProtocol } from "@/core/types/proxy.js";
import type { ErrorClassifier } from "@/core/types/proxy.js";
import { getAuthority, getClientAddress } from "@/utils/addr/index.js";

export interface CoreEventBridgeOptions {
  /** 公共事件总线：桥接结果全部发布到这里（库用户只通过 `runtime.events` 观察）。 */
  hub: EventHub;
  /** 协议，写进每个事件的 context（pipe 事件载荷本身不带协议维度）。 */
  protocol: ProxyProtocol;
  /** 把 pipe 事件里 `req` 的 client 提取注入；缺省 `getClientAddress`（XFF → X-Real-IP → Forwarded → socket）。 */
  extractClient?: (req: http.IncomingMessage) => string;
  /** 把 pipe 事件里 `req` 的 target 提取注入；缺省 `getAuthority`（CONNECT 取 url，其余取 Host）。 */
  extractTarget?: (req: http.IncomingMessage) => string | undefined;
  /**
   * 错误分类策略，原样递给本桥持有的 `ErrorBoundary`
   * @description **缺省 = `ErrorBoundary` 自己的 `DEFAULT_ERROR_CLASSIFIER`**——这一层刻意
   * **不再兜一次**：本桥是 runtime 装配链的一环，而那条链上 `RuntimeServices.errorClassification`
   * 是**必填**的（`buildDefaultServices` 解析），故生产路径总会显式传下来。这里的可选性只为
   * **裸构本桥的测试与库用法**（13 处 `new CoreEventBridge({ hub, protocol })`）不必知道默认实现是谁。
   */
  classifier?: ErrorClassifier;
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
 * 拒绝原因 / 来源：**原样透传**，只在「缺失或空串」时返回 undefined（调用方跳过发布）。
 *
 * **为什么它与 {@link present} 是两个名字而不是一个**（防「顺手合并」）：`present` 答的是
 * 「这个字段有值吗」，调用点读作一次普通的字符串净化；本函数答的是
 * 「**引擎的裁定原样发布，但拒绝臆造**」——这个裁定**不过任何闭合集**。
 *
 * ## 为什么必须原样透传（收窄会让「表外值静默丢掉安全事实」）
 *
 * 访问控制是对外端口，「表外值」不是理论问题：自定义策略引擎（限速 / 地域封锁 / 订阅网关）
 * 判出的 `reason` 是 `"rate-limited"`、`"geo-blocked"` 这类自由字符串，`AccessDecision.reason`
 * 已是 `string`。**任何按闭合集收窄的写法都会让每一次这样的拒绝在公共事件面上零痕迹**——
 * 而 `access.target-denied` 的 `host` 缺失本来就有正当的跳过理由（「公共契约必填项缺失」），
 * 收窄的表外值会走到**同一个 `return`**。且「静默丢事件」比「字段缺失」更坏：字段缺失至少是
 * 一条**已发布的**事件少一个可选项，消费方还能从 `host` / `client` 知道「这里发生过一次拒绝」；
 * 整条不发布则连「发生过什么」都没了 —— 安全审计面凭空出现一个洞，而且**没有任何报错提示它**，
 * 要补只能回头翻应用日志。
 *
 * ## 代价（由消费方承担）
 *
 * - **`reason` / `source` 不再有闭合集保证**：`AppEventMap` 里这两个字段是自由 `string`，
 *   消费方**不能拿它做穷尽 `switch`**（编译期不再帮你兜住「表外值」这一类 bug）。
 *   正确写法是先比 `whitelist` / `blacklist`，其余落一个 `other` 桶。
 * - **内置引擎产出的取值集合有限**：`createFileAccessControl` 只产 `whitelist|blacklist`，
 *   分层来源只产 `global|user`；落盘的 `[ip-denied]` / `[target-denied]` 行
 *   （`./event-log.ts:bindProxyEventLogs` 读的是 **core 载荷原文**，根本不经本文件）
 *   不受本文件的透传规则影响。
 *
 * ## 「缺失即跳过，绝不臆造」
 *
 * 空串 / `undefined` 一律判为缺失并**跳过发布**，绝不倒填成 `"blacklist"` 或 `"global"`
 * —— 那会把「个人名单拒的」伪装成「全局拒的」，运维去改错文件。`target-denied` 的 `host`
 * 缺失同样跳过（公共契约必填项），必填 `client` 缺失回落 `"unknown"` 哨兵。
 */
function passthroughReason(raw: string | undefined): string | undefined {
  return present(raw);
}

/** `PipeEventBase.req` 声明为 `unknown`；这里只按「有 headers 的对象」收窄成 IncomingMessage。 */
function asIncomingMessage(value: unknown): http.IncomingMessage | undefined {
  if (typeof value !== "object" || value === null || !("headers" in value)) {
    return undefined;
  }
  return value as http.IncomingMessage;
}

/**
 * 生命周期：`attach(ctx)` 在 core 的依赖上下文上订阅 `pipe`，之后 core 每次发布都被翻译并
 * 发布到 hub；`subscription.dispose()`（幂等）解绑该订阅并停止发布。
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
      classifier: options.classifier,
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
   * 总线取 `ctx.events` 而**不是**构造时的 `options.hub`，退订用**订阅那一刻**的 hub 实例
   * 而非 hub 字段：core 那边换过总线的话，按字段退订会摘错对象。
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
   * 退订动作闭包持有**订阅时那个 hub**，`dispose()` 只对那条总线生效。
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
        const reason = passthroughReason(event.reason);
        if (reason === undefined) {
          // 缺失即跳过，绝不臆造：载荷里没有 reason 就没有「为什么被拒」这条事实，
          // 倒填一个 `blacklist` 等于编造一条安全审计记录。
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
        const reason = passthroughReason(event.reason);
        const host = present(event.host);
        if (reason === undefined || host === undefined) {
          // `host` 是公共契约必填项，缺了就没法复述这次拒绝。
          return;
        }
        // `source` 缺失就不写该键，不倒填成 global。
        const source = passthroughReason(event.source);
        this.hub.publish(
          "access.target-denied",
          {
            host,
            target: present(event.target) ?? host,
            reason,
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
        // 刻意不桥接的 11 个变体：转发/握手内部细节，等 ForwardPlan 与 ErrorBoundary 收口。
        // 显式列出而非留空，是为了新增变体时仍在编译期强制表态（`target-unresolved` 也在其中：
        // 它的终态已由协议入口经终态 publisher 发布过一次）。
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
    // 缺失即不带：core 直构（无入口注入）时事件没有该维度。
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
