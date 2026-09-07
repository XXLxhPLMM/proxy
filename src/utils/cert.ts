/**
 * @fileoverview 证书加载工具 (cert.ts)
 *
 * 职责：
 * - 提供 TLS 证书的同步加载能力，供 `HttpsProxy` / `TlsProxy` 等需要 `key/cert/ca` 的服务端使用。
 * - 统一处理三种输入形态（对象 / 单路径字符串 / 未传）、相对路径解析、文件读取与可选 CA 的存在性检查。
 * - 加载失败时经可选 `logger` 记录上下文（key/cert/ca 路径与异常），并向上抛错以阻止服务以半初始化状态启动。
 *
 * 设计要点：
 * - 零异步：使用 `readFileSync` 同步读取，调用方在 `BaseProxy.onBeforeStart()` 同步阶段完成，
 *   失败立即抛错，避免异步竞争与未就绪监听。
 * - 输入归一：`TlsInput` 为联合类型，内部统一归一为 `TlsKeyCert` 对象；字符串输入视为 `key` 与 `cert` 同值（常用自签场景）。
 * - 路径解析：`resolvePath` 对相对路径以 `process.cwd()` 为基准解析，绝对路径原样保留；与 `loader` 的 `configDir` 计算保持一致。
 * - 可选 CA：`ca` 仅当路径存在时才读取，不存在静默跳过（兼容无 mTLS 的 `https` 场景）。
 * - 可选日志：`logger` 与 `label` 均为可选，不传时仅抛错不落盘；传入 `getLogger("https")` 等可在启动阶段即关联协议前缀。
 * - 错误信息富含路径：`keyPath/certPath/caPath` 均拼入日志，便于定位挂载或配置错误。
 *
 * 使用示例：
 * ```ts
 * import { loadCerts } from "@/utils/cert.js";
 * import { getLogger } from "@/utils/logger.js";
 *
 * // 1) 对象形态（推荐）
 * const ctx = loadCerts(
 *   { key: "keys/server.key", cert: "keys/server.crt", ca: "keys/ca.crt", passphrase: "s3cret" },
 *   getLogger("https"),
 *   "[https]"
 * );
 * // ctx = { key: Buffer, cert: Buffer, ca: Buffer|undefined, passphrase: "s3cret"|undefined }
 *
 * // 2) 单路径字符串（key 与 cert 同文件）
 * const ctx2 = loadCerts("keys/server.pem");
 *
 * // 3) 未传（空对象归一，key/cert 为空串路径，读取失败抛错由调用方捕获）
 * try { loadCerts(undefined); } catch (e) { console.error("证书缺失", e); }
 *
 * // 4) 在 HttpsProxy.doStart() 中
 * // const { key, cert, ca, passphrase } = loadCerts({ key: get("tlsKey"), cert: get("tlsCert"), ca: get("tlsCa") });
 * // https.createServer({ key, cert, ca, passphrase }, handler).listen(port);
 * ```
 *
 * 关联模块：
 * - `src/core/server/https.ts` / `tls.ts` — 服务端创建 `https.Server` / `tls.Server` 前的证书上下文来源。
 * - `src/utils/cert.ts:resolvePath` — 内部路径归一，与 `loader.ts:getConfigDir` 的目录语义对齐。
 * - `src/utils/logger.ts` — 可选的错误落盘目标。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * TLS 键/证书输入对象
 *
 * @description
 * 标准对象形态，所有字段均为可选，缺失时由 `loadCerts` 归一为空串路径并在读取时抛错。
 * - `key` 私钥路径（PEM，对应 `TLS_KEY`）
 * - `cert` 证书路径（PEM，对应 `TLS_CERT`）
 * - `ca` CA 证书路径（可选，对应 `TLS_CA`，不存在时不校验客户端）
 * - `passphrase` 私钥口令（可选，仅加密私钥 `ENCRYPTED PRIVATE KEY` 时需）
 */
export interface TlsKeyCert { key?: string; cert?: string; ca?: string; passphrase?: string; }

