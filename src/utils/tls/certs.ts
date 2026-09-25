/**
 * @fileoverview 入站证书材料读取（certs.ts）
 *
 * 职责：
 * - 定义 TLS 键/证书的三种输入形态（对象 / 单路径字符串 / 未传）与加载结果类型。
 * - `loadCerts` 同步把 `key` / `cert` / `ca` 路径读成 Buffer，供入站 `https` / TLS SOCKS 建服。
 * - 零配置依赖：`key` / `cert` / `ca` 全部由调用方经 `TlsInput` 显式传入，自身不读任何配置键，
 *   故刻意不接收 `config` 参数（加一个从不使用的参数只会误导读者）。
 *
 * 设计要点：
 * - 零异步：使用 `readFileSync` 同步读取，调用方在 `BaseProxy.onBeforeStart()` 同步阶段完成，
 *   失败立即抛错，避免异步竞争与未就绪监听。
 * - 输入归一：`TlsInput` 为联合类型，内部统一归一为 `TlsKeyCert` 对象；字符串输入视为 `key` 与 `cert` 同值（常用自签场景）。
 * - 路径不做任何改写：**路径绝对化由配置层负责**（`FIELDS` 中 `tlsKey`/`tlsCert`/`tlsCa` 均标 `path: true`，
 *   `resolveConfigPaths(config, configDir)` 在配置/runtime 构造期按 `configDir` 绝对化）。
 *   本模块**不改变入参路径**，避免出现以 `process.cwd()` 为基准的第二个权威。
 *   Node 的 `fs.readFileSync` 本身即按 cwd 解析相对路径，故行为与之前完全一致。
 * - CA 即 mTLS 开关：`ca` 一旦配置（非空串）就必须读到，文件缺失/不可读直接抛错，绝不静默降级为不校验——
 *   静默跳过等于谎称已开 mTLS；留空才是不校验。判定统一走 `./server-options.js:requiresClientCert`。
 * - 可选日志：`logger` 与 `label` 均为可选，不传时仅抛错不落盘；传入 `createLogger({ prefix: "https" })`
 *   等可在启动阶段即关联协议前缀。
 * - 错误信息富含路径：`keyPath` / `certPath` / `caPath` 均为调用方传入的原始路径（`ca` 缺省时省略该段），
 *   便于定位挂载或配置错误。
 *
 * 使用示例：
 * ```ts
 * import { loadCerts } from "@/utils/tls/index.js";
 * import { createLogger } from "@/utils/logger/index.js";
 *
 * // 1) 对象形态（推荐）
 * const ctx = loadCerts(
 *   { key: "keys/server.key", cert: "keys/server.crt", ca: "keys/ca.crt", passphrase: "s3cret" },
 *   createLogger({ prefix: "https" }),
 *   "[https]"
 * );
 * // ctx = { key: Buffer, cert: Buffer, ca: Buffer|undefined, passphrase: "s3cret"|undefined }
 *
 * // 2) 单路径字符串（key 与 cert 同文件）
 * const ctx2 = loadCerts("keys/server.pem");
 *
 * // 3) 未传（空对象归一，key/cert 为空串路径，读取失败抛错由调用方捕获）
 * try { loadCerts(undefined); } catch (e) { console.error("证书缺失", e); }
 * ```
 *
 * 关联模块：
 * - `./server-options.ts` — 把本文件的加载结果拼成 `tls.createServer` / `https.createServer` 选项。
 * - `./upstream.ts` — 出站侧 TLS 链路（servername / rejectUnauthorized / 上游 CA），与入站证书无关。
 * - `src/core/server/https.ts` / `tls.ts` — 入站服务创建前的证书上下文来源。
 */

import fs from "node:fs";

/**
 * TLS 键/证书输入对象
 *
 * @description
 * 标准对象形态，所有字段均为可选，缺失时由 `loadCerts` 归一为空串路径并在读取时抛错。
 * - `key` 私钥路径（PEM，对应 `TLS_KEY`）
 * - `cert` 证书路径（PEM，对应 `TLS_CERT`）
 * - `ca` 客户端证书 CA 路径（可选，对应 `TLS_CA`）：配置即强制校验客户端证书（mTLS），留空则不校验
 * - `passphrase` 私钥口令（可选，仅加密私钥 `ENCRYPTED PRIVATE KEY` 时需）
 *
 * @note 路径原样透传给 `fs.readFileSync`；绝对化由配置层在构造期完成，本模块不改写。
 */
export interface TlsKeyCert {
  readonly key?: string;
  readonly cert?: string;
  readonly ca?: string;
  readonly passphrase?: string;
}

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
export interface LoadedTlsCerts {
  key: Buffer;
  cert: Buffer;
  ca?: Buffer;
  passphrase?: string;
}

/**
 * 同步读取证书文件为 Buffer
 *
 * @description
 * - 输入归一：`string` → `{ key: s, cert: s }`；`undefined` → `{}`；对象原样。
 * - 路径**原样**交给 `readFileSync` 同步读取 `key` / `cert`（缺失直接抛错，调用方在 `onBeforeStart` 阶段捕获并阻止启动）；
 *   路径绝对化由配置层负责（`FIELDS` 标 `path: true`，构造期按 `configDir` 解析），本模块不改变入参路径。
 * - `ca` 一旦配置（非空串）即按普通文件读取，缺失/不可读直接抛错——
 *   它同时是「校验客户端证书」的开关，静默跳过等于谎称已开 mTLS；留空才是不校验。
 * - 失败时若提供 `logger` 则以 `label` 为前缀记录 `keyPath` / `certPath` / `caPath`（原始入参路径）与异常对象，随后原样抛错。
 *
 * @param tls - TLS 输入（对象 / 单路径字符串 / 未传）
 * @param logger - 可选日志器，需含 `error(msg, err?)` 方法（如 `createLogger({ prefix: "https" })`），不传则静默抛错
 * @param label - 可选日志前缀（如 `"[https]"` / `"[tls]"`），拼在错误消息前便于区分协议
 * @returns 已加载的证书上下文 `{ key, cert, ca?, passphrase? }`，`ca` 非空即代表启用 mTLS
 * @throws {Error} 当 `key` / `cert` / 已配置的 `ca` 文件不存在或不可读时抛错（`fs.readFileSync` 原始异常）
 * @example
 * ```ts
 * import { loadCerts } from "@/utils/tls/index.js";
 *
 * // 成功
 * const { key, cert, ca } = loadCerts({ key: "keys/server.key", cert: "keys/server.crt", ca: "keys/ca.crt" });
 *
 * // 失败（带日志）
 * import { createLogger } from "@/utils/logger/index.js";
 * try {
 *   loadCerts({ key: "keys/missing.key", cert: "keys/server.crt" }, createLogger({ prefix: "tls" }), "[tls]");
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
  const o = typeof tls === "string" ? { key: tls, cert: tls } : (tls ?? {});
  const keyPath = o.key ?? "";
  const certPath = o.cert ?? "";
  // ca 非空即 mTLS 开关：必须读到，读不到抛错由调用方 abort 启动，绝不静默降级为不校验
  const caPath = o.ca ?? "";
  try {
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    const ca = caPath ? fs.readFileSync(caPath) : undefined;
    // 空串归一 undefined：兼容 createSecureContext 可选语义，无口令即不传字段
    return { key, cert, ca, passphrase: o.passphrase || undefined };
  } catch (e) {
    const caInfo = caPath ? ` ca=${caPath}` : "";
    const prefix = label ? `${label} ` : "";
    logger?.error(`${prefix}证书加载失败 key=${keyPath} cert=${certPath}${caInfo}`, e);
    throw e;
  }
}
