/**
 * @fileoverview 配置访问器 → 名单数据源**接线**的翻译层
 * @module config/acl-locator
 * @description
 * 本模块是**唯一**知道「哪个配置键装名单」的地方。数据源层（`@/datasource/acl/`）拿到的是两个
 * 闭包，不认识 `ConfigAccessor` —— 于是「装配一份名单数据源」这件事可以被一个不跑代理的库调用方
 * **绕开本模块**完成（直接造 `aclLocatorFrom(driver, file)` 即可）。
 *
 * 边界的判据是**类型**而不是约定：数据源层一旦 import `@/config/index.js`，「不启动代理、
 * 单独用一个数据源」那条路就在类型上不成立了。
 *
 * ## 为什么两个闭包都是**现取**
 *
 * `driver()` / `path()` 每次调用都重读配置，故「热改 `ACL_DRIVER` / `ACL_FILE`」在**下一次读**
 * 即生效。烤成常量会让「换个名单文件」静默失效——那正是它**看起来生效了、实际没换**的那类故障。
 *
 * ## 为什么记忆表挂在 `ConfigAccessor` 上
 *
 * 判定热路径（`core/access-control.ts:compiled`）每连接都要读名单。若接线每次现造，下游的
 * 实现器记忆（按接线对象分槽）会**全部落空**，等价于每个请求 new 一个数据源。故同一个 accessor
 * 恒返回**同一个**接线对象；`WeakMap` 让它随 accessor 一起被回收，不留悬垂引用
 * （与 `core/access-control.ts:compiledCaches`、`src/datasource/users` 的读面同一手法）。
 */

import type { ConfigAccessor } from "./context.js";
import type { DataSourceDriver } from "@/datasource/driver.js";
import type { AclLocator } from "@/datasource/acl/index.js";

/**
 * 由两个平值造一条接线（**不记忆**）
 * @description 供 store 提交**之前**的一次性装配使用（`loadConfig` 的启动期强校验：那一步只有
 * `resolved` 那一份，没有 accessor 可挂记忆）。
 * @param driver - 已解析的驱动名
 * @param file - `ACL_FILE` 的值
 */
export function aclLocatorFrom(driver: DataSourceDriver, file: string): AclLocator {
  return {
    driver: () => driver,
    path: () => file,
  };
}

const locatorCache = new WeakMap<ConfigAccessor, AclLocator>();

/**
 * 由配置访问器造一条接线（**按 accessor 记忆**）
 * @description 同一个 accessor 恒返回**同一个**对象，故下游的实现器记忆跨调用命中。
 * 接线内部的两个闭包每次现读，故「热改驱动 / 热改路径」在**下一次读**即生效。
 * @param config - 配置访问器（驱动与路径都从它现读）
 */
export function aclLocatorFor(config: ConfigAccessor): AclLocator {
  const cached = locatorCache.get(config);
  if (cached !== undefined) {
    return cached;
  }
  const locator: AclLocator = {
    driver: () => config.get("aclDriver"),
    path: () => config.get("aclFile"),
  };
  locatorCache.set(config, locator);
  return locator;
}