/**
 * @fileoverview 请求终态守卫与 core → runtime 内部发布适配
 * @module core/request-terminal
 * @description
 * 一个请求在协议层可能同时经过 error/timeout/close/response-finish 等多个异步收尾点。
 * 本模块只负责让这些路径竞争同一个一次性终态：completed、rejected、failed 三者互斥，
 * 且不直接触碰 socket、ServerResponse 或日志。
 *
 * core 本身不持有公共 EventHub（库模式的 hub 属于 runtime），因此这里用一个按
 * `ConfigAccessor + protocol` 查找的内部 publisher 注册表连接两侧：runtime bridge
 * 注册 publisher，协议入口为每个请求创建 RequestTerminal。未注册 publisher 时
 * 仍只维护终态 guard，不发布公共事件；配置访问器必须由调用方显式注入。
 */

import type { ConfigAccessor } from "@/config/accessor.js";
import type { EventContext, RequestStage } from "@/core/events/types.js";
import type { ProxyProtocol } from "@/core/types/proxy.js";

/** 互斥的请求终态类别。 */
export type RequestTerminalKind = "completed" | "rejected" | "failed";

/**
 * runtime bridge 提供的内部发布端口。
 *
 * completed 没有 ErrorBoundary 对应方法，故由 bridge 直接发布公共事件；rejected/failed
 * 必须经 ErrorBoundary，调用方无需知道 EventHub 或分类细节。
 */
export interface RequestTerminalPublisher {
  completed(status: number | undefined, context: Partial<EventContext>): void;
  rejected(
    reason: string,
    stage: RequestStage,
    status: number | undefined,
    context: Partial<EventContext>,
  ): void;
  failed(error: unknown, stage: RequestStage, context: Partial<EventContext>): void;
}

/** RequestTerminal 构造选项。 */
export interface RequestTerminalOptions {
  /** 当前 runtime 的发布器；缺省时只维护 guard，不发布公共事件。 */
  publisher?: RequestTerminalPublisher;
  /** 该请求的默认关联上下文；每次发布可再覆盖。 */
  context?: Partial<EventContext>;
}

type PublisherMap = Map<ProxyProtocol, RequestTerminalPublisher>;

/**
 * 按配置访问器隔离 publisher。
 *
 * 库 runtime 的每个实例都有独立 ConfigAccessor；CLI 直构 core 若没有 bridge，则没有
 * 对应条目。用 WeakMap 而不是进程级单值，避免不同 runtime 互相把终态发到错误的总线。
 */
const publishers = new WeakMap<object, PublisherMap>();

/**
 * 请求对象 → guard 的弱关联。
 *
 * HTTP 的 target-unresolved 仍有一个历史 pipe 事件由 bridge 观察；关联让 bridge
 * 在真实协议路径中识别该请求已经抢先完成终态，从而不重复发布。没有关联的 fake/core
 * 事件仍按旧桥接契约处理。
 */
const requestTerminals = new WeakMap<object, RequestTerminal>();

/** 合并上下文的可选字段时不把 undefined 覆盖掉已有身份。 */
function mergeContext(
  base: Partial<EventContext>,
  patch?: Partial<EventContext>,
): Partial<EventContext> {
  const merged: Partial<EventContext> = { ...base };
  if (patch === undefined) {
    return merged;
  }
  if (patch.runtimeId !== undefined) merged.runtimeId = patch.runtimeId;
  if (patch.connectionId !== undefined) merged.connectionId = patch.connectionId;
  if (patch.requestId !== undefined) merged.requestId = patch.requestId;
  if (patch.protocol !== undefined) merged.protocol = patch.protocol;
  if (patch.client !== undefined) merged.client = patch.client;
  if (patch.user !== undefined) merged.user = patch.user;
  if (patch.target !== undefined) merged.target = patch.target;
  return merged;
}

/**
 * per-request 终态守卫。
 *
 * 典型用法是直接调用 `complete` / `reject` / `fail`；这些方法内部先 claim，再发布，
 * 因此“首次分类结果”和“事件发布”是一个不可分割的动作。裸 `claim` 仍公开，便于
 * 低层调用点在需要自定义发布动作时复用同一互斥语义。
 */
export class RequestTerminal {
  private terminalKind: RequestTerminalKind | undefined;
  private readonly publisher: RequestTerminalPublisher | undefined;
  private context: Partial<EventContext>;

