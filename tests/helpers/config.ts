import { get, set } from "@/config/store.js";
import type { AppConfig, ConfigKey } from "@/config/store.js";

/** 降噪：控制台静音 + 关闭落盘（等价于 set("logLevel","silent") + set("logFile","")） */
export function silenceLogs(): void {
  set("logLevel", "silent");
  set("logFile", "");
}

/** 逐键快照配置；键集合由调用方决定，与 restoreConfig 配对保证原样恢复 */
export function snapshotConfig<K extends ConfigKey>(keys: readonly K[]): Record<K, AppConfig[K]> {
  const snap = {} as Record<K, AppConfig[K]>;
  for (const key of keys) {
    snap[key] = get(key);
  }
  return snap;
}

/** 逐键恢复配置（类型桥接用最小断言，键集合与 snapshotConfig 一一对应） */
export function restoreConfig(snap: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(snap)) {
    set(key as ConfigKey, value as AppConfig[ConfigKey]);
  }
}
