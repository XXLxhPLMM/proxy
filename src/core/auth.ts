/**
 * @fileoverview 代理鉴权插件实现（none / basic / jwt / uid 各一个）
 * @module core/auth
 * @description
 * 本模块提供 `AuthProvider`（`plugins/contracts.ts`）的四个实现，**一类一种鉴权方式**。
 * 此前是一个 `Auth` 类在构造/校验时按 `options.type` 走 switch——「加一种鉴权」必须改核心源码，
 * 而这正是本轮插件化要拔掉的病根。现在注册表键（`AuthKind`）即实现类：
 * `none` / `basic` / `jwt` / `uid` 四个类共享一份**私有**基类（`AuthProviderBase`）里的审计与
 * 令牌提取机制，各自只关心自己那一种判据；组合根按配置从注册表里挑一个注入给协议插件。
 *
 * 职责：
 * - 从 `Proxy-Authorization`（优先）或 `Authorization`（回退）头提取令牌，scheme 前缀按 RFC 7235
 *   大小写不敏感剥离（`Basic` / `basic` 均可）
 * - `BasicAuthProvider`：构造期把账号表编译为「凭证 -> 用户名」索引（`b64(user:pass)` 与明文
 *   `user:pass` 两种键），运行时 O(1) 命中并回传用户名；socks4/sockss4 额外接受 `USERID == username`
 * - `UidAuthProvider`：仅比对用户名（socks4 USERID），token 可为裸用户名、`user:pass`、b64(user:pass)
 *   或 b64(username)
 * - `JwtAuthProvider`：委托注入的 `jwtVerify(token, secret)` 异步校验；**未注入即一律 deny**
 *   （fail-closed，绝不静默放行）
 * - `NoneAuthProvider`：恒放行，`isEnabled: false`
 * - 每个实现同时给出 `isOwnCredential(value)`：出站头剥离判据（`proxy-helpers:isStrippableOutboundHeader`）
 *   与 `authenticate` 共用同一判据，这是硬要求——两者漂移会让代理凭证泄漏到目标站
 * - 产生 `ProxyAuthEvent` 审计事件，经 `AuthContext.onAuthEvent` 上抛至 `BaseProxy.authorize()` 转为
 *   proxy `auth` 事件
 *
 * 设计要点：
 * - 零日志：本模块不直接写日志，审计细节通过 `onAuthEvent` 回调抛出，由 server 层统一落盘
 * - 异常即拒绝：`authenticate` 内部任何异常都归约为 `{ passed: false }`（契约要求「永不抛错」；
 *   上层 `BaseProxy.authorize()` 的捕获是第二道保险）
 * - 结果带身份：返回 `AuthResult{ passed, username }`，让上层把用户名带进逐连接日志（多账号下谁在访问必须可查）
 * - 不读全局：本模块**不 import** `config/store.js`，账号表 / JWT 密钥 / 审计开关一律经构造参数注入
 *   （此前 `createAuthFromConfig()` 每请求重读 store 是全局单例的产物，插件化后由组合根按 `ConfigScope`
 *   的生命周期决定何时重建 provider）
 * - 凭证索引按账号快照对象身份记忆（见 `proxy-helpers:credentialIndexesFor`），同一份只读索引可被
 *   多个并发会话共享
 * - 空用户名恒判否：账号表在解析期已拒绝空用户名，索引构建再跳过一次（纵深防御），
 *   否则空用户名会让 `:` / `Og==` 之类无意义 token 命中的正是「无账号」这种伪凭证
 * - 大小写不敏感的头查找：`getHeader` 遍历 headers 并以小写比对，兼容 Node 的头名大小写差异
 * - 脱敏与截断：`extractJwtUser` 对 JWT 取 `sub/username/user/uid/id`，Basic 解码后取用户名，
 *   均截断至 32 字符以内
 *
 * 使用示例：
 * ```ts
 * import {
 *   BasicAuthProvider,
 *   JwtAuthProvider,
 *   defaultJwtVerify,
 *   NoneAuthProvider,
 * } from "@/core/auth.js";
 *
 * // 1) 放行（组合根在 AUTH_ENABLED=false 时选它）
 * const none = new NoneAuthProvider();
 *
 * // 2) Basic 认证（账号表由组合根从 users.json 读出后注入）
 * const basic = new BasicAuthProvider({ accounts: [{ username: "admin", password: "s3cr3t" }] });
 * const r = await basic.authenticate({ protocol: "http", req, socket, authority: "example.com:443" } as AuthContext);
 *
 * // 3) JWT 认证（校验器由组合根注入；不注入 = 全拒）
 * const jwt = new JwtAuthProvider({ jwtSecret: "shhh", jwtVerify: defaultJwtVerify });
 * ```
 */

