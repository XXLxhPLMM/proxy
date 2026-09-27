/**
 * @fileoverview 身份插件工厂：none / basic / uid / jwt 四种模式的独立可构造形态
 * @module core/identity/modes
 * @description
 * 本模块是**四个可独立构造的插件工厂**（none / basic / uid / jwt）。拆分判据：共性
 * （取凭证 + 脱敏 + 审计发事件 + 结果判定）住在
 * `./token.ts:TokenIdentityBase`，个性（拿到 token 之后怎么比对）落在本文件每个工厂产出的小类里。
 *
 * 职责：
 * - `noneIdentity()`：恒放行（显式关掉身份识别的可读形态）
 * - `basicIdentity(opts)`：账号表精确比对（`b64(user:pass)` / 明文 `user:pass`）
 * - `uidIdentity(opts)`：仅比对用户名（socks4 USERID 语义，密码忽略）
 * - `jwtIdentity(opts)`：委托注入的 `verify` 异步验签，用户名取 token 的 sub
 *
 * 设计要点：
 * - **空账号表恒判否**：`basic` / `uid` 构造期就把账号表编译为索引，空表编译出空索引，
 *   任何令牌都匹配不上（`hasAccounts` 只是把这个事实提前到一处显式说明，不是额外语义）
 * - `jwt` 的用户名回传与 `basic`/`uid` 不同源：jwt 取 token 的 `sub`（不查账号表），
 *   basic/uid 取账号表里命中的用户名
 *
 * 不负责：
 * - 不读配置、**不读 `users.json`**（那两件事都在 `./factory.ts:createIdentityFromConfig`
 *   这个配置驱动的动态门面上）、不打日志、不注册任何观察面
 *
 * 使用示例：
 * ```ts
 * import { basicIdentity, uidIdentity, jwtIdentity, noneIdentity } from "@/core/identity/modes.js";
 *
 * const basic = basicIdentity({ accounts: [{ username: "alice", password: "pw1" }] });
 * const uid = uidIdentity({ accounts: [{ username: "test", password: "" }] });
 * const jwt = jwtIdentity({ secret: "s", verify: async (t, s) => verify(t, s) });
 * const open = noneIdentity();
 * ```
 */

import { matchBasicCredential, matchUidCredential } from "@/core/helpers/index.js";
import type { AuthAccount, IdentityContext, IdentityProvider } from "@/core/types/identity.js";
import {
  matchesBasicCredentialForms,
  matchesJwtCredentialForm,
  matchesUidCredentialForms,
  ownCredentialForms,
  TokenIdentityBase,
  matchJwtToken,
} from "./token.js";

/** `basic` / `uid` 两种账号表模式的构造选项 */
export interface AccountIdentityOptions {
  /** 账号表（`basic` 与 `uid` 都以此为比对源；空表一律判否） */
  accounts: AuthAccount[];
  /** 是否发审计事件（缺省 true） */
  enableLogging?: boolean;
}

/** `jwt` 模式的构造选项 */
export interface JwtIdentityOptions {
  /** JWT 签名密钥 */
  secret: string;
  /** JWT 校验器 `(token, secret) => Promise<boolean>`；未通过返回 false，抛错按拒绝处理 */
  verify: (token: string, secret: string) => Promise<boolean>;
  /** 是否发审计事件（缺省 true） */
  enableLogging?: boolean;
}

/**
 * 显式关闭身份识别（恒放行）
 * @description 与「忘记注入身份提供者」的缺省档（`BaseProxy` 归一出的 `noneIdentity()`）同构，
 * 但**作为插件显式构造**时把意图写进了代码：`kind = "none"`、永不剥任何凭证、永不发审计。
 * 供库调用方在「这里明确不要身份识别」的位置使用，避免与「忘了注入」混淆
 * @returns `IdentityProvider` 实例（`kind === "none"`、`isEnabled === false`）
 * @example const open = noneIdentity(); await open.identify(ctx); // => { passed: true }
 */