  public constructor(options: RequestTerminalOptions = {}) {
    this.publisher = options.publisher;
    this.context = { ...(options.context ?? {}) };
  }

  /**
   * 首次抢占终态返回 true；之后无论类别为何都返回 false。
   * 这保证 completed/rejected/failed 互斥且唯一。
   */
  public claim(kind: RequestTerminalKind): boolean {
    if (this.terminalKind !== undefined) {
      return false;
    }
    this.terminalKind = kind;
    return true;
  }

  public get settled(): boolean {
    return this.terminalKind !== undefined;
  }

  public get kind(): RequestTerminalKind | undefined {
    return this.terminalKind;
  }

  /** 补充请求身份，不改变已抢占的终态。 */
  public setContext(patch: Partial<EventContext>): void {
    this.context = mergeContext(this.context, patch);
  }

  /**
   * 只读快照：当前已知的请求身份（含 requestId / connectionId）。
   *
   * runtime bridge 用它把 core 事件（auth/pipe）发布的公共事件关联到同一请求，
   * 使 `auth.decided`、`route.selected` 与 `request.completed` 共享同一个 requestId。
   */
  public snapshotContext(): Readonly<Partial<EventContext>> {
    return { ...this.context };
  }

  /** 抢占并发布正常完成；status 对 SOCKS 等无状态码协议可省略。 */
  public complete(status?: number, context?: Partial<EventContext>): void {
    if (!this.claim("completed")) {
      return;
    }
    this.invoke((publisher) => publisher.completed(status, mergeContext(this.context, context)));
  }

  /** 抢占并发布预期内拒绝。 */
  public reject(
    reason: string,
    stage: RequestStage,
    status?: number,
    context?: Partial<EventContext>,
  ): void {
    if (!this.claim("rejected")) {
      return;
    }
    this.invoke((publisher) =>
      publisher.rejected(reason, stage, status, mergeContext(this.context, context)),
    );
  }

  /** 抢占并发布已发生但需要归因的失败。 */
  public fail(error: unknown, stage: RequestStage, context?: Partial<EventContext>): void {
    if (!this.claim("failed")) {
      return;
    }
    this.invoke((publisher) => publisher.failed(error, stage, mergeContext(this.context, context)));
  }

  private invoke(action: (publisher: RequestTerminalPublisher) => void): void {
    if (this.publisher === undefined) {
      return;
    }
    try {
      action(this.publisher);
    } catch {
      // 事件观察面不能改变协议收尾；终态已经抢占成功即完成本路径的职责。
    }
  }
}

/** 注册 runtime publisher，返回幂等退订动作。 */
export function registerRequestTerminalPublisher(
  config: object,
  protocol: ProxyProtocol,
  publisher: RequestTerminalPublisher,
): () => void {
  let byProtocol = publishers.get(config);
  if (byProtocol === undefined) {
    byProtocol = new Map<ProxyProtocol, RequestTerminalPublisher>();
    publishers.set(config, byProtocol);
  }
  byProtocol.set(protocol, publisher);

  let disposed = false;
  return (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    const current = publishers.get(config);
    if (current?.get(protocol) !== publisher) {
      return;
    }
    current.delete(protocol);
    if (current.size === 0) {
      publishers.delete(config);
    }
  };
}

/** 为某个协议配置创建请求终态；bridge 尚未 attach 时仍可正常作为纯 guard 使用。 */
export function createRequestTerminal(
  config: ConfigAccessor,
  protocol: ProxyProtocol,
  context?: Partial<EventContext>,
): RequestTerminal {
  return new RequestTerminal({
    publisher: publishers.get(config)?.get(protocol),
    context,
  });
}

/** 将 HTTP 请求对象与 guard 关联，供历史 pipe→公共桥接做去重判断。 */
export function associateRequestTerminal(request: object, terminal: RequestTerminal): void {
  requestTerminals.set(request, terminal);
}

/** 查找请求关联的 guard；非对象或未关联时返回 undefined。 */
export function requestTerminalFor(request: unknown): RequestTerminal | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  return requestTerminals.get(request);
}

/** 判断一个历史 core 事件对应的请求是否已经由协议路径抢占终态。 */
export function requestTerminalSettled(request: unknown): boolean {
  return requestTerminalFor(request)?.settled === true;
}
