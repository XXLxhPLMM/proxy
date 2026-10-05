/**
 * `runtime/context.ts` 的运行时依赖持有者 + `core/context.ts` 的承载体接口：本档只答一件事 ——
 * 依赖三件套（config / logger / events）从谁进来到谁手上。三个 `protected` getter（组件侧的窄化
 * 投影）与三个 `public` setter（库调用方唯一的运行期热换入口）是**同一份可写面的两头**，故
 * 「getter 保持 protected」与「setter 保持 public」必须同档钉住。
 * ⚠️ 「三个 setter 为何在 `src/` 内零调用方」与「`base.ts` 那条禁缓存 `events` 的纪律在本仓没有
 * 运行时保障」的完整论证在 `./AGENTS.md`。
 */
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
import { get } from "../../helpers/config.js";

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