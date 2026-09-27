/**
 * @fileoverview 代理认证实现
 * @module core/auth
 * @description
 * 本模块提供代理的认证能力，支持 `none / basic / jwt / uid` 四种模式，
 * 负责从请求头提取令牌、比对外部账号表并产生审计事件供上层落盘。
 *
 * 职责：
 * - 从 `Proxy-Authorization`（优先）或 `Authorization`（回退）头提取令牌，scheme 前缀按 RFC 7235 大小写不敏感剥离（`Basic` / `basic` 均可）
 * - Basic 模式：构造期把账号表编译为「凭证 -> 用户名」索引（`b64(user:pass)` 与明文 `user:pass` 两种键），运行时 O(1) 命中并回传用户名
 * - JWT 模式：委托外部注入的 `jwtVerify(token, secret)` 异步校验，未注入时抛错阻止误放行；用户名取自 token 的 sub/username
 * - UID 模式：仅比对用户名（socks4 USERID），token 可为民用名、`user:pass`、b64(user:pass) 或 b64(username)
 * - 产生 `ProxyAuthEvent` 审计事件，经 `AuthContext.onAuthEvent` 上抛至 `BaseProxy.authorize()` 转为 proxy `auth` 事件
 * - 提供 `createAuthFromConfig()` 工厂，每请求重读 store 与账号文件（热加载）
 *
 * 设计要点：
 * - 零日志：本模块不直接写日志，审计细节通过 `onAuthEvent` 回调抛出，由 `ProxyServer.bindProxyEventLogs()` 统一落盘
 * - 异常即拒绝：`authenticate` 内部的任何异常由 `BaseProxy.authorize()` 捕获并视为拒绝，避免异常穿透导致放行
 * - 结果带身份：返回 `AuthResult{ passed, username }`，让上层把用户名带进逐连接日志（多账号下谁在访问必须可查）
 * - 多账号：账号来自 `AUTH_USERS_FILE` 指向的 users.json；索引按账号快照对象身份记忆（见 `indexesFor`），
 *   并发会话共享同一份只读索引，不每请求重建
 * - 空用户名恒判否：账号表在解析期已拒绝空用户名，索引构建再跳过一次（纵深防御），
 *   否则空用户名会让 `:` / `Og==` 之类无意义 token 命中的正是「无账号」这种伪凭证
 * - 大小写不敏感的头查找：`getHeader` 遍历 headers 并以小写比对，兼容 Node 的头名大小写差异
 * - 脱敏与截断：`extractUserFromToken` 对 JWT 取 `sub/username/user/uid/id`，对 Basic 解码后取用户名，均截断至 32 字符以内
 *
 * 使用示例：
 * ```ts
 * import { Auth, createAuthFromConfig } from "@/core/auth.js";
 *
 * // 1) Basic 认证（手动构造）
 * const basic = new Auth({ enabled: true, type: "basic", accounts: [{ username: "admin", password: "s3cr3t" }] });
 * const r = await basic.authenticate({ protocol: "http", req, socket, authority: "example.com:443" } as AuthContext);
 *
 * // 2) JWT 认证（注入校验器）
 * const jwt = new Auth({ enabled: true, type: "jwt", jwtSecret: "shhh", jwtVerify: async (t,s)=> verify(t,s) });
 *
 * // 3) 从全局配置装配（ProxyServer 内部用法）
 * const auth = createAuthFromConfig();
 * ```
 */

import { get } from "@/config/store.js";
import { loadAuthUsers } from "@/config/auth-users.js";
import { getClientAddress } from "@/utils/ip.js";
import { encodeBasicCredentials } from "@/core/proxy-helpers.js";
import type { AuthAccount, ProxyAuthEvent } from "./types/proxy.js";
import type { AuthContext, AuthOptions, AuthProvider, AuthResult } from "./types/proxy.js";
import { AUTH_SCHEME_BASIC, AUTH_SCHEME_BEARER, RE_BASE64URL_DASH, RE_BASE64URL_UNDERSCORE, RE_BASE64_STRICT } from "@/utils/constants.js";

/** `AUTH_SCHEME_BASIC` 的小写形态，供大小写不敏感的 scheme 剥离（RFC 7235）用 */
const AUTH_SCHEME_BASIC_LOWER = AUTH_SCHEME_BASIC.toLowerCase();
/** `AUTH_SCHEME_BEARER` 的小写形态，供大小写不敏感的 scheme 剥离（RFC 7235）用 */
const AUTH_SCHEME_BEARER_LOWER = AUTH_SCHEME_BEARER.toLowerCase();