import { getClientAddress } from "@/utils/addr/request.js";
import {
  credentialIndexesFor,
  extractBasicUser,
  isJwtShape,
  matchBasicCredential,
  matchUidCredential,
  verifyHs256Jwt,
  type ProxyCredentialIndexes,
} from "@/core/proxy-helpers.js";
import type { AuthAccount, AuthContext, AuthResult, ProxyAuthEvent } from "@/core/types/proxy.js";
import type { AuthKind, AuthProvider } from "@/plugins/contracts.js";
import {
  AUTH_SCHEME_BASIC,
  AUTH_SCHEME_BEARER,
  RE_BASE64URL_DASH,
  RE_BASE64URL_UNDERSCORE,
} from "@/utils/protocol/http.js";

/** `AUTH_SCHEME_BASIC` 的小写形态，供大小写不敏感的 scheme 剥离（RFC 7235）用 */
const AUTH_SCHEME_BASIC_LOWER = AUTH_SCHEME_BASIC.toLowerCase();
/** `AUTH_SCHEME_BEARER` 的小写形态，供大小写不敏感的 scheme 剥离（RFC 7235）用 */
const AUTH_SCHEME_BEARER_LOWER = AUTH_SCHEME_BEARER.toLowerCase();

/** 空账号表（只读哨兵；basic/uid 空表时索引全空 → 一切凭证判否） */
const EMPTY_ACCOUNTS: readonly AuthAccount[] = [];

/** 审计事件里与「通过与否」无关的三个公共字段（client / target / tag） */
interface AuthAuditContext {
  tag: string;
  client: string;
  target: string;
}

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
 * scheme 按 RFC 7235 大小写不敏感匹配（`basic `/`Bearer ` 均可），剥离时依旧按常量长度切片，保留原始令牌大小写。
 * `Authorization` 回退正是代理 JWT 会被原样转发给目标站的入口，出站侧的对应物是各 provider 的
 * `isOwnCredential`（那边处理的是 scheme 剥离形态，覆盖无 scheme 裸值）
 * @param ctx - 认证上下文，含 `req.headers`
 * @returns 去前缀后的令牌字符串，未携带则返回 undefined
 * @example extractToken({ req: { headers: { "proxy-authorization": "Basic abc==" } } } as any) // => "abc==="
 * @example extractToken({ req: { headers: { "proxy-authorization": "basic abc==" } } } as any) // => "abc=="
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
 * 根据令牌形状分发提取用户名（审计的 attempted 字段用；`isJwtShape` 的注释指向本函数）
 * @param t - 原始令牌字符串
 * @returns 用户名或脱敏指纹
 * @example extractUserFromToken(jwtToken) // => "alice"
 * @example extractUserFromToken(basicB64) // => "admin"
 */
function extractUserFromToken(t: string): string | undefined {
  return isJwtShape(t) ? extractJwtUser(t) : extractBasicUser(t);
}

