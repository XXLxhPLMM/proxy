/**
 * @fileoverview 响应体的**信封层**校验 —— 手抄线格式下唯一的运行期防线
 * @module api/decode
 * @description
 * ⚠️ **深字段一律不做运行期校验，这是一条取舍，不是一笔省事**。本包的对面可能跑着旧版本
 * 控制面，而消费面是**模型**而不是终端 UI：某个可选字段对不上时，模型看得懂「没有这个
 * 字段」，而一个 `TypeError` 只会让整个工具调用失败、把其余信息一起带走。故判据收到
 * 「信封」这一层：`accounts` 是数组 / `account` 是对象 / `acl` 是对象 / `usage` 是对象。
 *
 * 校验信封之外的另一半理由：**信封字段变了才是真的崩**。深层字段缺失有语义（版本差异），
 * 而信封字段改名 / 变型意味着我们连「这份响应在讲什么」都不知道 —— 那时静默返回
 * `undefined` 会让模型编出一段不存在的事实。这正是这一层存在的理由。
 *
 * 校验失败一律记 `wire` 档且 `status` 传 `null`：请求已经成功（2xx），本层看不到状态码，
 * 而编一个状态码进 `McpError` 会让模型以为「服务端拒绝了」——它没有，是格式变了。
 */

import { McpError } from "../utils/errors.js";

/**
 * 断言 `value` 是一个 JSON 对象（非数组、非 `null`）
 * @param what 人读的定位串，形如 `GET /api/users/:username 的 account` —— 它会逐字进模型上下文，
 *             所以必须自带「哪条端点的哪个字段」而不能只说「数据有问题」
 * @throws {McpError} `wire` 档
 */
export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw McpError.wire(`${what} 不是 JSON 对象`, null, null);
  }
  return value as Record<string, unknown>;
}

/**
 * 断言 `value` 是一个数组
 * @param what 同 {@link asRecord}
 * @throws {McpError} `wire` 档
 */
export function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw McpError.wire(`${what} 不是 JSON 数组`, null, null);
  }
  return value;
}
