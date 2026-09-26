import { describe, expect, it, vi } from "vitest";
import { ConfigStore, configAccessorFromStore } from "@/config/index.js";
import type { ConfigAccessor } from "@/config/index.js";
import { ContextualBase } from "@/core/context.js";
import type { CoreContext } from "@/core/context.js";
import { EventHub } from "@/core/events/index.js";
import type { EventEnvelope } from "@/core/events/index.js";
import { RuntimeContext } from "@/runtime/context.js";
import { createNoopLogger } from "@/utils/logger/index.js";
import type { Logger } from "@/utils/logger/index.js";
import { get } from "../helpers/config.js";

/** 依赖承载体接口探针：子类经 protected getter 取三件套，经 `ctx` 取整个上下文。 */
class Probe extends ContextualBase {
  public readConfig(): ConfigAccessor {
    return this.config;
  }

  public readLog(): Logger {
    return this.log;
  }

  public readEvents(): EventHub {
    return this.events;
  }

  public readCtx(): CoreContext {
    return this.ctx;
  }
}

/** 发布通道自身抛错的替身：标准 EventHub 只会隔离 listener 异常，这里模拟更上层的故障。 */
class ExplodingEventHub extends EventHub {
  public publish(): void {
    throw new Error("publish channel failed");
  }
}

interface Harness {
  ctx: RuntimeContext;
  config: ConfigAccessor;
  logger: Logger;
  events: EventHub;
}

function makeContext(overrides: Partial<Omit<Harness, "ctx">> = {}): Harness {
  const config = overrides.config ?? configAccessorFromStore(new ConfigStore());
  const logger = overrides.logger ?? createNoopLogger();
  const events = overrides.events ?? new EventHub({ runtimeId: "runtime-ctx" });
  return { ctx: new RuntimeContext({ config, logger, events }), config, logger, events };
}

/** 订阅依赖交换事件并收集信封（含 context，用于断言发布确实走了哪条总线）。 */
function collectChanges(
  events: EventHub,
): EventEnvelope<"runtime.dependencies-changed">[] {
  const seen: EventEnvelope<"runtime.dependencies-changed">[] = [];
  events.subscribe("runtime.dependencies-changed", (event) => {
    seen.push(event);
  });
  return seen;
}

describe("core/context 依赖承载体", () => {
  it("子类经三个 protected getter 拿到注入的 config / logger / events 实例", () => {
    // 保护：承载体存在的意义就是让组件不必再手工逐层搬运这三个依赖。
    const { ctx, config, logger, events } = makeContext();
    const probe = new Probe(ctx);

    expect(probe.readConfig()).toBe(config);
    expect(probe.readLog()).toBe(logger);
    expect(probe.readEvents()).toBe(events);
  });

  it("ctx 完整上下文对子类可见，getter 恒等转发而非另存一份", () => {
    // 保护：getter 只是 ctx 的窄化投影；一旦有人改成构造期快照，依赖热替换就会静默失效。
    const { ctx, config, logger, events } = makeContext();
    const probe = new Probe(ctx);

    expect(probe.readCtx()).toBe(ctx);
    expect(probe.readCtx().config).toBe(config);
    expect(probe.readCtx().logger).toBe(logger);
    expect(probe.readCtx().events).toBe(events);
  });

  it("三个 getter 保持 protected，外部无法直接取用（编译期护栏）", () => {
    // 保护：getter 暴露成 public 就等于给每个组件开了一个绕过接线的后门。
    const { ctx } = makeContext();
    const probe = new Probe(ctx);
    const readProtected = (target: Probe): unknown => {
      // @ts-expect-error config 是 protected getter，外部不可直接取用
      const config = target.config;
      // @ts-expect-error log 是 protected getter，外部不可直接取用
      const log = target.log;
      // @ts-expect-error events 是 protected getter，外部不可直接取用
      const events = target.events;
      return { config, log, events };
    };

    expect(readProtected).toBeTypeOf("function");
    // 读取器刻意不被调用：它只用来在编译期证明「外部真的取不到这三个 getter」。
    expect(probe.readCtx()).toBe(ctx);
  });
});

