/**
 * 访问控制名单（acl.json）- 客户端来源 IP 与目标网站两组黑白名单
 * 职责：
 * - 校验 acl.json 结构，非法条目即返回 undefined（由 loader 在启动期 abort）
 * - 经 utils/json-file 做 mtime 节流热加载；编译结果按「快照对象身份」记忆，命中后不再重建
 * - 提供两个判定入口：checkClientIp（入站对端 IP）与 checkTargetHost（出站目标主机）
 * 设计：
 * - 语义统一：黑名单命中 → 拒绝（优先）；白名单非空且未命中 → 拒绝；皆空 → 全放过
 * - 客户端名单只接受 IP/CIDR（对端永远是 IP，写域名属配置错误）
 * - 目标名单接受 IP/CIDR/域名/`*.域名`；域名按请求 host 字符串匹配，不做 DNS 解析（见 utils/host-list）
 * - 编译结果为只读共享对象，多会话并发调用无每会话状态，无竞态
 */

import { get } from "./store.js";
import { compileIpRules, ipMatches, parseIpRule, type IpRule } from "@/utils/ip-list.js";
import {
  compileHostRules,
  hostMatches,
  parseHostRule,
  type HostMatcher,
} from "@/utils/host-list.js";
import { readJsonCached, type JsonFileRead } from "@/utils/json-file.js";

/** 单组名单 */
export interface AclList {
  whitelist: string[];
  blacklist: string[];
}

/** acl.json 顶层结构 */
export interface AclConfig {
  clientIp: AclList;
  target: AclList;
}

/** 拒绝原因：命中黑名单 / 不在白名单内 */
export type AclReason = "whitelist" | "blacklist";

/** 判定结果 */
export interface AclDecision {
  allowed: boolean;
  reason?: AclReason;
}

/** 空名单（只读哨兵，文件缺失或缺省该组时使用） */
const EMPTY_LIST: AclList = { whitelist: [], blacklist: [] };
const EMPTY_ACL: AclConfig = { clientIp: EMPTY_LIST, target: EMPTY_LIST };
const EMPTY_MATCHER: HostMatcher = { ip: [], exact: new Set<string>(), wildcards: [] };

/** acl.json 顶层允许的键 */
const GROUP_KEYS = new Set(["clientIp", "target"]);
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
    const ok = kind === "ip" ? parseIpRule(entry) !== undefined : parseHostRule(entry) !== undefined;
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
 * @returns 合法时返回归一化配置（未出现的组/键补空），非法返回 undefined
 * @example validateAcl({ clientIp: { blacklist: ["1.2.3.4"] } })
 * // => { clientIp: { whitelist: [], blacklist: ["1.2.3.4"] }, target: { whitelist: [], blacklist: [] } }
 */
export function validateAcl(raw: unknown): AclConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  if (Object.keys(raw).some((k) => !GROUP_KEYS.has(k))) {
    return undefined;
  }

  const o = raw as { clientIp?: unknown; target?: unknown };
  const clientIp = validateGroup(o.clientIp, "ip");
  const target = validateGroup(o.target, "host");

  if (!clientIp || !target) {
    return undefined;
  }
  return { clientIp, target };
}

/** 编译后的判定素材（按快照身份记忆，避免每连接重复编译） */
interface CompiledAcl {
  source: AclConfig;
  clientIpWhitelist: IpRule[];
  clientIpBlacklist: IpRule[];
  targetWhitelist: HostMatcher;
  targetBlacklist: HostMatcher;
}

let compiledCache: CompiledAcl | undefined;

/** 取编译结果；源快照未变则直接复用（只读共享，多会话并发安全） */
function compiled(): CompiledAcl {
  const acl = readAcl().value;
  if (compiledCache && compiledCache.source === acl) {
    return compiledCache;
  }
  compiledCache = {
    source: acl,
    clientIpWhitelist: compileIpRules(acl.clientIp.whitelist) ?? [],
    clientIpBlacklist: compileIpRules(acl.clientIp.blacklist) ?? [],
    targetWhitelist: compileHostRules(acl.target.whitelist) ?? EMPTY_MATCHER,
    targetBlacklist: compileHostRules(acl.target.blacklist) ?? EMPTY_MATCHER,
  };
  return compiledCache;
}

/** 匹配器是否为空（空白名单 = 不做白名单限制） */
function isEmptyMatcher(m: HostMatcher): boolean {
  return m.ip.length === 0 && m.exact.size === 0 && m.wildcards.length === 0;
}

/**
 * 读取 acl 文件（带节流缓存）
 * @param opts.force - 跳过节流强制重读（启动期校验用）
 * @param opts.path - 显式路径覆盖（initConfig 写 store 之前用解析值校验时必须传）
 * @returns 读取结果：value 为生效配置，error 为最近一次失败原因
 */
export function readAcl(opts?: { force?: boolean; path?: string }): JsonFileRead<AclConfig> {
  return readJsonCached(opts?.path ?? get("aclFile"), validateAcl, {
    label: "访问控制名单文件",
    fallback: EMPTY_ACL,
    force: opts?.force,
  });
}

/**
 * 取当前生效 ACL 配置
 * @returns ACL 配置（只读）；文件缺失或非法时为空配置/上一份有效值
 */
export function loadAcl(): AclConfig {
  return readAcl().value;
}

/**
 * 判定客户端来源是否放行
 * @description 只认 TCP 对端地址（由调用方经 socket.remoteAddress 取得），不看 X-Forwarded-For；
 * 地址取不到（"unknown"）且配了白名单时判否（fail-closed）
 * @param addr - 客户端对端地址
 * @returns 判定结果
 */
export function checkClientIp(addr: string): AclDecision {
  const c = compiled();
  if (ipMatches(addr, c.clientIpBlacklist)) {
    return { allowed: false, reason: "blacklist" };
  }
  if (c.clientIpWhitelist.length > 0 && !ipMatches(addr, c.clientIpWhitelist)) {
    return { allowed: false, reason: "whitelist" };
  }
  return { allowed: true };
}

/**
 * 判定目标主机是否放行
 * @description 目标为 IP 字面量时只可能命中 IP/CIDR 条目；为域名时只可能命中精确/通配域名条目
 * @param host - 客户端请求的目标主机（域名或 IP，可带方括号）
 * @returns 判定结果
 */
export function checkTargetHost(host: string): AclDecision {
  const c = compiled();
  if (hostMatches(host, c.targetBlacklist)) {
    return { allowed: false, reason: "blacklist" };
  }
  if (!isEmptyMatcher(c.targetWhitelist) && !hostMatches(host, c.targetWhitelist)) {
    return { allowed: false, reason: "whitelist" };
  }
  return { allowed: true };
}
