/**
 * @fileoverview 入站 TLS 建服选项拼装（server-options.ts）
 *
 * 职责：
 * - `requiresClientCert`：mTLS 判定语义的**唯一入口**（`ca` 已加载 ⇒ 强制校验客户端证书）。
 * - `tlsServerOptions`：把 `loadCerts` 的加载结果组装成 `tls.createServer` / `https.createServer` 选项。
 *
 * 设计要点：
 * - 零 IO、零配置：本文件不读文件、不读配置，纯粹做「材料 → 建服选项」的结构变换，可纯函数测试。
 * - 收敛重复：`core/server/https.ts` 与 TLS SOCKS（`socks-base.ts`）原本逐字重复 options 组装，
 *   统一到此处，杜绝两份实现漂移。
 * - mTLS 开关不可拆开置位：`requestCert` / `rejectUnauthorized` 同源自 `requiresClientCert` 且恒相等；
 *   只置 `requestCert` 不置 `rejectUnauthorized` 等于白要一张证书（拿到证书却不校验即放行）。
 * - `ca` 归一为数组形态（未配置即缺省），`key` / `cert` / `passphrase` 原样透传。
 *
 * 使用示例：
 * ```ts
 * import { loadCerts, requiresClientCert, tlsServerOptions } from "@/utils/tls/index.js";
 *
 * // 完整建服
 * const server = https.createServer(tlsServerOptions(loadCerts(this.options.tls)));
 *
 * // 手动置位（等价路径，仅供自定义建服时使用）
 * const certs = loadCerts(this.options.tls);
 * const mTLS = requiresClientCert(certs);
 * tls.createServer({ ...certs, requestCert: mTLS, rejectUnauthorized: mTLS });
 * ```
 *
 * 关联模块：
 * - `./certs.ts` — `LoadedTlsCerts` 的来源（读文件、抛错都在那边）。
 * - `src/core/server/https.ts` / `socks-base.ts` — 入站 TLS 服务的实际建服方。
 */

import type { LoadedTlsCerts } from "./certs.js";

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