/** 空账号表（只读哨兵） */
const EMPTY_ACCOUNTS: AuthAccount[] = [];

/**
 * 按大小写不敏感的方式从头字典中取值
 * @description 遍历 `headers` 的所有键，以小写比对目标 `name`；若值为数组则取首个非空字符串
 * @param headers - Node 请求头字典（键可能为任意大小写，值可能为字符串或字符串数组）
 * @param name - 目标头名（大小写不敏感，如 "proxy-authorization"）
 * @returns 去空格后的首个有效头值，未找到或全为空则返回 undefined
 * @example getHeader(req.headers, "proxy-authorization") // => "Basic YWRtaW46..."
 * @example getHeader({ "Authorization": ["", "Bearer xxx"] }, "authorization") // => "Bearer xxx"
 */
function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) {
      continue;
    }
    if (Array.isArray(v)) {
      return v.map((s) => s.trim()).find((s) => s.length > 0);
    }
    const s = v?.trim();
    return s?.length ? s : undefined;
  }
  return undefined;
}

/**
 * 从认证上下文中提取原始令牌
 * @description 优先读取 `Proxy-Authorization`，回退 `Authorization`；若值以 `Basic ` / `Bearer ` 开头则剥离前缀。
 * scheme 按 RFC 7235 大小写不敏感匹配（`basic `/`Bearer ` 均可），剥离时依旧按常量长度切片，保留原始令牌大小写
 * @param ctx - 认证上下文，含 `req.headers`
 * @returns 去前缀后的令牌字符串，未携带则返回 undefined
 * @example extractToken({ req: { headers: { "proxy-authorization": "Basic abc==" } } } as any) // => "abc=="
 * @example extractToken({ req: { headers: { "proxy-authorization": "basic abc==" } } as any) // => "abc=="
 * @example extractToken({ req: { headers: { "authorization": "Bearer eyJ..." } } } as any) // => "eyJ..."
 */
function extractToken(ctx: AuthContext): string | undefined {
  const h = ctx.req.headers;
  const raw = getHeader(h, "proxy-authorization") ?? getHeader(h, "authorization");
  if (!raw) {
    return undefined;
  }
  const lower = raw.toLowerCase();
  if (lower.startsWith(AUTH_SCHEME_BASIC_LOWER)) {
    return raw.slice(AUTH_SCHEME_BASIC.length).trim() || undefined;
  }
  if (lower.startsWith(AUTH_SCHEME_BEARER_LOWER)) {
    return raw.slice(AUTH_SCHEME_BEARER.length).trim() || undefined;
  }
  return raw || undefined;
}

/**
 * 判断字符串是否具备 JWT 形状
 * @param t - 待检测的令牌字符串
 * @returns 是否像 JWT
 * @example isJwtShape("eyJhbGciOi...") // => true（若为三段式）
 * @example isJwtShape("YWRtaW46c2VjcmV0") // => false
 */
function isJwtShape(t: string): boolean {
  return t.includes(".") && t.split(".").length === 3;
}

/**
 * 从 JWT 令牌中提取用户名（用于审计展示与身份回传）
 * @description 对 JWT 的 payload 做 base64url 解码后解析 JSON，依次尝试 `sub / username / user / uid / id` 字段；
 * 成功则截断至 32 字符，异常则回退为 `token.slice(0,8)+…` 的脱敏指纹
 * @param token - JWT 字符串（三段式）
 * @returns 用户名字符串或脱敏指纹，解析失败时返回指纹
 * @example extractJwtUser("eyJhbGciOi...eyJzdWIiOiJhbGljZSJ9...") // => "alice"
 */
function extractJwtUser(token: string): string | undefined {
  try {
    const p = token.split(".")[1].replace(RE_BASE64URL_DASH, "+").replace(RE_BASE64URL_UNDERSCORE, "/");
    const pad = p + "=".repeat((4 - (p.length % 4)) % 4);
    const j = JSON.parse(Buffer.from(pad, "base64").toString()) as Record<string, unknown>;
    const s = (j.sub ?? j.username ?? j.user ?? j.uid ?? j.id) as string | undefined;
    if (s && typeof s === "string") {
      return s.trim().slice(0, 32);
    }
  } catch {}
  return `${token.slice(0, 8)}…`;
}

