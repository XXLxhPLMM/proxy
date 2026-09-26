/**
 * @fileoverview 鉴权插件默认装配 - `AuthKind` 注册表
 * @module plugins/auth-providers
 * @description
 * `AuthProvider`（`plugins/contracts.ts`）的**默认实现装配**。注册表键 = `AuthKind`，
 * 值是**工厂**而不是已配置实例——这是鉴权与其余插件唯一的结构差异，且理由很硬：
 * 账号表 / JWT 密钥 / 审计开关都是**实例级**配置，注册表若存实例就会把某个实例的
 * 账号表固化下来并跨实例共享；存工厂则注册表自身无状态，可被任意多个 `ConfigScope`
 * 共享，各实例用自己的配置调工厂产出自己的实现（`createProxyInstance` 的
 * `selectAuthProvider` 就是那个调用点）。
 *
 * 四项注册与实现的对应关系（**一项一个类，不做 switch**）：
 * | 键     | 实现                | 消费的配置字段            | 不消费      |
 * | ------ | ------------------- | ------------------------- | ----------- |
 * | `none` | `NoneAuthProvider`  | —（恒放行）               | 全部        |
 * | `basic`| `BasicAuthProvider` | `accounts` + 审计开关     | `jwtSecret` |
 * | `uid`  | `UidAuthProvider`   | `accounts` + 审计开关     | `jwtSecret` |
 * | `jwt`  | `JwtAuthProvider`   | `jwtSecret` + 校验器 + 审计开关 | `accounts` |
 *
 * 两条装配期的不变量：
 * - **注册表值类型是 `AuthProviderFactory`**，于是「换一种鉴权」= 往注册表加一项
 *   （如 mTLS、OAuth introspection），既不改 `core/auth.ts` 也不改本文件。
 * - **注册表无状态**：工厂只做「参数 → 实例」的一步映射，不读配置、不缓存、
 *   不持有账号表快照之外的任何东西（凭证索引由各实现自己按账号表对象身份记忆）。
 *
 * 本层零日志：审计事件由 `core/auth.ts` 各实现经 `AuthContext.onAuthEvent` 上抛。
 *
 * @example
 * ```ts
 * const auths = createAuthProviderRegistry();
 * // 组合根按本实例的 authType 取工厂、传本实例配置、调出实现
 * const auth = auths.require("basic")({
 *   accounts: [{ username: "admin", password: "s3cr3t" }],
 *   jwtSecret: "",
 *   enableLogging: true,
 * });
 * ```
 */

import {
  BasicAuthProvider,
  JwtAuthProvider,
  NoneAuthProvider,
  UidAuthProvider,
  defaultJwtVerify,
} from "@/core/auth.js";
import {
  createPluginRegistry,
  type AuthKind,
  type AuthProviderFactory,
  type PluginRegistry,
} from "./contracts.js";

/**
 * `none`：放行实现
 * @description **刻意忽略全部 options**：账号表与密钥对「不鉴权」无意义，让它去读
 * 会诱使后来者以为 `none` 也能顺带做凭证剥离（它不能——`isOwnCredential` 恒 false，
 * 不鉴权的实例不该剥掉任何 `Authorization`，那是目标站自己的凭证）。
 * @param options - 工厂参数（**刻意不读**：账号表与密钥对「不鉴权」无意义，让它去读会诱使
 *   后来者以为 `none` 也能顺带做凭证剥离——它不能，`isOwnCredential` 恒 false）
 * @returns `NoneAuthProvider`（`isEnabled === false`，基类模板直接放行且不发审计）
 */
const createNoneAuthProvider: AuthProviderFactory = (options) => {
  void options;

  return new NoneAuthProvider();
};

/**
 * `basic`：用户名 + 密码整串比对
 * @description 账号表与审计开关原样透传（空表 ⇒ 实现内索引全空 ⇒ 一切凭证判否，
 * 装配期的「空表即 abort」由 loader 的 `assertAuthConfig` 与组合根负责）。
 * `jwtSecret` 刻意不传：basic 的判据与 JWT 无关。
 * @param options - 工厂参数（`accounts` / `enableLogging`）
 * @returns `BasicAuthProvider`
 */
const createBasicAuthProvider: AuthProviderFactory = (options) =>
  new BasicAuthProvider({
    accounts: options.accounts,
    enableLogging: options.enableLogging,
  });

/**
 * `uid`：只比用户名（socks4 USERID 场景）
 * @description 与 basic 共用账号表字段，判据差异在实现内的 `matchUidCredential`
 * （`password` 字段不参与判定，但账号表形状仍须合法——由 loader 校验）。
 * @param options - 工厂参数（`accounts` / `enableLogging`）
 * @returns `UidAuthProvider`
 */
const createUidAuthProvider: AuthProviderFactory = (options) =>
  new UidAuthProvider({
    accounts: options.accounts,
    enableLogging: options.enableLogging,
  });

/**
 * `jwt`：HS256 验签
 * @description **注入内置校验器 `defaultJwtVerify`**：`JwtAuthProvider` 未注入校验器时
 * 是 fail-closed 全拒（`core/auth.ts` 明确的设计：装配漏注入的后果应该是这个实例
 * 静悄悄地拒绝一切请求，而不是启动崩溃）。默认装配的职责就是不让这件事发生——
 * 组合根要换校验器时，整表替换本注册表或只替换 `jwt` 这一项即可。
 * @param options - 工厂参数（`jwtSecret` / `enableLogging`）
 * @returns `JwtAuthProvider`（已带内置 HS256 校验器）
 */
const createJwtAuthProvider: AuthProviderFactory = (options) =>
  new JwtAuthProvider({
    jwtSecret: options.jwtSecret,
    jwtVerify: defaultJwtVerify,
    enableLogging: options.enableLogging,
  });

/**
 * 创建鉴权插件注册表（默认装配）
 *
 * @description 每次调用产出一份**新的**不可变注册表。内容是四个**无状态**工厂，
 * 因此同一份注册表跨实例共享也不会串味（账号表/密钥都由每次调用的 options 带入）；
 * 组合根仍按实例各自建一份，以便将来给某个实例挂上不同的鉴权实现。
 *
 * @returns 键为 `AuthKind`、值为 `AuthProviderFactory` 的注册表
 * @example
 * ```ts
 * const auths = createAuthProviderRegistry();
 * auths.keys();            // ["none", "basic", "uid", "jwt"]
 * auths.require("basic");  // 取工厂；未注册键在此 fail-fast 抛错
 * ```
 */
export function createAuthProviderRegistry(): PluginRegistry<AuthKind, AuthProviderFactory> {
  return createPluginRegistry<AuthKind, AuthProviderFactory>([
    ["none", createNoneAuthProvider],
    ["basic", createBasicAuthProvider],
    ["uid", createUidAuthProvider],
    ["jwt", createJwtAuthProvider],
  ]);
}
