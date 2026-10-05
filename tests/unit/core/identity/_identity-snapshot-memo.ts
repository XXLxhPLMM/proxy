/**
 * 两档共用的 `IdentityContext` 构造器与 Basic 头拼装
 *
 * @description
 * 搬自旧 `identity-snapshot-memo.test.ts` 的前导。只被一档用到的东西**刻意留档内**
 * （`signJwt` 只有热改判据那档要、`noopOnEvent` 只有失效判据那档要）——搬进来就成了一份
 * 没人能单独删掉、也没人说得清谁在用的间接层。
 *
 * ⚠️ 与 `_identity.ts` 的 `ctxWith` 是**两份而不是一份**：形状不同（这里是
 * `(headers, onAuthEvent)` 两段式、协议恒 `http`、方法恒 `GET`），那份是单一
 * `over` 对象形态。为了「少一处间接」把两种形状塞进同一个函数，得到的会是一个带
 * 四个可空形参、每个调用点都要想一遍的 `ctxWith`。
 *
 * `authority` 用 RFC 2606 保留 TLD（`.invalid`）而不是 `example.com`：后者**算公网**
 * （`.com` 之下、真的可解析），会让 B 面「未申报即红」立刻命中。本档不建链，
 * 这个字段只进审计事件的 `target`。
 *
 * 口径与理由归 `AGENTS.md`。
 */
import type http from "node:http";
import type { Duplex } from "node:stream";
import type { IdentityContext } from "@/core/types/identity.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";

/** base64 编码辅助（Basic 凭证的常见形态） */
export function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

/** 手搓一个 `IdentityContext`（身份端口的入参是只读事实包，测试自己造最省事） */
export function ctxWith(
  headers: Record<string, string>,
  onAuthEvent?: (e: ProxyAuthEvent) => void,
): IdentityContext {
  return {
    protocol: "http",
    req: {
      method: "GET",
      headers,
      url: "/",
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    socket: {} as unknown as Duplex,
    authority: "target.invalid:80",
    onAuthEvent,
  };
}

/** `Basic <b64>` 形态的 Proxy-Authorization 头 */
export function basicHeader(user: string, pass: string): Record<string, string> {
  return { "proxy-authorization": `Basic ${b64(`${user}:${pass}`)}` };
}