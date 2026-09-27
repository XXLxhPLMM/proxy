/**
 * 访问控制名单文件（acl.json）的读取与结构校验。
 *
 * 三组名单语义：clientIp 只收 IP/CIDR，按 TCP 对端地址判定；target 收 IP/CIDR/域名/`*.域名`，
 * 按客户端请求的 host 字符串匹配、不做 DNS；upstream 条目语法同 target，但动作相反
 * （命中 = 直连，不交上游）。
 */

import fs from "node:fs";
import type { ConfigAccessor } from "../context.js";
import { readJsonCached, type JsonFileEvent, type JsonFileRead } from "@/utils/json-file/index.js";
import { parseHostRule, parseIpRule } from "./rules/index.js";

export interface AclList {
  whitelist: string[];
  blacklist: string[];
}

export interface AclConfig {
  clientIp: AclList;
  target: AclList;
  /** client 模式路由名单（命中动作 = 直连，不交上游） */
  upstream: AclList;
}

/** 空名单（只读哨兵，文件缺失或缺省该组时使用） */
const EMPTY_LIST: AclList = { whitelist: [], blacklist: [] };

/** 空 ACL（只读哨兵，文件缺失或非法时回退） */
export const EMPTY_ACL: AclConfig = {
  clientIp: EMPTY_LIST,
  target: EMPTY_LIST,
  upstream: EMPTY_LIST,
};

const GROUP_KEYS = new Set(["clientIp", "target", "upstream"]);

const LIST_KEYS = new Set(["whitelist", "blacklist"]);

/** 启动期直接读取的大小上限：1MiB。 */
const MAX_FILE_BYTES = 1024 * 1024;

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 与账号表异步读取相同：缺失为空，JSON/schema/读取错误只通过返回值报告，不抛异常，
 * 不写热加载缓存，也不触发全局 logger。
 */
export async function readAclAsync(filePath: string): Promise<JsonFileRead<AclConfig>> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return {
        value: EMPTY_ACL,
        path: filePath,
        exists: true,
        error: `文件超过 ${MAX_FILE_BYTES} 字节上限`,
      };
    }

    const raw = JSON.parse(content) as unknown;
    const value = validateAcl(raw);
    if (value === undefined) {
      return {
        value: EMPTY_ACL,
        path: filePath,
        exists: true,
        error: "格式非法（字段缺失、类型不符或存在未知键）",
      };
    }
    return { value, path: filePath, exists: true };
  } catch (error) {
    if (isMissingFile(error)) {
      return { value: EMPTY_ACL, path: filePath, exists: false };
    }
    return {
      value: EMPTY_ACL,
      path: filePath,
      exists: false,
      error: errorMessage(error),
    };
  }
}

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

/**
 * @param opts.force - 跳过节流强制重读（启动期校验用）
 * @param opts.path - 显式路径覆盖（loader 写 store 之前用解析值校验时必须传）
 * @param opts.config - 必填配置访问器，决定未显式给 path 时读取哪份 `aclFile`
 * @returns 读取结果：value 为生效配置，error 为最近一次失败原因
 */
export interface ReadAclOptions {
  force?: boolean;
  path?: string;
  /** 必填：决定未显式给 path 时读取哪份配置。 */
  config: ConfigAccessor;
  /** 当前服务显式提供的文件状态观察面；缺省不产生日志副作用。 */
  onEvent?: (event: JsonFileEvent) => void;
}

export function readAcl(opts: ReadAclOptions): JsonFileRead<AclConfig> {
  if (!opts.config) {
    throw new Error("readAcl 必须显式传入 config");
  }
  const filePath = opts.path ?? opts.config.get("aclFile");
  return readJsonCached(filePath, validateAcl, {
    label: "访问控制名单文件",
    fallback: EMPTY_ACL,
    force: opts.force,
    maxBytes: MAX_FILE_BYTES,
    onEvent: opts.onEvent,
  });
}

/**
 * @param config - 必填配置访问器
 * @returns ACL 配置（只读）；文件缺失或非法时为空配置/上一份有效值
 */
export function loadAcl(
  config: ConfigAccessor,
  onEvent?: (event: JsonFileEvent) => void,
): AclConfig {
  return readAcl({ config, onEvent }).value;
}

/**
 * 「配了访问控制」的**文件事实**判定：三组名单任一组非空即算配了。
 *
 * @description
 * 与 `runtime/services.ts:hasConfiguredQuota` **同构**（它也是「落盘事实的唯一出口」）：
 * `runtime.start()` 启动期要报一条 `acl-inert` 告警，而**告警与判定必须是同一个函数**
 * ——两处各写一份，迟早出现「告警说没配、判定说配了」。**判据是文件事实而不是配置猜测**：
 * ACL_FILE 路径有没有被显式设置、跑的是哪个协议，都答不出「名单里有没有内容」；只有读文件能答。
 *
 * ### 复用既有读取路径（**绝不许另开一个 `readJsonCached` 调用点**）
 *
 * 走的就是上面的 `readAcl` → `readJsonCached`；另开一个调用点会造成**两份节流缓存、两份解析、
 * 两套坏文件处理**并互相污染同一缓存键——这条纪律与它的变异测试（断言 `acl.ts` 全文
 * `readJsonCached` 恰好一处）见 `tests/unit/acl-configured.test.ts`。
 *
 * ### 「读失败 → false」的代价（刻意取舍）
 *
 * 读不到名单（文件缺失 / 名单全空 / `EACCES` 等 stat 错误 / 坏 JSON 且无历史）一律 `false`，
 * 于是**读不到名单时不告警**。语义是「**压根不知道配没配**」，不是「配了却没生效」——
 * 报出来是**误报**。宁可少报也不误报：一条会误报的告警在第一次误报之后就再也不会被看了，
 * 那等于把这条告警永久关掉。真正读不到文件时**已经有别的可见信号**：`readJsonCached` 会
 * 经 `onEvent` 报 `error`、runtime 转成 `config.file-error` 公共事件、CLI 落一条日志。
 *
 * @param config - 必填配置访问器（决定读哪份 `aclFile`）
 * @param onFileEvent - 文件状态观察面；与 `loadAcl` 同一份，用于发 `config.file-*` 事件
 * @returns 任一组的 whitelist 或 blacklist 非空即 `true`；缺失 / 全空 / 读失败即 `false`
 */
export function hasConfiguredAcl(
  config: ConfigAccessor,
  onFileEvent?: (event: JsonFileEvent) => void,
): boolean {
  const acl = loadAcl(config, onFileEvent);
  return (
    acl.clientIp.whitelist.length > 0 ||
    acl.clientIp.blacklist.length > 0 ||
    acl.target.whitelist.length > 0 ||
    acl.target.blacklist.length > 0 ||
    acl.upstream.whitelist.length > 0 ||
    acl.upstream.blacklist.length > 0
  );
}
