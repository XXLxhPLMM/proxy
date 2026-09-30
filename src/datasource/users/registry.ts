/**
 * @fileoverview 账号数据源的**驱动注册表**：驱动名 → 工厂
 * @module datasource/users/registry
 * @description
 * 一张表回答「`AUTH_USERS_DRIVER` 里那个字符串背后是谁」。判据是**注册表里有没有这一项**
 * （见 `../registry.ts` 文件头：驱动名是开放集合，闭合性由运行时事实而非类型系统保证）。
 *
 * ## 为什么 {@link accountSourceFor} 记忆的是「实现器」而不是「路径」
 *
 * 实现器持有的是一个**路径闭包**（`../users/types.ts:PathResolver`），路径在**每次读**的时候
 * 现取。`AUTH_USERS_FILE` 是 runtime 相位——烤进去就让「热改路径」永远不生效，而那份失效
 * 表现为「换文件后仍读旧文件」，在测试里是「账号表读出来是空的」，极难定位。
 *
 * 记忆表的键因此是**接线对象**（`AccountLocator`）而不是路径字符串：接线对象由装配层按
 * `ConfigAccessor` 长期持有（`WeakMap` 让它随 accessor 一起被回收），而它内部的两个闭包
 * 每次都现读，于是「换驱动 / 换路径」都在**下一次 `list()`** 生效，无需重建任何东西。
 *
 * ## 未注册驱动必须抛错，绝不落到内置档
 *
 * 驱动名是开放集合，而 `else → JsonAccountSource` 会把 `AUTH_USERS_DRIVER=mysql` 变成
 * 「静默按 json 跑」——用户以为接上了数据库，实际读的是 `users.json`。判据在**装配点**
 * （本模块）而不是配置层，因为「有哪些驱动」是注册表这个运行时事实。
 */

import { BUILTIN_ACCOUNT_DRIVERS, type DataSourceDriver } from "../driver.js";
import { createSourceRegistry } from "../registry.js";
import { JsonAccountSource } from "./json-source.js";
import { SqliteAccountSource } from "./sqlite-source.js";
import type { AccountLocator, AccountSource, AccountSourceFactory } from "./types.js";

/** 本数据源的实现器记忆表：`接线对象 → (驱动名 → 实现器)`（见文件头的理由） */
const sourceCache = new WeakMap<AccountLocator, Map<DataSourceDriver, AccountSource>>();

/** 内置两档工厂（`json` 读一个文件、`sqlite` 开一个库，除此之外两者**逐条同形**） */
const BUILTIN_ACCOUNT_SOURCES: Readonly<Record<string, AccountSourceFactory>> = Object.freeze({
  [BUILTIN_ACCOUNT_DRIVERS.json]: (locator) => new JsonAccountSource(locator),
  [BUILTIN_ACCOUNT_DRIVERS.sqlite]: (locator) => new SqliteAccountSource(locator),
});

const accountSources = createSourceRegistry<AccountSourceFactory>("账号表", BUILTIN_ACCOUNT_SOURCES);

/**
 * 注册一个账号数据源驱动
 * @param driver - 驱动名（开放集合；大小写与前缀一律自负）
 * @param factory - 该驱动的实现器工厂（**只吃路径闭包**，不认识任何配置端口）
 * @param options - `override: true` 才允许覆盖已有注册项
 * @returns 幂等的退订函数（已被别人覆盖过时退订**不删**别人的项）
 * @throws 重名且未给 `override` 时抛错（**不静默替换**）
 * @description ⚠️ 注册是**模块级可变全局状态**，带来一条真实的顺序约束：**先注册、再装配**
 * （`createProxyRuntime` / `loadConfig` 之前的任何时刻）。反过来不会崩，但**那一次装配解析不到
 * 新驱动**，于是抛「驱动未注册」并列出当时已注册的项。
 */
export function registerAccountSource(
  driver: string,
  factory: AccountSourceFactory,
  options?: { override?: boolean },
): () => void {
  return accountSources.register(driver, factory, options);
}

/** 全部已注册驱动名（含内置两档），供诊断与错误信息用 */
export function listAccountSourceDrivers(): readonly string[] {
  return accountSources.list();
}

/** 按驱动名取工厂，**未注册即抛错**（错误文本点名驱动名并列出全部已注册项） */
export function resolveAccountSource(driver: DataSourceDriver): AccountSourceFactory {
  return accountSources.resolve(driver);
}

/**
 * 按接线解析出该用哪个实现器（**带记忆**）
 * @description
 * 记忆的**只有「实现器是哪一个」**——路径由闭包现取（见 {@link PathResolver}）。反过来做
 * （把路径烤进实现器再记忆）会让「热改 `AUTH_USERS_FILE`」静默失效。
 *
 * ⚠️ **未注册驱动必须抛错，绝不落到 `json` 那一支**（理由见文件头）。
 * @param locator - 装配接线（驱动名与路径都是现取）
 * @param forceDriver - 显式指定后端（**启动期校验专用**：那处要在一个明确的后端上读，
 *   不该被热改影响）。缺省 = 按 `locator` 现读
 * @param pathOverride - 显式路径覆盖。⚠️ **只对 JSON 档有意义**（它就是「换个文件读」）；
 *   SQLite 档下会被忽略。传了它就**不进记忆表**（那个实现器带着一次性的路径，不该被后续
 *   调用复用）。
 */
export function accountSourceFor(
  locator: AccountLocator,
  forceDriver?: DataSourceDriver,
  pathOverride?: string,
): AccountSource {
  const driver: DataSourceDriver = forceDriver ?? locator.driver();
  let byDriver = sourceCache.get(locator);
  if (byDriver === undefined) {
    byDriver = new Map<DataSourceDriver, AccountSource>();
    sourceCache.set(locator, byDriver);
  }
  const cached = byDriver.get(driver);
  if (cached !== undefined && pathOverride === undefined) {
    return cached;
  }
  const factory = resolveAccountSource(driver);
  const created = factory(() => (pathOverride ?? locator.pathFor(driver)));
  if (pathOverride === undefined) {
    byDriver.set(driver, created);
  }
  return created;
}