describe("runtime/context 运行时依赖持有者", () => {
  it("三个 getter 原样返回构造时注入的实例", () => {
    const { ctx, config, logger, events } = makeContext();

    expect(ctx.config).toBe(config);
    expect(ctx.logger).toBe(logger);
    expect(ctx.events).toBe(events);
  });

  it("构造参数三项全必填、无缺省解析（编译期护栏）", () => {
    // 保护：一旦某项变成可选或内部补上默认值，「忘注入」就会被静默吞掉。
    const requireGuards = (config: ConfigAccessor, logger: Logger, events: EventHub): void => {
      // @ts-expect-error 三项全必填
      new RuntimeContext({});
      // @ts-expect-error logger 与 events 必填
      new RuntimeContext({ config });
      // @ts-expect-error events 必填
      new RuntimeContext({ config, logger });
      // @ts-expect-error config 与 logger 必填
      new RuntimeContext({ events });
    };

    expect(requireGuards).toBeTypeOf("function");
  });

  it("setLogger 交换成功，恰好发一条 kind=logger 的事件且 context 正确", () => {
    // 保护：消费者据此重新绑定 logger；多条或零条都会让重绑定逻辑写错。
    const { ctx, logger, events } = makeContext();
    const seen = collectChanges(events);
    const next = createNoopLogger();

    ctx.setLogger(next);

    expect(ctx.logger).toBe(next);
    expect(ctx.logger).not.toBe(logger);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.data.kind).toBe("logger");
    expect(seen[0]?.context.runtimeId).toBe(events.runtimeId);
  });

  it("setConfig 交换成功，恰好发一条 kind=config 的事件且 context 正确", () => {
    const { ctx, config, events } = makeContext();
    const seen = collectChanges(events);
    const next = configAccessorFromStore(new ConfigStore());

    ctx.setConfig(next);

    expect(ctx.config).toBe(next);
    expect(ctx.config).not.toBe(config);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.data.kind).toBe("config");
    expect(seen[0]?.context.runtimeId).toBe(events.runtimeId);
  });

  it("setEvents 交换成功，在新总线上发恰好一条 kind=events 的事件", () => {
    // 保护：事件必须由「交换之后」的总线发出，观察者才能在新链路上立刻收到通知。
    const { ctx, events } = makeContext();
    const seenBefore = collectChanges(events);
    const next = new EventHub({ runtimeId: "runtime-next" });
    const seenAfter = collectChanges(next);

    ctx.setEvents(next);

    expect(ctx.events).toBe(next);
    expect(seenBefore).toHaveLength(0);
    expect(seenAfter).toHaveLength(1);
    expect(seenAfter[0]?.data.kind).toBe("events");
    expect(seenAfter[0]?.context.runtimeId).toBe(next.runtimeId);
  });

  it("重复设置同一实例不交换也不发事件（幂等）", () => {
    // 保护：重复 set 是常见调用形态，噪音事件会让订阅方做无意义的重复重绑定。
    const { ctx, config, logger, events } = makeContext();
    const seen = collectChanges(events);

    ctx.setLogger(logger);
    ctx.setConfig(config);
    ctx.setEvents(events);

    expect(ctx.logger).toBe(logger);
    expect(ctx.config).toBe(config);
    expect(ctx.events).toBe(events);
    expect(seen).toHaveLength(0);
  });

  it("观察者抛错不阻断 setter：已完成的交换不被回滚，setter 也不抛", () => {
    // 保护：依赖交换是「先写字段、再通知」，通知面的异常绝不能反向影响依赖本身。
    const onListenerError = vi.fn();
    const events = new EventHub({ runtimeId: "runtime-observed", onListenerError });
    const { ctx, logger } = makeContext({ events });
    events.subscribe("runtime.dependencies-changed", () => {
      throw new Error("observer failed");
    });
    const next = createNoopLogger();

    expect(() => {
      ctx.setLogger(next);
    }).not.toThrow();
    expect(ctx.logger).toBe(next);
    expect(ctx.logger).not.toBe(logger);
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), "runtime.dependencies-changed");
  });

  it("发布通道自身抛错也不阻断 setter（交换先于通知）", () => {
    const { ctx, logger } = makeContext({ events: new ExplodingEventHub() });
    const next = createNoopLogger();

    expect(() => {
      ctx.setLogger(next);
    }).not.toThrow();
    expect(ctx.logger).toBe(next);
    expect(ctx.logger).not.toBe(logger);
  });

  it("setEvents 只换引用：旧总线上的既有订阅全部保留", () => {
    // 保护：旧总线归它的创建者所有，持有者无权代为清理（ProxyRuntimeImpl.ownsEvents 同理）。
    const events = new EventHub({ runtimeId: "runtime-old" });
    const { ctx } = makeContext({ events });
    const listener = vi.fn();
    const subscription = events.subscribe("auth.decided", listener);

    ctx.setEvents(new EventHub({ runtimeId: "runtime-new" }));

    expect(subscription.disposed).toBe(false);
    expect(events.listenerCount("auth.decided")).toBe(1);
    // 依赖交换事件只走新总线，旧总线既不收它、也不被清空。
    expect(events.listenerCount("runtime.dependencies-changed")).toBe(0);

    events.publish("auth.decided", { passed: true });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("可结构化当作 CoreContext 使用，且只读视图不暴露任何写入口", () => {
    // 保护：可变只对持有者成立；消费者拿到的接口一旦能写，依赖替换就会散落到业务代码里。
    const runtimeCtx = new RuntimeContext({
      config: configAccessorFromStore(new ConfigStore()),
      logger: createNoopLogger(),
      events: new EventHub({ runtimeId: "runtime-structural" }),
    });
    const readonlyView: CoreContext = runtimeCtx;

    expect(readonlyView).toBe(runtimeCtx);
    expect(readonlyView.config).toBe(runtimeCtx.config);
    expect(readonlyView.logger).toBe(runtimeCtx.logger);
    expect(readonlyView.events).toBe(runtimeCtx.events);
    expect(new Probe(readonlyView).readLog()).toBe(runtimeCtx.logger);

    const writeGuards = (view: CoreContext): void => {
      // @ts-expect-error CoreContext 是只读视图：没有 setConfig
      view.setConfig(view.config);
      // @ts-expect-error CoreContext 是只读视图：没有 setLogger
      view.setLogger(createNoopLogger());
      // @ts-expect-error CoreContext 是只读视图：没有 setEvents
      view.setEvents(view.events);
    };
    expect(writeGuards).toBeTypeOf("function");
  });

  it("本文件只用 noop logger 且不落盘", () => {
    // 保护：测试零落盘（setup-env.ts 已钉空 LOG_FILE），这里再钉一次「不写真实 log/」。
    expect(get("logFile")).toBe("");
    expect(process.env.LOG_FILE).toBe("");
  });
});

