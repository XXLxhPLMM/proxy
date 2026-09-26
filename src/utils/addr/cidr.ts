/**
 * IP/CIDR 名单规则 - 纯函数，无 IO，无配置依赖
 * 职责：
 * - 解析单条 IP/CIDR 规则（`1.2.3.4` / `10.0.0.0/8` / `::1` / `2001:db8::/32`）为可匹配结构
 * - 批量编译规则条目（任一条非法即整体 undefined，由调用方 fail-closed）
 * - 判定地址是否命中规则集（按前缀位数做位掩码比对）
 * 不负责：IP 文本 ↔ 字节的解析与格式化（`address.ts`）、主机名与通配域名（`host.ts`）
 * 设计：
 * - 规则以「网段基址字节 + 前缀位数」表示，故 `10.0.0.5/24` 与 `10.0.0.0/24` 等价
 * - 归一（v4-mapped → IPv4）统一委托 `address.ts:normalizeIp`，本模块不重写地址语义
 * - 族不同直接跳过：IPv4 规则不命中 IPv6 地址，反之亦然
 * - 编译结果只读，可被多会话并发共享（无每会话状态）
 */

import { normalizeIp, type IpFamily } from "./address.js";

/** 单条 IP/CIDR 规则 */
export interface IpRule {
  family: IpFamily;
  /** 网段基址（与 family 等长的字节缓冲） */
  base: Buffer;
  /** 前缀位数：v4 0-32，v6 0-128 */
  bits: number;
  /** 原始条目文本，供日志/审计回溯 */
  source: string;
}

/**
 * 按前缀位数比较两段地址是否同网段
 * @param a - 地址字节
 * @param b - 网段基址字节
 * @param bits - 前缀位数（0 表示全匹配）
 * @returns 同网段返回 true
 */
function prefixEquals(a: Buffer, b: Buffer, bits: number): boolean {
  const full = bits >> 3;
  const rem = bits & 7;

  for (let i = 0; i < full; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  if (rem === 0) {
    return true;
  }

  const mask = (0xff << (8 - rem)) & 0xff;
  return (a[full] & mask) === (b[full] & mask);
}

/**
 * 解析单条 IP/CIDR 规则
 * @param entry - 形如 `1.2.3.4`、`10.0.0.0/8`、`::1`、`2001:db8::/32`
 * @returns 编译后的规则，非法条目（含前缀越界）返回 undefined
 * @example parseIpRule("10.0.0.0/8") // => { family: 4, base: <0a 00 00 00>, bits: 8, source: "10.0.0.0/8" }
 */
export function parseIpRule(entry: string): IpRule | undefined {
  if (typeof entry !== "string") {
    return undefined;
  }

  const raw = entry.trim();
  if (!raw) {
    return undefined;
  }

  const slash = raw.indexOf("/");
  const addrPart = slash === -1 ? raw : raw.slice(0, slash);
  const bitsPart = slash === -1 ? undefined : raw.slice(slash + 1);

  const ip = normalizeIp(addrPart);
  if (!ip) {
    return undefined;
  }

  const maxBits = ip.family === 4 ? 32 : 128;
  let bits = maxBits;

  if (bitsPart !== undefined) {
    if (!/^\d{1,3}$/.test(bitsPart)) {
      return undefined;
    }
    bits = Number(bitsPart);
    if (bits > maxBits) {
      return undefined;
    }
  }

  return { family: ip.family, base: ip.bytes, bits, source: raw };
}

/**
 * 批量编译规则条目
 * @param entries - 规则文本数组
 * @returns 全部合法时返回规则数组，任一条非法返回 undefined（由调用方 fail-closed）
 */
export function compileIpRules(entries: readonly string[]): IpRule[] | undefined {
  const rules: IpRule[] = [];
  for (const e of entries) {
    const r = parseIpRule(e);
    if (!r) {
      return undefined;
    }
    rules.push(r);
  }
  return rules;
}

/**
 * 判定地址是否命中规则集
 * @description 空规则集恒 false；族不同直接跳过（IPv4 规则不命中 IPv6 地址，反之亦然）；
 * 前缀位数 0 视为全匹配（`0.0.0.0/0`）
 * @param addr - 待判地址（可为 v4-mapped 形态）
 * @param rules - 已编译规则
 * @returns 命中返回 true
 */
export function ipMatches(addr: string, rules: readonly IpRule[]): boolean {
  if (rules.length === 0) {
    return false;
  }

  const ip = normalizeIp(addr);
  if (!ip) {
    return false;
  }

  for (const r of rules) {
    if (r.family !== ip.family) {
      continue;
    }
    if (r.bits === 0 || prefixEquals(ip.bytes, r.base, r.bits)) {
      return true;
    }
  }

  return false;
}