/**
 * 取 `Authorization` 头值参与凭证判定的两种形态
 * @description 出站头有两种真实写法：带 scheme（`Basic dXNlcjpwYXNz`，主流客户端）与**不带 scheme**
 * 的裸凭证值（非标准但真实存在）。`trimmed` 是去空白后的原值，`stripped` 是再去掉 `^[A-Za-z]+\s+`
 * 的值——无 scheme 时两者相等，于是「两种形态」各判一次就覆盖全部写法，
 * 不必在每个判据里重写一遍剥离逻辑（两处剥离规则漂移过一次就会漏判）。
 * @param value - 原始头值
 * @returns `{ trimmed, stripped }`
 * @example credentialForms("Basic dXNlcjpwYXNz") // => { trimmed: "Basic dXNlcjpwYXNz", stripped: "dXNlcjpwYXNz" }
 * @example credentialForms("dXNlcjpwYXNz") // => { trimmed: 同值, stripped: 同值 }
 */
function credentialForms(value: string): { trimmed: string; stripped: string } {
  const trimmed = value.trim();
  return { trimmed, stripped: trimmed.replace(/^[A-Za-z]+\s+/, "") };
}

/**
 * 构造审计事件的公共字段（`tag` / `client` / `target`）
 * @description `tag` 的判据必须显式——`method === "CONNECT"` 或 `socks*` 协议才是隧道；
 * 普通请求的 Host 常带端口（authority 含 ":"），以 `authority.includes(":")` 判隧道会把普通请求
 * 误标 tunnel，审计因此分不清被拒的是隧道还是普通请求
 * @param ctx - 认证上下文
 * @returns tag/client/target 三元组
 * @example auditContext(ctx) // => { tag: "tunnel", client: "1.2.3.4", target: "example.com:443" }
 */
function auditContext(ctx: AuthContext): AuthAuditContext {
  return {
    tag: ctx.req.method === "CONNECT" || ctx.protocol.startsWith("socks") ? "tunnel" : "",
    client: getClientAddress(ctx.req),
    target: ctx.authority || ctx.req.url || "-",
  };
}

/**
 * 内置 JWT 校验器（HS256，零依赖 `node:crypto`）
 * @description
 * `JwtAuthProvider` 的默认注入实现（由组合根注入），薄 async 包装——校验实现体在
 * `proxy-helpers:verifyHs256Jwt`（鉴权与出站凭证剥离共用同一实现，避免两处验签逻辑漂移）。
 * 完整语义见 {@link verifyHs256Jwt}：空密钥 / 非 HS256 / 签名不符 / 载荷非对象 / `exp` 非法或过期
 * 一律 fail-closed，永不抛出（上层 `authenticate()` 的 catch 也按拒绝处理，双保险）。
 * @param token - JWT 字符串（三段式）
 * @param secret - 签名密钥（由组合根从 `ConfigScope` 取出后注入）
 * @returns 校验是否通过；只 resolve，永不 reject
 * @example await defaultJwtVerify("eyJhbGciOi...eyJzdWIi...sig", "s3cr3t") // => true
 * @example await defaultJwtVerify("not-a-jwt", "s3cr3t") // => false
 * @example await defaultJwtVerify(token, "") // => false（空密钥）
 */
export async function defaultJwtVerify(token: string, secret: string): Promise<boolean> {
  return verifyHs256Jwt(token, secret);
}

/**
 * 鉴权实现的私有共享基类（不导出）
 * @description
 * 承载四个实现完全相同的那部分机制：审计字段构造、`enableLogging` 开关、`authenticate` 的
 * 「无令牌 → 拒绝 / 有令牌 → 交子类判据 / 命中回传用户名 / 未命中记 attempted」模板，以及
 * 异常归约。**刻意不导出**：它是本模块内部的复用手段，不是插件契约的一部分——
 * 导出它等于邀请外部实现去继承，进而把 `resolveUsername` 这个私有扩展点固化成公共 API。
 * 子类只需给出 `kind`、`isOwnCredential` 与 `resolveUsername`。
 */
abstract class AuthProviderBase implements AuthProvider {
  /** 注册表键回显（由各子类以字面量声明，保证与 `AuthKind` 同步） */
  abstract readonly kind: AuthKind;

