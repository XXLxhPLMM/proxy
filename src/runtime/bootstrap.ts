import { Context, type Fiber, type Plugin } from "cordis";
import type { ConfigService } from "./config-service.js";
import { createConfigPlugin } from "./config-plugin.js";
import { createErrorService, type ErrorService } from "./error-service.js";
import { createErrorPolicyPlugin } from "./error-policy.js";
import { createEventDispatcher } from "./event-dispatch.js";
import type { LoggerService } from "./logger-service.js";
import { createLoggerPlugin } from "./logger-plugin.js";
import type { PresetService } from "./preset-service.js";
import { createPresetPlugin } from "./preset-plugin.js";
import type { ProxyService } from "./proxy-service.js";
import { createObserverPlugin, createStartupJournal } from "./observer-plugin.js";
import type { RuntimeEventObserver, StartupFact } from "./events.js";
import { createProxyLifecyclePlugin, createProxyServicePlugin } from "./plugins.js";

export type { RuntimeEventEnvelope, RuntimeEventObserver, StartupFact } from "./events.js";

export interface RuntimeOptions {
  readonly config?: ConfigService;
  readonly preset?: PresetService;
  readonly logger?: LoggerService;
  readonly error?: ErrorService;
  /** 单次事件观察 deadline；非正数/非有限值回退安全默认值。 */
  readonly eventObservationDeadlineMs?: number;
  /** 单次 proxy service start/stop deadline；非正数/非有限值回退 15000ms。 */
  readonly serviceOperationDeadlineMs?: number;
  /** 只接收已重建冻结的安全 runtime event envelope；失败不会阻塞 runtime。 */
  readonly eventObserver?: RuntimeEventObserver;
}

export interface RuntimeHandle {
  readonly context: Context;
  /** 启动关键事实的有界只读快照；不包含完整配置或运行时噪声。 */
  readonly startupFacts: readonly StartupFact[];
  /** 返回新的只读启动事实快照，便于 handle 时序记录。 */
  replayStartup(): readonly StartupFact[];
  stop(): Promise<void>;
}

class DisposalTracker {
  private failed = false;
  private firstError: unknown;

  readonly record = (error: unknown): void => {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.firstError = error;
  };

  throwIfFailed(): void {
    if (this.failed) {
      throw this.firstError;
    }
  }
}

async function mountPlugin(context: Context, plugin: Plugin, fibers: Fiber[]): Promise<void> {
  const fiber = context.plugin(plugin);
  fibers.push(fiber);
  await fiber;
}

/** 启动失败时尽力清理，但 cleanup error 不能覆盖原始启动错误。 */
async function disposeAfterFailure(fibers: Fiber[]): Promise<void> {
  for (const fiber of [...fibers].reverse()) {
    try {
      await fiber.dispose();
    } catch {
      // Cordis 之外的异常同样不能覆盖启动主因。
    }
  }
}

/** 正常停止时按依赖逆序释放；全部清理后抛出首个业务/清理错误。 */
async function disposeFibers(fibers: Fiber[], tracker: DisposalTracker): Promise<void> {
  for (const fiber of [...fibers].reverse()) {
    try {
      await fiber.dispose();
    } catch (error) {
      tracker.record(error);
    }
  }
  tracker.throwIfFailed();
}

/**
 * 启动 Cordis 运行时适配层。
 * 依赖顺序固定为 observer → logger → config → preset → error policy → proxy provider → lifecycle。
 */
export async function startRuntime(
  service: ProxyService,
  options: RuntimeOptions = {},
): Promise<RuntimeHandle> {
  if (options.preset && !options.config) {
    throw new Error("preset service requires config service");
  }

  const context = new Context();
  const dispatcher = createEventDispatcher(context, {
    deadlineMs: options.eventObservationDeadlineMs,
  });
  const startupJournal = createStartupJournal();
  const errors = options.error ?? createErrorService();
  const fibers: Fiber[] = [];
  const tracker = new DisposalTracker();

  try {
    // observer 必须先于 config/preset；journal 与外部 callback 都在 dispatcher
    // 的安全重建之后旁路执行，不等待 ErrorPolicy 或外部 Promise。
    await mountPlugin(
      context,
      createObserverPlugin(dispatcher, options.eventObserver, startupJournal),
      fibers,
    );
    if (options.logger) {
      await mountPlugin(context, createLoggerPlugin(options.logger), fibers);
    }
    if (options.config) {
      await mountPlugin(context, createConfigPlugin(options.config, dispatcher), fibers);
    }
    if (options.preset && options.config) {
      await mountPlugin(
        context,
        createPresetPlugin(options.config, options.preset, dispatcher),
        fibers,
      );
    }
    await mountPlugin(context, createErrorPolicyPlugin(errors, dispatcher), fibers);
    await mountPlugin(context, createProxyServicePlugin(service), fibers);
    await mountPlugin(
      context,
      createProxyLifecyclePlugin(
        errors,
        dispatcher,
        tracker.record,
        options.serviceOperationDeadlineMs,
      ),
      fibers,
    );

    let stopPromise: Promise<void> | undefined;
    return {
      context,
      get startupFacts(): readonly StartupFact[] {
        return startupJournal.snapshot();
      },
      replayStartup(): readonly StartupFact[] {
        return startupJournal.snapshot();
      },
      stop(): Promise<void> {
        stopPromise ??= (async () => {
          try {
            await disposeFibers(fibers, tracker);
          } finally {
            dispatcher.dispose();
          }
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    try {
      await disposeAfterFailure(fibers);
    } finally {
      dispatcher.dispose();
    }
    throw error;
  }
}
