/**
 * @fileoverview 配置读取端口（ConfigAccessor）
 * @module core/config-access
 * @description
 * core 全链路读配置的唯一入口：本文件定义一个极小的读取端口 `ConfigAccessor`，
 * 令「core 读哪份配置」成为**可注入的参数**，而不是隐式绑死在全局 Map 上。
 *
 * 背景：
 * - 本仓库要作为第三方库被嵌入，一个宿主进程里可能同时跑**多份互不干扰的配置**
 *   （各自的 `ConfigStore`：不同监听端口、不同上游、不同鉴权与名单）。
 * - 若 core 内部直接 `import { get } from "@/config/store.js"`，即使外面建了私有
 *   store，鉴权 / ACL / 路由 / 转发仍会读全局值——多实例互相串号。
 * - 故 core 侧一律经本端口读值：构造期注入，缺省落到全局单例（行为与改造前逐字一致）。
 *
 * 设计要点：
 * - 极小面：只有 `get`（读单键）与 `getAll`（全量快照），**刻意不含 `set`**
 *   ——core 是配置的消费者，不是写入方；写入归 `config/store` 与 `loader`。
 * - 零 IO：端口自身不读 env / 文件 / `process.env`，值从哪来由注入方决定。
 * - type-only 反向依赖：本文件对 `@/config/store` 只需类型（`AppConfig`/`ConfigKey`），
 *   但 `globalConfigAccessor` 需要运行时的 `get`/`getAll`，故 store 是**唯一**运行时依赖。
 * - 与 `ConfigStore` 结构兼容：`ConfigStore` 已具备同名同签名的 `get`/`getAll`，
 *   因此 `configAccessorFromStore` 只是一层薄转接，不复制任何逻辑。
 *
 * 使用示例：
 * ```ts
 * import { ConfigStore } from "@/config/store.js";
 * import { configAccessorFromStore } from "@/core/config-access.js";
 *
 * // 1) CLI 模式（缺省）：不传即读全局单例，行为与改造前完全一致
 * const proxy = new HttpProxy({ port: 7890 });
 *
 * // 2) 库模式（多实例隔离）：传入私有 store 派生出的访问器
 * const store = new ConfigStore({ port: 9101, proxyMode: "client" });
 * const proxy = new HttpProxy({ config: configAccessorFromStore(store) });
 * ```
 */

import { get, getAll, type AppConfig, type ConfigKey, type ConfigStore } from "@/config/store.js";

/**
 * 配置读取端口：core 全链路只认这个，不直接碰全局 Map
 * @description
 * 结构上与 `ConfigStore` 的读侧同形（`get`/`getAll`），因此二者可互换注入；
 * 刻意**不含写入能力**——core 只消费配置，写入归 `config/store` 与 `config/loader`。
 * @param key - 配置键
 * @returns 该键的生效值（loader 未跑时为 `defaults` 对应值）
 * @example accessor.get("proxyMode") // => "server" | "client"
 */
export interface ConfigAccessor {
  get<K extends ConfigKey>(key: K): AppConfig[K];
  getAll(): AppConfig;
}

/**
 * 绑定全局单例的默认访问器（保持现有行为）
 * @description
 * 全程委托给 `config/store` 的全局 `get`/`getAll`——**逐键等值于改造前的裸读**，
 * 因此所有未显式注入访问器的调用方（CLI 链路、既有测试）行为完全不变。
 * @example globalConfigAccessor.get("port") // === get("port")
 */
export const globalConfigAccessor: ConfigAccessor = {
  get: <K extends ConfigKey>(key: K): AppConfig[K] => get(key),
  getAll: (): AppConfig => getAll(),
};

/**
 * 从 ConfigStore 派生访问器（库模式多实例隔离用）
 * @description
 * 薄转接：每次读都落到给定 `ConfigStore` 的实例值，与全局单例**零共享**。
 * 不做缓存也不做快照记忆——store 自身承担热改语义，`get` 每次现读，
 * 故 `store.set(...)` 之后下一次请求即生效（与全局单例的 `set()` 热改语义同源）。
 * @param store - 目标 store（通常是某个 runtime 私有的 `ConfigStore`）
 * @returns 绑定该 store 的访问器，可注入 `ProxyOptions.config` 或各构造函数的可选参数
 * @example configAccessorFromStore(new ConfigStore({ proxyMode: "client" })).get("proxyMode") // => "client"
 */
export function configAccessorFromStore(store: ConfigStore): ConfigAccessor {
  return {
    get: <K extends ConfigKey>(key: K): AppConfig[K] => store.get(key),
    getAll: (): AppConfig => store.getAll(),
  };
}