  /**
   * 鉴权是否生效
   * @description 只有 `NoneAuthProvider` 为 false（它就是「不鉴权」这个实现本身）；
   * 其余实现恒 true——「开不开鉴权」由组合根**选哪个实现**表达，不再是实例内的第二个开关。
   * 基类模板靠它短路：`NoneAuthProvider` 因此连令牌都不提取，也**不产生审计事件**。
   */
  get isEnabled(): boolean {
    return true;
  }

  /**
   * @param enableLogging - 是否启用认证审计事件；由组合根从配置（`AUTH_LOGGING`）取出后注入。
   *   缺省 true，与旧实现 `o.enableLogging ?? get("authLogging") ?? true` 的兜底一致
   */
  protected constructor(protected readonly enableLogging: boolean) {}

  /**
   * 上抛审计事件（受 `enableLogging` 开关约束）
   * @description core 零日志：审计只走 `ctx.onAuthEvent`，由上层转抛为 proxy `auth` 事件落盘；
   * 开关关掉时**静默丢弃事件**（不是丢判定）——鉴权照常执行，只是不落审计
   * @param ctx - 认证上下文
   * @param event - 审计事件
   */
  protected emit(ctx: AuthContext, event: ProxyAuthEvent): void {
    if (this.enableLogging) {
      ctx.onAuthEvent?.(event);
    }
  }

  /**
   * 判定一个 `Authorization` 头值是否为本代理自身的凭证（出站剥离用）
   * @description 由子类实现：判据必须与各自的 `resolveUsername` 同源，否则入站放行的凭证
   * 会被原样转发给目标站（`proxy-helpers:isStrippableOutboundHeader` 是唯一调用点）。
   * `NoneAuthProvider` 恒 false——不鉴权就没有「自己的凭证」
   * @param value - `Authorization` 头值（可能带 scheme）
   * @returns 是否为代理自身凭证
   */
  abstract isOwnCredential(value: string): boolean;

  /**
   * 判定本实现是否认这个令牌（子类实现）
   * @description 同步实现（basic/uid）与异步实现（jwt）都允许：调用方一律 `await`，
   * 非 Promise 值直接透传。**不许抛错**——模板方法已把异常归约为拒绝，但子类抛错会丢掉审计事件
   * @param token - `extractToken` 剥掉 scheme 后的令牌
   * @param ctx - 认证上下文（socks4 USERID 形态的判定需要 `ctx.protocol`）
   * @returns 命中的用户名；未命中 undefined
   */
  protected abstract resolveUsername(
    token: string,
    ctx: AuthContext,
  ): string | undefined | Promise<string | undefined>;

  /**
   * 执行认证（模板方法：审计与异常归约只此一份）
   * @description 未启用（`NoneAuthProvider`）直接放行且**不发审计**；否则提取令牌、按子类判据比对、
   * 经 `onAuthEvent` 抛出审计事件。任一步抛错都归约为 `{ passed: false }`（fail-closed）
   * @param ctx - 认证上下文（含请求头、socket、authority 与审计回调）
   * @returns `{ passed: true, username }` 或 `{ passed: false }`；后者上层应返回 407/断开
   * @example const r = await basic.authenticate({ protocol: "http", req, socket, authority: "example.com:443" } as AuthContext);
   */
  async authenticate(ctx: AuthContext): Promise<AuthResult> {
    if (!this.isEnabled) {
      return { passed: true };
    }
    try {
      const token = ctx.req.headers ? extractToken(ctx) : undefined;
      const audit = auditContext(ctx);
      if (!token) {
        this.emit(ctx, {
          passed: false,
          ...audit,
          reason: "no-token",
        });
        return { passed: false };
      }
      const username = await this.resolveUsername(token, ctx);
      if (username) {
        this.emit(ctx, {
          passed: true,
          ...audit,
          user: username,
        });
        return { passed: true, username };
      }
      this.emit(ctx, {
        passed: false,
        ...audit,
        attempted: extractUserFromToken(token),
      });
      return { passed: false };
    } catch {
      // 异常即拒绝：契约要求 authenticate 永不抛错（数据面不得因鉴权实现 bug 而崩）
      return { passed: false };
    }
  }
}

