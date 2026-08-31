/**
 * 鉴权抽象层 - 供所有代理方式复用（全异步）
 * 单一入口：Auth 同步承载 开关 + 方式分发，外部只需 new Auth() 或 createAuthProvider()
 */

import type http from "node:http";
import type { Duplex } from "node:stream";
import { get } from "../config/store.js";

export interface AuthContext {
  protocol: string;
  req: http.IncomingMessage;
  socket: Duplex;
  authority: string;
}

export type AuthResult = boolean;

export interface AuthProvider {
  authenticate(ctx: AuthContext): Promise<AuthResult>;
}

// ── Token 提取抽象 ───────────────────────────────────────────────

export interface TokenExtractor {
  extract(ctx: AuthContext): Promise<string | undefined> | string | undefined;
}

export class HeaderTokenExtractor implements TokenExtractor {
  extract(ctx: AuthContext): string | undefined {
    const raw = (ctx.req.headers["proxy-authorization"] ?? ctx.req.headers["authorization"]) as
      | string
      | undefined;
    if (!raw) return undefined;
    if (raw.startsWith("Basic ")) return raw.slice(6).trim();
    if (raw.startsWith("Bearer ")) return raw.slice(7).trim();
    return raw.trim() || undefined;
  }
}

export class CookieTokenExtractor implements TokenExtractor {
  private readonly keys = [
    "proxy-authorization",
    "proxy_authorization",
    "token",
    "auth",
    "proxy_token",
    "auth_token",
    "access_token",
  ];

  extract(ctx: AuthContext): string | undefined {
    const raw = ctx.req.headers.cookie as string | undefined;
    if (!raw) return undefined;
    const map = new Map<string, string>();
    for (const part of raw.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (!k || rest.length === 0) continue;
      map.set(k.trim(), rest.join("=").trim());
    }
    for (const key of this.keys) {
      const v = map.get(key);
      if (v) {
        const decoded = decodeURIComponent(v);
        if (decoded.startsWith("Basic ")) return decoded.slice(6).trim();
        if (decoded.startsWith("Bearer ")) return decoded.slice(7).trim();
        return decoded;
      }
    }
    return undefined;
  }
}

export class UrlTokenExtractor implements TokenExtractor {
  extract(ctx: AuthContext): string | undefined {
    const raw = ctx.req.url ?? "";
    try {
      if (!raw.includes("?") || !raw.includes("=")) return undefined;
      const url = raw.startsWith("http") ? new URL(raw) : new URL(raw, "http://dummy");
      return (
        url.searchParams.get("token") ??
        url.searchParams.get("auth") ??
        url.searchParams.get("proxy_token") ??
        url.searchParams.get("auth_token") ??
        url.searchParams.get("access_token") ??
        undefined
      );
    } catch {
      return undefined;
    }
  }
}

export class CompositeTokenExtractor implements TokenExtractor {
  constructor(private readonly extractors: TokenExtractor[]) {}
  async extract(ctx: AuthContext): Promise<string | undefined> {
    for (const ex of this.extractors) {
      const token = await ex.extract(ctx);
      if (token) return token;
    }
    return undefined;
  }
}

export const defaultTokenExtractor = new CompositeTokenExtractor([
  new HeaderTokenExtractor(),
  new CookieTokenExtractor(),
  new UrlTokenExtractor(),
]);

export async function getToken(
  ctx: AuthContext,
  extractor: TokenExtractor = defaultTokenExtractor,
): Promise<string | undefined> {
  return extractor.extract(ctx);
}

// ── 统一鉴权实现 ───────────────────────────────────────────────

export interface AuthOptions {
  /** 总开关，false 直接放行 */
  enabled?: boolean;
  /** 方式：none/basic/jwt，enabled=false 时忽略 */
  type?: "none" | "basic" | "jwt";
  /** basic 用户名 */
  username?: string;
  /** basic 密码 */
  password?: string;
  /** jwt 密钥 */
  jwtSecret?: string;
  /** Token 提取器，默认 头 > Cookie > URL */
  extractor?: TokenExtractor;
  /** 自定义 jwt 验签，默认仅判非空 */
  jwtVerify?: (token: string, secret: string) => Promise<boolean>;
}

/**
 * 统一鉴权提供者 - 唯一对外使用的鉴权类
 * 内部按 enabled/type 分发，所有代理共享同一实例
 */
export class Auth implements AuthProvider {
  private readonly enabled: boolean;
  private readonly type: "none" | "basic" | "jwt";
  private readonly username: string;
  private readonly password: string;
  private readonly jwtSecret: string;
  private readonly extractor: TokenExtractor;
  private readonly jwtVerify?: (token: string, secret: string) => Promise<boolean>;
  private readonly expectedB64: string;
  private readonly expectedPlain: string;

  constructor(options: AuthOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.type = options.type ?? "none";
    this.username = options.username ?? "";
    this.password = options.password ?? "";
    this.jwtSecret = options.jwtSecret ?? "";
    this.extractor = options.extractor ?? defaultTokenExtractor;
    this.jwtVerify = options.jwtVerify;
    this.expectedB64 = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    this.expectedPlain = `${this.username}:${this.password}`;
  }

  async authenticate(ctx: AuthContext): Promise<AuthResult> {
    if (!this.enabled || this.type === "none") return true;
    const token = await getToken(ctx, this.extractor);
    if (!token) return false;
    if (this.type === "basic") {
      return token === this.expectedB64 || token === this.expectedPlain;
    }
    if (this.type === "jwt") {
      if (this.jwtVerify) return this.jwtVerify(token, this.jwtSecret);
      await Promise.resolve();
      return this.jwtSecret.length > 0 && token.length > 0;
    }
    return false;
  }
}

/** 工厂：从环境配置创建统一 Auth（便于 BaseProxy 注入） */
export function createAuthProvider(options: AuthOptions = {}): AuthProvider {
  return new Auth(options);
}

/** 快捷：从 src/config/store 读取配置创建 */
export function createAuthFromConfig(): AuthProvider {
  return new Auth({
    enabled: get("authEnabled"),
    type: get("authType"),
    username: get("authUsername"),
    password: get("authPassword"),
    jwtSecret: get("jwtSecret"),
  });
}
