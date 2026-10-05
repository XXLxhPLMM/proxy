/**
 * @fileoverview 账号表驱动的身份门面：由 `type` 分发到四种模式，并把出站凭证判据内化
 * @module core/identity/file-account
 * @description
 * `FileAccountIdentity` 是**账号表驱动的身份门面**：构造参数就是一份
 * `IdentityOptions`（`enabled` / `type` / `jwtSecret` / `jwtVerify` / `enableLogging`），
 * 内部按 `type` 分发到 basic / uid / jwt 的比对逻辑，并在 socks4 场景按**该协议语义**额外接受
 * 「USERID == username 也算 basic 通过」——SOCKS4 的 `USERID` 字段里没有密码可填（密码是
 * SOCKS5 RFC1929 子协商才有的东西），所以这不是历史兼容，而是该协议唯一正确的读法。
 *
 * 它与 `createIdentityFromConfig()`（`./factory.ts`）的分工：
 * - 本类 = **快照**语义：构造时定死 `enabled` / `type` / `jwtSecret` / 账号索引，
 *   之后 `identify` 与 `isOwnCredential` 读的都是**这份快照**，不读任何配置。
 * - `createIdentityFromConfig` = **动态**语义：每次判定现读 `authEnabled` / `authType` /
 *   `jwtSecret` / `authLogging` 与账号文件（热加载），每次判定现造一份本类快照再委派。
 *   于是「热改配置下次请求即生效」这条能力仍然成立，而判据实现只有这一份。
 *
 * 职责：
 * - 按 `type` 分发：`none` 放行 / `basic` 账号表精确比对 / `uid` 仅用户名 / `jwt` 委托验签
 * - **出站凭证判据 `isOwnCredential`**：判据只读**自己的 `enabled` / `type` / `jwtSecret` /
 *   `indexes`**
 * - `jwtVerify` 外部注入位（public 可读写，供 `createIdentityFromConfig` 的动态代理回写）
 *
 * 设计要点（**零配置读取带来的核心收益**）：
 * - **零配置读取**：本类**不 import `@/config/index.js`**，一个 `config.get` 都没有。
 *   **判据绝不能从 config 猜**「哪个 Authorization 是本代理的」——身份一旦可插值，凭证形态由
 *   插件决定，config 不再是真相源，继续猜必然失配 → 调用方凭证被原样转发给目标站。现在判据读
 *   **自己的字段**，与 `identify` 读**同一份**状态，「能通过鉴权」和「会被剥掉」恒一致
 *   （来由与锁点见 `../../../tests/unit/core/identity/credential-seam.test.ts`）
 * - **密钥真相统一（这是本设计的核心）**：判据读的是**本实例的 `this.jwtSecret`**，而 `identify`
 *   的验签走**注入的** `this.jwtVerify`——两者各读一份就是「两份真相」：注入的校验器一旦不用
 *   配置里那个 `JWT_SECRET`（密钥轮换中的旧密钥、公钥验签），判据就会拿错密钥去验
 * - **但「自定义异步校验器不被感知」这条边界仍在，原因是端口形状而非疏忽**（完整后果与修法候选见
 *   本类 `isOwnCredential` 的注释）
 * - `isEnabled` 口径：并入 `type === "none"`（不判人 = 不启用识别），使基类模板方法首行早退与
 *   本字段**同一个事实**，不需要第二个开关与之同步；消费方只读这一个字段
 * - **零日志**：审计经 `IdentityContext.onAuthEvent` 上抛，由 `BaseProxy.authorize` 事件化
 * - **异常即拒绝**：`match()` 抛错（如 jwtVerify 未注入）由基类 `.catch` 接成带审计的拒绝
 *
 * 不负责：读配置（`factory.ts` 的活）、读 `users.json`、出站头剥离的 `proxy-` 前缀宽规则
 * （`@/core/helpers/headers.ts` 的活）。
 *
 * 使用示例：
 * ```ts
 * import { FileAccountIdentity } from "@/core/identity/file-account.js";
 *
 * const id = new FileAccountIdentity({
 *   enabled: true,
 *   type: "basic",
 *   accounts: [{ username: "alice", password: "pw1" }],
 * });
 * const r = await id.identify(ctx);
 * const own = id.isOwnCredential("authorization", "Basic YWxpY2U6cHcx"); // => true
 * ```
 */