/**
 * 放行实现（注册表键 `none`）
 * @description
 * 「不鉴权」在插件化之后是一个**一等实现**而不是某个类里的 `type === "none"` 分支：
 * 组合根在 `AUTH_ENABLED=false` 时挂它，于是 `isEnabled: false` 让基类模板直接放行
 * （连令牌都不提取，也不产生审计事件——没有凭证就没有可审计的判定）。
 * @example
 * const auth = new NoneAuthProvider();
 * await auth.authenticate(ctx); // => { passed: true }
 */
export class NoneAuthProvider extends AuthProviderBase {
  readonly kind = "none" as const;

  /**
   * @description 审计开关传 false 只是让基类构造有实参：本实现恒放行、恒不发审计事件，
   * 该字段永远读不到（`authenticate` 在 `isEnabled` 短路处就返回了）
   */
  constructor() {
    super(false);
  }

  /**
   * 恒 false：不鉴权 ⇒ 没有「自己的凭证」可言
   * @description 基类的 `isEnabled` 短路已保证 `authenticate` 恒放行；这里补上的是**出站侧**的
   * 同一件事——不鉴权的实例不该剥掉任何 `Authorization`（那是目标站自己的凭证）
   */
  override get isEnabled(): boolean {
    return false;
  }

  /**
   * 恒 false（同上：没有「自己的凭证」）
   * @description 刻意不读参数：出站头是否要剥只看本实例的鉴权方式，与具体头值无关
   */
  isOwnCredential(value: string): boolean {
    void value;
    return false;
  }

  /** 恒放行，不做任何判定（也不需要） */
  protected resolveUsername(): undefined {
    return undefined;
  }
}

/**
 * Basic 认证实现（注册表键 `basic`）
 * @description
 * 账号表整串比对：构造期编译为索引（`b64(user:pass)` 与明文 `user:pass` 两种键），
 * 运行时 O(1) 命中。socks4/sockss4 只有 USERID、没有密码字段，该协议下额外接受
 * `USERID == username`（见 `resolveUsername`）。
 * @param options.accounts - 账号表（来源见 `AUTH_USERS_FILE`，由组合根读出后注入）；空表 ⇒ 索引全空 ⇒ 一律判否
 * @param options.enableLogging - 是否启用审计事件（缺省 true）
 * @example
 * const auth = new BasicAuthProvider({ accounts: [{ username: "alice", password: "pw1" }] });
 * await auth.authenticate(ctx); // => { passed: true, username: "alice" }
 */
export class BasicAuthProvider extends AuthProviderBase {
  readonly kind = "basic" as const;

  /** 只读凭证索引：构造期编译一次，之后所有会话共享 */
  private readonly indexes: ProxyCredentialIndexes;

  constructor(options: { accounts?: readonly AuthAccount[]; enableLogging?: boolean } = {}) {
    super(options.enableLogging ?? true);
    this.indexes = credentialIndexesFor(options.accounts ?? EMPTY_ACCOUNTS);
  }

  /**
   * 比对令牌（薄委托：判据在 `proxy-helpers:matchBasicCredential`）
   * @description socks4/sockss4 额外接受 uid 形态（`USERID == username`，无密码字段可校验）
   * @param token - 提取到的令牌（`b64(user:pass)` 或明文 `user:pass`）
   * @param ctx - 认证上下文（判 socks4 形态）
   * @returns 命中的用户名，未命中 undefined
   */
  protected resolveUsername(token: string, ctx: AuthContext): string | undefined {
    // socks4/sockss4 仅 USERID，无密码字段：当 basic 模式遇该协议时，允许 userid==username 的 uid 形态通过
    if (ctx.protocol === "socks4" || ctx.protocol === "sockss4") {
      return matchUidCredential(token, this.indexes) ?? matchBasicCredential(token, this.indexes);
    }
    return matchBasicCredential(token, this.indexes);
  }

