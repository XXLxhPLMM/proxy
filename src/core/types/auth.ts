/**
 * 鉴权共享类型 - core/types 叶子模块
 * 职责：集中 AuthRequestLike / AuthContext / TokenExtractor / AuthProvider / AuthResult / AuthOptions，
 * 零运行时依赖的叶子模块；auth.ts 与 token-extractors.ts 均只从此取类型，依赖无环。
 * 依赖方向：types/auth（仅类型，无运行时依赖）← token-extractors ← auth
 */

import type { Duplex } from "node:stream";
import type { ProxyAuthEvent } from "./proxy.js";

/**
 * 鉴权请求最小形状 - Auth 实际只读 headers/url/socket.remoteAddress
 * http 真请求天然满足（结构兼容），socks/tls 传裸对象即可
 */
export interface AuthRequestLike {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  /** 底层套接字：运行时为 net.Socket/TLSSocket（取 remoteAddress 做客 IP），鉴权层只嗅探不操作，故擦为 unknown */
  socket?: unknown;
}

/**
 * 鉴权上下文 - 每次代理请求/隧道建立时构造，供 AuthProvider 决策
 * 由 BaseProxy.authorize 统一组装，包含协议、原始请求、底层套接字与目标 authority
 */
export interface AuthContext {
  /** 触发鉴权的代理协议（http/https/tls），来源于 BaseProxy.protocol */
  protocol: string;
  /** 入站请求最小载体（真 IncomingMessage 或 socks/tls 裸对象），用于提取 Proxy-Authorization/Authorization token */
  req: AuthRequestLike;
  /** 与客户端的底层双工流（http 为 Duplex 实为 net.Socket，tls 为 TLSSocket），可用于 IP 限流等扩展 */
  socket: Duplex;
  /** 目标 authority（http 为 host 头，CONNECT 为 req.url 的 host:port），用于审计日志 */
  authority: string;
  /** 鉴权审计事件槽：Auth 只抛不记，由 BaseProxy.authorize 注入并转为 proxy "auth" 事件 */
  onAuthEvent?: (e: ProxyAuthEvent) => void;
}

/**
 * Token 提取器契约 - 负责从 AuthContext 中提取待校验的原始 token 字符串
 */
export interface TokenExtractor {
  /** 提取 token，未命中返回 undefined（同步或异步均可） */
  extract(ctx: AuthContext): Promise<string | undefined> | string | undefined;
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
  /** Token 提取器，默认标准头（defaultTokenExtractor） */
  extractor?: TokenExtractor;
  /** 自定义 jwt 验签，默认仅判非空（可注入 jsonwebtoken.verify 等） */
  jwtVerify?: (token: string, secret: string) => Promise<boolean>;
  /** 是否抛出鉴权审计事件（经 onAuthEvent），false 静默（便于测试），默认 true */
  enableLogging?: boolean;
}