/**
 * 从 Basic 令牌中提取用户名（用于审计展示）
 * @description 若令牌符合 base64 字符集则尝试解码，含 `:` 时视为 `user:pass` 明文；取 `:` 前的用户名并截断至 32 字符
 * @param token - 可能为 base64 或明文 `user:pass` 的字符串
 * @returns 用户名或截断后的令牌前缀
 * @example extractBasicUser("YWRtaW46c2VjcmV0") // => "admin"
 * @example extractBasicUser("admin:s3cr3t") // => "admin"
 */
function extractBasicUser(token: string): string | undefined {
  let plain = token;
  if (RE_BASE64_STRICT.test(token)) {
    try {
      const d = Buffer.from(token, "base64").toString();
      if (d.includes(":")) {
        plain = d;
      }
    } catch {}
  }
  const u = plain.split(":")[0]?.trim();
  return (u && u.length <= 32 ? u : token.slice(0, 16)) || undefined;
}

/**
 * 根据令牌形状分发提取用户名
 * @param t - 原始令牌字符串
 * @returns 用户名或脱敏指纹
 * @example extractUserFromToken(jwtToken) // => "alice"
 * @example extractUserFromToken(basicB64) // => "admin"
 */
function extractUserFromToken(t: string): string | undefined {
  return isJwtShape(t) ? extractJwtUser(t) : extractBasicUser(t);
}

/** 账号表编译出的凭证索引（只读，可被并发会话共享） */
interface CredentialIndexes {
  /** Basic 键：`b64(user:pass)` 与明文 `user:pass`（整串精确比对） */
  basic: Map<string, string>;
  /** UID 用户名集合（只比对用户名部分，密码忽略） */
  uidUsers: Set<string>;
}

/** 单槽记忆：账号快照对象未变则复用索引（每请求新建 Auth 也不会重建 Map） */
let indexMemo: { accounts: readonly AuthAccount[]; indexes: CredentialIndexes } | undefined;

/**
 * 编译账号表为凭证索引
 * @description 索引只在账号快照变化时重建；构建结果只读，多会话并发共享无竞态
 * @param accounts - 账号表（来自 users.json，视为只读）
 * @returns basic/uid 两套索引
 */
function indexesFor(accounts: readonly AuthAccount[]): CredentialIndexes {
  if (indexMemo && indexMemo.accounts === accounts) {
    return indexMemo.indexes;
  }

  const basic = new Map<string, string>();
  const uidUsers = new Set<string>();

  for (const a of accounts) {
    // 空用户名账号在解析期已被拒（纵深防御：此处再挡一次，避免 `:` / `Og==` 之类空凭证命中）
    if (!a.username) {
      continue;
    }
    basic.set(encodeBasicCredentials(a.username, a.password), a.username);
    basic.set(`${a.username}:${a.password}`, a.username);

    uidUsers.add(a.username);
  }

  const indexes = { basic, uidUsers };
  indexMemo = { accounts, indexes };
  return indexes;
}

/**
 * 代理认证器
 * @description 实现 `AuthProvider` 接口，支持 none/basic/jwt/uid 四模式；构造期把账号表编译为凭证索引，运行时 O(1) 命中
 * @example
 * const auth = new Auth({ enabled: true, type: "basic", accounts: [{ username: "alice", password: "pw1" }] });
 * const r = await auth.authenticate(ctx); // => { passed: true, username: "alice" }
 */
export class Auth implements AuthProvider {
  private enabled: boolean;
  private type: "none" | "basic" | "jwt" | "uid";
  private jwtSecret: string;
  private jwtVerify?: (token: string, secret: string) => Promise<boolean>;
  private enableLogging: boolean;
  private indexes: CredentialIndexes;

  get isEnabled(): boolean {
    return this.enabled;
  }

  get authType(): string {
    return this.type;
  }

