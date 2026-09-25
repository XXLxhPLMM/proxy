/**
 * 配置加载及初始化 - 全局唯一入口
 * 覆盖顺序：默认值 < preset < CLI / 终端环境变量 / env 文件
 * 设计：表驱动（FIELDS 描述全部字段），CLI 解析、env 合并、
 * store 写入、快照返回均由表自动生成；
 * 新增配置只需 store.ts 加字段 + fields.ts 表加一行，杜绝多处手工同步漂移
 */

import path from "node:path";
import { commitConfig, getAll, defaults, type AppConfig, type ConfigKey } from "./store.js";
import { readAuthUsers } from "./auth-users.js";
import { readAcl } from "./acl.js";
import { logger } from "@/utils/logger.js";
import { applyUpstreamUrl } from "@/utils/upstream-url.js";
import { sanitizeJsonFileErrorText } from "@/utils/json-file.js";
import {
  subscribeConfigResourceEvents,
  type ConfigResource,
  type ConfigResourceEvent,
  type ConfigResourceOutcome,
  type ConfigResourceTransition,
} from "./resource-events.js";
import {
  getConfigDir,
  ensureConfigDir,
  loadEnvFiles,
  parseRawArgv,
  toBoolean,
  HOME_CONFIG_KEY,
} from "./config-helpers.js";
import {
  FIELDS,
  collectFieldValueErrors,
  collectIntRangeErrors,
  assertAuthConfig,
  resolveFieldEntries,
  getFieldDef,
  isConfigKey,
  validateFieldValue,
} from "./fields.js";
import { resolvePreset } from "./presets.js";

// ── 重导出：保持原有 import 路径兼容 ──
export { keysByPhase } from "./fields.js";
export { parseStartupArgs } from "./fields.js";
export { assertAuthConfig } from "./fields.js";

/** 初始化幂等标记：显式调用一次，重复调用直接返回快照 */
let _inited = false;

/** 将已校验的 unknown 值写进 candidate；只通过明确的 ConfigKey 访问。 */
function assignCandidateValue(candidate: AppConfig, key: ConfigKey, value: unknown): void {
  (candidate as unknown as Record<string, unknown>)[key] = value;
}

/**
 * 准备一次 runtime 配置候选，不读取 env、CLI、preset，也不写 store。
 *
 * 这是 ConfigService.reload 唯一的配置语义入口：先拒绝 startup 字段，再
 * 复用 FIELDS 的 parser/范围检查和 auth 跨字段守卫，最后 force 校验两个
 * JSON 资源。成功返回完整 candidate；任何异常都让调用方保留旧快照。
 */
export function prepareRuntimeConfig(current: AppConfig, patch: Partial<AppConfig>): AppConfig {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new Error("配置校验失败: runtime patch 必须是对象");
  }

  const keys = Object.keys(patch);
  const startupFields: string[] = [];
  for (const rawKey of keys) {
    if (!isConfigKey(rawKey)) {
      throw new Error("配置校验失败: 未知配置字段");
    }
    const definition = getFieldDef(rawKey);
    if (definition === undefined) {
      throw new Error("配置校验失败: 未知配置字段");
    }
    if (definition.phase === "startup") {
      startupFields.push(definition.env);
    }
  }
  if (startupFields.length > 0) {
    // 整批拒绝：即使同一 patch 里还有合法 runtime 字段，也不能部分写入。
    throw new Error(
      `配置校验失败: runtime reload 不允许修改 startup 字段: ${startupFields.join(", ")}`,
    );
  }

  const candidate: AppConfig = { ...current };
  for (const rawKey of keys) {
    if (!isConfigKey(rawKey)) {
      throw new Error("配置校验失败: 未知配置字段");
    }
    const key: ConfigKey = rawKey;
    const validation = validateFieldValue(key, (patch as Record<string, unknown>)[key]);
    if (!validation.valid) {
      const definition = getFieldDef(key);
      throw new Error(`配置校验失败: ${definition?.env ?? "配置字段"} 值非法`);
    }
    assignCandidateValue(candidate, key, validation.value);
  }

  // UPSTREAM_URL 仍是整体覆盖 granular 字段的单一派生入口；这里只处理
  // candidate，不重新解析任何外部来源。
  const urlValidation = validateFieldValue("upstreamUrl", candidate.upstreamUrl);
  if (!urlValidation.valid) {
    throw new Error("配置校验失败: UPSTREAM_URL 值非法");
  }
  assignCandidateValue(candidate, "upstreamUrl", urlValidation.value);
  if (candidate.upstreamUrl !== "") {
    applyUpstreamUrl(candidate as unknown as Record<string, unknown>, candidate.upstreamUrl);
  }

  const candidateRecord = candidate as unknown as Record<string, unknown>;
  const badValues = collectFieldValueErrors(candidateRecord);
  if (badValues.length > 0) {
    throw new Error(`配置校验失败: ${badValues.join(", ")} 值非法`);
  }
  const badRange = collectIntRangeErrors(candidateRecord);
  if (badRange.length > 0) {
    throw new Error(`配置校验失败: ${badRange.join(", ")} 越界`);
  }

  // 资源内容不属于 store，但在跨字段鉴权判断前必须按 candidate 路径验证；
  // force 读取沿用现有 reader 的 last-good/fallback 语义，错误则拒绝本次提交。
  const usersRead = readAuthUsers({ force: true, path: candidate.authUsersFile });
  const aclRead = readAcl({ force: true, path: candidate.aclFile });
  const badFiles: string[] = [];
  if (usersRead.error !== undefined) {
    badFiles.push(`AUTH_USERS_FILE=${usersRead.path} ${usersRead.error}`);
  }
  if (aclRead.error !== undefined) {
    badFiles.push(`ACL_FILE=${aclRead.path} ${aclRead.error}`);
  }
  if (badFiles.length > 0) {
    throw new Error(`配置校验失败: ${badFiles.join("; ")}`);
  }

  assertAuthConfig({
    authEnabled: candidate.authEnabled,
    authType: candidate.authType,
    accountCount: usersRead.value.length,
    jwtSecret: candidate.jwtSecret,
  });

  return candidate;
}

