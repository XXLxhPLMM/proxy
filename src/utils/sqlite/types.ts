/**
 * @fileoverview SQLite 端口的类型契约（零运行时值）
 * @module utils/sqlite/types
 * @description
 * 只声明一个类型：本仓写入 SQLite 的值域。**闭合集合**——这不是「目前用到的类型」，
 * 而是「账本表里真正可能出现的类型」：用户名与窗口键是字符串，字节数是非负安全整数。
 *
 * **为什么单独成文件**：`driver.ts` 是纯接口（零运行时值），而 `index.ts` 是 barrel
 * （有 re-export）。把类型放进 barrel 会让「引入一个类型」变成一次真实的模块求值——
 * 账本是**零成本档**下不加载的路径，这个代价不该由只想引个类型的调用方付。
 */

/**
 * 可绑定到 SQL 占位符的值
 * @description **刻意不含 `boolean` / `Date` / `Uint8Array`**：它们要么被 SQLite 隐式
 * 转成 `0/1`（`true` 变 `1`，而账本没有布尔列）、要么需要显式定格式（时间戳）。
 * 收下它们只会让「这一列到底存了什么」变模糊。
 */
export type SqlValue = string | number | null;