  /**
   * 构造认证器
   * @description 读取 `AuthOptions` 并把 `accounts` 编译为凭证索引；`enableLogging` 默认取全局 `authLogging` 配置。
   * 注意：`o.extractor` 暂未接线，统一走内联 `extractToken`，自定义提取器不生效，后续在此分发接入
   * @param o - 认证选项，缺省为 `{}`（等价于 none/放行）
   * @example new Auth({ enabled: true, type: "basic", accounts: [{ username: "u", password: "p" }] })
   * @example new Auth({ enabled: true, type: "jwt", jwtSecret: "s", jwtVerify: async (t,s)=>true })
   */
  constructor(o: AuthOptions = {}) {
    this.enabled = o.enabled ?? false;
    this.type = o.type ?? "none";
    this.jwtSecret = o.jwtSecret ?? "";
    this.jwtVerify = o.jwtVerify;
    this.enableLogging = o.enableLogging ?? (get("authLogging") as boolean) ?? true;
    this.indexes = indexesFor(o.accounts ?? EMPTY_ACCOUNTS);
  }

  /**
   * 比对 Basic 令牌
   * @param t - 提取到的令牌（`b64(user:pass)` 或明文 `user:pass`）
   * @returns 命中的用户名，未命中 undefined
   * @example auth["matchBasic"]("YWxpY2U6cHcx") // => "alice"
   */
  private matchBasic(t: string): string | undefined {
    return this.indexes.basic.get(t);
  }

  /**
   * 比对 UID 令牌（仅用户名，密码忽略）
   * @description socks4 USERID 场景：该协议没有密码字段，客户端可能发裸用户名、
   * `user:pass` 明文、`b64(user:pass)` 或 `b64(username)`——一律只取用户名部分与账号表比对，
   * 密码部分不参与判定（与服务端的 uid 语义一致）
   * @param t - 提取到的令牌
   * @returns 命中的用户名，未命中 undefined
   * @example auth["matchUid"]("alice:anypass") // => "alice"
   */
  private matchUid(t: string): string | undefined {
    const trimmed = t.trim();
    if (!trimmed) {
      return undefined;
    }

    // 1) 裸用户名
    if (this.indexes.uidUsers.has(trimmed)) {
      return trimmed;
    }

    // 2) 明文 `user:pass` 或 b64(user:pass)：取 `:` 前的用户名
    const extracted = extractBasicUser(trimmed);
    if (extracted && this.indexes.uidUsers.has(extracted)) {
      return extracted;
    }

    // 3) b64(裸用户名)（如 test -> dGVzdA==）：整体解码后再按 `:` 切
    try {
      const decoded = Buffer.from(trimmed, "base64").toString().trim();
      const user = decoded.split(":")[0]?.trim();
      if (user && this.indexes.uidUsers.has(user)) {
        return user;
      }
    } catch {
      // 非法 base64 不抛即视为不匹配
    }

    return undefined;
  }

  /**
   * 校验 JWT 令牌
   * @description 委托外部注入的 `jwtVerify` 实现；未注入时抛错由上层捕获并视为拒绝。
   * 声明为 `async`：把「未注入」的同步抛错统一转成 rejected Promise，
   * 否则 `authenticate()` 的 `.catch()` 拦不住同步异常，审计事件会被异常越过
   * @param t - JWT 字符串
   * @returns 校验是否通过
   * @throws {Error} 当 `jwtVerify` 未注入时以 rejected Promise 抛出 "JWT auth requires jwtVerify"
   * @example await auth["verifyJwt"](jwtToken)
   */
  private async verifyJwt(t: string): Promise<boolean> {
    if (!this.jwtVerify) {
      throw new Error("JWT auth requires jwtVerify");
    }
    return this.jwtVerify(t, this.jwtSecret);
  }

