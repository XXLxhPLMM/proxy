/**
 * @fileoverview 代理身份识别层出口（`src/core/identity/`）
 * @module core/identity
 * @description
 * 本文件是身份域的**层出口**：对内把「骨架 / 四模式插件 / 账号表门面 / 工厂」四块实现
 * re-export 出去，对外只呈现一个语义面——「给本代理一份能识别身份、并能判断哪些出站
 * 凭证是自己发出的 `IdentityProvider`」。
 *
 * 职责：
 * - re-export 四个模式插件工厂：`noneIdentity` / `basicIdentity` / `uidIdentity` / `jwtIdentity`
 * - re-export 账号表门面 `FileAccountIdentity` 与两个工厂 `createIdentity` / `createIdentityFromConfig`
 * - re-export 内置 HS256 校验器 `defaultJwtVerify`（配置驱动的默认注入实现）
 *
 * 设计要点：
 * - **拆分理由（为什么值得拆四个文件）**：四种模式的差异**只在「拿到 token 之后怎么比对」
 *   这一步**（账号表精确比对 / 仅比用户名 / 异步验签 / 恒放行），而「取凭证 + 脱敏 +
 *   审计发事件 + 结果判定」是完全同形的一份——「单文件 + 一个 `type` 字段」的四合一形态
 *   表达不了这件事。拆开后：① 库调用方能**单独构造其中一种语义**（如「只要 uid 语义」，或
 *   「自备 JWT 校验器但仍要本代理的出站剥离与审计」）——这是可插值身份的真实价值；
 *   ② 那份同形的骨架收进 `TokenIdentityBase`，**不许**把它也拆成四份拷贝（scheme 大小写
 *   不敏感、隧道 tag 判据、失败必发审计这三条不变量经不起任何一处漂移）。
 * - **层出口刻意不引 barrel**（`./identity/index.js` 之类）：本目录**没有** `index.ts`，
 *   出面只用相对路径 `./identity/xxx.js` 逐个 re-export——避免「自我引用 barrel」造成的循环。
 * - **三件套在构造期注入**：`createIdentityFromConfig(ctx, onFileEvent?)` 收整个
 *   `CoreContext`（配置 / 日志 / 事件总线），因为 `isOwnCredential` 跑在出站头剥离热路径上，
 *   逐方法传参等于把 DI 成本摊到最热的路径。文件观察面（发公共事件那一半）**仍由唯一组装点
 *   注入**，理由与那条纪律见 `identity/factory.ts` 文件头。
 * - **消费方只读 `isEnabled` 一个字段**（口径 = 「本实例会不会拒绝任何人」，`none` 已并入）：
 *   不要再自己判一次 `kind !== "none"`，那是把同一个事实抄成第二份真相。
 * - core 零日志：本层所有审计经 `IdentityContext.onAuthEvent` 上抛，由 `BaseProxy.authorize`
 *   事件化、runtime 层落盘（`src/runtime/event-log.ts:bindProxyEventLogs`，CLI 与库共用同一份）；
 *   本层零 `console.*`、零直接日志调用。
 * - **一并导出 `TokenIdentityBase`**（虽是内部基类，但它是自研身份插件的**唯一复用入口**）：
 *   身份可插值的价值有一半在这里——不导出它，调用方写自定义插件就得把「取凭证 + 脱敏 +
 *   审计发事件」重新抄一遍，而那正是上面那条「不许拆成四份拷贝」的理由。
 *
 * 使用示例：
 * ```ts
 * import { uidIdentity, createIdentityFromConfig } from "@/core/identity.js";
 *
 * // 1) 库调用方自选语义：只要 uid（socks4 USERID），不要 basic 的账号表比对
 * const uid = uidIdentity({ accounts: [{ username: "test", password: "" }] });
 * // 2) 生产链路：配置驱动、每次判定现读；三件套整体注入，文件观察面由组装点给
 * const id = createIdentityFromConfig(ctx, fileEventHandler);
 * ```
 */

export { noneIdentity, basicIdentity, uidIdentity, jwtIdentity } from "./identity/modes.js";
export type { AccountIdentityOptions, JwtIdentityOptions } from "./identity/modes.js";

export { FileAccountIdentity } from "./identity/file-account.js";

export { createIdentity, createIdentityFromConfig, defaultJwtVerify } from "./identity/factory.js";

export { TokenIdentityBase } from "./identity/token.js";
