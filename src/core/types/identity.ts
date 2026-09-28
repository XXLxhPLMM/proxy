/**
 * @fileoverview 身份类型叶模块（转发导出）
 * @module core/types/identity
 * @description
 * 身份域类型的「叶模块」，不定义任何新类型，仅从 `proxy.ts` 总表按领域转发
 * （`IdentityRequestLike` / `IdentityContext` / `IdentityResult` / `IdentityProvider` /
 * `IdentityOptions` / `AuthAccount` / `ProxyAuthEvent`），保持引入路径的语义清晰且避免循环依赖。
 *
 * 设计要点：
 * - 零运行时：仅含 `export type`，构建后完全擦除
 * - 单向依赖：依赖 `proxy.ts`，禁止被 `proxy.ts` 反向依赖；**禁止在此文件新增独立类型**，
 *   新增类型应回到 `proxy.ts` 总表定义后再在此转发
 * - 所有身份类型的主定义与 JSDoc 均在 `proxy.ts`，本文件不重复展开
 * - `IdentityRequestLike` **超出端口六件套**也从这里出去（它是最小集形状，四个通道各自能凑出的
 *   最小公共面比端口六件套更宽）
 * - 两个名字保留 Auth 字样、以及端口名零 Auth 化的取舍，理由见 `proxy.ts` 文件头
 *
 * 使用示例：
 * ```ts
 * import type { IdentityProvider, IdentityContext, IdentityResult } from "@/core/types/identity.js";
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
