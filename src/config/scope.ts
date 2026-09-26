/**
 * 实例配置作用域 - 每实例一份的活配置容器
 *
 * 职责（刻意很窄）：
 * - 持有「本实例当前生效的那份」配置；**进程内可以有任意多个 scope，互不可见**
 * - 提供事务式批量提交边界 `commit`
 * - 零 IO、零解析、零默认值语义：类型契约在 `types.ts`，默认种子在 `defaults.ts`，
 *   字段怎么从字符串变成值在 `schema/`，从外部世界取值在 `source/`，
 *   整条加载编排在 `load.ts`
 *
 * 设计要点：
 * - **替代模块级单例**：此前 `store.ts` 导出 `const config = new Map(...)`，
 *   全进程唯一一份，所有调用点裸 `get("x")`。同进程跑第二个实例时，
 *   它的 `get("authType")` 必然读到第一个实例 reload 后的值——多实例根本不可能。
 *   现在每个实例持有自己的 scope，配置随实例走。
 * - **活的，不是快照**：`get()` 每次都读当前 Map，`commit()` 之后的调用立刻看到新值。
 *   这是热加载语义的前提（`Auth`/ACL/路由判定都靠「每请求重读」实现零重启生效），
 *   所以**禁止**把 scope 换成构造时的冻结快照。
 * - 类型安全：key 受 `ConfigKey` 约束，value 自动推导为对应字段类型。
 */
import { defaults } from "./defaults.js";
import type { AppConfig, ConfigKey } from "./types.js";

/**
 * 实例配置作用域的公开契约。
 *
 * 调用方只经这三个方法接触配置；**不存在**模块级 `get`/`set` 自由函数，
 * 任何需要配置的地方都必须显式拿到一个 scope（由组合根注入）。
 */
export interface ConfigScope {
  /** 读取单个字段；loader 未跑时返回播种值（通常是 defaults 或调用方传入的 seed）。 */
  get<K extends ConfigKey>(key: K): AppConfig[K];
  /** 全量快照（浅拷贝）；调用方不得原地修改返回值。 */
  getAll(): AppConfig;
  /**
   * 事务式提交一份已完成校验的完整候选。
   *
   * 这是配置层唯一的批量写入边界：先构造独立的 next Map，再同步替换活动 Map。
   * 字段全集以 `defaults` 为准，候选缺字段必须失败（而不是悄悄少一个键让
   * 后续 `get()` 读到 undefined）。
   *
   * @throws 候选缺少 defaults 中的任一字段
   */
  commit(candidate: Readonly<AppConfig>): void;
}

const CONFIG_KEYS = Object.keys(defaults) as ConfigKey[];

/**
 * 创建一个配置作用域。
 *
 * @param seed - 初始候选；缺字段回退 `defaults`。传入的是完整 AppConfig 时
 *               行为等价于「已加载」；库调用方通常用它注入实例差异化配置。
 * @throws seed 含 defaults 之外的未知键（拼写错误必须在构造期暴露，不能静默丢弃）
 */
export function createConfigScope(seed?: Partial<AppConfig>): ConfigScope {
  const active = new Map<ConfigKey, AppConfig[ConfigKey]>(
    Object.entries(defaults) as [ConfigKey, AppConfig[ConfigKey]][],
  );

  if (seed !== undefined) {
    for (const key of Object.keys(seed) as ConfigKey[]) {
      if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
        throw new Error(`配置作用域创建失败: 未知配置字段 ${String(key)}`);
      }
    }
    for (const key of CONFIG_KEYS) {
      const value = seed[key];
      if (value !== undefined) {
        active.set(key, value as AppConfig[ConfigKey]);
      }
    }
  }

  return {
    get<K extends ConfigKey>(key: K): AppConfig[K] {
      return active.get(key) as AppConfig[K];
    },

    getAll(): AppConfig {
      // Map 的快照必须换新对象：调用方拿到的是独立副本，改它不会污染 scope
      return Object.fromEntries(active) as unknown as AppConfig;
    },

    commit(candidate: Readonly<AppConfig>): void {
      const next = new Map<ConfigKey, AppConfig[ConfigKey]>();

      for (const key of CONFIG_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
          throw new Error(`配置提交失败: 缺少配置字段 ${key}`);
        }
        next.set(key, candidate[key]);
      }

      // Map 没有外部回调；这里没有 await，clear/set 对同步读取者表现为一次替换。
      active.clear();
      for (const [key, value] of next) {
        active.set(key, value);
      }
    },
  };
}
