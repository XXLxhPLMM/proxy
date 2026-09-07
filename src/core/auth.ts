/**
 * 鉴权抽象层 - 供所有代理方式复用（全异步、零依赖）
 * 文件职责：
 * - 定义统一鉴权契约 AuthProvider / AuthContext，所有 ProxyCore 通过 BaseProxy.authorize(ctx) 调用，无需感知具体鉴权方式
 * - 单一实现类 Auth：内部按 enabled/type 分发（none 放行 / basic 比对 Base64+明文 / jwt 验签），支持自定义 extractor 与 jwtVerify 注入，便于测试与扩展
 * - 工厂 createAuthFromConfig：从 src/config/store 读取 authEnabled/authType/username/password/jwtSecret 一次性构造，BaseProxy 默认持有 Auth{enabled:false}
 * - Token 提取由 ./token-extractors.ts 提供（仅标准头 HeaderTokenExtractor）
 * 设计约束：
 * - 全异步 authenticate(ctx):Promise<boolean>，异常由 BaseProxy 捕获视为拒绝，避免击穿隧道
 * - 不直接读取 process.env，仅依赖 store.get，保证可测试性与优先级一致（CLI>env文件>终端>默认）
 */

import { get } from "@/config/store.js";
import { getClientAddress } from "@/utils/ip.js";
import { encodeBasicCredentials } from "@/core/proxy-helpers.js";
import type { ProxyAuthEvent } from "./types/proxy.js";
import { defaultTokenExtractor, getToken } from "./token-extractors.js";
import type { AuthContext, AuthOptions, AuthProvider, AuthResult, TokenExtractor } from "./types/auth.js";

// ── 统一鉴权实现 ───────────────────────────────────────────────
/**
 * 统一鉴权提供者 - 唯一对外使用的鉴权类（所有 ProxyCore 共享）
 * 内部状态：enabled/type/username/password/jwtSecret 在构造时固化，expectedB64/Plain 预计算以加速 basic 比对
 * 行为：
 * - enabled=false 或 type=none 直接放行
 * - 否则通过 extractor 提取 token，未命中直接拒绝
 * - basic：比对 Base64(username:password) 或明文，兼容 curl -x user:pass 与显式 Proxy-Authorization 头
 * - jwt：若提供 jwtVerify 则委托外部验签，否则仅校验 secret 与 token 非空（占位实现）
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
  /** 预计算的期望 Base64，用于 O(1) 比对 */
  private readonly expectedB64: string;
  /** 预计算的明文期望，兼容明文 username:password 形态 */
  private readonly expectedPlain: string;
  /** 对外暴露是否启用（供 SOCKS 无密码分支判断，避免 core 直读 store） */
  get isEnabled(): boolean { return this.enabled; }
  get authType(): "none" | "basic" | "jwt" { return this.type; }

  /** basic 校验：命中预计算的 Base64 或明文任一即过 */
  private async verifyBasic(token: string): Promise<boolean> {
    return token === this.expectedB64 || token === this.expectedPlain;
  }

  /** jwt 校验：委托外部验签（未注入直接抛，由 BaseProxy 视为拒绝） */
  private async verifyJwt(token: string): Promise<boolean> {
    if (!this.jwtVerify) throw new Error("JWT auth requires jwtVerify function — inject via AuthOptions.jwtVerify");
    return this.jwtVerify(token, this.jwtSecret);
  }

  /** 按 type 分发校验器：none 已在入口放行，此处只剩 basic/jwt */
  private verifier(): (token: string) => Promise<boolean> {
    return this.type === "jwt" ? (t) => this.verifyJwt(t) : (t) => this.verifyBasic(t);
  }

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
    this.enableLogging = options.enableLogging ?? (get("authLogging") as boolean) ?? true;
    this.expectedB64 = encodeBasicCredentials(this.username, this.password);
    this.expectedPlain = `${this.username}:${this.password}`;
  }

  /**
   * 异步鉴权入口 - 零日志：审计细节经 ctx.onAuthEvent 随调抛出，由上层记日志
   * @param ctx - 本次请求的鉴权上下文
   * @returns true 放行，false 拒绝
   */
  async authenticate(ctx: AuthContext): Promise<AuthResult> {
    if (!this.enabled || this.type === "none") return true;
    const token = await getToken(ctx, this.extractor);
    const clientAddr = getClientAddress(ctx.req);
    const target = ctx.authority || ctx.req.url || "-";
    const isTunnel = ctx.authority?.includes(":") ?? false;
    const tag = isTunnel ? "tunnel " : "";
    const emit = (e: ProxyAuthEvent): void => {
      if (this.enableLogging) ctx.onAuthEvent?.(e);
    };
    if (!token) {
      emit({ passed: false, tag, client: clientAddr, target, expected: this.username || undefined, reason: "no-token" });
      return false;
    }
    const passed = await this.verifier()(token);
    const attempted = extractUserFromToken(token);
    if (passed) emit({ passed: true, tag, client: clientAddr, target, user: this.username || attempted });
    else emit({ passed: false, tag, client: clientAddr, target, attempted, expected: this.username || undefined });
    return passed;
  }
}

/**
 * 从 token 提取用户名用于审计（兼容 basic 与 jwt）
 * 按形态分发：jwt 取 payload 的 sub/username，basic 解 Base64 取冒号前
 */
function extractUserFromToken(token: string): string | undefined {
  return isJwtShape(token) ? extractJwtUser(token) : extractBasicUser(token);
}

/** jwt 形态：xxx.yyy.zzz 三段式 */
function isJwtShape(token: string): boolean {
  return token.includes(".") && token.split(".").length === 3;
}

/** jwt 取 payload 的 sub/username（失败截断前缀防日志爆炸） */
function extractJwtUser(token: string): string | undefined {
  try {
    const payloadB64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString();
    const payload = JSON.parse(json) as Record<string, unknown>;
    const sub = (payload.sub ?? payload.username ?? payload.user ?? payload.uid ?? payload.id) as string | undefined;
    if (sub && typeof sub === "string") return sub.trim().slice(0, 32);
  } catch { /* 非法 jwt，走截断兜底 */ }
  // 无法解析则返回截断的 jwt 前缀，避免日志过长或泄露
  return `${token.slice(0, 8)}…`;
}

/** basic 形态：Base64(username:password) 或明文 username:password，取冒号前 */
function extractBasicUser(token: string): string | undefined {
  let plain = token;
  if (/^[A-Za-z0-9+/=]+$/.test(token)) {
    try {
      const decoded = Buffer.from(token, "base64").toString();
      if (decoded.includes(":")) plain = decoded;
    } catch { /* 不是有效 base64，当作明文处理 */ }
  }
  const user = plain.split(":")[0]?.trim();
  return (user && user.length <= 32 ? user : token.slice(0, 16)) || undefined;
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
