import { configAccessorFromStore, type ConfigAccessor } from "@/config/index.js";
import { ConfigStore, type AppConfig, type ConfigKey } from "@/config/index.js";

/** 每个 Vitest fork 内的测试配置实例；生产代码不存在同类全局 store。 */
export const testConfigStore = new ConfigStore();
export const testConfig: ConfigAccessor = configAccessorFromStore(testConfigStore);

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
