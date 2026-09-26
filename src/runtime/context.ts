/**
 * @fileoverview 可变的运行时依赖上下文：CoreContext 的持有者，带 setter 与变更事件
 * @module runtime/context
 * @description
 * `CoreContext` 是只读视图，core 组件只消费它；真正持有并允许替换依赖的是本类：
 * - 构造参数三项全必填、全显式，**内部不做任何兜底/懒初始化**
 *   （没有 `?? createNoopLogger()`、没有 `?? new EventHub()`）：缺省解析只在唯一组装根
 *   `createProxyRuntime()` 做一次，在组件内部兜底只会把「忘注入」变成静默的运行期怪问题
 * - 每次成功交换后用**当前**（对 `setEvents` 而言即新的）事件总线发一条
 *   `runtime.dependencies-changed`，payload 为 `{ kind }`
 * - 同一个实例重复设置直接 return 且不发事件：依赖交换是幂等操作，重复噪音没有信息量
 * - 事件发布整体 try/catch：观察者抛错绝不让 setter 抛出，也绝不回滚已完成的交换
 *   （与 `runtime/runtime.ts:publishRuntimeError` 的容错风格一致）
 * - `setEvents` 只换引用，**绝不**对被换下的旧总线调 `removeAll()`：旧总线归它的创建者所有
 *   （`ProxyRuntimeImpl` 的 `ownsEvents` 就是这个先例），本类没有所有权判断的依据
 * - 本类不 `Object.freeze`：它按设计就是可变的。可变的只有这个持有者，消费者拿到的
 *   仍是 `CoreContext` 只读接口，对消费者依旧只读
 */

import type { ConfigAccessor } from "@/config/index.js";
import type { CoreContext } from "@/core/context.js";
import type { EventData, EventHub } from "@/core/events/index.js";
import type { Logger } from "@/utils/logger/index.js";

/** 被交换的那一件依赖；取值域由 `AppEventMap` 的 payload 直接派生，避免第二份联合类型。 */
type DependencyKind = EventData<"runtime.dependencies-changed">["kind"];

/** `RuntimeContext` 的构造参数：三项全必填，不接受任何省略。 */
export interface RuntimeContextOptions {
  config: ConfigAccessor;
  logger: Logger;
  events: EventHub;
}

/**
 * 运行时依赖上下文的持有者。
 *
 * 只读面（`config` / `logger` / `events`）与 `CoreContext` 结构一致，因此本类可以
 * 直接当 `CoreContext` 传给 core 组件；替换面是三个独立的 `setX`，刻意不提供
 * `setX` 之外的任何写入口。
 */
export class RuntimeContext implements CoreContext {
  private currentConfig: ConfigAccessor;
  private currentLogger: Logger;
  private currentEvents: EventHub;

  constructor(options: RuntimeContextOptions) {
    this.currentConfig = options.config;
    this.currentLogger = options.logger;
    this.currentEvents = options.events;
  }

  public get config(): ConfigAccessor {
    return this.currentConfig;
  }

  public get logger(): Logger {
    return this.currentLogger;
  }

  public get events(): EventHub {
    return this.currentEvents;
  }

  public setConfig(next: ConfigAccessor): void {
    if (this.currentConfig === next) {
      return;
    }
    this.currentConfig = next;
    this.announce("config");
  }

  public setLogger(next: Logger): void {
    if (this.currentLogger === next) {
      return;
    }
    this.currentLogger = next;
    this.announce("logger");
  }

  public setEvents(next: EventHub): void {
    if (this.currentEvents === next) {
      return;
    }
    this.currentEvents = next;
    // 刻意不对 `this.currentEvents` 的旧值调 removeAll()：旧总线归创建者所有。
    this.announce("events");
  }

  /**
   * 交换完成后通知观察面：用**当前**总线发一条 `{ kind }`。
   *
   * try/catch 覆盖的是发布通道自身（自定义 EventHub 子类、代理包装等）抛错；
   * 标准 `EventHub` 自己也会隔离单个 listener 的异常，两层都不许把异常
   * 升级成 setter 的异常，更不许回滚已完成的交换。
   */
  private announce(kind: DependencyKind): void {
    try {
      this.currentEvents.publish("runtime.dependencies-changed", { kind });
    } catch {
      // 观察者异常不能改变已完成的依赖交换。
    }
  }
}
