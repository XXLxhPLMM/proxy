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
 * 本文件**不**装任何订阅：`resources/notice.ts` 的 notice 订阅是**每实例**显式创建
 * 的（`src/instance.ts` 调 `subscribeConfigNotices`），它需要一个已就绪的实例 scope
 * 与实例 Logger——而 `initConfig()` 这一刻连 scope 都还没产出。`initConfig()` 强制读
 * users/ACL 时产生的四态事件因此无人呈现（致命错误另有 CLI 兜底），这正是「读外部
 * 来源」与「实例装配」必须分两段的原因。
 *
 * 进程级与实例级的边界：读外部来源（env 文件 / 进程 argv / preset 目录）天然是
 * 进程级的一次性动作，但**产物是实例级的**——`initConfig()` 返回一个全新的
 * `ConfigScope`，不写任何模块级单例。同进程起 N 个实例就调用 N 次，各自持有
 * 互不可见的配置。
 */

import path from "node:path";
import { createInstanceLogger } from "@/utils/log/logger.js";

import { createConfigScope, type ConfigScope } from "./scope.js";
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

/** 将已校验的 unknown 值写进 candidate；只通过明确的 ConfigKey 访问。 */
function assignCandidateValue(candidate: AppConfig, key: ConfigKey, value: unknown): void {
  (candidate as unknown as Record<string, unknown>)[key] = value;
}

/**
 * 准备一次 runtime 配置候选，不读取 env、CLI、preset，也不写 store。
 *
 * 这是 `ConfigProvider.reload(patch)` 唯一的配置语义入口（契约
 * `src/plugins/contracts.ts`，实现 `src/instance.ts:createInstanceConfigProvider`，
 * 库消费方经 `instance.reload(patch)` 触达）：先拒绝 startup 字段，再
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
 * `initConfig` 的输入：唯一目的是让**库调用方**能切断 argv 误读。
 */
export interface InitConfigOptions {
  /**
   * CLI 参数来源，默认 `process.argv.slice(2)`。
   * 库调用方**必须**显式传 `[]` 或自己的参数数组：否则宿主进程（如某个 web
   * 服务器）的 argv 会被当成代理配置解析，`--port 3000` 之类会静默改掉实例配置。
   */
  argv?: string[];
}

/**
 * 读取全部外部来源并返回一个**全新的实例配置作用域**：CLI > 终端 env > env 文件 > preset > 默认值
 *
 * 显式给出的非法值（CLI/env 同源）、int 越界、账号/名单文件内容非法（users.json / acl.json）、
 * 以及 auth 交叉非法（启用 basic/uid 但账号表为空）
 * 一律抛错阻止启动，不做静默回退；任何一步抛错都**不会**产出 scope，调用方重试会重跑整条链。
 *
 * 无幂等位：每次调用产出一个独立 scope，同进程可持有任意多个互不可见的实例配置。
 * env 文件重复加载是安全的（`loadEnvFiles` 规定终端已设变量永不覆盖）。
 *
 * @returns 只属于本次调用的配置作用域；调用方负责把它交给实例组合根
 */
export function initConfig(options?: InitConfigOptions): ConfigScope {
  const rawCli = parseRawArgv(options?.argv ?? process.argv.slice(2));

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

  // 全部解析/校验通过后才构造 scope：此前任何一步抛错都不会留下半批字段的实例配置。
  const scope = createConfigScope(resolved as unknown as AppConfig);

  // 构造之后再告警：此刻本实例的 LOG_LEVEL/LOG_FILE 已生效，告警不会绕过用户设定的等级
  // 走实例 scope（而不是进程级门面）：这条告警描述的就是**本次调用**解析出来的
  // 拆项被覆盖，多实例时各实例应各按自己的等级与落盘路径提示，而不是互相串。
  if (clobbered.length) {
    createInstanceLogger(scope).warn(
      `[config] UPSTREAM_URL 已设置，覆盖了同时提供的拆项: ${clobbered.join(", ")}`,
    );
  }

  return scope;
}

// 配置初始化由 CLI / 库入口显式调用；导入本模块不再产生配置 IO 副作用。
