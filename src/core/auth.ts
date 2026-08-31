/**
 * 鉴权抽象层 - 供所有代理方式复用（全异步、零依赖）
 * 文件职责：
 * - 定义统一鉴权契约 AuthProvider / AuthContext，所有 ProxyCore 通过 BaseProxy.authorize(ctx) 调用，无需感知具体鉴权方式
 * - 提供 Token 提取链 TokenExtractor：Header（Proxy-Authorization/Authorization）> Cookie（proxy-authorization 等 7 别名）> URL（?token 等 5 别名），按 Composite 优先级依次尝试
 * - 单一实现类 Auth：内部按 enabled/type 分发（none 放行 / basic 比对 Base64+明文 / jwt 验签），支持自定义 extractor 与 jwtVerify 注入，便于测试与扩展
 * - 工厂 createAuthFromConfig：从 src/config/store 读取 authEnabled/authType/username/password/jwtSecret 一次性构造，BaseProxy 默认持有 Auth{enabled:false}
 * 设计约束：
 * - 全异步 authenticate(ctx):Promise<boolean>，异常由 BaseProxy 捕获视为拒绝，避免击穿隧道
 * - 不直接读取 process.env，仅依赖 store.get，保证可测试性与优先级一致（CLI>env文件>终端>默认）
 * - 与 src/core/http.ts:116 https.ts:86 tls.ts:132 的 407/断开逻辑配套
 */

import type http from "node:http";
import type { Duplex } from "node:stream";
import type net from "node:net";
import { get } from "../config/store.js";
import { getLogger } from "../utils/logger.js";

/**
 * 鉴权上下文 - 每次代理请求/隧道建立时构造，供 AuthProvider 决策
 * 由 BaseProxy.authorize 统一组装，包含协议、原始请求、底层套接字与目标 authority
 */
export interface AuthContext {
  /** 触发鉴权的代理协议（http/https/tls），来源于 BaseProxy.protocol */
  protocol: string;
  /** 原始入站请求头载体，用于提取 Proxy-Authorization/Cookie/URL token */
  req: http.IncomingMessage;
  /** 与客户端的底层双工流（http 为 Duplex 实为 net.Socket，tls 为 TLSSocket），可用于 IP 限流等扩展 */
  socket: Duplex;
  /** 目标 authority（http 为 host 头，CONNECT 为 req.url 的 host:port），用于审计日志 */
  authority: string;
}

/** 鉴权结果：true 放行，false 拒绝（由调用方转为 407/断开） */
export type AuthResult = boolean;

/**
 * 鉴权提供者契约 - 全异步
 * 实现方需保证异常不外泄（由 BaseProxy 捕获视为拒绝）
 */
export interface AuthProvider {
  /** 异步鉴权入口 */
  authenticate(ctx: AuthContext): Promise<AuthResult>;
}

// ── Token 提取抽象 ───────────────────────────────────────────────
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

// ── 统一鉴权实现 ───────────────────────────────────────────────
/**
 * Auth 构造选项 - 与 AppConfig 的 auth* 字段一一映射
 * 由 createAuthFromConfig 从 store 注入，保持单一事实源
 */
export interface AuthOptions {
  /** 总开关，false 直接放行（对应 store.authEnabled） */
  enabled?: boolean;
  /** 方式：none/basic/jwt，enabled=false 时忽略（对应 store.authType） */
  type?: "none" | "basic" | "jwt";
  /** basic 用户名（对应 AUTH_USERNAME） */
  username?: string;
  /** basic 密码（对应 AUTH_PASSWORD） */
  password?: string;
  /** jwt 密钥（对应 JWT_SECRET，兼容 PROXY_SECRET/JWT_KEY） */
  jwtSecret?: string;
  /** Token 提取器，默认 头 > Cookie > URL（defaultTokenExtractor） */
  extractor?: TokenExtractor;
  /** 自定义 jwt 验签，默认仅判非空（可注入 jsonwebtoken.verify 等） */
  jwtVerify?: (token: string, secret: string) => Promise<boolean>;
  /** 是否输出鉴权日志，false 静默（便于测试），默认 true */
  enableLogging?: boolean;
}

/**
 * 统一鉴权提供者 - 唯一对外使用的鉴权类（所有 ProxyCore 共享）
 * 内部状态：enabled/type/username/password/jwtSecret 在构造时固化，expectedB64/Plain 预计算以加速 basic 比对
 * 行为：
 * - enabled=false 或 type=none 直接放行
 * - 否则通过 extractor 提取 token，未命中直接拒绝
 * - basic：比对 Base64(username:password) 或明文，兼容 curl -x user:pass 与显式 Proxy-Authorization 头
 * - jwt：若提供 jwtVerify 则委托外部验签，否则仅校验 secret 与 token 非空（占位，需替换为真实验签）
 */
