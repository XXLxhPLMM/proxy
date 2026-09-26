/**
 * acl.json 结构校验 - 纯函数，零 IO
 *
 * 只回答「这份 JSON.parse 结果是不是合法的名单文件」，不认识路径、不读文件、
 * 不做编译缓存。读盘在 `reader.ts`，判定与编译缓存在 `eval.ts`。
 *
 * 语义（由 `eval.ts` 消费）：
 * - clientIp / target 两组一致：黑名单命中 → 拒绝（优先）；白名单非空且未命中 → 拒绝；皆空 → 放行
 * - upstream 组动作相反：黑名单命中 → 直连（优先）；白名单非空且未命中 → 直连；皆空 → 走上游
 * - 客户端名单只接受 IP/CIDR（对端永远是 IP，写域名属配置错误）
 * - 目标名单与 upstream 名单接受 IP/CIDR/域名/`*.域名`；域名按请求 host 字符串匹配，
 *   不做 DNS 解析（见 utils/addr/host）
 */
import { parseIpRule } from "@/utils/addr/cidr.js";
import { parseHostRule } from "@/utils/addr/host.js";

/** 单组名单 */
export interface AclList {
  whitelist: string[];
  blacklist: string[];
}

/** acl.json 顶层结构 */
export interface AclConfig {
  clientIp: AclList;
  target: AclList;
  /** client 模式路由名单（命中动作 = 直连，不交上游） */
  upstream: AclList;
}

/** 空名单（只读哨兵，文件缺失或缺省该组时使用） */
export const EMPTY_LIST: AclList = { whitelist: [], blacklist: [] };

/** acl.json 顶层允许的键 */
const GROUP_KEYS = new Set(["clientIp", "target", "upstream"]);
/** 每组内允许的键 */
const LIST_KEYS = new Set(["whitelist", "blacklist"]);

/**
 * 校验单组名单的条目
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
 * 校验单组名单
 * @param raw - 候选对象（缺省视为空名单）
 * @param kind - 条目类型，见 validateList
 * @returns 合法时返回 { whitelist, blacklist }，非法返回 undefined
 */
function validateGroup(raw: unknown, kind: "ip" | "host"): AclList | undefined {
  if (raw === undefined) {
    return EMPTY_LIST;
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
 * 校验 acl.json 内容
 * @param raw - JSON.parse 结果
 * @returns 合法时返回归一化配置（未出现的组/键补空，老文件无 upstream 键仍合法），非法返回 undefined
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
