/**
 * @fileoverview 数据源**注册表**：驱动名 → 工厂
 * @module datasource/registry
 * @description
 * 一张注册表回答一个问题：**「这个驱动名背后是谁」**。三类数据源各有各的端口类型，
 * 所以是三张同形的表（`createSourceRegistry` 是唯一的构造入口，保证三张表形状逐字相同）。
 *
 * ## 判据：注册表里有没有这一项
 *
 * 驱动名是开放集合（见 `./driver.ts`），所以「合法」不由类型系统而由本模块回答。非法驱动名
 * **在 `resolve` 时抛错**并列出全部已注册项——不是静默回落到内置档：**回落会让用户以为配生效了**。
 *
 * ⚠️ **注册是模块级的可变全局状态**，它带来一条真实的顺序约束：
 * **库调用方必须先注册、再建 runtime**（`createProxyRuntime` / `loadConfig` 之后的任何装配）。
 * 反过来（先建 runtime 后注册）不会崩，但**那一次装配解析不到新驱动**，于是抛
 * 「驱动未注册」并列出当时已注册的项。判据故意做成**只在装配时报**而不是在注册时报，
 * 因为「谁还没注册」只有装配那一刻才知道。
 *
 * ## 为什么退订闭包只删自己写的那一项
 *
 * `registerPreset`（`config/presets.ts`）已经裁决过同一条：`override: true` 覆盖之后，
 * 先前那个注册方调退订**不许**把覆盖它的项删掉。所以每张表的退订都带
 * 「当前值仍是我写的吗」这道自查。
 *
 * @example
 * ```ts
 * const off = registerAccountSource("mysql", (locator) => new MysqlAccountSource(...));
 * off();  // 幂等；已被别人覆盖过则不删
 * ```
 */

import { unknownDriverError } from "./driver.js";

/** 一个驱动名对应的那份东西（三类数据源分别是端口实现器 / 账本 / 名单读取面）。 */
export type SourceFactory<T> = T;

/** 一张注册表。`T` 是该类数据源的「驱动实现」类型。 */
export interface SourceRegistry<T> {
  /**
   * 注册一个驱动名
   * @param driver - 驱动名。**大小写与前缀一律自负**（本仓不规范化）
   * @param factory - 该驱动的实现
   * @param options - `override: true` 才允许覆盖已有注册项
   * @returns 幂等的退订函数
   * @throws 重名且未给 `override` 时抛错（**不静默替换**）
   */
  register(driver: string, factory: SourceFactory<T>, options?: { override?: boolean }): () => void;
  /** 该驱动名是否已注册（**装配前的自查用**，避免靠捕获异常判断）。 */
  has(driver: string): boolean;
  /** 取已注册的工厂；未注册返回 `undefined`（**不抛**——`resolve` 才抛）。 */
  get(driver: string): SourceFactory<T> | undefined;
  /** 全部已注册驱动名（含内置项），供错误信息与诊断用。 */
  list(): string[];
  /**
   * 按驱动名取工厂，**未注册即抛错**
   * @throws 错误文本点名驱动名并列出全部已注册项
   */
  resolve(driver: string): SourceFactory<T>;
}

/**
 * 造一张注册表
 * @param kind - 数据源种类（人读的名，进错误文本）
 * @param builtin - 内置项（`Record<驱动名, 实现>`，在**构造时**就写入，故 `list()` 首次即含内置）
 */
export function createSourceRegistry<T>(
  kind: string,
  builtin: Readonly<Record<string, SourceFactory<T>>>,
): SourceRegistry<T> {
  const registry = new Map<string, SourceFactory<T>>(Object.entries(builtin));
  return {
    register(driver, factory, options) {
      if (options?.override !== true && registry.has(driver)) {
        throw new Error(`${kind}驱动 ${JSON.stringify(driver)} 已注册（要覆盖请给 { override: true }）`);
      }
      registry.set(driver, factory);
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        // 退订只删自己写入的那一项：同名已被覆盖时不删除。
        if (registry.get(driver) === factory) {
          registry.delete(driver);
        }
      };
    },
    has: (driver) => registry.has(driver),
    get: (driver) => registry.get(driver),
    list: () => [...registry.keys()],
    resolve(driver) {
      const found = registry.get(driver);
      if (found === undefined) {
        throw unknownDriverError(kind, driver, [...registry.keys()]);
      }
      return found;
    },
  };
}
