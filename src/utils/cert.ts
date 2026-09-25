/**
 * @fileoverview 证书加载工具 (cert.ts)
 *
 * 职责：
 * - 提供 TLS 证书的同步加载能力，供 `HttpsProxy` / `TlsProxy` 等需要 `key/cert/ca` 的服务端使用。
 * - 统一处理三种输入形态（对象 / 单路径字符串 / 未传）、相对路径解析与文件读取。
 * - 加载失败时经可选 `logger` 记录上下文（key/cert/ca 路径与异常），并向上抛错以阻止服务以半初始化状态启动。
 * - 统一 TLS 服务端建服接线：`tlsServerOptions` 组装 createServer 选项（mTLS 开关同源置位），
 *   `bindTlsClientError` 绑定握手失败告警——`https.ts` 与 TLS SOCKS 共用，杜绝两份实现漂移。
 * - 上游侧 TLS：`readUpstreamCa`（串联上游 CA 读取）与 `upstreamTlsOptions`（servername/rejectUnauthorized/ca
 *   建链三选项）——`forward/http.ts` 与 `forward/dial.ts` 共用，杜绝两份实现漂移。
 *
 * 设计要点：
 * - 零异步：使用 `readFileSync` 同步读取，调用方在 `BaseProxy.onBeforeStart()` 同步阶段完成，
 *   失败立即抛错，避免异步竞争与未就绪监听。
 * - 输入归一：`TlsInput` 为联合类型，内部统一归一为 `TlsKeyCert` 对象；字符串输入视为 `key` 与 `cert` 同值（常用自签场景）。
 * - 路径解析：`resolvePath` 对相对路径以 `process.cwd()` 为基准解析，绝对路径原样保留；与 `loader` 的 `configDir` 计算保持一致。
 * - CA 即 mTLS 开关：`ca` 配了就是「校验客户端证书」，文件读不到直接抛错，绝不静默降级为不校验；
 *   留空 = 只做服务端 TLS（不向客户端索要证书）。判定统一走 `requiresClientCert`，各 TLS 服务端不自行解释。
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
 * // const certs = loadCerts({ key: get("tlsKey"), cert: get("tlsCert"), ca: get("tlsCa") });
 * // const server = https.createServer(tlsServerOptions(certs)); // ca 非空 ⇒ 强制校验客户端证书
 * // bindTlsClientError(server, getLogger("https"), "https");
 * ```
 *
 * 关联模块：
 * - `src/core/server/https.ts` / `tls.ts` — 服务端创建 `https.Server` / `tls.Server` 前的证书上下文来源。
 * - `src/utils/cert.ts:resolvePath` — 内部路径归一，与 `loader.ts:getConfigDir` 的目录语义对齐。
 * - `src/utils/logger.ts` — 可选的错误落盘目标。
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type tls from "node:tls";
import { get } from "@/config/store.js";
import type { Logger } from "@/utils/logger.js";
import { logTlsClientError } from "@/server/log/events-log.js";

/**
 * TLS 键/证书输入对象
 *
 * @description
 * 标准对象形态，所有字段均为可选，缺失时由 `loadCerts` 归一为空串路径并在读取时抛错。
 * - `key` 私钥路径（PEM，对应 `TLS_KEY`）
 * - `cert` 证书路径（PEM，对应 `TLS_CERT`）
 * - `ca` 客户端证书 CA 路径（可选，对应 `TLS_CA`）：配置即强制校验客户端证书（mTLS），留空则不校验
 * - `passphrase` 私钥口令（可选，仅加密私钥 `ENCRYPTED PRIVATE KEY` 时需）
 */
