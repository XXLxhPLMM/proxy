/**
 * @fileoverview 请求作用域值对象：这一次请求/连接的全部易变数据收在一处
 * @module core/request-scope
 * @description
 * 四个转发器（http / tunnel / websocket / socks）在**服务构造期一次组装好**、跨请求复用
 * （它们本身无请求态，复用是刻意的性能取舍，见 `./AGENTS.md`）。而 `user` / `requestId` /
 * `connectionId` 是**逐请求**才产生的数据——这两件事必须分开，否则「共享实例 + 逐请求字段」
 * 就是一个已经埋好的串号雷。
 *
 * **本对象存在的唯一理由**：给「易变的逐请求数据」一个**只经参数逐次传入**的载体，
 * 使它在类型层面就无法被误存到共享实例上。
 *
 * 设计要点：
 * - **纯值对象 + 一个 `emit` 闭包**：无状态、无配置依赖、无日志、无 IO；`emit` 带容错包装
 *   （`createEventEmitter`），观察面抛错不得反噬协议收尾
 * - **`terminal` 是引用而非副本**：`RequestTerminal` 的互斥抢占语义对全链唯一，
 *   复制会让 completed/rejected/failed 三者各发一次
 * - 「纯值对象、逐请求身份绝不存实例字段」与「关联 id 只从 `context` 派生」两条判据（含锁点）见
 *   `../../../tests/unit/forwarder-request-path-allocation.test.ts` 与
 *   `dead-optionality-cleared.test.ts` 的头注释
 *
 * 使用示例：
 * ```ts
 * const scope = createRequestScope({ ctx, terminal, context: { protocol, requestId, connectionId }, user });
 * forwarder.handleRequest(req, res, scope); // 三个入口方法名各与其 InboundKind 对齐
 * ```
 */

import type { CoreContext } from "@/core/context.js";
import type { EventContext } from "@/core/events/types.js";
import { createEventEmitter } from "@/core/guard.js";
import type { RequestTerminal } from "@/core/request-terminal.js";
import type { PipeEvent } from "@/core/types/proxy.js";

/**
 * 请求作用域：这一次请求/连接的可变数据 + 唯一的事件出口
 * @param emit - 把身份维度注进 `PipeEvent` 后发布到 `ctx.events`；**每请求一条闭包，天然隔离**
 * @param terminal - 本请求的终态守卫（**引用**，非副本：互斥抢占语义对全链唯一）
 * @param user - 已鉴权用户名，无则不带
 * @param requestId - 请求标识（keep-alive 下每请求一个）
 * @param connectionId - 连接标识（keep-alive 下同一 TCP 连接共享；SOCKS 与 requestId 同值）
 */
export interface RequestScope {
  emit(e: PipeEvent): void;
  readonly terminal: RequestTerminal;
  readonly user?: string;
  readonly requestId?: string;
  readonly connectionId?: string;
}

/**
 * {@link createRequestScope} 的构造选项
 * @param ctx - 依赖上下文（事件总线的唯一来源），必须显式注入
 * @param terminal - 本请求的终态守卫；与 scope 同寿命，同一个实例
 * @param context - 关联上下文，原样透传进 `publish` 的 context，身份维度由本工厂从它取
 * @param user - 已鉴权用户名（省略即不带，绝不写 `undefined` 键）
 */
export interface RequestScopeOptions {
  ctx: CoreContext;
  terminal: RequestTerminal;
  context?: Partial<EventContext>;
  user?: string;
}

/**
 * 造一个请求作用域：身份维度注进事件的动作**只在这里发生一次**（`src/**` 恰好一个调用点，
 * 锁点见 `../../../tests/unit/inbound-dispatch.test.ts`）
 * @description
 * `emit` 把 `identity` 同时贴进事件载荷与 `EventContext`（两者同源、不是两套事实）：载荷侧供
 * `runtime/bridge.ts` 与 `runtime/event-log.ts:bindProxyEventLogs` 按 `type` 分派时取用，context
 * 侧供不解析载荷的观察者（只读 context 就能按 `requestId` 与 `user` 串联）。省略的身份维度**不写
 * 键**（而不是写 `undefined`）。**关联 id 只从 `context` 取、不另设形参**——`identity` 反正会
 * 被合并进发布的 context，「id 在 `context` 里、却不算身份」是自相矛盾的形状，两个入口必然漂移。
 * @param options - 见 {@link RequestScopeOptions}
 * @returns 冻结的请求作用域（`terminal` 仍是同一个引用，可被其内部抢占）
 */
export function createRequestScope(options: RequestScopeOptions): RequestScope {
  const { ctx, terminal, context, user } = options;

  // 身份维度：全仓唯一一处「把身份注进事件」的代码
  const identity: Partial<EventContext> = {
    ...(user !== undefined ? { user } : {}),
    ...(context?.requestId !== undefined ? { requestId: context.requestId } : {}),
    ...(context?.connectionId !== undefined ? { connectionId: context.connectionId } : {}),
  };

  const emit = createEventEmitter<PipeEvent>((e) =>
    ctx.events.publish("pipe", { ...e, ...identity }, { ...context, ...identity }),
  );

  return Object.freeze({ emit, terminal, ...identity });
}
