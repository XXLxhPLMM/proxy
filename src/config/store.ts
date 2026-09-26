/**
 * 活动配置的状态容器 - 全局唯一 Map 单例
 *
 * 职责边界（刻意很窄）：
 * - 持有「当前生效的那份」配置，全进程仅此一份，所有模块经 get/set 访问
 * - 提供一次性的批量提交边界 `commitConfig`
 * - 零 IO、零解析、零默认值语义：类型契约在 `types.ts`，默认种子在 `defaults.ts`，
 *   字段怎么从字符串变成值在 `schema/`，从外部世界取值在 `source/`，
 *   整条加载编排在 `load.ts`
 *
 * 设计要点：
 * - 单例：Map 在模块加载时由 defaults 播种，之后只有 load 路径能整体替换
 * - 类型安全：key 受 ConfigKey 约束，value 自动推导为对应字段类型
 */
import { defaults } from "./defaults.js";
import type { AppConfig, ConfigKey } from "./types.js";

/** 全局单例；孤立 import 本文件时仅含 defaults，需经 load.initConfig() 才为生效值 */
export const config = new Map<ConfigKey, AppConfig[ConfigKey]>(
  Object.entries(defaults) as [ConfigKey, AppConfig[ConfigKey]][],
);

/** 读取配置；loader 未跑时仅返回 defaults 对应值 */
export function get<K extends ConfigKey>(key: K): AppConfig[K] {
  return config.get(key) as AppConfig[K];
}

/** 写入配置 */
export function set<K extends ConfigKey>(key: K, value: AppConfig[K]): void {
  config.set(key, value);
}

/**
 * 提交一份已经完成校验的完整配置候选。
 *
 * 这是配置层唯一的批量写入边界：先构造独立的 next Map，再同步替换活动
 * Map 的内容。调用方不得在提交前把 candidate 暴露给服务层，也不得在提交
 * 后继续修改原对象；ConfigService 因此不需要维护第二份长期快照。
 *
 * 字段全集以 `defaults` 为准（而非 `Object.keys(candidate)`）：候选缺字段必须
 * 失败，而不是悄悄少一个键让后续 get() 读到 undefined。
 */
export function commitConfig(candidate: Readonly<AppConfig>): void {
  const keys = Object.keys(defaults) as ConfigKey[];
  const next = new Map<ConfigKey, AppConfig[ConfigKey]>();
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
      throw new Error(`配置提交失败: 缺少配置字段 ${key}`);
    }
    next.set(key, candidate[key]);
  }

  // Map 没有外部回调；这里没有 await，clear/set 对同步读取者表现为一次替换。
  config.clear();
  for (const [key, value] of next) {
    config.set(key, value);
  }
}

/** 获取全量快照（浅拷贝） */
export function getAll(): AppConfig {
  // Object.fromEntries 推断为 {[k:string]:unknown}，
  // 需经 unknown 中转至 AppConfig
  return Object.fromEntries(config) as unknown as AppConfig;
}
