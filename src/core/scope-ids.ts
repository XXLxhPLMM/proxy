/**
 * @fileoverview 请求/连接标识生成
 * @module core/scope-ids
 * @description
 * 为事件作用域提供 `requestId` / `connectionId`。core 不直接依赖 `EventScope`
 * （那是 runtime 观察面的概念），只在协议入口需要把身份注入 `RequestTerminal`
 * 的上下文时调用本模块。
 *
 * 设计要点：
 * - `connectionId` 按底层连接（socket）缓存复用：HTTP keep-alive 下同一 TCP 连接上的
 *   多次请求共享 connectionId、requestId 各自独立；SOCKS 一连接一会话一请求，两者同值。
 * - 复用 `WeakMap<object, string>` 缓存，socket 被 GC 时条目自动回收，无泄漏。
 * - 使用 `crypto.randomUUID()` 生成，避免自增序号在多 runtime/多进程下碰撞或泄漏请求量。
 */

import { randomUUID } from "node:crypto";

/** socket → connectionId 缓存（WeakMap：socket 回收即释放）。 */
const connectionIds = new WeakMap<object, string>();

/**
 * 取（必要时生成）一条连接的 connectionId。
 *
 * @param connection - 底层连接对象（net.Socket / tls.TLSSocket / http keep-alive socket）。
 *   同一对象重复调用返回同一个 id。
 * @returns 该连接的稳定 connectionId。
 */
export function connectionIdFor(connection: object): string {
  const existing = connectionIds.get(connection);
  if (existing !== undefined) {
    return existing;
  }
  const id = randomUUID();
  connectionIds.set(connection, id);
  return id;
}

/**
 * 生成一个新的 requestId（每个逻辑请求一个，跨事件保持一致）。
 *
 * @returns 新生成的 requestId。
 */
export function newRequestId(): string {
  return randomUUID();
}