/**
 * 三个 setter 的**归属**：`src/` 内零调用方，调用方全在**库调用方**。
 *
 * @description
 * `setConfig` / `setLogger` / `setEvents` 在 `src/**` 里的调用点**恰好 0 个**
 * （只在 `tests/unit/core-context.test.ts` 被调）。**那不是死代码**：`ProxyRuntimeImpl`
 * 把 `RuntimeContext` 经 `services` / `ProxyOptions.ctx` 暴露给库调用方，而这三个 setter 是
 * 库调用方**唯一**能在运行期热换配置 / 日志器 / 事件总线的入口。删掉它们 = 库调用方失去这个
 * 能力，而本仓测试**一条都不会红**（没有调用方就没有覆盖）。
 *
 * ⚠️ **代价必须写下来**：`core/server/base.ts` 那两条「**绝不允许**把 `events` 缓存成字段」
 * 的强纪律，其论证前提正是「`RuntimeContext.setEvents()` 能在运行期换总线」。**而在本仓内部
 * 这件事永不发生**（`src/` 零调用方）—— 那条纪律在本仓**是靠源码注释与源码级断言维持的，
 * 不是靠运行时压力**：谁把 `this.events` 缓存成字段，全仓测试仍然全绿。这是一条**无运行时
 * 保障的纪律**，如实写出比再加一条测试更重要。
 *
 * 下面这条断言能做的，是**守住接口的可见性**（别把公开面悄悄改成 `private`/`protected`，
 * 那样库调用方在编译期就断了，而那至少是**响亮的**失败）；它**不能**证明有人真的在用它。
 */
describe("runtime/context 三个 setter：库调用方的公开面（src/ 内零调用是预期形态）", () => {
  it("三个 setter 都是 public 成员（编译期护栏：改成 private/protected 会让 pnpm typecheck 红）", () => {
    // 本仓唯一检查类型面的工具是 `tsc --noEmit`（vitest 走 esbuild，类型全被擦除）。
    // 所以这条护栏**只能是编译期**的：下面三行**刻意不带** `@ts-expect-error` ——
    // 一旦有人给它们加 `private`/`protected`，这三行会当场编译失败。
    // 这与本文件里「三个 getter 保持 protected」那条恰好互为镜像（那边用 `@ts-expect-error`
    // 证明「外部取不到」，这边证明「外部取得到」）。
    const publicLibrarySurface = (ctx: RuntimeContext): void => {
      ctx.setConfig(ctx.config);
      ctx.setLogger(ctx.logger);
      ctx.setEvents(ctx.events);
    };

    expect(publicLibrarySurface).toBeTypeOf("function");
  });

  it("三个 setter 真的挂在原型上（运行期确认：不是靠字段初始化或装饰器塞进来的）", () => {
    // 与上一条互补：编译期说「访问合法」，这条说「访问到的确实是三个真函数」。
    for (const name of ["setConfig", "setLogger", "setEvents"] as const) {
      expect(
        Object.prototype.hasOwnProperty.call(RuntimeContext.prototype, name),
        `RuntimeContext.prototype 上必须真的有 ${name}（库调用方唯一能热换 ${name.slice(3)} 的入口）`,
      ).toBe(true);
      expect(
        typeof (RuntimeContext.prototype as unknown as Record<string, unknown>)[name],
      ).toBe("function");
    }
  });

  it("只读视图 `CoreContext` 上仍然取不到这三个 setter（可写面只属持有者，不外泄）", () => {
    // 与上一组里的「可结构化当作 CoreContext 使用」那条配对：同一个对象，
    // 经 `RuntimeContext` 静态类型可写、经 `CoreContext` 静态类型不可写。
    // 这条边界一破，「谁有权换总线」就变成「谁都能换」，而换总线要连带重绑
    // bridge/lifecycle/终态 publisher 三处订阅。
    const readonlyView: CoreContext = makeContext().ctx;
    const attemptWrite = (view: CoreContext): void => {
      // @ts-expect-error CoreContext 是只读视图：没有 setConfig
      view.setConfig(view.config);
    };

    expect(readonlyView).toBeInstanceOf(RuntimeContext);
    expect(attemptWrite).toBeTypeOf("function");
  });
});
