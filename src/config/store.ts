/**
 * 配置存放位置 - 全局唯一
 * 职责：定义配置类型 + 持有全局 Map 单例，不做任何 IO
 * 设计要点：
 * - 单例：整个进程仅此一份 Map，所有模块通过 get/set 访问同一份数据
 * - 类型安全：key 受 ConfigKey 约束，value 自动推导为对应字段类型
 * - 默认值：defaults 在模块加载时一次性写入 Map，后续 loader 覆盖
 */

/** 缓存类型，memory=纯内存，redis=Redis（失败自动降级至内存） */
export type CacheType = "memory" | "redis";

export interface AppConfig {
  /** 服务监听端口，默认 3000 */
  port: number;
  /** 缓存实现类型，默认 memory */
  cacheType: CacheType;
}

/** Map 的合法 key 集合，新增 AppConfig 字段时自动扩展 */
export type ConfigKey = keyof AppConfig;

/** 默认配置，作为 Map 初始值 */
const defaults: AppConfig = {
  port: 3000,
  cacheType: "memory",
};

/**
 * 全局配置 Map
 * - key 类型受 ConfigKey 约束，非法 key 编译期报错
 * - 初始化时由 defaults 填充，确保 get 调用始终有值
 */
export const config = new Map<ConfigKey, AppConfig[ConfigKey]>(
  Object.entries(defaults) as [ConfigKey, AppConfig[ConfigKey]][],
);

/**
 * 读取配置
 * @param key - 配置键名，受 ConfigKey 类型限制
 * @returns 对应类型的配置值
 */
export function get<K extends ConfigKey>(key: K): AppConfig[K] {
  return config.get(key) as AppConfig[K];
}

/**
 * 写入配置
 * @param key - 配置键名
 * @param value - 与 key 对应的值类型，类型不匹配编译期报错
 */
export function set<K extends ConfigKey>(key: K, value: AppConfig[K]): void {
  config.set(key, value);
}

/**
 * 获取全量配置快照
 * @returns 浅拷贝的 AppConfig 对象
 */
export function getAll(): AppConfig {
  // Object.fromEntries 推断为 {[k:string]:unknown}，需经 unknown 中转至 AppConfig
  return Object.fromEntries(config) as unknown as AppConfig;
}

/**
 * 判断配置是否存在
 * @param key - 配置键名
 */
export function has(key: ConfigKey): boolean {
  return config.has(key);
}