export interface TlsKeyCert {
  key?: string;
  cert?: string;
  ca?: string;
  passphrase?: string;
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
 * 读取上游 CA（自签上游场景）
 *
 * @description
 * - 未配置 `upstreamCa`（默认空串）→ 返回 `undefined`，Node 回退**系统信任库**校验公网上游证书。
 * - 配置后把文件内容作为 `ca` 传给 `https.request` / `tls.connect`，**整体替换系统信任库**：
 *   只信任该 CA，公网 CA 签发的上游会 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 而 502。
 *   因此默认值必须是空串（曾经的 `keys/ca.crt` 默认值会让串联任何公网 HTTPS 上游必然失败）。
 * - 路径存在但不是普通文件（目录等）时返回 `undefined`，避免 `readFileSync` 抛 EISDIR。
 * - 供 `forward/http.ts` 与 `forward/dial.ts` 共用，避免两份实现漂移。
 *
 * @returns CA 文件内容；未配置、路径缺失或非普通文件时返回 `undefined`
 * @example const ca = readUpstreamCa();
 */
export function readUpstreamCa(): Buffer | undefined {
  const p = get("upstreamCa");

  if (!p) {
    return undefined;
  }

  const abs = resolvePath(p);

  try {
    return fs.statSync(abs).isFile() ? fs.readFileSync(abs) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 上游 TLS 建链三选项（servername / rejectUnauthorized / ca）
 *
 * @description
 * 收敛 `forward/http.ts` 与 `forward/dial.ts` 逐字重复的 `{ servername, rejectUnauthorized, ca }` 三元组：
 * - 证书校验必须锚定**建链目标**（`host`），而非转发的 Host 头（Host 是源站名）；
 * - IP 按 RFC6066 置空 servername（跳过 SNI，按连接 host 校验 SAN-IP）；
 * - `rejectUnauthorized` 由 `upstreamInsecure` 反转，`ca` 走 `readUpstreamCa`（空串 = 回退系统信任库）。
 *
 * @param host - 建链目标主机名或 IP 字面量（不含端口）
 * @returns 可直接展开进 `https.request` / `tls.connect` 的 TLS 选项
 * @example
 * ```ts
 * const opts: https.RequestOptions = { host, port, ...(secure ? upstreamTlsOptions(host) : {}) };
 * ```
 */
export function upstreamTlsOptions(host: string): {
  servername: string;
  rejectUnauthorized: boolean;
  ca: Buffer | undefined;
} {
  return {
    servername: net.isIP(host) ? "" : host,
    rejectUnauthorized: !get("upstreamInsecure"),
    ca: readUpstreamCa(),
  };
}

/**
 * 是否要求客户端证书（mTLS）
 *
 * @description
 * 语义唯一入口：`ca` 已加载 ⇒ 强制校验客户端证书。经 `tlsServerOptions` 统一置位
 * `requestCert` / `rejectUnauthorized`，并供握手后 `authorized` 守卫判定。
 *
 * @param certs - `loadCerts` 的返回值
 * @returns 需要客户端证书返回 true（调用方须同时置位 requestCert + rejectUnauthorized）
 * @example
 * ```ts
 * const mTLS = requiresClientCert(certs);
 * tls.createServer({ ...certs, requestCert: mTLS, rejectUnauthorized: mTLS });
 * ```
 */
export function requiresClientCert(certs: LoadedTlsCerts): boolean {
  return certs.ca !== undefined;
}

/**
 * 同步读取证书文件为 Buffer
 *
 * @description
 * - 输入归一：`string` → `{ key: s, cert: s }`；`undefined` → `{}`；对象原样。
 * - 路径解析后 `readFileSync` 同步读取 `key` / `cert`（缺失直接抛错，调用方在 `onBeforeStart` 阶段捕获并阻止启动）。
 * - `ca` 一旦配置（非空串）即按普通文件读取，缺失/不可读直接抛错——
 *   它同时是「校验客户端证书」的开关，静默跳过等于谎称已开 mTLS；留空才是不校验。
 * - 失败时若提供 `logger` 则以 `label` 为前缀记录 `keyPath/certPath/caPath` 与异常对象，随后原样抛错。
 *
 * @param tls - TLS 输入（对象 / 单路径字符串 / 未传）
 * @param logger - 可选日志器，需含 `error(msg, err?)` 方法（如 `getLogger("https")`），不传则静默抛错
 * @param label - 可选日志前缀（如 `"[https]"` / `"[tls]"`），拼在错误消息前便于区分协议
 * @returns 已加载的证书上下文 `{ key, cert, ca?, passphrase? }`，`ca` 非空即代表启用 mTLS
 * @throws {Error} 当 `key` / `cert` / 已配置的 `ca` 文件不存在或不可读时抛错（`fs.readFileSync` 原始异常）
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
  const o = typeof tls === "string" ? { key: tls, cert: tls } : (tls ?? {});
  const keyPath = resolvePath(o.key ?? "");
  const certPath = resolvePath(o.cert ?? "");
  // ca 非空即 mTLS 开关：必须读到，读不到抛错由调用方 abort 启动，绝不静默降级为不校验
  const caPath = o.ca ? resolvePath(o.ca) : "";
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

/**
 * 组装 TLS 服务端选项（https.Server / tls.Server 建服共用）
 *
 * @description
 * 收敛 `core/server/https.ts` 与 `core/server/socks-base.ts` 逐字重复的 options 组装：
 * - `key` / `cert` / `passphrase` 原样透传，`ca` 归一为数组形态（未配置即缺省）。
 * - `requestCert` / `rejectUnauthorized` 同源自 `requiresClientCert` 且恒相等：
 *   只置 `requestCert` 不置 `rejectUnauthorized` 等于白要一张证书（不校验即放行），故不可拆开置位。
 *
 * @param certs - `loadCerts` 的返回值
 * @returns 可直接传给 `tls.createServer` / `https.createServer` 的选项对象
 * @example
 * ```ts
 * const server = https.createServer(tlsServerOptions(loadCerts(this.options.tls)));
 * ```
 */
export function tlsServerOptions(certs: LoadedTlsCerts): {
  key: Buffer;
  cert: Buffer;
  ca?: Buffer[];
  passphrase?: string;
  requestCert: boolean;
  rejectUnauthorized: boolean;
} {
  const mTLS = requiresClientCert(certs);
  return {
    key: certs.key,
    cert: certs.cert,
    ca: certs.ca ? [certs.ca] : undefined,
    passphrase: certs.passphrase,
    requestCert: mTLS,
    rejectUnauthorized: mTLS,
  };
}

/**
 * 绑定 TLS 握手失败告警（tlsClientError）
 *
 * @description
 * 收敛 `core/server/https.ts` 与 TLS SOCKS（`onListenerReady`）两处逐字重复的 `tlsClientError` 接线：
 * 握手失败（含 mTLS 拒绝、非 TLS 客户端打到 TLS 端口）只落 warn、不断服，
 * 携带 `code` / `authorizationError` 结构化字段便于定位「为什么连不上」（事件码 `[tls-client-error]`）。
 *
 * 等级判定只看**错误码**：**`ECONNRESET`（socket hang up，对端没完成 TLS 握手就断开）降到
 * debug** —— 端口探活/扫描的裸 TCP connect+close 只产生这一种码，属环境噪音；其余一律维持
 * warn 与原有结构化字段。`ERR_SSL_*` 意味着双方真的交换过 TLS 字节（明文 HTTP 打 TLS 端口的
 * `ERR_SSL_HTTP_REQUEST`、畸形记录 `ERR_SSL_UNEXPECTED_MESSAGE`、mTLS 缺客户端证书的
 * `ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE`），是有效诊断，绝不降级。
 *
 * **判据不能用「已读字节数」**：`tlsClientError(err, socket)` 给的 `socket` 是 **TLSSocket
 * 包装器**，TLS 状态机经底层 handle 读字节并累加到 **raw socket** 的计数器，包装层自己的
 * `bytesRead` 从不递增、恒为 0（实测：裸探活 0B / 明文 38B / 畸形记录 85B / mTLS 拒绝全部为 0）。
 * 拿它当判据会让**所有**握手失败（含 mTLS 配置错误）都被静默成 debug。要按真实字节数区分只能
 * 读私有 API（`_handle`/`_parent`）或给 raw socket 挂 `data` 监听自己计数——后者会扰动 TLS
 * 状态机读路径，两者都禁用。
 *
 * 已知代价：握手期间**已交换过字节、随后被 RST** 的对端同样是 `ECONNRESET`，会被一并降级
 * （该场景与裸探活在错误码上不可区分）。取向是「宁可少记噪音，也不用读不出来的字节数当判据」。
 *
 * @param server - 已创建的 TLS 服务实例（`https.Server` 是其子类，同样可传）
 * @param log - 日志器，以协议名为前缀区分来源
 * @param protocol - 协议标识（https / sockss4 / sockss5），拼入消息正文
 * @example bindTlsClientError(server, getLogger("https"), "https");
 */
export function bindTlsClientError(server: tls.Server, log: Logger, protocol: string): void {
  server.on("tlsClientError", (err: Error, socket) => {
    const code = (err as NodeJS.ErrnoException).code;
    logTlsClientError(
      log,
      `${protocol} 客户端 TLS 握手失败`,
      err,
      {
        code,
        authorizationError: socket?.authorizationError,
      },
      isBareTcpProbe(code) ? "debug" : undefined,
    );
  });
}

/**
 * 该错误是否「对端没发 TLS 字节就断开」（裸 TCP 探活/端口扫描），可安全降到 debug。
 * @description 判据**只有错误码**：`ECONNRESET` 是唯一「握手未完成即断开」的码；`ERR_SSL_*`
 * 与其它码一律返回 false 保持 warn。绝不读 `socket` 上的字节计数（TLSSocket 包装层的
 * `bytesRead` 恒为 0，见 `bindTlsClientError` 注释）。
 * @param code - 握手失败的错误码（`err.code`，无则 undefined）
 * @returns 仅 `ECONNRESET`（socket hang up）返回 true
 */
function isBareTcpProbe(code: string | undefined): boolean {
  return code === "ECONNRESET";
}
