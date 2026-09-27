/**
 * @fileoverview 代理身份识别层出口（`src/core/identity/`）
 * @module core/identity
 * @description
 * 本文件是身份域的**层出口**：对内把「骨架 / 四模式插件 / 账号表门面 / 工厂」四块实现
 * re-export 出去，对外只呈现一个语义面——「给本代理一份能识别身份、并能判断哪些出站
 * 凭证是自己发出的 `IdentityProvider`」。职责：
 * - re-export 四个模式插件工厂（`noneIdentity` / `basicIdentity` / `uidIdentity` / `jwtIdentity`）
 *   与两个选项类型
 * - re-export 账号表门面 `FileAccountIdentity` 与两个工厂 `createIdentity` /
 *   `createIdentityFromConfig`、内置 HS256 校验器 `defaultJwtVerify`
 * - 一并 re-export `TokenIdentityBase`（虽是内部基类，但它是自研身份插件的**唯一复用入口**）
 *
 * 设计要点（**这一组全部是「没有任何测试会红」那一类，改动只能自己复核**）：
 * - **拆成四个文件**：差异只在「拿到 token 之后怎么比对」，同形的骨架不许拆成四份拷贝
 * - **层出口刻意不引 barrel**：本目录**没有** `index.ts`，出面只用相对路径逐个
 *   re-export，避免自我引用 barrel 循环
 * - **文件观察面是形参**：`createIdentityFromConfig(ctx, onFileEvent?)` 收整个
 *   `CoreContext`，但文件订阅**由唯一组装点注入**，身份模块不自注册
 * - **`createIdentity(opts, config)` 是不收 ctx 的低层直构入口**
 * - **`kind` 是稳定字符串、不是闭合集；消费方只读 `isEnabled`**：不要再自己判一次
 *   `kind !== "none"`，那是把同一个事实抄成第二份真相
 * - core 零日志：本层所有审计经 `IdentityContext.onAuthEvent` → `BaseProxy.authorize` 上抛，
 *   runtime 层落盘（`src/runtime/event-log.ts:bindProxyEventLogs`，CLI 与库共用同一份）
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
