/**
 * 主机名单工具 - 目标黑白名单的匹配核心（纯函数，无 IO）
 * 职责：
 * - 归一主机文本为可比较形态（`normalizeHost`，小写/剥方括号与端口/去尾点/剥 %zone）
 * - 解析目标条目：IP / CIDR / 域名 / `*.` 通配域名
 * - 编译为「IP 规则 + 精确域名 Set + 通配后缀数组」，供热路径做无分配匹配
 * 设计：
 * - 匹配对象是**客户端请求的 host 字符串**，不做 DNS 解析后比对：
 *   额外一次解析往返不划算，且解析结果可被 DNS rebinding 绕过；
 *   于是「域名条目拦不住客户端直写 IP」属已知边界，两类条目都写才两头都堵
 * - 域名一律小写、去尾点、剥方括号；IDN 需写 punycode（ASCII 白名单正则天然拒绝非 ASCII）
 * - `*.a.com` 只匹配 a.com 的子域，不匹配 a.com 本身（精确与通配职责分离，不隐式包含）
 * - `normalizeHost` 同时是自环判定（`loop.ts`）的前置归一步骤，全项目只有这一份主机归一实现
 * - 编译结果不可变，可被多会话并发共享（只读，无每会话状态）
 */

import { ipMatches, normalizeIp, parseIpRule, type IpRule } from "./ip.js";

/**
 * 单条目标规则
 * - `ip`：IP 或 CIDR（命中客户端请求中的 IP 字面量）
 * - `exact`：精确域名（`example.com`）
 * - `wildcard`：通配域名（`*.example.com` → suffix `.example.com`）
 */
export type HostRule =
  | { kind: "ip"; rule: IpRule; source: string }
  | { kind: "exact"; name: string; source: string }
  | { kind: "wildcard"; suffix: string; source: string };

/**
 * 编译后的匹配器：热路径零分配
 * @param ip - IP/CIDR 规则集（空数组即无规则）
 * @param exact - 精确域名集合
 * @param wildcards - 通配后缀数组
 */
export interface HostMatcher {
  ip: IpRule[];
  exact: Set<string>;
  wildcards: string[];
}

/**
 * 域名合法性：ASCII 字母数字与连字符，标签内不以连字符开头/结尾，至少一个标签
 * 说明：刻意拒绝非 ASCII（IDN 必须写 punycode）与下划线，避免与真实 DNS 语义产生歧义
 */
const RE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * 归一化主机文本为可比较形态
 * @description 小写、剥方括号（含 `[v6]:port` 的端口段）、去末尾点、剥 %zone
 * @param host - 原始主机（可含方括号/端口/尾点）
 * @returns 归一化后的主机串，空串返回 undefined
 * @example normalizeHost("[::1]:443") // => "::1"
 * @example normalizeHost("Example.COM.") // => "example.com"
 */
export function normalizeHost(host: string): string | undefined {
  if (typeof host !== "string") {
    return undefined;
  }

  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    h = end === -1 ? h.slice(1) : h.slice(1, end);
  } else {
    while (h.endsWith(".")) {
      h = h.slice(0, -1);
    }
  }

  const zone = h.indexOf("%");
  if (zone !== -1) {
    h = h.slice(0, zone);
  }

  return h || undefined;
}

/**
 * 解析单条目标规则
 * @param entry - `1.2.3.4` / `10.0.0.0/8` / `example.com` / `*.example.com`
 * @returns 编译后的规则，非法条目返回 undefined
 * @example parseHostRule("*.example.com") // => { kind: "wildcard", suffix: ".example.com", source: "*.example.com" }
 */
export function parseHostRule(entry: string): HostRule | undefined {
  if (typeof entry !== "string") {
    return undefined;
  }

  const raw = entry.trim();
  if (!raw) {
    return undefined;
  }

  if (raw.startsWith("*.")) {
    const rest = normalizeHost(raw.slice(2));
    if (!rest || !RE_DOMAIN.test(rest)) {
      return undefined;
    }
    return { kind: "wildcard", suffix: `.${rest}`, source: raw };
  }

  const ip = parseIpRule(raw);
  if (ip) {
    return { kind: "ip", rule: ip, source: raw };
  }

  const name = normalizeHost(raw);
  if (!name || !RE_DOMAIN.test(name)) {
    return undefined;
  }

  return { kind: "exact", name, source: raw };
}

/**
 * 批量编译目标规则为匹配器
 * @param entries - 规则文本数组
 * @returns 全部合法时返回匹配器，任一条非法返回 undefined（fail-closed 交给调用方）
 */
export function compileHostRules(entries: readonly string[]): HostMatcher | undefined {
  const matcher: HostMatcher = { ip: [], exact: new Set<string>(), wildcards: [] };

  for (const e of entries) {
    const r = parseHostRule(e);
    if (!r) {
      return undefined;
    }
    if (r.kind === "ip") {
      matcher.ip.push(r.rule);
    } else if (r.kind === "exact") {
      matcher.exact.add(r.name);
    } else {
      matcher.wildcards.push(r.suffix);
    }
  }

  return matcher;
}

/**
 * 判定主机是否命中匹配器
 * @description IP 与域名分属两套规则，互不串味：请求目标是 IP 字面量时只可能命中 ip 规则，
 * 是域名时只可能命中精确/通配规则（域名条目不做解析后再比对，见文件头说明）
 * @param host - 客户端请求的目标主机
 * @param matcher - 已编译匹配器
 * @returns 命中返回 true
 */
export function hostMatches(host: string, matcher: HostMatcher): boolean {
  const h = normalizeHost(host);
  if (!h) {
    return false;
  }

  const isIp = normalizeIp(h) !== undefined;
  if (isIp) {
    return ipMatches(h, matcher.ip);
  }

  if (matcher.exact.has(h)) {
    return true;
  }

  for (const suffix of matcher.wildcards) {
    if (h.length > suffix.length && h.endsWith(suffix)) {
      return true;
    }
  }

  return false;
}
