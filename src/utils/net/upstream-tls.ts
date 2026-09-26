/**
 * 出站（上游）TLS - 建链三选项的唯一组装点
 * 职责：
 * - `readUpstreamCa`：按**调用方传入的 CA 路径**读（空串 = 系统信任库）
 * - `upstreamTlsOptions`：出站 TLS 的 `servername` / `rejectUnauthorized` / `ca` 三元组
 * 设计要点：
 * - 纯同步零异步：调用点在拨号前同步取，回调/事件循环无竞态
 * - 纯函数、零配置依赖：`upstreamInsecure` / `upstreamCa` 由调用方**显式传值**注入，
 *   本文件不读任何模块级单例（配置随实例走，同进程多实例互不可见）
 * - 证书校验锚定**建链目标**（`host`），而不是转发的 Host 头（Host 是源站名）
 * - IP 按 RFC6066 置空 servername（跳过 SNI，按连接 host 校验 SAN-IP）
 * - 与 `tls.ts`（入站 mTLS）同属 TLS 但配置键、生命周期、失败语义都不同，故分文件
 * 关联模块：`src/plugins/forwarders.ts`（传输策略组 `https.request` 选项）与
 * `core/forward/dial.ts:dialTls`（`tls.connect`）共用本文件。两处都只收
 * `ForwardPlan.upstreamTls` 冻结下来的策略，不读配置——传输策略与
 * `forward/**` 入站侧同为零配置读取，热加载由路由插件每次 `plan()` 现读 scope 保证。
 */

import fs from "node:fs";
import net from "node:net";
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
 * @param caPath - 上游 CA 路径（来自本实例配置的 `upstreamCa`；空串 = 不配置）
 * @returns CA 文件内容；未配置、路径缺失或非普通文件时返回 `undefined`
 * @example const ca = readUpstreamCa("keys/ca.crt");
 */
function readUpstreamCa(caPath: string): Buffer | undefined {
  if (!caPath) {
    return undefined;
  }

  const abs = resolveFromCwd(caPath);

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
 * 收敛两个出站建链点逐字重复的 `{ servername, rejectUnauthorized, ca }` 三元组
 * （`plugins/forwarders.ts` 的 `https.request` 与 `forward/dial.ts:dialTls` 的 `tls.connect`）：
 * - 证书校验必须锚定**建链目标**（`host`），而非转发的 Host 头（Host 是源站名）；
 * - IP 按 RFC6066 置空 servername（跳过 SNI，按连接 host 校验 SAN-IP）；
 * - `rejectUnauthorized` 由 `upstreamInsecure` 反转，`ca` 走 `readUpstreamCa`（空串 = 回退系统信任库）。
 *
 * 刻意**只收它真正需要的两个配置值**而不是整个 `ConfigScope`：保持纯函数、可单测，
 * 配置读取（scope/instance 归属）由调用方的组合根负责。
 *
 * @param host - 建链目标主机名或 IP 字面量（不含端口）
 * @param options - `insecure` 取自本实例 `upstreamInsecure`；`ca` 取自本实例 `upstreamCa`（空串 = 系统信任库）
 * @returns 可直接展开进 `https.request` / `tls.connect` 的 TLS 选项
 * @example
 * ```ts
 * const opts: https.RequestOptions = {
 *   host,
 *   port,
 *   ...(secure ? upstreamTlsOptions(host, { insecure: scope.get("upstreamInsecure"), ca: scope.get("upstreamCa") }) : {}),
 * };
 * ```
 */
export function upstreamTlsOptions(
  host: string,
  options: { insecure: boolean; ca: string },
): {
  servername: string;
  rejectUnauthorized: boolean;
  ca: Buffer | undefined;
} {
  return {
    servername: net.isIP(host) ? "" : host,
    rejectUnauthorized: !options.insecure,
    ca: readUpstreamCa(options.ca),
  };
}
