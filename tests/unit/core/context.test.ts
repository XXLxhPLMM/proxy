import { describe, expect, it } from "vitest";
import { ConfigStore, configAccessorFromStore } from "@/config/index.js";
import type { ConfigAccessor } from "@/config/index.js";
import { ContextualBase } from "@/core/context.js";
import type { CoreContext } from "@/core/context.js";
import { EventHub } from "@/core/events/index.js";
import { RuntimeContext } from "@/runtime/context.js";
import { createNoopLogger } from "@/utils/logger/index.js";
import type { Logger } from "@/utils/logger/index.js";

/**
 * `ContextualBase` 这一层：依赖承载体只做**恒等投影**。
 *
 * 本档只答「三个 getter 恒等转发 `ctx`」与「它们保持 `protected`」；core 的层不变量归
 * `src/core/AGENTS.md`，`RuntimeContext` 那三个可写 setter 是同源旧档的另一半（归
 * `tests/unit/runtime/services.test.ts`）。⚠️ 最后那条是**编译期**护栏，只有 `pnpm typecheck`
 * 过得去 —— 改 `protected` 时别只看测试是否全绿。
 */

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