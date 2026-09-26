/**
 * @fileoverview 身份插件的共用骨架：取凭证 + 脱敏 + 审计发事件 + 结果判定
 * @module core/identity/token
 * @description
 * 本模块是身份域的**骨架层**。四种内置身份模式（none/basic/jwt/uid）之间，
 * 差异**只在「拿到 token 之后怎么比对」这一步**；而「从哪取凭证、怎么脱敏、
 * 审计事件长什么样、通过/拒绝怎么组结果」是完全同形的一份，抄成四份必然漂移——
 * 于是那份同形的东西住在这里（`TokenIdentityBase`），差异留在各插件的 `match()`。
 *
 * 职责：
 * - `TokenIdentityBase`：识别模板方法（取 token → 审计 → 交 `match()` 比对 → 组结果）
 * - 头值原语：`getHeader` / `extractToken`（`Proxy-Authorization` 优先、`Authorization` 回退、
 *   scheme 大小写不敏感剥离）/ `extractJwtUser` / `extractUserFromToken`
 * - 出站凭证判据的**共用部分**：`ownCredentialForms`（头名门禁 + trim + 剥 scheme）、
 *   `matchesBasicCredentialForms` / `matchesUidCredentialForms` / `matchesJwtCredentialForm`
 *   （各自只对 basic/uid/jwt 负责，双形态判定在这一处）
 * - `defaultJwtVerify`：内置 HS256 校验器的薄 async 包装
 *
 * 设计要点：
 * - **零日志**：本模块不直接写日志，审计细节经 `IdentityContext.onAuthEvent` 上抛，
 *   由 `BaseProxy.authorize()` 转成 `auth.decided` 事件、runtime 层统一落盘
 *   （`src/runtime/event-log.ts:bindProxyEventLogs`，CLI 与库共用同一份）。
 * - **零配置依赖**：本文件**不 import `@/config/index.js`**。配置驱动的门面在
 *   `./file-account.ts`（`createIdentityFromConfig`），纯插件这一侧只消费显式入参。
 * - **异常即拒绝**：`identify` 用 `.catch(() => undefined)` 包住插件的 `match()`。
 *   这条保护**刻意放在骨架而不是各插件的 `match()` 里**：「插件实现不可信」是**端口级**
 *   事实，自定义身份插件同样适用；若由每个插件各自记得，早晚会漏一个，而漏掉的后果是
 *   「异常越过审计事件直接上抛」——整条模式的放行/拒绝都没有审计。
 * - `isEnabled` 的口径是「**本实例会不会拒绝任何人**」：它就是识别模板方法首行那个
 *   早退开关本身。config 驱动的门面把 `type === "none"` 也并进这个字段，于是「不判人」
 *   这件事在全仓只有**一个**真相，模板方法不必再自己判一次 type。
 *
 * 不负责：
 * - 不做账号表读取（`loadAuthUsers` 在 config 侧）、不做目标解析、不发事件、不打日志
 * - 不实现出站头剥离的**宽规则**（任意 `proxy-` 前缀）——那在 `@/core/helpers/headers.ts`
 *
 * 使用示例：
 * ```ts
 * import { TokenIdentityBase } from "@/core/identity/token.js";
 *
 * class MyIdentity extends TokenIdentityBase {
 *   readonly kind = "mine";
 *   isOwnCredential(): boolean { return false; }
 *   protected async match(token: string): Promise<string | undefined> {
 *     return token === process.env.MY_TOKEN ? "trusted" : undefined;
 *   }
 * }
 * ```
 */

