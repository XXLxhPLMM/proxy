/**
 * Token 提取链 - 从 AuthContext 中提取待校验的原始 token
 * 职责：Header（Proxy-Authorization/Authorization）> Cookie（7 别名）> URL（5 别名），按 Composite 优先级依次尝试
 * 设计：可组合，Composite 按构造函数顺序链式尝试，首个命中即返回
 */

import type { AuthContext } from "./auth.js";

/**
 * Token 提取器契约 - 负责从 AuthContext 中提取待校验的原始 token 字符串
 * 设计为可组合：Composite 按优先级依次尝试，首个命中即返回
 */
export interface TokenExtractor {
  /** 提取 token，未命中返回 undefined（同步或异步均可） */
  extract(ctx: AuthContext): Promise<string | undefined> | string | undefined;
}

/**
 * Header 提取器 - 优先级最高
 * 读取 proxy-authorization 优先于 authorization，兼容 Basic/Bearer 前缀自动剥离
 * 例：Proxy-Authorization: Basic dGVzdDoxMjM= -> dGVzdDoxMjM=；Bearer xxx -> xxx
 */
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

/**
 * Cookie 提取器 - 兼容浏览器场景
 * 解析 Cookie 头为 Map，按 7 别名优先级匹配，自动 decodeURIComponent 并剥离 Basic/Bearer
 * 键优先级：proxy-authorization > proxy_authorization > token > auth > proxy_token > auth_token > access_token
 */
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

/**
 * URL 提取器 - 兼容显式 ?token= 场景（最末优先级）
 * 仅当 url 含 ? 与 = 时解析，避免对 CONNECT authority 误判；支持绝对/相对 URL
 * 查询键优先级：token > auth > proxy_token > auth_token > access_token
 */
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

/**
 * 组合提取器 - 按构造函数传入顺序优先级链式尝试
 * 用于实现 Header > Cookie > URL 的默认策略，也支持测试时注入自定义链
 */
export class CompositeTokenExtractor implements TokenExtractor {
  /** @param extractors - 按优先级排序的提取器列表 */
  constructor(private readonly extractors: TokenExtractor[]) {}
  async extract(ctx: AuthContext): Promise<string | undefined> {
    for (const ex of this.extractors) {
      const token = await ex.extract(ctx);
      if (token) return token;
    }
    return undefined;
  }
}

/** 默认提取链：Header > Cookie > URL，与 README 及 http.ts 鉴权日志保持一致 */
export const defaultTokenExtractor = new CompositeTokenExtractor([
  new HeaderTokenExtractor(),
  new CookieTokenExtractor(),
  new UrlTokenExtractor(),
]);

/**
 * 便捷获取 token - 供 Auth.authenticate 内部调用
 * @param ctx - 鉴权上下文
 * @param extractor - 提取器，默认 defaultTokenExtractor
 */
export async function getToken(
  ctx: AuthContext,
  extractor: TokenExtractor = defaultTokenExtractor,
): Promise<string | undefined> {
  return extractor.extract(ctx);
}
