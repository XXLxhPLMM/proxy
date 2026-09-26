/**
 * @fileoverview 核心依赖上下文：三件套（配置访问器 / 日志端口 / 事件总线）的只读载体
 * @module core/context
 * @description
 * core 的组件过去靠构造函数逐层手工搬运同一个依赖（`ProxyOptions.config` /
 * `ProxyOptions.logger` / `PipeEventSink` 事件槽），几十个构造函数都在做同一件事。
 * 本模块只提供**承载体**，不负责接线：
 * - `CoreContext`：只读三件套，字段恰好三个且全部必填、无可选标记、无默认实现
 * - `ContextualBase`：把三件套收成 `config` / `log` / `events` 三个 protected getter 的基类
 *
 * 设计要点：
 * - **零副作用**：基类不注册事件监听、不读配置、不打日志、不碰 `process`/文件。装配由调用方负责
 * - **无兜底**：本模块不出现 `createNoopLogger()` / `new EventHub()` / 任何 `??` 缺省。
 *   依赖缺失的兜底只允许发生在唯一组装根 `createProxyRuntime()`，那是被显式记录的决策；
 *   在这里兜底会让「忘注入」变成静默的运行期怪问题
 * - **type-only 引用**：`ConfigAccessor` / `Logger` / `EventHub` 全部 `import type`，
 *   编译期擦除，不给 core 引入任何运行期依赖边
 * - getter 名字固定为 `config` / `log` / `events`：子类要用别的名字就得写转发，
 *   那样这套 getter 就白存在了。后续让 `BaseProxy`（删掉自己的 `log` 字段）与
 *   `ForwarderBase`（删掉自己的 `config` 字段）继承本基类时，名字必须对得上
 */

import type { ConfigAccessor } from "@/config/index.js";
import type { EventHub } from "@/core/events/index.js";
import type { Logger } from "@/utils/logger/index.js";

/**
 * core 组件的依赖上下文：三件套的只读视图。
 *
 * 只读是刻意的——消费者拿到它就不该改依赖；真正需要换依赖的只有持有者
 * （`RuntimeContext` 之类的可变实现），它自己实现同一组字段并额外提供 setter。
 */
export interface CoreContext {
  /** 配置读取端口：只有泛型 `get`，无写入、无全局回退。 */
  readonly config: ConfigAccessor;
  /** 日志端口：当前实例显式注入的那个 logger，不是全局 logger。 */
  readonly logger: Logger;
  /** 公共事件总线：只发布已发生的事实，订阅方只观察。 */
  readonly events: EventHub;
}

/**
 * 依赖上下文的基类：构造期注入一个 `CoreContext`，子类经三个 protected getter 取用。
 *
 * 零副作用：构造只做一次字段赋值；不订阅事件、不读配置、不打日志。
 */
export abstract class ContextualBase {
  /** 完整上下文；需要三件套之外的形状时子类经 `this.ctx` 自取。 */
  protected readonly ctx: CoreContext;

  constructor(ctx: CoreContext) {
    this.ctx = ctx;
  }

  protected get config(): ConfigAccessor {
    return this.ctx.config;
  }

  protected get log(): Logger {
    return this.ctx.logger;
  }

  protected get events(): EventHub {
    return this.ctx.events;
  }
}
