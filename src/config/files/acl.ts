/**
 * 访问控制名单文件（acl.json）的读取与结构校验。
 *
 * 职责边界：acl.json 分三层，**互不越界**：
 * - **条目规则层** `./rules/`（`ip.ts` + `host.ts`）：条目语法（IP/CIDR/域名/`*.域名`）
 *   的解析、编译与匹配，纯函数、零 IO。改条目语法动这里。
 * - **本模块（数据层）**：读文件、校验顶层形状与三组名单，返回合法的 `AclConfig`。
 * - **策略层** `src/core/access-control.ts`：请求期判定（clientIp / target / upstream
 *   三组名单怎么用）。改判定语义动那里。数据留配置层、策略进 core。
 *
 * 三组名单语义（判定规则见 src/core/access-control.ts 与本目录 AGENTS.md）：
 * - clientIp：只收 IP/CIDR，按 TCP 对端地址判定
 * - target：收 IP/CIDR/域名/`*.域名`，按客户端请求的 host 字符串匹配，不做 DNS
 * - upstream：条目语法同 target，但动作相反（命中 = 直连，不交上游）
 */

import fs from "node:fs";
import type { ConfigAccessor } from "../context.js";
import { readJsonCached, type JsonFileEvent, type JsonFileRead } from "@/utils/json-file/index.js";
import { parseHostRule, parseIpRule } from "./rules/index.js";

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
const EMPTY_LIST: AclList = { whitelist: [], blacklist: [] };

/** 空 ACL（只读哨兵，文件缺失或非法时回退） */
export const EMPTY_ACL: AclConfig = {
  clientIp: EMPTY_LIST,
  target: EMPTY_LIST,
  upstream: EMPTY_LIST,
};

/** acl.json 顶层允许的键 */
const GROUP_KEYS = new Set(["clientIp", "target", "upstream"]);

/** 每组内允许的键 */
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
 * 启动期直接读取并校验 ACL 文件。
 *
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

/**
 * 读取 acl 文件（带节流缓存）
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
 * 取当前生效 ACL 配置。
 * @param config - 必填配置访问器
 * @returns ACL 配置（只读）；文件缺失或非法时为空配置/上一份有效值
 */
export function loadAcl(
  config: ConfigAccessor,
  onEvent?: (event: JsonFileEvent) => void,
): AclConfig {
  return readAcl({ config, onEvent }).value;
}