  /**
   * 判定 `Authorization` 头值是否为代理自身凭证（出站剥离判据）
   * @description 与 `authenticate` 共用同一份索引（唯一收口）；**必须比对整份账号表**——
   * 只比一个账号会让其余账号的凭证原样泄漏到目标站点。scheme 剥离形态与裸值形态各判一次
   * （裸值即无 scheme 的 `Authorization: <b64>`，非标准但真实存在的客户端写法）
   * @param value - `Authorization` 头值（如 "Basic dXNlcjpwYXNz"）
   * @returns 是否为代理凭证（空账号表时索引全空，恒 false）
   * @example auth.isOwnCredential("Basic YWRtaW46czNjcjN0") // => true（账号表含 admin/s3cr3t）
   */
  isOwnCredential(value: string): boolean {
    const { trimmed, stripped } = credentialForms(value);
    if (!stripped) {
      return false;
    }
    return (
      matchBasicCredential(stripped, this.indexes) !== undefined ||
      matchBasicCredential(trimmed, this.indexes) !== undefined
    );
  }
}

/**
 * UID 认证实现（注册表键 `uid`）
 * @description
 * 只比用户名、忽略密码：socks4 USERID 场景（`USERID` 无密码字段）。token 可为裸用户名、
 * `user:pass` 明文、`b64(user:pass)` 或 `b64(username)`，判据全在
 * `proxy-helpers:matchUidCredential`。
 * @param options.accounts - 账号表（`password` 字段不参与判定）
 * @param options.enableLogging - 是否启用审计事件（缺省 true）
 * @example
 * const auth = new UidAuthProvider({ accounts: [{ username: "test", password: "" }] });
 * await auth.authenticate(ctx); // => { passed: true, username: "test" }
 */
export class UidAuthProvider extends AuthProviderBase {
  readonly kind = "uid" as const;

  /** 只读凭证索引：构造期编译一次，之后所有会话共享 */
  private readonly indexes: ProxyCredentialIndexes;

  constructor(options: { accounts?: readonly AuthAccount[]; enableLogging?: boolean } = {}) {
    super(options.enableLogging ?? true);
    this.indexes = credentialIndexesFor(options.accounts ?? EMPTY_ACCOUNTS);
  }

  /**
   * 比对令牌（薄委托：判据在 `proxy-helpers:matchUidCredential`，仅用户名，密码忽略）
   * @param token - 提取到的令牌
   * @returns 命中的用户名，未命中 undefined
   */
  protected resolveUsername(token: string): string | undefined {
    return matchUidCredential(token, this.indexes);
  }

  /**
   * 判定 `Authorization` 头值是否为代理自身凭证（出站剥离判据）
   * @description 与 `authenticate` 共用同一份索引；同样**必须比对整份账号表**（只比一个账号
   * 会让其余账号的凭证泄漏）。uid 判据是用户名模糊匹配，比 basic 更宽——
   * 宁可多剥（目标站恰好用同形 username 走 Basic 时会被误剥，属已接受的方向性代价）
   * @param value - `Authorization` 头值
   * @returns 是否为代理凭证
   * @example auth.isOwnCredential("Basic YWRtaW46czNjcjN0") // => true（账号表含 admin）
   */
  isOwnCredential(value: string): boolean {
    const { trimmed, stripped } = credentialForms(value);
    if (!stripped) {
      return false;
    }
    return (
      matchUidCredential(stripped, this.indexes) !== undefined ||
      matchUidCredential(trimmed, this.indexes) !== undefined
    );
  }
}