export function noneIdentity(): IdentityProvider {
  // 传 `{}` 而非让基类构造参数可选：none 模式既无账号表也不发审计，显式给出「什么都没有」
  // 比一个可省略的参数更诚实（缺席该参数在别处会静默变成「空账号表 + 审计开启」）
  return new NoneIdentity({});
}

/** none 模式实现：所有识别请求恒放行，出站判据恒不剥离 */
class NoneIdentity extends TokenIdentityBase {
  readonly kind = "none";

  /**
   * 出站判据恒 false
   * @description 既然从不校验凭证，就**没有任何头值是「本代理的凭证」**——恒不剥离是正确的。
   * （反过来 basic/uid/jwt 恒 false 才是泄漏形态）
   */
  isOwnCredential(): boolean {
    return false;
  }

  /** isEnabled 恒 false：本模式不拒绝任何人（端口口径「会不会拒绝任何人」） */
  get isEnabled(): boolean {
    return false;
  }

  /** 恒放行，不比对（基类模板方法因 isEnabled=false 早退，本方法实际不可达，保留以实现抽象契约） */
  protected async match(): Promise<undefined> {
    return undefined;
  }
}

/**
 * basic 模式：账号表精确比对
 * @description `b64(user:pass)` 与明文 `user:pass` 两种形态任一命中即通过，回传命中账号的
 * 用户名。出站剥离判据与之**同一份双形态比对**（`matchesBasicCredentialForms`），保证
 * 「能通过鉴权的凭证」与「会被剥掉的凭证」恒一致。
 *
 * **socks4/sockss4 走 SOCKS4 协议语义**（`USERID == username` 也算通过）：SOCKS4 请求里的
 * `USERID` 字段**本身就没有密码字段**（密码是 SOCKS5 的 RFC1929 子协商才有的概念，SOCKS4 不做），
 * 客户端只能把用户名填在这里，所以「先按 uid 比、不中再按 basic 比」是**该协议唯一正确的读法**，
 * **不是**旧写法留下的兼容分支——别按「删兼容层」的直觉砍掉这条活着的协议路径。
 *
 * 这条分支必须**同时存在于本插件里**而不只留在 `FileAccountIdentity`：只留在那里会让「用
 * `basicIdentity()` 跑 socks4 监听」的库调用方**静默丢掉**它，属于插件化之后才冒出来的行为回归
 * @param opts - 账号表与审计开关
 * @returns `IdentityProvider` 实例（`kind === "basic"`）
 * @example const id = basicIdentity({ accounts: [{ username: "alice", password: "pw1" }] });
 * @example await id.identify({ protocol: "socks4", req, socket, authority: "" }); // USERID 形态也命中
 */
export function basicIdentity(opts: AccountIdentityOptions): IdentityProvider {
  return new BasicAccountIdentity(opts);
}

/** basic 模式实现 */
class BasicAccountIdentity extends TokenIdentityBase {
  readonly kind = "basic";

  constructor(o: AccountIdentityOptions) {
    super(o);
  }

  /**
   * 比对 basic 令牌（整串精确，薄委托：判据在 `helpers/credentials:matchBasicCredential`）
   * @description socks4/sockss4 额外接受 uid 形态（该协议无密码字段，见工厂注释）
   * @param t - 提取到的令牌（`b64(user:pass)` 或明文 `user:pass`）
   * @param ctx - 身份上下文（协议用于 socks4 的 USERID 语义分支）
   * @returns 命中的用户名，未命中 undefined
   */
  protected async match(t: string, ctx: IdentityContext): Promise<string | undefined> {
    if (ctx.protocol === "socks4" || ctx.protocol === "sockss4") {
      return matchUidCredential(t, this.indexes) ?? matchBasicCredential(t, this.indexes);
    }
    return matchBasicCredential(t, this.indexes);
  }

  /** 出站剥离判据：basic 双形态账号表比对（与 `match` 同一份判据源） */
  isOwnCredential(name: string, value: string): boolean {
    const forms = ownCredentialForms(name, value);
    if (!forms || !this.hasAccounts) {
      // 空账号表恒判否（与 `FileAccountIdentity` 同一判据）：直构插件没有 loader 层的
      // 启动期拦截，这里是显式失败而不是「碰巧没匹配上」
      return false;
    }
    return matchesBasicCredentialForms(forms, this.indexes);
  }
}

