/**
 * @fileoverview 数据源**驱动名**的词汇表：开放集合的形状 + 未知驱动的错误形态
 * @module datasource/driver
 * @description
 * 驱动名是**开放集合**——内置两项之外，库调用方可以通过 `register*` 插进任意名字。
 * 故它的类型是 `string` 而**不是**字面量联合：闭合性由**注册表里有没有这一项**保证，
 * 不由类型系统保证。
 *
 * ## 为什么把闭合性从类型层挪到注册表层
 *
 * 闭合联合（`"json" | "sqlite"`）给的是**编译期穷尽性**，代价是**第三方驱动在类型上不存在**——
 * 库调用方写 `AUTH_USERS_DRIVER=mysql` 时，那一行过不了类型检查，而运行时其实完全可行。
 * 更糟的是它把「有哪些驱动」这个**部署事实**冻进了类型：一个纯类型声明没有任何运行时后果，
 * 却让「不启动代理、单独用一个数据源」这件事在编译期就做不到。
 *
 * 换到注册表之后：
 * - **判据从「在枚举里」变成「有注册的工厂」**，而注册表是运行时事实——它对「单独使用数据源」
 *   与「经配置装配」两条路**同样成立**，这正是数据源独立于配置层的必要条件。
 * - 非法驱动名**照样启动即 abort**（未注册即 `resolve` 抛错），安全性质一条不丢。
 * - 丢掉的只有编译期穷尽性。**那不是安全性质，是提示**——而提示可以由「驱动名拼错」这条
 *   更直白的错误信息更好地提供（未注册驱动会列出全部已注册项）。
 *
 * @see ./registry.ts 注册表本体
 */

/**
 * 一个数据源的驱动名
 * @description **开放集合**：`string` 而非字面量联合，理由见文件头。自定义驱动名由
 *   `register*` 决定，本仓不预置任何约束（大小写、前缀一律由注册方自负）。
 */
export type DataSourceDriver = string;

/** 内置账号表驱动名（`cfg/users.json` / `cfg/users.db`）。 */
export const BUILTIN_ACCOUNT_DRIVERS = Object.freeze({
  json: "json",
  sqlite: "sqlite",
} as const);

/** 内置配额账本驱动名（`<dir>/usage.jsonl` / `<dir>/quota.db`）。 */
export const BUILTIN_LEDGER_DRIVERS = Object.freeze({
  json: "json",
  sqlite: "sqlite",
} as const);

/** 内置访问控制名单驱动名（`cfg/acl.json`）。 */
export const BUILTIN_ACL_DRIVERS = Object.freeze({
  json: "json",
} as const);

/**
 * 「这个驱动没人注册」的错误
 * @description **错误信息必须列出全部已注册项**：驱动名是部署事实，而部署出错时最常见的
 * 成因就是**拼错**（`sqlite` 写成 `sqlit`）。只说「未知驱动」而不说「有哪些」，等于把
 * 「打开配置看一眼」变成「去翻源码」。
 * @param kind - 数据源种类（人读的名，如「账号表」）
 * @param driver - 调用方给的驱动名
 * @param registered - 当前全部已注册驱动名
 */
export function unknownDriverError(kind: string, driver: string, registered: readonly string[]): Error {
  const known = registered.length === 0 ? "（无）" : registered.join(" / ");
  return new Error(
    `${kind}驱动 ${JSON.stringify(driver)} 未注册。已注册：${known}。自定义驱动请先调对应的 register* 函数（库调用方必须在建 runtime 之前注册）。`,
  );
}
