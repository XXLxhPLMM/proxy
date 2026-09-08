/**
 * @fileoverview 认证类型叶模块（转发导出）
 * @module core/types/auth
 * @description
 * 本文件为认证域的「叶模块」，不定义任何新类型，仅从 `proxy.ts` 总表
 * 转发认证相关契约，保持 `src/core/auth.ts` 与 `src/core/token-extractors.ts`
 * 的引入路径语义清晰且避免循环依赖。
 *
 * 职责：
 * - 按领域聚合导出：`AuthRequestLike / AuthContext / TokenExtractor / AuthResult / AuthProvider / AuthOptions`
 * - 作为 `proxy.ts` 与 `auth.ts` 之间的语义桥梁，调用方可 `import from "@/core/types/auth.js"`
 *   而不必感知总表位置
 *
 * 设计要点：
 * - 零运行时：仅含 `export type`，构建后完全擦除
 * - 单向依赖：依赖 `proxy.ts`，禁止被 `proxy.ts` 反向依赖；禁止在此文件新增独立类型，
 *   新增类型应回到 `proxy.ts` 总表定义后再在此转发
 * - 与 `proxy.ts` 保持同构：所有认证类型的主定义与 JSDoc 均在 `proxy.ts`，此文件不重复展开
 *
 * 使用示例：
 * ```ts
 * import type { AuthProvider, AuthContext, AuthOptions } from "@/core/types/auth.js";
 * import { Auth } from "@/core/auth.js";
 *
 * const auth: AuthProvider = new Auth({ enabled: true, type: "basic", username: "admin", password: "secret" });
 * const ok = await auth.authenticate({ protocol: "http", req, socket, authority: "example.com:443" } as AuthContext);
 * ```
 */

export type {
  AuthRequestLike,
  AuthContext,
  TokenExtractor,
  AuthResult,
  AuthProvider,
  AuthOptions,
} from "./proxy.js";
