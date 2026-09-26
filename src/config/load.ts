/**
 * 配置加载编排 - 启动期初始化 + runtime 候选准备
 *
 * 覆盖顺序：默认值 < preset < CLI / 终端环境变量 / env 文件
 *
 * 这里只做「编排」：按优先级把各来源喂给 `schema/` 的字段表，交叉校验，
 * 最后经 `store.commitConfig` 一次性提交。各来源怎么读在 `source/`，
 * 字段怎么解释在 `schema/`，JSON 资源怎么读在 `resources/`——本文件不含
 * 任何解析规则或路径推导规则。
 *
 * 两个入口服务于两个时机：
 * - `initConfig` 进程启动时读全部来源（CLI / 库公共入口显式调用，不靠 import 副作用）
 * - `prepareRuntimeConfig` runtime reload 用已有快照 + patch 构造新候选，绝不重读外部来源
 *
 * 本文件也是「安装热加载 notice 呈现」的副作用边界（见下方 side-effect import）：
 * `resources/notice.ts` 在模块加载时订阅资源总线一次，而总线本身不依赖 logger，
 * 所以订阅必须由这个编排入口显式接上——`resources/` 里的 reader 只负责桥事件，
 * 不能各自 import notice（那会让「唯一 notice 路径」退化成 N 条隐式依赖）。
 */

import path from "node:path";
import { logger } from "@/utils/log/logger.js";

// side-effect import：安装资源热加载的 notice 订阅（唯一日志路径）。
// 删掉它会让 cfg/*.json 的 error/missing/recovered/reloaded 四态日志静默消失。
import "./resources/notice.js";

import { commitConfig, getAll } from "./store.js";
import { defaults } from "./defaults.js";
import type { AppConfig, ConfigKey } from "./types.js";
import { FIELDS, getFieldDef, isConfigKey } from "./schema/fields.js";
import {
  collectFieldValueErrors,
  collectIntRangeErrors,
  resolveFieldEntries,
  validateFieldValue,
} from "./schema/validate.js";
import { assertAuthConfig } from "./schema/guards.js";
import { HOME_CONFIG_KEY, ensureConfigDir, getConfigDir } from "./source/dir.js";
import { loadEnvFiles } from "./source/env-file.js";
import { parseRawArgv } from "./source/argv.js";
import { parseBoolean } from "./schema/field.js";
import { readAcl } from "./resources/acl/reader.js";
import { readAuthUsers } from "./resources/users/reader.js";
import { applyUpstreamUrl } from "./upstream-url.js";
import { resolvePreset } from "./presets.js";

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
 * 复用 schema/ 的 parser/范围检查和 auth 跨字段守卫，最后 force 校验两个
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
  const useHomeConfig = homeRaw === undefined ? false : (parseBoolean(homeRaw) ?? false);

  loadEnvFiles(useHomeConfig);
  ensureConfigDir(useHomeConfig);
  const configDir = getConfigDir(useHomeConfig);

  // 解析循环抽在 schema/validate.ts:resolveFieldEntries（与 parseStartupArgs 共用同一张表同一套判定）；
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
    throw new Error(`配置校验失败: ${badFiles.join(", ")}`);
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