/** force pull 的安全结果；不把 reader 返回的 users/ACL 值带到 runtime。 */
export interface ConfigResourceReadResult {
  readonly resource: ConfigResource;
  readonly path: string;
  readonly exists: boolean;
  readonly transition?: ConfigResourceTransition;
  readonly outcome?: ConfigResourceOutcome;
  readonly mtimeMs?: number;
  readonly size?: number;
  readonly error?: string;
}

function safeResourceError(value: unknown): string {
  return typeof value === "string" ? sanitizeJsonFileErrorText(value) : "未知错误";
}

/**
 * 强制 pull 一个配置资源并返回脱敏状态元数据。
 *
 * 读取仍完全委托 auth-users/acl 的 force 路径；这里只临时观察 resource
 * bridge 以保留本轮 transition/version，且在返回前取消订阅，不创建 watcher。
 */
export function refreshConfigResource(
  resource: ConfigResource,
  path: string,
): ConfigResourceReadResult {
  let observed: ConfigResourceEvent | undefined;
  const dispose = subscribeConfigResourceEvents((event) => {
    if (event.resource === resource && event.path === path) {
      observed = event;
    }
  }, resource);

  try {
    if (resource === "authUsers") {
      const read = readAuthUsers({ force: true, path });
      const error = read.error ?? observed?.error;
      return {
        resource,
        path: read.path,
        exists: read.exists,
        ...(error === undefined ? {} : { error: safeResourceError(error) }),
        ...(observed === undefined
          ? {}
          : { transition: observed.transition, outcome: observed.outcome }),
        ...(observed?.mtimeMs === undefined ? {} : { mtimeMs: observed.mtimeMs }),
        ...(observed?.size === undefined ? {} : { size: observed.size }),
      };
    }

    const read = readAcl({ force: true, path });
    const error = read.error ?? observed?.error;
    return {
      resource,
      path: read.path,
      exists: read.exists,
      ...(error === undefined ? {} : { error: safeResourceError(error) }),
      ...(observed === undefined
        ? {}
        : { transition: observed.transition, outcome: observed.outcome }),
      ...(observed?.mtimeMs === undefined ? {} : { mtimeMs: observed.mtimeMs }),
      ...(observed?.size === undefined ? {} : { size: observed.size }),
    };
  } catch (error) {
    // reader 当前设计为不抛；保留安全兜底，避免未来实现泄漏原始异常。
    return {
      resource,
      path,
      exists: false,
      error: safeResourceError(readErrorMessage(error)),
      ...(observed === undefined
        ? {}
        : { transition: observed.transition, outcome: observed.outcome }),
      ...(observed?.mtimeMs === undefined ? {} : { mtimeMs: observed.mtimeMs }),
      ...(observed?.size === undefined ? {} : { size: observed.size }),
    };
  } finally {
    dispose();
  }
}

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    try {
      const message = (error as { message?: unknown }).message;
      return typeof message === "string" ? message : "未知错误";
    } catch {
      return "未知错误";
    }
  }
  return "未知错误";
}

/**
 * 初始化全局配置：CLI > 终端 env > env 文件 > preset > 默认值
 * 显式给出的非法值（CLI/env 同源）、int 越界、账号/名单文件内容非法（users.json / acl.json）、
 * 以及 auth 交叉非法（启用 basic/uid 但账号表为空）
 * 一律抛错阻止启动，不做静默回退；幂等位仅在全部校验通过、store 写完后置位（失败后可重试且仍抛错）
 */