/**
 * TLS 输入联合类型
 *
 * @description
 * - `TlsKeyCert` 对象：分别指定 key/cert/ca/passphrase
 * - `string`：单路径字符串，视为 `{ key: s, cert: s }`（key 与 cert 同文件，常见于合并 PEM）
 * - `undefined`：未传，归一为空对象，随后读取空路径抛错由调用方处理
 */
export type TlsInput = TlsKeyCert | string | undefined;

/**
 * 已加载的证书上下文
 *
 * @description
 * `loadCerts` 的成功返回值，可直接传给 `tls.createSecureContext` / `https.createServer`。
 * `key` / `cert` 必为 Buffer，`ca` 仅在输入含 `ca` 且文件存在时为 Buffer，`passphrase` 为原样回传。
 */
export interface LoadedTlsCerts { key: Buffer; cert: Buffer; ca?: Buffer; passphrase?: string; }

/**
 * 解析为绝对路径
 *
 * @description
 * 绝对路径原样返回；相对路径以 `process.cwd()` 为基准解析。
 * 与 `loader.ts` 中 `def: (dir) => path.join(dir, ...)` 的相对路径语义一致，
 * 确保 `keys/server.key` 在不同 `configDir` 下均可正确定位。
 *
 * @param p - 原始路径（可能为相对或绝对）
 * @returns 绝对路径
 * @example
 * ```ts
 * resolvePath("keys/server.crt");      // "/app/proxy/keys/server.crt"
 * resolvePath("/etc/ssl/server.key"); // "/etc/ssl/server.key"
 * ```
 */
function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * 同步读取证书文件为 Buffer
 *
 * @description
 * - 输入归一：`string` → `{ key: s, cert: s }`；`undefined` → `{}`；对象原样。
 * - 路径解析后 `readFileSync` 同步读取 `key` / `cert`（缺失直接抛错，调用方在 `onBeforeStart` 阶段捕获并阻止启动）；
 *   `ca` 可选，路径不存在时跳过读取，存在则一并读入。
 * - 失败时若提供 `logger` 则以 `label` 为前缀记录 `keyPath/certPath/caPath` 与异常对象，随后原样抛错。
 *
 * @param tls - TLS 输入（对象 / 单路径字符串 / 未传）
 * @param logger - 可选日志器，需含 `error(msg, err?)` 方法（如 `getLogger("https")`），不传则静默抛错
 * @param label - 可选日志前缀（如 `"[https]"` / `"[tls]"`），拼在错误消息前便于区分协议
 * @returns 已加载的证书上下文 `{ key, cert, ca?, passphrase? }`
 * @throws {Error} 当 `key` / `cert` 文件不存在或不可读时抛错（`fs.readFileSync` 原始异常）
 * @example
 * ```ts
 * import { loadCerts } from "@/utils/cert.js";
 *
 * // 成功
 * const { key, cert, ca } = loadCerts({ key: "keys/server.key", cert: "keys/server.crt", ca: "keys/ca.crt" });
 *
 * // 失败（带日志）
 * import { getLogger } from "@/utils/logger.js";
 * try {
 *   loadCerts({ key: "keys/missing.key", cert: "keys/server.crt" }, getLogger("tls"), "[tls]");
 * } catch (e) {
 *   // 日志已含 key/cert 路径，异常向上阻止 ProxyServer.start()
 * }
 * ```
 */
export function loadCerts(
  tls: TlsInput,
  logger?: { error(msg: string, err?: unknown): void },
  label?: string,
): LoadedTlsCerts {
  const o = typeof tls === "string" ? { key: tls, cert: tls } : tls ?? {};
  const keyPath = resolvePath(o.key ?? "");
  const certPath = resolvePath(o.cert ?? "");
  try {
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    let ca: Buffer | undefined;
    if (o.ca) {
      const caPath = resolvePath(o.ca);
      if (fs.existsSync(caPath)) ca = fs.readFileSync(caPath);
    }
    return { key, cert, ca, passphrase: o.passphrase || undefined };
  } catch (e) {
    const caInfo = o.ca ? ` ca=${resolvePath(o.ca)}` : "";
    const prefix = label ? `${label} ` : "";
    logger?.error(`${prefix}证书加载失败 key=${keyPath} cert=${certPath}${caInfo}`, e);
    throw e;
  }
}
