/**
 * 六档共用的身份入参构造器与最小签发器
 *
 * @description
 * 搬自旧 `identity.test.ts` 的前导。**只收「两个以上档真用到」的东西**：六档都要手搓一个
 * `IdentityContext`（身份端口的入参是只读事实包）、都要 base64 拼 Basic 凭证，签发器被
 * 四档用到（`verify` 那条还要传 `alg: "RS256"` 验证 fail-closed）。
 *
 * ⚠️ `authority` 缺省 `example.com:80` 是**申报过的**公网字面量（见
 * `tests/helpers/public-hosts/unit-core-identity.ts`）：它只进审计事件的 `target`，
 * 这一族不建链。真要建链的档走 `127.0.0.1` 的空闲端口。
 *
 * 口径与理由（各档锁的是什么）归 `AGENTS.md`，本文件只负责「东西在这儿」。
 */
import { createHmac } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import type { AuthAccount, IdentityContext } from "@/core/types/identity.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";

/** base64 编码辅助：Basic 凭证的常见形态 */
export function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

/** 构造账号 */
export function acct(username: string, password: string): AuthAccount {
  return { username, password };
}

/** 签发 HS256 JWT（测试用最小签发器，与内置校验器 defaultJwtVerify 共用 node:crypto HMAC） */
export function signJwt(
  payload: unknown,
  secret: string,
  header: { alg: string; typ?: string } = { alg: "HS256", typ: "JWT" },
): string {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

/** 手搓一个 `IdentityContext`（身份端口的入参是只读事实包，测试自己造最省事） */
export function ctxWith(over: {
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
  authority?: string;
  protocol?: string;
  method?: string;
  onAuthEvent?: (e: ProxyAuthEvent) => void;
}): IdentityContext {
  return {
    protocol: over.protocol ?? "http",
    req: {
      method: over.method,
      headers: over.headers ?? {},
      url: over.url ?? "/",
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    socket: {} as unknown as Duplex,
    authority: over.authority ?? "example.com:80",
    onAuthEvent: over.onAuthEvent,
  };
}