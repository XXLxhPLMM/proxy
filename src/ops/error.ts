/**
 * @fileoverview ops 层的失败词汇：`OpsError` 与它的**原因分类**
 * @module ops/error
 * @description
 * ops 层把「这件事没做成」表达成**抛错**，并把**为什么**编码进 `code` 而不是编码进文案。文案是
 * 给人读的、每条都随上下文变化；`code` 是给传输层读的、**闭合且稳定**。判据：
 * **文案随便改，`code` 不许增殖**——每加一个 `code` 就是给「同一种失败两个名字」开一扇门。
 *
 * ## 为什么单独一个文件
 *
 * `OpsError` 被本层**每一个**模块抛出，而本目录内**禁止自我引用 barrel**（见根 `AGENTS.md`
 * 的 import 路径规约：barrel 会把兄弟模块全部拉进循环依赖图）。故它住在 `./error.js`，
 * 由 `./index.js` 转发出去。
 *
 * ## 为什么本层不定义「用户怎么看到这条错」
 *
 * 呈现与退出码归传输层。传输层**不得**拿 `code` 改文案：同一件事说两种话，是「两个入口对不上」
 * 那类配置事故的另一种形态——而本层存在的全部意义就是消灭它。
 *
 * @module
 */

/**
 * 失败原因的闭合分类
 * @description
 * - `not-found` — 目标不存在（账号表里没有这个用户名、账本里没有这个用户的记录）
 * - `already-exists` — 目标已存在，而这次调用要求它**不存在**
 * - `invalid` — 调用方给的那几个参数**组合**不成立（字段互相依附、条目语法不合法）
 * - `read-only-driver` — 这份驱动没有实现写面
 * - `source-unreadable` — 内容读不到，或形状校验判它非法
 */
export type OpsErrorCode =
  | "not-found"
  | "already-exists"
  | "invalid"
  | "read-only-driver"
  | "source-unreadable";

/** ops 层的操作失败 */
export class OpsError extends Error {
  /** 失败原因（**不是**文案；映射状态码之类的事归传输层） */
  public readonly code: OpsErrorCode;

  public constructor(code: OpsErrorCode, message: string) {
    super(message);
    this.name = "OpsError";
    this.code = code;
  }
}