/**
 * @fileoverview 访问控制名单的**形状校验**（纯函数，零 IO）
 * @module datasource/acl/validate
 * @description
 * 「什么算一份合法的名单」只有这一份判据，**与它存在哪个后端无关**：换驱动换的是
 * 「字节从哪来」，换不掉「这份数据说了什么」。条目语法层（IP/CIDR 编译、主机通配匹配）
 * 在 `@/utils/addr/index.js` —— 零配置依赖的纯词汇层，与全局名单、账号级名单共用同一份。
 *
 * **fail-closed，一律到底**：任一条目非法即**整份文件作废**（不是一个字段被忽略）。
 * 未知键同样作废——多写一个键就静默忽略，等于「配置写错了但没人告诉你」。
 */

import { parseHostRule, parseIpRule } from "@/utils/addr/index.js";
import type { AclConfig, AclList } from "./types.js";

const GROUP_KEYS = new Set(["clientIp", "target", "upstream"]);

const LIST_KEYS = new Set(["whitelist", "blacklist"]);

/**
 * @param raw - 候选数组
 * @param kind - `ip`（只收 IP/CIDR）或 `host`（收 IP/CIDR/域名/通配域名）
 * @returns 合法时返回条目数组（去空白），非法返回 undefined
 */
function validateList(raw: unknown, kind: "ip" | "host"): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const out: string[] = [];
  for (const e of raw) {
    if (typeof e !== "string" || !e.trim()) {
      return undefined;
    }
    const entry = e.trim();
    const ok =
      kind === "ip" ? parseIpRule(entry) !== undefined : parseHostRule(entry) !== undefined;
    if (!ok) {
      return undefined;
    }
    out.push(entry);
  }
  return out;
}

/**
 * @param raw - 候选对象（缺省视为空名单）
 * @param kind - 条目类型，见 validateList
 * @returns 合法时返回 { whitelist, blacklist }，非法返回 undefined
 */
function validateGroup(raw: unknown, kind: "ip" | "host"): AclList | undefined {
  if (raw === undefined) {
    return { whitelist: [], blacklist: [] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  if (Object.keys(raw).some((k) => !LIST_KEYS.has(k))) {
    return undefined;
  }

  const o = raw as { whitelist?: unknown; blacklist?: unknown };
  const whitelist = o.whitelist === undefined ? [] : validateList(o.whitelist, kind);
  const blacklist = o.blacklist === undefined ? [] : validateList(o.blacklist, kind);

  if (!whitelist || !blacklist) {
    return undefined;
  }
  return { whitelist, blacklist };
}

/**
 * @param raw - JSON.parse 结果
 * @returns 合法时返回归一化配置（未出现的组/键补空；没有 `upstream` 键的名单仍合法），非法返回 undefined
 * @example validateAcl({ clientIp: { blacklist: ["1.2.3.4"] } })
 * // => { clientIp: { whitelist: [], blacklist: ["1.2.3.4"] }, target: {...空...}, upstream: {...空...} }
 */
export function validateAcl(raw: unknown): AclConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  if (Object.keys(raw).some((k) => !GROUP_KEYS.has(k))) {
    return undefined;
  }

  const o = raw as { clientIp?: unknown; target?: unknown; upstream?: unknown };
  const clientIp = validateGroup(o.clientIp, "ip");
  const target = validateGroup(o.target, "host");
  // 条目语法与 target 同形（kind "host"：IP/CIDR/域名/`*.域名`，不支持端口、不做 DNS）
  const upstream = validateGroup(o.upstream, "host");

  if (!clientIp || !target || !upstream) {
    return undefined;
  }
  return { clientIp, target, upstream };
}