import { getClientAddress } from "@/utils/ip.js";
import {
  AUTH_SCHEME_BASIC,
  AUTH_SCHEME_BEARER,
  RE_BASE64URL_DASH,
  RE_BASE64URL_UNDERSCORE,
} from "@/utils/constants/index.js";
import {
  credentialIndexesFor,
  extractBasicUser,
  isJwtShape,
  matchBasicCredential,
  matchUidCredential,
  verifyHs256Jwt,
  type ProxyCredentialIndexes,
} from "@/core/helpers/index.js";
import type {
  AuthAccount,
  IdentityContext,
  IdentityOptions,
  IdentityProvider,
  IdentityResult,
  ProxyAuthEvent,
} from "@/core/types/identity.js";

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
 * 从身份上下文中提取原始令牌
 * @description 优先读取 `Proxy-Authorization`，回退 `Authorization`；若值以 `Basic ` / `Bearer ` 开头则剥离前缀。
 * scheme 按 RFC 7235 大小写不敏感匹配（`basic `/`Bearer ` 均可），剥离时依旧按常量长度切片，保留原始令牌大小写
 * @param ctx - 身份上下文，含 `req.headers`
 * @returns 去前缀后的令牌字符串，未携带则返回 undefined
 * @example extractToken({ req: { headers: { "proxy-authorization": "Basic abc==" } } } as any) // => "abc=="
 * @example extractToken({ req: { headers: { "proxy-authorization": "basic abc==" } } as any) // => "abc=="
 * @example extractToken({ req: { headers: { authorization: "Bearer eyJ..." } } as any) // => "eyJ..."
 */
function extractToken(ctx: IdentityContext): string | undefined {
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
    const p = token
      .split(".")[1]
      .replace(RE_BASE64URL_DASH, "+")
      .replace(RE_BASE64URL_UNDERSCORE, "/");
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
 * 根据令牌形状分发提取用户名（审计事件里的 `attempted` 字段）
 * @param t - 原始令牌字符串
 * @returns 用户名或脱敏指纹
 * @example extractUserFromToken(jwtToken) // => "alice"
 * @example extractUserFromToken(basicB64) // => "admin"
 */
function extractUserFromToken(t: string): string | undefined {
  return isJwtShape(t) ? extractJwtUser(t) : extractBasicUser(t);
}

/**
 * 内置 JWT 校验器（HS256，零依赖 `node:crypto`）
 * @description
 * `createIdentityFromConfig()` 的默认注入实现，薄 async 包装——校验实现体在
 * `helpers/credentials:verifyHs256Jwt`（鉴权与出站凭证判据共用同一实现，避免两处验签逻辑漂移）。
 * 完整语义见 {@link verifyHs256Jwt}：空密钥 / 非 HS256 / 签名不符 / 载荷非对象 / `exp` 非法或过期
 * 一律 fail-closed，永不抛出（上层 `identify()` 的 catch 也按拒绝处理，双保险）。
 * @param token - JWT 字符串（三段式）
 * @param secret - 签名密钥（由调用方显式提供的 `jwtSecret`）
 * @returns 校验是否通过；只 resolve，永不 reject
 * @example await defaultJwtVerify("eyJhbGciOi...eyJzdWIi...sig", "s3cr3t") // => true
 * @example await defaultJwtVerify("not-a-jwt", "s3cr3t") // => false
 * @example await defaultJwtVerify(token, "") // => false（空密钥）
 */
export async function defaultJwtVerify(token: string, secret: string): Promise<boolean> {
  return verifyHs256Jwt(token, secret);
}

/**
 * 出站凭证判据的头值两种形态
 * @description 同一个凭证在出站头里会以两种形态出现：带 scheme 前缀（`Basic dXNlcjpwYXNz`）
 * 与裸值（`dXNlcjpwYXNz`）。判据必须**两种都认**——只认一种就会让另一种原样转发出去。
 */
export interface CredentialForms {
  /** 去空格后的整串（带 scheme 形态，账号表里也存了 `user:pass` 明文键，故仍要判） */
  trimmed: string;
  /** 剥掉 `^[A-Za-z]+\s+` 之后的裸值 */
  stripped: string;
}

/**
 * 出站凭证判据的**共用前置**：头名门禁 + trim + 剥 scheme
 * @description
 * 抽出来是因为三种形态（basic/uid/jwt）的这一段**逐字相同**，而它又是整个判据里最容易
 * 抄歪的一段（大小写、空串、scheme 剥离的贪婪性）。返回值 `undefined` = 「这不是本代理
 * 可能发出的凭证，别剥」，由调用方回 false。
 *
 * **⚠️ 下面那道 `name !== "authorization"` 门禁是「内置四插件自己的优化」，不是端口的限制。**
 * - 它成立的理由很窄也很硬：内置四插件**只签发 `Authorization`**（`extractToken` 只从
 *   `Proxy-Authorization` / `Authorization` 取凭证），所以对任何别的头名它们**本来就不持有
 *   任何凭证**——早退是为了让「每个出站头都被问一遍」这件事在生产路径上足够便宜。
 * - `IdentityProvider.isOwnCredential` 的端口契约**不**要求对非 `authorization` 头名恒 false：
 *   库层（`helpers/headers.ts:isStrippableOutboundHeader`）对**每个出站头名 × 每个头值**都调
 *   它，自定义插件完全可以认 `X-Api-Key` 这类自定义头名，那一层就会把那个头剥掉。
 * - **所以这道门禁是性能优化、不是安全边界**：它放在头名比较的**最前面**（先判名、再 `trim`、
 *   最后才剥 scheme），正是为了让「被问到但不是我的头」这条路径的代价只有一次
 *   `toLowerCase()` + 一次 `!==`。**自定义插件请照抄这个顺序**（本方法因此是同步的、
 *   零 IO、零 crypto 的纯字符串操作）——别在头名判完之前做值判定。
 * @param name - 出站头名（小写归一后传入；本函数仍做一次 `toLowerCase` 以容忍未归一的调用方）
 * @param value - 出站头值原文
 * @returns 两种形态；非 `authorization` 头名或空值时为 undefined
 * @example ownCredentialForms("authorization", " Basic dXNlcjpwYXNz ") // => { trimmed: "Basic dXNlcjpwYXNz", stripped: "dXNlcjpwYXNz" }
 * @example ownCredentialForms("x-api-key", "k-42") // => undefined（内置插件只签发 Authorization；**自定义插件不学这条**）
 */
export function ownCredentialForms(name: string, value: string): CredentialForms | undefined {
  if (name.toLowerCase() !== "authorization") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return { trimmed, stripped: trimmed.replace(/^[A-Za-z]+\s+/, "") };
}

/**
 * basic 形态的出站凭证判据（双形态、整份账号表）
 * @description 多账号下必须与**整份账号表**逐个比对——只比对一个账号会让其余账号的凭证
 * 原样泄漏到目标站点。判据本体在 `helpers/credentials:matchBasicCredential`，这里只做双形态编排
 * @param forms - `ownCredentialForms` 的产物
 * @param indexes - 账号表编译出的凭证索引
 * @returns 是否命中本代理的 basic 凭证
 */
export function matchesBasicCredentialForms(
  forms: CredentialForms,
  indexes: ProxyCredentialIndexes,
): boolean {
  return (
    matchBasicCredential(forms.stripped, indexes) !== undefined ||
    matchBasicCredential(forms.trimmed, indexes) !== undefined
  );
}

/**
 * uid 形态的出站凭证判据（双形态、仅用户名）
 * @description 裸用户名 / `user:pass` / `b64(user:pass)` / `b64(username)` 四形态由
 * `matchUidCredential` 统一处理（密码不参与判定，与 uid 语义一致）
 * @param forms - `ownCredentialForms` 的产物
 * @param indexes - 账号表编译出的凭证索引
 * @returns 是否命中本代理的 uid 凭证
 */
export function matchesUidCredentialForms(
  forms: CredentialForms,
  indexes: ProxyCredentialIndexes,
): boolean {
  return (
    matchUidCredential(forms.stripped, indexes) !== undefined ||
    matchUidCredential(forms.trimmed, indexes) !== undefined
  );
}

/**
 * jwt 形态的出站凭证判据（**不依赖账号表**，且必须先于空表早退）
 * @description 否则客户端用 `Authorization: Bearer <代理JWT>` 认证时，该 JWT 会被原样转发给
 * 目标站（`extractToken` 的 `Authorization` 回退正是这么取的）。`isJwtShape` 只判形状不验签，
 * 真正的判据是内置 HS256 验签（`verifyHs256Jwt`）
 * @param forms - `ownCredentialForms` 的产物
 * @param secret - 签名密钥
 * @returns 是否是本代理签发且未过期的 jwt
 * @example matchesJwtCredentialForm(forms, "s3cr3t") // => true / false
 */
export function matchesJwtCredentialForm(forms: CredentialForms, secret: string): boolean {
  return isJwtShape(forms.stripped) && verifyHs256Jwt(forms.stripped, secret);
}

/**
 * jwt 形态的识别比对（异步验签 → 回传用户名）
 * @description 声明为 `async` 并在**函数体内**抛错（而不是让调用方在调 `verify` 前判空）：
 * 这样一个「未注入 jwtVerify」的同步抛错会变成 rejected Promise，被骨架的
 * `.catch(() => undefined)` 拦成一次「带审计的拒绝」。写成裸同步抛错则拦不住——
 * 异常会越过审计事件直接上抛，整条 jwt 模式的放行/拒绝都无审计
 * @param token - 提取到的令牌（三段式）
 * @param secret - 签名密钥
 * @param verify - 注入的校验器；省略时按拒绝处理
 * @returns 命中的用户名（token 的 `sub/username/user/uid/id`），未通过为 undefined
 * @throws {Error} 当 `verify` 未注入时以 rejected Promise 抛出 "JWT auth requires jwtVerify"
 */
export async function matchJwtToken(
  token: string,
  secret: string,
  verify?: IdentityOptions["jwtVerify"],
): Promise<string | undefined> {
  if (!verify) {
    throw new Error("JWT auth requires jwtVerify");
  }
  return (await verify(token, secret)) ? extractJwtUser(token) : undefined;
}

/**
 * 身份插件骨架基类
 * @description
 * 把「取凭证 → 审计 → 比对 → 组结果」这条**同形流程**收在一处，四种内置模式与
 * config 驱动的门面都继承它，只实现 `match()`（拿到 token 之后怎么比对）与
 * `isOwnCredential()`（出站剥离判据）。可独立构造某种语义正是本次拆分的收益：
 * 库调用方可以只要「uid 语义」而不必连带 basic 的账号表比对。
 *
 * 账号表编译放在基类：`basic` / `uid` 两种模式共用，`jwt` / `none` 各持一份空索引
 * （构造期两次 `new Map()`，可忽略）——比让两个子类各写一份「存 accounts + 编译 +
 * 记 hasAccounts」更值。
 * - `implements IdentityProvider`：**基类自己就声明实现端口**，于是「骨架漏了端口成员」
 *   这类错误在基类处编译期红，而不是等到某个具体模式才发现。
 */
export abstract class TokenIdentityBase implements IdentityProvider {
  /** 审计事件开关（`IdentityOptions.enableLogging`，缺省 true） */
  protected readonly enableLogging: boolean;
  /** 账号表编译出的凭证索引（basic/uid 用；jwt/none 持空索引） */
  protected readonly indexes: ProxyCredentialIndexes;
  /** 账号表是否非空：空表**显式**判否（而不是「碰巧没匹配上」） */
  protected readonly hasAccounts: boolean;

  /**
   * @param o - `enableLogging` 审计开关；`accounts` 账号表（缺省空表）
   * @description 声明为 public（而非 protected）：本类是 `abstract`、无法被直接实例化，
   * 而 protected 构造器会让**子类所在模块的工厂函数**也 `new` 不到自己的子类——那等于逼着
   * 所有插件类把构造器也标 protected，工厂就只能拿到 `any`。抽象已经把「不许直接 new」挡住了
   */
  constructor(o: { enableLogging?: boolean; accounts?: readonly AuthAccount[] }) {
    const accounts = o.accounts ?? EMPTY_ACCOUNTS;
    this.enableLogging = o.enableLogging ?? true;
    this.indexes = credentialIndexesFor(accounts);
    this.hasAccounts = accounts.length > 0;
  }

  /** 身份类型标识（仅展示/审计，不参与控制流） */
  abstract readonly kind: string;

  /**
   * 出站凭证判据（`IdentityProvider` 端口成员，**必填**）
   * @description 抽象成员而非默认实现：默认实现必然是「恒 false = 永不剥离」，
   * 那正是凭证泄漏的形态。宁可编译期红。
   */
  abstract isOwnCredential(name: string, value: string): boolean;

  /**
   * 是否启用身份识别（`IdentityProvider` 端口成员）
   * @description 口径是**「本实例会不会拒绝任何人」**，它**就是**识别模板方法首行那个早退开关
   * 本身——不是「有没有装身份判定器」。本基类恒 true（basic/uid/jwt 三个模式都判人）；不判人的
   * 两种形态各自覆写：`noneIdentity()` 恒 false，配置驱动的门面把 `type === "none"` 也并进来
   * （见 `FileAccountIdentity.isEnabled`）。
   * **消费方只读这一个字段**：再自己判一次 `kind !== "none"` 就是把同一个事实抄成第二份真相，
   * 两处一旦漂移，症状是 `isEnabled` 说「不判人」而某个消费点仍走鉴权握手分支
   */
  get isEnabled(): boolean {
    return true;
  }

  /**
   * 拿到凭证之后「怎么比对」——**四种模式的唯一差异点**
   * @param token - 提取到的令牌（已剥 scheme）
   * @param ctx - 身份上下文（协议判定需要它，如 basic 在 socks4 下的兼容分支）
   * @returns 命中的用户名；未通过为 undefined
   */
  protected abstract match(token: string, ctx: IdentityContext): Promise<string | undefined>;

  /**
   * 执行身份识别（模板方法，四种模式逐字共用）
   * @description 未启用（`isEnabled === false`）时直接放行且**不发审计事件**——
   * 「什么都不判」不是一次鉴权失败；否则提取令牌、按 `match()` 的结论比对，并通过
   * `onAuthEvent` 抛出审计事件，通过时把命中的用户名随结果回传（供上层写逐连接日志）
   * @param ctx - 身份上下文（含请求头、socket、authority 与审计回调）
   * @returns `{ passed: true, username }` 或 `{ passed: false }`；后者上层应返回 407/断开
   * @example const r = await identity.identify({ protocol: "http", req, socket, authority: "example.com:443" } as IdentityContext);
   */
  async identify(ctx: IdentityContext): Promise<IdentityResult> {
    if (!this.isEnabled) {
      return { passed: true };
    }
    const token = ctx.req.headers ? extractToken(ctx) : undefined;
    const client = getClientAddress(ctx.req);
    const target = ctx.authority || ctx.req.url || "-";
    // 隧道判据必须显式：普通请求的 Host 常带端口（authority 含 ":"），
    // 以 authority.includes(":") 判隧道会把普通请求误标 tunnel
    const tag = ctx.req.method === "CONNECT" || ctx.protocol.startsWith("socks") ? "tunnel" : "";
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

    // match 抛错（jwtVerify 未注入、自定义校验器炸了…）一律按拒绝处理，保证审计事件照常落盘；
    // 保护刻意留在骨架：自定义身份插件同样是「不可信实现」
    const username = await this.match(token, ctx).catch(() => undefined);
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
