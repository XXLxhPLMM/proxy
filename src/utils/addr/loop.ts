/**
 * 自环检测 - 目标地址是否指回代理自身（纯函数，host/port 全参数化）
 * 职责：
 * - `isSelfLoopAddr`：比对「客户端请求的目标」与「本代理监听地址」，命中即拒绝转发
 * 设计：
 * - 归一全部交给 `addr/host.ts:normalizeHost`（小写/剥方括号/去尾点/剥 zone）与
 *   `addr/address.ts:normalizeIp`（v4-mapped IPv6 → IPv4 的字节级归一）+
 *   `ipv4BytesToString`/`ipv6BytesToString`：
 *   **同一份地址语义只有一处实现**，不再在本文件重写 v4-mapped 还原
 * - 通配/回环是「族」概念：`0.0.0.0` 与 `::` 都表示所有接口，`localhost`/`127.0.0.1`/`::1`
 *   都指向本机回环，因此归一后按字符串比对即可覆盖 IPv4/IPv6/主机名三种写法
 * - 不查 DNS、不读配置：监听地址由调用方（`core/proxy-helpers.ts:isSelfLoop`）注入
 */

/** 通配监听地址：IPv4 0.0.0.0 与 IPv6 :: / 0:0:0:0:0:0:0:0 等价（均表示所有接口） */
const WILDCARD_HOSTS = ["0.0.0.0", "::"];

/** loopback 别名族：这些都指向同一个本机回环接口 */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

import { ipv4BytesToString, ipv6BytesToString, normalizeIp } from "./address.js";
import { normalizeHost } from "./host.js";

/**
 * 归一为「可与监听地址逐字比对」的形态
 * @description 非 IP 文本（`localhost`、裸主机名）原样返回（小写、去尾点后）；
 * IP 走字节级归一后重新格式化，因此 `::ffff:127.0.0.1` 与十六进制形态 `::ffff:7f00:1`
 * 都会收敛成 `127.0.0.1`，`0:0:0:0:0:0:0:0` 收敛成 `::`。
 * @param raw - 原始主机名/IP（可含方括号、尾点）
 * @returns 归一后的主机名
 * @example comparableHost("[::1]") // => "::1"
 * @example comparableHost("::ffff:127.0.0.1") // => "127.0.0.1"
 * @example comparableHost("localhost.") // => "localhost"
 */
function comparableHost(raw: string): string {
  const h = normalizeHost(raw);
  if (!h) {
    return "";
  }
  const ip = normalizeIp(h);
  if (!ip) {
    return h;
  }
  return ip.family === 4 ? ipv4BytesToString(ip.bytes) : ipv6BytesToString(ip.bytes);
}

/**
 * 检测目标地址是否指向代理自身，防止循环转发
 * 规则：
 * 1. 端口不同 → 不是循环
 * 2. 代理监听通配地址（0.0.0.0 / ::）→ 任何目标 + 相同端口都是循环
 * 3. 目标与监听地址归一后完全相等 → 循环
 * 4. 双方都属 loopback 别名族（localhost / 127.0.0.1 / ::1 / v4-mapped ::ffff:127.0.0.1）→ 循环
 * 5. 目标是通配地址而监听在 loopback → 循环（connect(0.0.0.0) 实际连到 127.0.0.1）
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

  const target = comparableHost(targetHost);
  const self = comparableHost(selfHost);

  if (WILDCARD_HOSTS.includes(self)) {
    return true;
  }

  if (target === self) {
    return true;
  }

  const selfLoopback = LOOPBACK_HOSTS.includes(self);
  const targetLoopback = LOOPBACK_HOSTS.includes(target);

  if (selfLoopback && targetLoopback) {
    return true;
  }

  // 目标是通配地址：内核按 loopback 处理，此时只要代理就监听在 loopback 就是自环
  return selfLoopback && WILDCARD_HOSTS.includes(target);
}
