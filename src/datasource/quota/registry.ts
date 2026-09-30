/**
 * @fileoverview 配额账本的**驱动注册表**：驱动名 → 用量数据源工厂
 * @module datasource/quota/registry
 * @description
 * 账本从「配置里挑一个实现器的三元」变成「注册表里的一项」。判据没变——**未注册即抛错**，
 * 而不是静默回落到某一支（回落会让用户以为配生效了，实际接上的是别的后端，那比报错贵得多）。
 *
 * ## 为什么「有哪些驱动」是运行时事实而不是类型
 *
 * 驱动名是**开放集合**（`@/datasource/driver.ts` 有一整段论证）：库调用方可以
 * `registerUsageSource("mysql", …)` 插进任意名字，而「不启动代理、单独用一个数据源」这条路
 * 压根不经过配置层。闭合联合 `QUOTA_LEDGER_DRIVER` 能给的只有编译期穷尽性，代价是**第三方驱动
 * 在类型上不存在**。
 *
 * ## 与配置侧的词汇对照（唯一一处翻译）
 *
 * `quotaLedgerDriver`（`src/config/schema/fields.ts` 的 startup 相位字段，env
 * `QUOTA_LEDGER_DRIVER`）的值就是喂给 {@link resolveUsageSource} 的驱动名；两个内置项的名字由
 * `BUILTIN_LEDGER_DRIVERS` 给出（`json` / `sqlite`）。配置侧保留「账本 / ledger」的词汇是部署
 * 面上「这些字节记在哪」的既有说法，本层不改它。
 *
 * ## 顺序约束（继承 `createSourceRegistry` 那条）
 *
 * **库调用方必须先注册、再建 runtime**。反过来不会崩，但**那一次装配解析不到新驱动**，于是
 * 抛「驱动未注册」并列出当时已注册的项。判据故意做成**只在装配时报**而不是在注册时报，因为
 * 「谁还没注册」只有装配那一刻才知道。
 *
 * @example
 * const off = registerUsageSource("mysql", (spec) => new MysqlUsageSource(spec));
 * off();  // 幂等；已被别人覆盖过则不删
 * // 之后 buildDefaultServices({ quotaLedgerDriver: "mysql" }) 就会用上它
 */

import { BUILTIN_LEDGER_DRIVERS } from "@/datasource/driver.js";
import { createSourceRegistry } from "@/datasource/registry.js";
import { JsonlUsageSource } from "./jsonl-source.js";
import { SqliteUsageSource } from "./sqlite-source.js";
import type { UsageSourceFactory } from "./types.js";

/**
 * 账本驱动注册表（模块级可变状态，见文件头的顺序约束）
 * @description **构造时**就写入两个内置项，故 `list()` 首次即含 `json` / `sqlite`——错误信息里
 * 「已注册」那一份从第一次装配起就是完整的。
 */
const usageSources = createSourceRegistry<UsageSourceFactory>("配额账本", {
  /** json 档：单文件 JSONL、零原生依赖、人肉可读（`grep | awk` 可直接统计）。 */
  [BUILTIN_LEDGER_DRIVERS.json]: (spec) => new JsonlUsageSource(spec),
  /** sqlite 档：单个库文件，累加是数据库内部的原子 UPSERT（无 json 档那个压缩窗口）。 */
  [BUILTIN_LEDGER_DRIVERS.sqlite]: (spec) => new SqliteUsageSource(spec),
});

/**
 * 注册一个账本驱动名
 * @param driver - 驱动名。**大小写与前缀一律自负**（本层不规范化）
 * @param factory - 该驱动的实现
 * @param options - `override: true` 才允许覆盖已有注册项（内置两项也算）
 * @returns 幂等的退订函数；退订**只删自己写的那一项**（已被别人覆盖时不删）
 * @throws 重名且未给 `override` 时抛错（**不静默替换**）
 */
export function registerUsageSource(
  driver: string,
  factory: UsageSourceFactory,
  options?: { override?: boolean },
): () => void {
  return usageSources.register(driver, factory, options);
}

/** 全部已注册账本驱动名（含内置两项），供诊断与错误信息用。 */
export function listUsageSourceDrivers(): string[] {
  return usageSources.list();
}

/** 某个驱动名是否已注册（**装配前的自查用**，避免靠捕获异常判断）。 */
export function hasUsageSource(driver: string): boolean {
  return usageSources.has(driver);
}

/**
 * 按驱动名取工厂，**未注册即抛错**
 * @param driver - 配置里的 `quotaLedgerDriver` 值
 * @throws 错误文本点名驱动名并列出全部已注册项（拼错是部署出错最常见的成因）
 */
export function resolveUsageSource(driver: string): UsageSourceFactory {
  return usageSources.resolve(driver);
}