/**
 * uid 模式：仅比对用户名（socks4 USERID 语义）
 * @description socks4/sockss4 协议没有密码字段，客户端可能发裸用户名、`user:pass` 明文、
 * `b64(user:pass)` 或 `b64(username)`——一律只取用户名部分与账号表比对，密码不参与判定。
 * 这与服务端的 uid 语义一致
 * @param opts - 账号表与审计开关
 * @returns `IdentityProvider` 实例（`kind === "uid"`）
 * @example const id = uidIdentity({ accounts: [{ username: "test", password: "" }] });
 */
export function uidIdentity(opts: AccountIdentityOptions): IdentityProvider {
  return new UidAccountIdentity(opts);
}

/** uid 模式实现 */
class UidAccountIdentity extends TokenIdentityBase {
  readonly kind = "uid";

  constructor(o: AccountIdentityOptions) {
    super(o);
  }

  /**
   * 比对 uid 令牌（仅用户名，薄委托：判据在 `helpers/credentials:matchUidCredential`）
   * @param t - 提取到的令牌
   * @returns 命中的用户名，未命中 undefined
   */
  protected async match(t: string): Promise<string | undefined> {
    return matchUidCredential(t, this.indexes);
  }

  /** 出站剥离判据：uid 双形态比对（与 `match` 同一份判据源） */
  isOwnCredential(name: string, value: string): boolean {
    const forms = ownCredentialForms(name, value);
    if (!forms || !this.hasAccounts) {
      // 空账号表恒判否（与 `FileAccountIdentity` 同一判据）：直构插件没有 loader 层的
      // 启动期拦截，这里是显式失败而不是「碰巧没匹配上」
      return false;
    }
    return matchesUidCredentialForms(forms, this.indexes);
  }
}

/**
 * jwt 模式：委托注入的校验器异步验签
 * @description 用户名取自 token 的 `sub/username/user/uid/id`（不查账号表，故允许空账号表）。
 * 未注入 `verify` 时按拒绝处理并照常发审计（由 `matchJwtToken` 抛错、基类 `.catch` 接住）
 * @param opts - 密钥、校验器与审计开关
 * @returns `IdentityProvider` 实例（`kind === "jwt"`）
 * @example const id = jwtIdentity({ secret: "s", verify: async (t, s) => verifyHs256Jwt(t, s) });
 */
export function jwtIdentity(opts: JwtIdentityOptions): IdentityProvider {
  return new JwtVerifyIdentity(opts);
}

/** jwt 模式实现 */
class JwtVerifyIdentity extends TokenIdentityBase {
  readonly kind = "jwt";
  private readonly secret: string;
  private readonly verify: JwtIdentityOptions["verify"];

  constructor(o: JwtIdentityOptions) {
    super(o);
    this.secret = o.secret;
    this.verify = o.verify;
  }

  /**
   * 验签并回传用户名（薄委托：抛错/拒绝语义在 `matchJwtToken`）
   * @param t - JWT 字符串
   * @returns token 的 sub 类字段，未通过 undefined
   */
  protected async match(t: string): Promise<string | undefined> {
    return matchJwtToken(t, this.secret, this.verify);
  }

  /**
   * 出站剥离判据：jwt **不依赖账号表**（jwt 允许空账号表），故走内置 HS256 验签形状判定
   * @description `matchesJwtCredentialForm` 走的是内置 HS256（`verifyHs256Jwt`），**不调用**本类
   * 注入的 `verify`：`isOwnCredential` 按端口契约是**同步**的，而 `verify` 的类型是
   * `(token, secret) => Promise<boolean>`——同步判据无法 await 一个 Promise。注入别的校验器时
   * 的已知边界见 `token.ts:matchesJwtCredentialForm`。
   */
  isOwnCredential(name: string, value: string): boolean {
    const forms = ownCredentialForms(name, value);
    if (!forms) {
      return false;
    }
    return matchesJwtCredentialForm(forms, this.secret);
  }
}
