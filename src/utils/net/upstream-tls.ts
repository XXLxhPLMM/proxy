/**
 * 出站（上游）TLS - 建链三选项的唯一组装点
 * 职责：
 * - `readUpstreamCa`：读 `upstreamCa`（空串 = 系统信任库）
 * - `upstreamTlsOptions`：出站 TLS 的 `servername` / `rejectUnauthorized` / `ca` 三元组
 * 设计要点：
 * - 纯同步零异步：调用点在拨号前同步取，回调/事件循环无竞态
 * - 证书校验锚定**建链目标**（`host`），而不是转发的 Host 头（Host 是源站名）
 * - IP 按 RFC6066 置空 servername（跳过 SNI，按连接 host 校验 SAN-IP）
 * - 与 `tls.ts`（入站 mTLS）同属 TLS 但配置键、生命周期、失败语义都不同，故分文件
 * 关联模块：`forward/http.ts` 与 `forward/dial.ts` 共用本文件。
 */

import fs from "node:fs";
import net from "node:net";
import { get } from "@/config/store.js";
import { resolveFromCwd } from "@/utils/file/path.js";

/**
 * 读取上游 CA（自签上游场景）
 *
 * @description
 * - 未配置 `upstreamCa`（默认空串）→ 返回 `undefined`，Node 回退**系统信任库**校验公网上游证书。
 * - 配置后把文件内容作为 `ca` 传给 `https.request` / `tls.connect`，**整体替换系统信任库**：
 *   只信任该 CA，公网 CA 签发的上游会 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 而 502。
 *   因此默认值必须是空串（曾经的 `keys/ca.crt` 默认值会让串联任何公网 HTTPS 上游必然失败）。
 * - 路径存在但不是普通文件（目录等）时返回 `undefined`，避免 `readFileSync` 抛 EISDIR。
 * - 出站侧刻意**不**像入站那样 abort：CA 读不到等价于「不配置」，回退系统信任库。
 *
 * @returns CA 文件内容；未配置、路径缺失或非普通文件时返回 `undefined`
 * @example const ca = readUpstreamCa();
 */
function readUpstreamCa(): Buffer | undefined {
  const p = get("upstreamCa");

  if (!p) {
    return undefined;
  }

  const abs = resolveFromCwd(p);

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
