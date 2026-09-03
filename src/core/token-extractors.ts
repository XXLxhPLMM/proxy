/**
 * Token 提取器 - 从 AuthContext 中提取待校验的原始 token
 * 职责：仅 Header（Proxy-Authorization/Authorization），标准代理鉴权头（RFC 7235）
 * 取舍：Cookie/URL 携带不予识别——URL token 进日志/历史，Cookie 易与源站混淆，均属泄露面
 */

import type { AuthContext, TokenExtractor } from "./types/auth.js";
import { AUTH_SCHEME_BASIC, AUTH_SCHEME_BEARER } from "@/utils/constants.js";

/**
 * 大小写无关取头：真 IncomingMessage 的键恒小写，裸对象允许原样大小写；
 * 数组值取首个非空元素
 */
function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    if (Array.isArray(v)) return v.map((s) => s.trim()).find((s) => s.length > 0);
    const s = v?.trim();
    return s?.length ? s : undefined;
  }
  return undefined;
}

/**
 * Header 提取器 - 唯一标准来源
 * 读取 proxy-authorization 优先于 authorization，兼容 Basic/Bearer 前缀自动剥离
 * 例：Proxy-Authorization: Basic dGVzdDoxMjM= -> dGVzdDoxMjM=；Bearer xxx -> xxx
 */
export class HeaderTokenExtractor implements TokenExtractor {
  extract(ctx: AuthContext): string | undefined {
    const headers = ctx.req.headers;
    const raw = getHeader(headers, "proxy-authorization") ?? getHeader(headers, "authorization");
    if (!raw) return undefined;
    if (raw.startsWith(AUTH_SCHEME_BASIC)) return raw.slice(AUTH_SCHEME_BASIC.length).trim() || undefined;
    if (raw.startsWith(AUTH_SCHEME_BEARER)) return raw.slice(AUTH_SCHEME_BEARER.length).trim() || undefined;
    return raw || undefined;
  }
}

/** 默认提取器：仅标准头，与 README 及 http.ts 鉴权日志保持一致 */
export const defaultTokenExtractor = new HeaderTokenExtractor();

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
