/**
 * @fileoverview 配置访问器 → 账号数据源**接线**的翻译层
 * @module config/account-locator
 * @description
 * 本模块是**唯一**知道「哪个配置键装账号表」的地方。数据源层（`@/datasource/users/`）拿到的是
 * 两个闭包，不认识 `ConfigAccessor`，于是「装配一份账号数据源」这件事可以被一个不跑代理的
 * 库调用方**绕开本模块**完成。
 *
 * ## 为什么 `pathFor` 收驱动名而不是裸路径
 *
 * 一条接线同时服务多个驱动（`AUTH_USERS_DRIVER` 是 runtime 相位，热改即换档），而每档读的
 * **不是同一个文件**。若接线只带一条路径，「sqlite 档读 `AUTH_USERS_DB`、其余读
 * `AUTH_USERS_FILE`」这条映射就会被抄进每一个读面调用点——第二份真相源。映射在本模块**一份**，
 * 读面只问「给我这个驱动的位置」。
 *
 * **非 `sqlite` 驱动（含自定义驱动）一律给 `AUTH_USERS_FILE`**：那是本仓仅有的第二个位置键。
 * 一个自带连接串的自定义驱动**可以完全忽略**这个 locator（工厂签名允许），但它若想沿用
 * 「一个文件」的位置模型，拿到的就是这一条。
 *
 * ## 为什么记忆表挂在 `ConfigAccessor` 上
 *
 * 读面有两条**每请求 / 每 chunk** 的热路径（`core/access-control.ts:loadUserPolicy`、
 * `runtime/services.ts:loadUserQuota`）。若接线对象每次现造，那两条路上会**每次分配一个对象**
 * 且下游的实现器记忆全部落空（`AccountSource` 每次重新 new）。故同一个 accessor 恒返回
 * **同一个**接线对象，`WeakMap` 让它随 accessor 一起被回收，不留悬垂引用
 * （与 `core/access-control.ts:compiledCaches`、`core/identity/factory.ts:liveSnapshots` 同一手法）。
 */

import type { ConfigAccessor } from "./context.js";
import { BUILTIN_ACCOUNT_DRIVERS, type DataSourceDriver } from "@/datasource/driver.js";
import type { AccountLocator } from "@/datasource/users/index.js";

/**
 * 内置驱动 → 账号表位置（**唯一一份**「哪个键装哪一档」的映射）
 * @description 非 `sqlite` 档（含自定义驱动）取 `AUTH_USERS_FILE`——本仓仅有的第二个位置键。
 */
function pathKeyOf(driver: DataSourceDriver): "authUsersFile" | "authUsersDb" {
  return driver === BUILTIN_ACCOUNT_DRIVERS.sqlite ? "authUsersDb" : "authUsersFile";
}

/**
 * 由三个平值造一条接线（**不记忆**）
 * @description 供 store 提交**之前**的一次性装配使用（`loadConfig` 的启动期强校验：那一步
 * 只有 `resolved` 那一份，没有 accessor 可挂记忆）。
 * @param driver - 已解析的驱动名
 * @param file - `AUTH_USERS_FILE` 的值
 * @param db - `AUTH_USERS_DB` 的值
 */
export function accountLocatorFrom(
  driver: DataSourceDriver,
  file: string,
  db: string,
): AccountLocator {
  return {
    driver: () => driver,
    pathFor: (asked) => (pathKeyOf(asked) === "authUsersDb" ? db : file),
  };
}

const locatorCache = new WeakMap<ConfigAccessor, AccountLocator>();

/**
 * 由配置访问器造一条接线（**按 accessor 记忆**）
 * @description 同一个 accessor 恒返回**同一个**对象，故下游的实现器记忆（按接线对象分槽）
 * 跨调用命中。接线内部的两个闭包每次现读，故「热改驱动 / 热改路径」在**下一次读**即生效。
 * @param config - 配置访问器（驱动与路径都从它现读）
 */
export function accountLocatorFor(config: ConfigAccessor): AccountLocator {
  const cached = locatorCache.get(config);
  if (cached !== undefined) {
    return cached;
  }
  const locator: AccountLocator = {
    driver: () => config.get("authUsersDriver"),
    pathFor: (driver) => config.get(pathKeyOf(driver)),
  };
  locatorCache.set(config, locator);
  return locator;
}