import { matchBasicCredential, matchUidCredential } from "@/core/helpers/index.js";
import type { IdentityContext, IdentityOptions, IdentityProvider } from "@/core/types/identity.js";
import {
  matchesBasicCredentialForms,
  matchesJwtCredentialForm,
  matchesUidCredentialForms,
  matchJwtToken,
  ownCredentialForms,
  TokenIdentityBase,
} from "./token.js";

/**
 * 账号表驱动的身份门面
 * @description 实现 `IdentityProvider`；按 `type` 分发四种模式，并内化出站凭证判据。
 * 与 `createIdentityFromConfig()` 配套：后者每次判定现造一份本类快照来委派，
 * 而本类自身是**纯快照**、零配置读取
 * @example const id = new FileAccountIdentity({ enabled: true, type: "uid", accounts: [{ username: "t", password: "" }] });
 */
export class FileAccountIdentity extends TokenIdentityBase implements IdentityProvider {
  /** 构造期冻结的启用开关（`IdentityOptions.enabled`，缺省 false） */
  private readonly enabled: boolean;
  private readonly type: "none" | "basic" | "jwt" | "uid";
  private readonly jwtSecret: string;

  /**
   * JWT 校验器（外部注入位）
   * @description 构造期取 `IdentityOptions.jwtVerify`；声明为 public 是为了让
   * `createIdentityFromConfig()` 的动态代理类型安全地读写快照注入位（**零 `unknown`**
   * 链式强转，字段改名会编译报错而非静默失效）。刻意不加 `readonly`：动态代理的 setter
   * 要回写快照，运行期替换对下一次 `match()` 立即生效
   */
  jwtVerify?: IdentityOptions["jwtVerify"];

  /**
   * 构造身份门面
   * @description 只消费显式传入的 `IdentityOptions` 并把 `accounts` 编译为凭证索引；
   * 门面本身不读取任何配置
   * @param o - 身份选项，必须显式提供
   * @example new FileAccountIdentity({ enabled: true, type: "basic", accounts: [{ username: "u", password: "p" }] })
   * @example new FileAccountIdentity({ enabled: true, type: "jwt", jwtSecret: "s", jwtVerify: async (t,s)=>true })
   */
  constructor(o: IdentityOptions) {
    const type = o.type ?? "none";
    // ⚠️ **只有账号表驱动的 basic / uid 才把账号表递给基类**，jwt / none 刻意不递。
    // 理由是 jwt 的用户名取自 token 的 `sub`、**根本不查账号表**（`match()` 走
    // `matchJwtToken`、`isOwnCredential()` 走 `matchesJwtCredentialForm`，两者都不碰索引），
    // 于是「本模式的判定依赖账号表」这个信号必须保持真实。两个后果都指同一个方向：
    // ① 账号有效期（基类按账号表建的 `expiries`）**不会错误地作用到 jwt 上**——否则一个
    //    token 的 `sub` 恰好与某个账号同名时，那个账号的 `expiresAt` 会去拒一个 jwt 请求，
    //    而 jwt 的有效期由 token 自己的 `exp` 裁决（`helpers/credentials:verifyHs256Jwt`）；
    // ② `hasAccounts` 也才说得准（它现在的含义是「账号表非空**且本模式用它**」）。
    super({
      enableLogging: o.enableLogging,
      accounts: type === "basic" || type === "uid" ? o.accounts : undefined,
      now: o.now,
    });
    this.enabled = o.enabled ?? false;
    this.type = type;
    this.jwtSecret = o.jwtSecret ?? "";
    this.jwtVerify = o.jwtVerify;
  }

  /** 身份类型标识（本门面按 `type` 原样透出；`none` 时为 "none"） */
  get kind(): string {
    return this.type;
  }

  /**
   * isEnabled = `enabled` **且** `type !== "none"`
   * @description 端口口径是**「本实例会不会拒绝任何人」**。并入 `none` 判据后，「不判人」与
   * 「不启用识别」在全仓就是**同一个事实**，基类模板方法首行早退可直接读本字段——不需要第二个
   * 开关与之同步（`AUTH_ENABLED=true` + `AUTH_TYPE=none` 的组合从此只有一个答案：false）
   */
  get isEnabled(): boolean {
    return this.enabled && this.type !== "none";
  }