/**
 * JWT 认证实现（注册表键 `jwt`）
 * @description
 * 委托注入的 `jwtVerify(token, secret)` 异步校验，**不自带账号表语义**（jwt 允许空表）。
 * 用户名取 token 的 `sub / username / user / uid / id`。
 * 校验器由组合根注入（生产链路注入 `defaultJwtVerify`，即内置 HS256；显式注入优先）。
 * @param options.jwtSecret - 签名密钥（组合根从配置取出后注入；空串 ⇒ 一律判否）
 * @param options.jwtVerify - 校验器；**不注入即全部拒绝**（fail-closed，见字段注释）
 * @param options.enableLogging - 是否启用审计事件（缺省 true）
 * @example
 * const auth = new JwtAuthProvider({ jwtSecret: "shhh", jwtVerify: defaultJwtVerify });
 * await auth.authenticate(ctx); // => { passed: true, username: "alice" }
 */
export class JwtAuthProvider extends AuthProviderBase {
  readonly kind = "jwt" as const;

  /** 签名密钥：只读，出站剥离与入站验签共用同一份 */
  private readonly jwtSecret: string;

  /**
   * 校验器（外部注入位）
   * @description 缺省即「没有校验能力」：`resolveUsername` 会 fail-closed 全拒。刻意**不在构造期抛错**——
   * 抛错会让「装配漏注入」变成启动崩溃，而漏注入的真实后果应该是这个实例静悄悄地拒绝一切请求；
   * 审计仍照常落盘（带 `attempted`），运维从 `[auth] deny` 行能看出「有令牌但一条都不过」
   */
  private readonly jwtVerify?: (token: string, secret: string) => Promise<boolean>;

  constructor(
    options: {
      jwtSecret?: string;
      jwtVerify?: (token: string, secret: string) => Promise<boolean>;
      enableLogging?: boolean;
    } = {},
  ) {
    super(options.enableLogging ?? true);
    this.jwtSecret = options.jwtSecret ?? "";
    this.jwtVerify = options.jwtVerify;
  }

  /**
   * 验签并回传用户名
   * @description 唯一的异步判据（basic/uid 都是同步 O(1) 查表）；未注入校验器或校验器抛错都归为
   * 「未通过」，因此 JWT 路径**不可能**出现「因为实现 bug 而放行」
   * @param token - 提取到的令牌（预期为三段式 JWT）
   * @returns 通过时为 token 中的用户名；未通过/未注入校验器时 undefined
   */
  protected async resolveUsername(token: string): Promise<string | undefined> {
    const verifier = this.jwtVerify;
    // fail-closed：没有校验器就没有「验签通过」这件事，绝不因为漏注入而放行
    if (!verifier) {
      return undefined;
    }
    // 校验器抛错同样按拒绝处理，保证审计事件照常落盘（否则整条 JWT 路径的放行/拒绝都无审计）
    const ok = await verifier(token, this.jwtSecret).catch(() => false);
    return ok ? extractJwtUser(token) : undefined;
  }

  /**
   * 判定 `Authorization` 头值是否为代理自身凭证（出站剥离判据）
   * @description
   * 与入站验签**共用同一实现**（内置 HS256 + 同一份密钥），且**不依赖账号表**——jwt 允许空表，
   * 所以这里也不存在「空表早退」：一旦引入空表早退，客户端用
   * `Authorization: Bearer <代理JWT>` 认证时该 JWT 会被原样转发给目标站
   * （`extractToken` 的 `Authorization` 回退正是这么取的），等于把代理凭证泄漏出去。
   * 判据：剥 scheme 前缀后 `isJwtShape` 三段式 + `verifyHs256Jwt` 验签通过。
   *
   * 已知边界：注入**自定义** `jwtVerify` 时本判据不感知（只认内置 HS256）。方向仍是
   * 「宁可多剥不泄漏」；自定义校验器放行的 token 不会被剥离，属已记录边界。
   * @param value - `Authorization` 头值（如 "Bearer eyJ..."）
   * @returns 是否为代理凭证
   * @example auth.isOwnCredential("Bearer eyJhbGciOi...") // => 内置 HS256 验签通过才为 true
   */
  isOwnCredential(value: string): boolean {
    const { stripped } = credentialForms(value);
    if (!stripped) {
      return false;
    }
    return isJwtShape(stripped) && verifyHs256Jwt(stripped, this.jwtSecret);
  }
}
