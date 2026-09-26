/**
 * @fileoverview 身份类型叶模块（转发导出）
 * @module core/types/identity
 * @description
 * 本文件为身份域的「叶模块」，不定义任何新类型，仅从 `proxy.ts` 总表
 * 转发身份相关契约，保持 `src/core/identity.ts` 的引入路径语义清晰且避免循环依赖。
 *
 * 职责：
 * - 按领域聚合导出：`IdentityRequestLike / IdentityContext / IdentityResult /
 *   IdentityProvider / IdentityOptions / AuthAccount / ProxyAuthEvent`
 * - 作为 `proxy.ts` 与 `identity.ts` 之间的语义桥梁，调用方可 `import from "@/core/types/identity.js"`
 *   而不必感知总表位置
 *
 * 设计要点：
 * - 零运行时：仅含 `export type`，构建后完全擦除
 * - 单向依赖：依赖 `proxy.ts`，禁止被 `proxy.ts` 反向依赖；禁止在此文件新增独立类型，
 *   新增类型应回到 `proxy.ts` 总表定义后再在此转发
 * - 与 `proxy.ts` 保持同构：所有身份类型的主定义与 JSDoc 均在 `proxy.ts`，此文件不重复展开
 * - **两个名字保留 Auth 字样是刻意的**（`AuthAccount` = 一条账号表条目、`ProxyAuthEvent` =
 *   一次鉴权审计事件）：它们描述的是**数据**而不是**识别方式**，改名只会给调用方凭空加一次翻译。
 *   端口名（`IdentityProvider` 等）则已全部去 Auth 化——它们描述的是「可插值的身份组件」。
 * - `IdentityRequestLike` 也从这里出去（**超出端口六件套**）：它是 `IdentityContext.req` 的
 *   形状，调用方要手搓一个 `IdentityContext` 做测试替身时就必须能引到这个类型，
 *   逼它去引总表 `@/core/types/proxy.js` 反而破坏了本叶模块存在的意义。
 *
 * 使用示例：
 * ```ts
 * import type { IdentityProvider, IdentityContext, IdentityResult } from "@/core/types/identity.js";
 * import { basicIdentity } from "@/core/identity.js";
 *
 * const identity: IdentityProvider = basicIdentity({ accounts: [{ username: "alice", password: "pw1" }] });
 * const r: IdentityResult = await identity.identify({ protocol: "http", req, socket, authority: "example.com:443" } as IdentityContext);
 * ```
 */

export type {
  IdentityRequestLike,
  IdentityContext,
  IdentityResult,
  IdentityProvider,
  IdentityOptions,
  AuthAccount,
  ProxyAuthEvent,
} from "./proxy.js";