  /**
   * 执行身份识别（按 `type` 分发）
   * @description 四种模式的分支：none 恒放行 / basic 账号表精确比对 /
   * uid 仅用户名 / jwt 委托验签；**且 basic 在 socks4/sockss4 时额外接受 uid 形态**
   * （`USERID == username`，因该协议无密码字段）。base 的模板方法已处理「无 token → 发
   * no-token 审计 → 拒绝」与「enabled=false / none → 放行」的前置，这里只负责比对那一步
   * @param token - 提取到的令牌
   * @param ctx - 身份上下文（协议用于 socks4 的 USERID 语义分支）
   * @returns 命中的用户名；未通过为 undefined
   */
  protected async match(token: string, ctx: IdentityContext): Promise<string | undefined> {
    if (this.type === "jwt") {
      // jwt 校验器未注入会抛错，由基类 `.catch` 接成带审计的拒绝（保证 JWT 模式永不静默放行）
      return matchJwtToken(token, this.jwtSecret, this.jwtVerify);
    }
    if (this.type === "uid") {
      return matchUidCredential(token, this.indexes);
    }
    if (this.type === "basic" && (ctx.protocol === "socks4" || ctx.protocol === "sockss4")) {
      // socks4/sockss4 仅 USERID，无密码字段：type=basic 时允许 userid==username 的 uid 形态通过
      return matchUidCredential(token, this.indexes) ?? matchBasicCredential(token, this.indexes);
    }
    return matchBasicCredential(token, this.indexes);
  }

  /**
   * 出站凭证判据：**读自己的 `enabled` / `type` / `jwtSecret` / `indexes`，零配置读取**
   * @description
   * 这是「判据由插件自述」的落点，判据**逻辑一字不改**
   * （`authEnabled` 门禁 → type 三值门禁 → trim → 剥 scheme → jwt 走 `isJwtShape`+验签
   * / basic 走 `matchBasicCredential` 双形态 / uid 走 `matchUidCredential` 双形态），
   * 变的只是**输入来源**：从 `config.get(...)` + `loadAuthUsers` 换成实例字段。
   *
   * - `enabled` 门禁用 `this.isEnabled`（已并入 `none`）——与 `identify` 的早退同一开关。
   * - `type !== "basic" && type !== "uid" && type !== "jwt" → false` 那条显式门禁
   *   在这里由「`isEnabled` 已剔掉 `none`」+「末尾 `else` 即 uid」共同承担：`type` 只有四个
   *   取值，剔掉 `none` 之后必落在那三值之内，再写一遍是同义反复。
   * - jwt 分支**不要求账号表非空**（`isJwtShape`+验签先判，`jwt` 允许空表）。
   * - **jwt 分支走的是内置 HS256，不调用 `this.jwtVerify`** —— 这是**端口形状**决定的，不是疏忽：
   *   `isOwnCredential` 是同步方法，而 `jwtVerify` 的类型是
   *   `(token, secret) => Promise<boolean>`，同步判据无法 await 一个 Promise。注入别的校验器时的
   *   已知边界见 `token.ts:matchesJwtCredentialForm`。
   * @param name - 出站头名（大小写不敏感）
   * @param value - 出站头值原文
   * @returns true = 本代理凭证，出站须剥掉
   * @example id.isOwnCredential("Authorization", "Basic dXNlcjpwYXNz") // basic 命中账号表时 true
   * @example id.isOwnCredential("authorization", "Bearer eyJ...") // jwt 验签通过才 true
   */
  isOwnCredential(name: string, value: string): boolean {
    if (!this.isEnabled) {
      return false;
    }
    const forms = ownCredentialForms(name, value);
    if (!forms) {
      // 头名不是 `authorization`（本类**只签发 `Authorization`**，见 `ownCredentialForms`
      // 的说明：这道门禁是**内置插件自己的廉价早退**、不是端口对头名的限制——库层对每个
      // 出站头都会问过来，自定义插件完全可以认别的头名）或值是空串。自定义凭证形态请写自己的
      // `IdentityProvider`，不要来改这个类。
      return false;
    }
    if (this.type === "jwt") {
      // jwt 允许空账号表：本分支先于空表早退（否则空表下代理 JWT 会泄漏）
      return matchesJwtCredentialForm(forms, this.jwtSecret);
    }
    if (!this.hasAccounts) {
      // 空账号表在配置 loader 层已阻止启动，这里保持纵深防御（直构本类时无此保证）
      return false;
    }
    if (this.type === "basic") {
      return matchesBasicCredentialForms(forms, this.indexes);
    }
    return matchesUidCredentialForms(forms, this.indexes);
  }
}
