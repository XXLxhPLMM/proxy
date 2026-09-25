/**
 * @fileoverview 自环判定：目标是否指向代理自身的监听地址（纯函数，零 config、零 IO）
 * @module core/helpers/self-loop
 * @description
 * 代理若把请求转发回自己的监听端口就会成环（隧道套隧道直到资源耗尽），所以拨号前
 * 必须判定一次。本模块是该判定的**唯一实现**。
 *
 * 为什么不住在 `src/utils/ip.ts`：
 * - 它不是「IP 工具」，而是转发策略的一部分（唯一调用方是同目录的 `predial.ts`）。
 *   归一化与判定混在一个叫 `ip` 的文件里，读者会以为它是可复用的地址原语。
 * - 归一化原子（剥方括号 / 去尾点 / 剥 `%zone`）已收敛到 `@/utils/host-text.js`，
 *   v4-mapped 归一收敛到 `@/config/files/rules/index.js`（与 ACL 名单同一份实现），
 *   本文件只做「归一 → 比对」这一步。
 *
 * 判定规则（顺序即优先级）：
 * 1. 端口不同 → 不是循环
 * 2. 代理监听通配地址（0.0.0.0 / ::）→ 任何目标 + 相同端口都是循环
 * 3. 目标与监听地址归一后完全相等 → 循环
 * 4. 双方都属 loopback 别名族（localhost / 127.0.0.1 / ::1 / v4-mapped 形态）→ 循环
 * 5. 目标是通配地址而监听在 loopback → 循环（`connect(0.0.0.0)` 实际连到 127.0.0.1）
 *
 * 依赖：`@/utils/host-text.js`（文本原子）+ `@/config/files/rules/index.js`（IP 归一，
 * 纯函数）。不读配置：`host`/`port` 由调用方从显式访问器取出后传入。
 */

import { ipToString, normalizeHost, normalizeIp } from "@/config/files/rules/index.js";

/** 通配监听地址：IPv4 0.0.0.0 与 IPv6 :: / 0:0:0:0:0:0:0:0 等价（均表示所有接口） */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

/** loopback 别名族：这些都指向同一个本机回环接口 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * 归一为可与监听地址比对的形式
 * @description 复用名单规则的归一链，保证「自环判定」与「名单判定」对同一个 host 的
 * 归一结果**逐字一致**：小写、剥方括号（含 `[v6]:port`）、去末尾点、剥 `%zone`，
 * 并把 v4-mapped IPv6（`::ffff:127.0.0.1` 与十六进制形态 `::ffff:7f00:1`）还原为点分 IPv4。
 * @param raw - 原始主机名/IP（可含方括号、端口段、尾点、%zone）
 * @returns 归一后的主机串；空串返回 undefined
 * @example canonicalHost("[::1]:443") // => "::1"
 * @example canonicalHost("::ffff:127.0.0.1") // => "127.0.0.1"
 * @example canonicalHost("localhost.") // => "localhost"
 */
function canonicalHost(raw: string): string | undefined {
  const h = normalizeHost(raw);
  if (h === undefined) {
    return undefined;
  }
  const ip = normalizeIp(h);
  // 归一得出 IPv4/IPv6 字面量时用其规范文本比对，避免 v4-mapped 形态与裸 IPv4 判不等
  return ip ? ipToString(ip) : h;
}

/**
 * 检测目标地址是否指向代理自身，防止循环转发
 * @param targetHost - 目标主机名/IP
 * @param targetPort - 目标端口
 * @param selfHost - 代理监听地址
 * @param selfPort - 代理监听端口
 * @returns 是否构成自环
 * @example isSelfLoopAddr("example.com", 8080, "0.0.0.0", 8080) // => true
 * @example isSelfLoopAddr("::ffff:127.0.0.1", 8080, "127.0.0.1", 8080) // => true
 * @example isSelfLoopAddr("127.0.0.1", 8080, "192.168.1.5", 8080) // => false
 */
export function isSelfLoopAddr(
  targetHost: string,
  targetPort: number,
  selfHost: string,
  selfPort: number,
): boolean {
  if (targetPort !== selfPort) {
    return false;
  }

  const target = canonicalHost(targetHost);
  const self = canonicalHost(selfHost);
  // 空主机名无法构成有意义的相等判断：只保留「通配监听 ⇒ 同端口即成环」这一条
  if (target === undefined || self === undefined) {
    return false;
  }

  if (WILDCARD_HOSTS.has(self)) {
    return true;
  }

  if (target === self) {
    return true;
  }

  const selfLoopback = LOOPBACK_HOSTS.has(self);
  const targetLoopback = LOOPBACK_HOSTS.has(target);

  if (selfLoopback && targetLoopback) {
    return true;
  }

  // 目标是通配地址：内核按 loopback 处理，此时只要代理就监听在 loopback 就是自环
  return selfLoopback && WILDCARD_HOSTS.has(target);
}