export function initConfig(): AppConfig {
  if (_inited) {
    return getAll();
  }

  const rawCli = parseRawArgv(process.argv.slice(2));

  // 先定 useHomeConfig（决定 env 目录；CLI > 终端 env）
  const homeRaw = rawCli[HOME_CONFIG_KEY] ?? process.env[HOME_CONFIG_KEY];
  // 值非法时先按 false 定位配置目录即可：下面的 FIELDS 循环会报错并终止启动
  const useHomeConfig = homeRaw === undefined ? false : (toBoolean(homeRaw) ?? false);

  loadEnvFiles(useHomeConfig);
  ensureConfigDir(useHomeConfig);
  const configDir = getConfigDir(useHomeConfig);

  // 解析循环抽在 fields.ts:resolveFieldEntries（与 parseStartupArgs 共用同一张表同一套判定）；
  // source 对每个字段恰好调用一次，顺带记录显式提供的 env（CLI 优先于 env）供 UPSTREAM_URL 覆盖告警比对
  const provided = new Set<string>();
  const { resolved, bad } = resolveFieldEntries((env) => {
    const raw = rawCli[env] ?? process.env[env];
    if (raw !== undefined) {
      provided.add(env);
    }
    return raw;
  });
  // 未提供（或解析失败——后者随即被下面的 bad 抛错中断，回落默认值无副作用）的字段回退 def / store 默认值
  for (const d of FIELDS) {
    if (d.key in resolved) {
      continue;
    }
    if (d.def !== undefined) {
      if (typeof d.def === "function") {
        resolved[d.key] = d.def(configDir);
      } else {
        resolved[d.key] = d.def;
      }
    } else {
      resolved[d.key] = defaults[d.key];
    }
  }
  if (bad.length) {
    throw new Error(`配置校验失败: ${bad.join(", ")} 非法`);
  }

  // 预设位于默认值之上、显式 CLI/env 之下；只通过 FIELDS 找对应字段，不另建合并表。
  const activePreset = resolved.preset as AppConfig["preset"];
  if (activePreset !== "") {
    const preset = resolvePreset(activePreset);
    for (const d of FIELDS) {
      if (provided.has(d.env)) {
        continue;
      }
      const value = preset.config[d.key];
      if (value !== undefined) {
        // 路径型字段的 preset 值与 FIELDS.def 一样，以当前配置目录为基准。
        resolved[d.key] =
          typeof value === "string" && typeof d.def === "function"
            ? path.resolve(configDir, value)
            : value;
      }
    }
  }

  // 上游标准 URL 整体覆盖拆项：配了 UPSTREAM_URL 时 granular 字段以它为准（已过 parseUpstreamUrl 校验）
  const upstreamUrlRaw = resolved.upstreamUrl as string;
  let clobbered: string[] = [];
  if (upstreamUrlRaw) {
    const before = new Map(Object.entries(resolved));
    applyUpstreamUrl(resolved, upstreamUrlRaw);
    // 显式提供了拆项、值又被 URL 改写：静默换值最难排查，收集起来等写库后再告警
    clobbered = FIELDS.filter(
      (d) => provided.has(d.env) && before.get(d.key) !== resolved[d.key],
    ).map((d) => d.env);
  }

  // 数值越界在此拦截（枚举已在表中由 parseEnum 保证合法）
  const badRange = collectIntRangeErrors(resolved);
  if (badRange.length) {
    throw new Error(`配置校验失败: ${badRange.join(", ")} 越界`);
  }

  // 账号表与访问控制名单来自独立 JSON 文件：启动期强制重读并校验内容，非法即 abort（不做静默降级）。
  // 此刻尚未写 store，故显式把解析出的路径传给读取器（其默认路径取自 store，会读到旧值）
  const usersRead = readAuthUsers({ force: true, path: resolved.authUsersFile as string });
  const aclRead = readAcl({ force: true, path: resolved.aclFile as string });
  const badFiles: string[] = [];
  if (usersRead.error) {
    badFiles.push(`AUTH_USERS_FILE=${usersRead.path} ${usersRead.error}`);
  }
  if (aclRead.error) {
    badFiles.push(`ACL_FILE=${aclRead.path} ${aclRead.error}`);
  }
  if (badFiles.length) {
    throw new Error(`配置校验失败: ${badFiles.join("; ")}`);
  }

  // 交叉字段校验（与 bad/badRange 同阶段、写 store 之前）：开启鉴权就必须真正能拦人，否则阻止启动
  assertAuthConfig({
    authEnabled: resolved.authEnabled as boolean,
    authType: resolved.authType as string,
    accountCount: usersRead.value.length,
    jwtSecret: resolved.jwtSecret as string,
  });

  // 所有校验通过后一次性提交完整快照；不让启动路径留下半批字段。
  commitConfig(resolved as unknown as AppConfig);

  // 全部解析/校验通过、store 已写：此刻置幂等位；此前任何一步抛错都不置位，
  // 从而首次失败后重试 initConfig() 会重跑并再次抛错，而非静默返回默认配置
  _inited = true;

  // 写库之后再告警：此刻 LOG_LEVEL/LOG_FILE 等已生效，告警不会绕过用户设定的等级
  if (clobbered.length) {
    logger.warn(`[config] UPSTREAM_URL 已设置，覆盖了同时提供的拆项: ${clobbered.join(", ")}`);
  }

  return getAll();
}

// 配置初始化由 CLI / 库入口显式调用；导入本模块不再产生配置 IO 副作用。