export class Auth implements AuthProvider {
  /** 总开关 */
  private readonly enabled: boolean;
  /** 鉴权类型 */
  private readonly type: "none" | "basic" | "jwt";
  /** basic 用户名 */
  private readonly username: string;
  /** basic 密码 */
  private readonly password: string;
  /** jwt 密钥 */
  private readonly jwtSecret: string;
  /** 绑定的提取器 */
  private readonly extractor: TokenExtractor;
  /** 可选外部 jwt 验签 */
  private readonly jwtVerify?: (token: string, secret: string) => Promise<boolean>;
  /** 是否输出鉴权日志 */
  private readonly enableLogging: boolean;
  /** 作用域日志，Auth 前缀 */
  private readonly log = getLogger("Auth");
  /** 预计算的期望 Base64，用于 O(1) 比对 */
  private readonly expectedB64: string;
  /** 预计算的明文期望，兼容 Cookie 解码后明文 */
  private readonly expectedPlain: string;

  /**
   * 构造鉴权实例
   * @param options - 鉴权选项，未传默认放行
   */
  constructor(options: AuthOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.type = options.type ?? "none";
    this.username = options.username ?? "";
    this.password = options.password ?? "";
    this.jwtSecret = options.jwtSecret ?? "";
    this.extractor = options.extractor ?? defaultTokenExtractor;
    this.jwtVerify = options.jwtVerify;
    // 优先用显式传入，其次读 store 的环境变量控制，默认 true
    let envLogging: boolean | undefined;
    try { envLogging = get("authLogging") as unknown as boolean; } catch {}
    this.enableLogging = options.enableLogging ?? envLogging ?? true;
    this.expectedB64 = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    this.expectedPlain = `${this.username}:${this.password}`;
  }

  /**
   * 异步鉴权入口 - 集中鉴权日志，代理实现无需再输出 [auth] 日志
   * @param ctx - 本次请求的鉴权上下文
   * @returns true 放行，false 拒绝
   */
  async authenticate(ctx: AuthContext): Promise<AuthResult> {
    if (!this.enabled || this.type === "none") return true;
    const token = await getToken(ctx, this.extractor);
    const clientAddr = (ctx.socket as unknown as net.Socket)?.remoteAddress ?? "unknown";
    const target = ctx.authority || ctx.req.url || "-";
    const isTunnel = ctx.authority.includes(":");
    const tag = isTunnel ? "tunnel " : "";
    if (!token) {
      if (this.enableLogging) this.log.warn(`[auth] deny ${tag}${clientAddr} -> ${target} attempted=- expected=${this.username || "-"} reason=no-token`);
      return false;
    }
    let passed = false;
    if (this.type === "basic") {
      passed = token === this.expectedB64 || token === this.expectedPlain;
    } else if (this.type === "jwt") {
      if (this.jwtVerify) passed = await this.jwtVerify(token, this.jwtSecret);
      else { await Promise.resolve(); passed = this.jwtSecret.length > 0 && token.length > 0; }
    }
    if (this.enableLogging) {
      const attempted = this.extractUser(token);
      if (passed) this.log.info(`[auth] allow ${tag}${clientAddr} -> ${target} user=${this.username || attempted || "-"}`);
      else this.log.warn(`[auth] deny ${tag}${clientAddr} -> ${target} attempted=${attempted ?? "-"} expected=${this.username || "-"}`);
    }
    return passed;
  }

  /** 从 token 提取用户名用于审计（兼容 basic 与 jwt） */
  private extractUser(token: string): string | undefined {
    // jwt 形态：xxx.yyy.zzz，解 payload 取 sub/username/user，避免明文泄露完整 token
    if (token.includes(".") && token.split(".").length === 3) {
      try {
        const payloadB64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
        const json = Buffer.from(padded, "base64").toString();
        const payload = JSON.parse(json) as Record<string, unknown>;
        const sub = (payload.sub ?? payload.username ?? payload.user ?? payload.uid ?? payload.id) as string | undefined;
        if (sub && typeof sub === "string") return sub.trim().slice(0, 32);
        // 无法解析则返回截断的 jwt 前缀，避免日志过长或泄露
        return `${token.slice(0, 8)}…`;
      } catch { return `${token.slice(0, 8)}…`; }
    }
    // basic 形态：Base64(username:password) 或明文 username:password
    let plain = token;
    if (/^[A-Za-z0-9+/=]+$/.test(token) && token.length % 4 === 0) {
      try { const decoded = Buffer.from(token, "base64").toString(); if (decoded.includes(":")) plain = decoded; } catch {}
    }
    const user = plain.split(":")[0]?.trim();
    return (user && user.length <= 32 ? user : token.slice(0, 16)) || undefined;
  }
}

/**
 * 工厂：从选项创建统一 Auth（便于测试注入自定义 extractor/jwtVerify）
 * @param options - 同 Auth 构造选项
 */
export function createAuthProvider(options: AuthOptions = {}): AuthProvider {
  return new Auth(options);
}

/**
 * 快捷工厂：从 src/config/store 读取 auth* 配置创建
 * 优先级已在 loader 阶段收敛（CLI > env文件 > 终端 > 默认），此处仅透传
 */
export function createAuthFromConfig(): AuthProvider {
  return new Auth({
    enabled: get("authEnabled"),
    type: get("authType"),
    username: get("authUsername"),
    password: get("authPassword"),
    jwtSecret: get("jwtSecret"),
  });
}
