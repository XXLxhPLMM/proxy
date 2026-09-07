/**
 * @fileoverview 服务端类型叶模块（转发导出）
 * @module core/types/server
 * @description
 * 本文件为 HTTP 传输服务端域的「叶模块」，不定义任何新类型，仅从 `proxy.ts`
 * 总表转发 `ProxyHttpServer`，供 `src/core/server/*` 与上层 `ProxyServer` 按域引入。
 *
 * 职责：
 * - 转发 `ProxyHttpServer` 适配器接口，使 `HttpServer` / `HttpsServer` 的引入路径按域收敛
 * - 屏蔽 `http.Server` / `https.Server` 的具体差异，上层仅依赖此抽象
 *
 * 设计要点：
 * - 零运行时：仅含 `export type`，构建后完全擦除
 * - 单向依赖：依赖 `proxy.ts`，禁止被 `proxy.ts` 反向依赖；禁止在此新增独立类型
 * - 适配器模式：`ProxyHttpServer` 将 `onRequest/onConnect/onUpgrade/onError/...` 等钩子与
 *   `start/close/started` 生命周期收敛，`transport.ts` 的 `HttpTransport` 为其抽象父类
 *
 * 使用示例：
 * ```ts
 * import type { ProxyHttpServer } from "@/core/types/server.js";
 * import { HttpServer } from "@/core/server/http.js";
 *
 * const server: ProxyHttpServer = new HttpServer({ host: "0.0.0.0", port: 7890 } as any);
 * server.onRequest = (req, res) => { res.end("hello"); };
 * await server.start();
 * // 业务完成后
 * await server.close();
 * ```
 */

export type { ProxyHttpServer } from "./proxy.js";