  /**
   * 执行认证
   * @description 未启用或 type=none 时直接放行；否则提取令牌、按类型比对账号表并通过 `onAuthEvent` 抛出审计事件。
   * 通过时把命中的用户名随结果回传（供上层写入逐连接日志）
   * @param ctx - 认证上下文（含请求头、socket、authority 与审计回调）
   * @returns `{ passed: true, username }` 或 `{ passed: false }`；后者上层应返回 407/断开
   * @example const r = await auth.authenticate({ protocol: "http", req, socket, authority: "example.com:443" } as AuthContext);
   */
  async authenticate(ctx: AuthContext): Promise<AuthResult> {
    if (!this.enabled || this.type === "none") {
      return { passed: true };
    }
    const token = ctx.req.headers ? extractToken(ctx) : undefined;
    const client = getClientAddress(ctx.req);
    const target = ctx.authority || ctx.req.url || "-";
    // 隧道判据必须显式：普通请求的 Host 常带端口（authority 含 ":"），
    // 以 authority.includes(":") 判隧道会把普通请求误标 tunnel
    const tag =
      ctx.req.method === "CONNECT" || ctx.protocol.startsWith("socks") ? "tunnel" : "";
    const emit = (e: ProxyAuthEvent): void => {
      if (this.enableLogging) {
        ctx.onAuthEvent?.(e);
      }
    };
    if (!token) {
      emit({
        passed: false,
        tag,
        client,
        target,
        reason: "no-token",
      });
      return { passed: false };
    }

    // socks4/sockss4 仅 USERID，无密码字段：当 type=basic 时，允许 userid==username 的 uid 形态通过
    let username: string | undefined;
    // verifyJwt 未注入实现时会抛错：捕获后按拒绝处理，保证审计事件照常落盘
    // （否则异常会越过下方 emit，整条 JWT 模式的放行/拒绝都无审计）
    if (this.type === "jwt") {
      const ok = await this.verifyJwt(token).catch(() => false);
      if (ok) {
        username = extractJwtUser(token);
      }
    } else if (this.type === "uid") {
      username = this.matchUid(token);
    } else if (this.type === "basic" && (ctx.protocol === "socks4" || ctx.protocol === "sockss4")) {
      username = this.matchUid(token) ?? this.matchBasic(token);
    } else {
      username = this.matchBasic(token);
    }

    if (username) {
      emit({
        passed: true,
        tag,
        client,
        target,
        user: username,
      });
      return { passed: true, username };
    }

    emit({
      passed: false,
      tag,
      client,
      target,
      attempted: extractUserFromToken(token),
    });
    return { passed: false };
  }
}

/**
 * 创建认证提供者（工厂函数）
 * @description `Auth` 的薄工厂封装，便于按接口编程与测试时替换
 * @param o - 认证选项
 * @returns AuthProvider 实例（实际为 Auth 类实例）
 * @example const auth = createAuthProvider({ enabled: true, type: "basic", accounts: [{ username: "alice", password: "pw1" }] });
 */
export function createAuthProvider(o: AuthOptions = {}): AuthProvider {
  return new Auth(o);
}

/**
 * 从全局配置创建认证提供者（动态版）
 * @description 每次 `authenticate()` 都重读 store 的 `authEnabled/authType/jwtSecret/authLogging` 与账号文件
 * （账号文件经 mtime 节流热加载），改配置或改 users.json 后下一次请求即生效，无需重建 Auth 实例。
 * 账号索引按快照对象身份记忆（见 `indexesFor`），因此「每请求新建 Auth」不会带来每请求的 Map 重建
 * @returns AuthProvider 实例（动态代理）
 * @example const auth = createAuthFromConfig(); // ProxyServer 内部在 createProxy 时调用
 */
export function createAuthFromConfig(): AuthProvider {
  // 缓存一个基础 Auth 仅作 isEnabled/authType 的初始快照与 jwtVerify 注入位，真正校验走动态委派
  const snap = new Auth({
    enabled: get("authEnabled"),
    type: get("authType"),
    jwtSecret: get("jwtSecret"),
  });

  const dynamic: AuthProvider = {
    get isEnabled() {
      return get("authEnabled") as boolean;
    },
    get authType() {
      return get("authType") as string;
    },
    async authenticate(ctx: AuthContext) {
      // 每次重读 store 与账号文件；jwtVerify 沿用快照的注入
      const live = new Auth({
        enabled: get("authEnabled") as boolean,
        type: get("authType") as AuthOptions["type"],
        accounts: loadAuthUsers(),
        jwtSecret: get("jwtSecret") as string,
        jwtVerify: (snap as unknown as { jwtVerify?: AuthOptions["jwtVerify"] }).jwtVerify,
        enableLogging: get("authLogging") as boolean,
      });
      // 若快照曾注入 jwtVerify，透传给 live
      (live as unknown as { jwtVerify: unknown }).jwtVerify = (snap as unknown as { jwtVerify: unknown }).jwtVerify;
      return live.authenticate(ctx);
    },
  };
  // 透传 jwtVerify 的 setter，以便外部注入后动态生效
  Object.defineProperty(dynamic, "jwtVerify", {
    get() {
      return (snap as unknown as { jwtVerify?: unknown }).jwtVerify;
    },
    set(v: unknown) {
      (snap as unknown as { jwtVerify: unknown }).jwtVerify = v;
    },
  });
  return dynamic;
}
