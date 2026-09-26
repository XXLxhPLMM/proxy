import { configAccessorFromStore, type ConfigAccessor } from "@/config/index.js";
import { ConfigStore, type AppConfig, type ConfigKey } from "@/config/index.js";
import { EventHub } from "@/core/events/index.js";
import type { CoreContext } from "@/core/context.js";
import { createNoopLogger, type Logger } from "@/utils/logger/index.js";

/** 每个 Vitest fork 内的测试配置实例；生产代码不存在同类全局 store。 */
export const testConfigStore = new ConfigStore();
export const testConfig: ConfigAccessor = configAccessorFromStore(testConfigStore);

/** 共享测试 logger：默认 noop（不落盘、不打印），需要断言日志的用例自行注入 LoggerImpl。 */
export const testLogger: Logger = createNoopLogger();

/** 共享测试事件总线：默认不抛 listener 异常，与 runtime 自建总线同形。 */
export const testEvents = new EventHub({ onListenerError: () => undefined });

/**
 * 默认注入 core 的依赖上下文（`ProxyOptions.ctx` 的测试侧共享实例）。
 * 需要别的 accessor 时经 `testContextFor(accessor)` 派生变体，而不是就地改这个单例。
 */
export const testContext: CoreContext = Object.freeze({
  config: testConfig,
  logger: testLogger,
  events: testEvents,
});

/** 派生一个只换配置访问器的上下文变体；logger/events 与共享实例同源。 */
export function testContextFor(config: ConfigAccessor): CoreContext {
  return Object.freeze({ config, logger: testLogger, events: testEvents });
}

/** 测试兼容包装：语义仍落到上面的显式实例，不依赖生产全局单例。 */
export function get<K extends ConfigKey>(key: K): AppConfig[K] {
  return testConfigStore.get(key);
}

export function set<K extends ConfigKey>(key: K, value: AppConfig[K]): void {
  testConfigStore.set(key, value);
}

export function getAll(): AppConfig {
  return testConfigStore.getAll();
}

/** 降噪：控制台静音 + 关闭落盘。 */
export function silenceLogs(): void {
  set("logLevel", "silent");
  set("logFile", "");
}

/** 逐键快照配置；键集合由调用方决定，与 restoreConfig 配对保证原样恢复。 */
export function snapshotConfig<K extends ConfigKey>(keys: readonly K[]): Record<K, AppConfig[K]> {
  const snap = {} as Record<K, AppConfig[K]>;
  for (const key of keys) {
    snap[key] = get(key);
  }
  return snap;
}

/** 逐键恢复配置（类型桥接用最小断言，键集合与 snapshotConfig 一一对应）。 */
export function restoreConfig(snap: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(snap)) {
    set(key as ConfigKey, value as AppConfig[ConfigKey]);
  }
}
