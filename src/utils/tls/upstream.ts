/**
 * @fileoverview 出站（上游）TLS 链路选项（upstream.ts）
 *
 * 职责：
 * - `readUpstreamCa(config)`：读 `upstreamCa` 指定的 CA 材料（自签上游场景）。
 * - `upstreamTlsOptions(host, config)`：组装建链三选项 `{ servername, rejectUnauthorized, ca }`。
 * - 本目录**唯一**读取配置的两个函数，`config: ConfigAccessor` 必填（避免读到别处的实例配置）。
 *
 * 设计要点：
 * - 收敛重复：`forward/channel/http.ts` 与 `forward/upstream/dial.ts` 原本逐字重复 `readUpstreamCa` 与三选项组装，
 *   统一到此处，杜绝两份实现漂移。
 * - 校验锚定建链目标：证书校验必须锚定 `host`（建链目标），而非转发的 Host 头（Host 是源站名）。
 * - IP 按 RFC6066 置空 `servername`（跳过 SNI，按连接 host 校验 SAN-IP）。
 * - `upstreamCa` 是**整体替换系统信任库**，不是追加：配置后只信任该 CA，
 *   公网 CA 签发的上游会 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 而 502；因此默认值必须为空串。
 * - `readUpstreamCa` 对「路径存在但不是普通文件（目录等）」返回 `undefined`，避免 `readFileSync` 抛 EISDIR。
 * - 路径绝对化由配置层负责（`FIELDS` 中 `upstreamCa` 标 `path: true`，构造期按 `configDir` 解析）；
 *   本模块不改写入参路径，`fs` 自身按 cwd 解析相对路径。
 *
 * 使用示例：
 * ```ts
 * import { upstreamTlsOptions } from "@/utils/tls/index.js";
 *
 * const opts: https.RequestOptions = {
 *   host,
 *   port,
 *   ...(secure ? upstreamTlsOptions(host, this.options.config) : {}),
 * };
 * ```
 *
 * 关联模块：
 * - `src/core/forward/channel/http.ts` / `upstream/dial.ts` — 上游请求 / 上游拨号的两条建链路径。
 * - `./certs.ts` — 入站侧证书材料，与本文件无关（配置键不同、方向不同）。
 */

import fs from "node:fs";
import net from "node:net";
import type { ConfigAccessor } from "@/config/index.js";

/**
 * 读取上游 CA（自签上游场景）
 *
 * @description
 * - 未配置 `upstreamCa`（默认空串）→ 返回 `undefined`，Node 回退**系统信任库**校验公网上游证书。
 * - 配置后把文件内容作为 `ca` 传给 `https.request` / `tls.connect`，**整体替换系统信任库**：
 *   只信任该 CA，公网 CA 签发的上游会 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 而 502。
 *   因此默认值必须是空串（曾经的 `keys/ca.crt` 默认值会让串联任何公网 HTTPS 上游必然失败）。
 * - 路径存在但不是普通文件（目录等）时返回 `undefined`，避免 `readFileSync` 抛 EISDIR。
 * - 供 `forward/channel/http.ts` 与 `forward/upstream/dial.ts` 共用，避免两份实现漂移。
 *
 * @param config - 当前 runtime/代理实例的配置访问器（必填，不读全局 store）
 * @returns CA 文件内容；未配置、路径缺失或非普通文件时返回 `undefined`
 */
export function readUpstreamCa(config: ConfigAccessor): Buffer | undefined {
  const p = config.get("upstreamCa");

  if (!p) {
    return undefined;
  }

  try {
    return fs.statSync(p).isFile() ? fs.readFileSync(p) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 上游 TLS 建链三选项（servername / rejectUnauthorized / ca）
 *
 * @description
 * 收敛 `forward/channel/http.ts` 与 `forward/upstream/dial.ts` 逐字重复的 `{ servername, rejectUnauthorized, ca }` 三元组：
 * - 证书校验必须锚定**建链目标**（`host`），而非转发的 Host 头（Host 是源站名）；
 * - IP 按 RFC6066 置空 servername（跳过 SNI，按连接 host 校验 SAN-IP）；
 * - `rejectUnauthorized` 由 `upstreamInsecure` 反转，`ca` 走 `readUpstreamCa`（空串 = 回退系统信任库）。
 *
 * @param host - 建链目标主机名或 IP 字面量（不含端口）
 * @param config - 当前 runtime/代理实例的配置访问器
 * @returns 可直接展开进 `https.request` / `tls.connect` 的 TLS 选项
 * @example
 * ```ts
 * const opts: https.RequestOptions = { host, port, ...(secure ? upstreamTlsOptions(host, config) : {}) };
 * ```
 */
export function upstreamTlsOptions(
  host: string,
  config: ConfigAccessor,
): {
  servername: string;
  rejectUnauthorized: boolean;
  ca: Buffer | undefined;
} {
  return {
    servername: net.isIP(host) ? "" : host,
    rejectUnauthorized: !config.get("upstreamInsecure"),
    ca: readUpstreamCa(config),
  };
}
