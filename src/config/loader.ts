/**
 * CLI 配置初始化 - **带 import 期副作用，仅 CLI 路径可引**
 * 覆盖顺序：CLI > 终端环境变量 > env 文件 > 默认值
 * 设计：表驱动（FIELDS 描述全部字段），CLI 解析、env 合并、
 * store 写入、快照返回均由表自动生成；
 * 新增配置只需 store.ts 加字段 + fields.ts 表加一行，杜绝多处手工同步漂移
 *
 * ⚠️ 职责边界（勿回退）：
 * - 本文件底部有 `initConfig()` **自执行**：import 本文件即读 `.env`、校验 users/acl、写全局 store。
 *   因此**只有 `src/cli.ts` 可以 import 它**；库入口 `src/index.ts` 与 `src/server/**` 一律不许。
 * - 库模式要显式加载配置，请引 `./load.js` 的 `loadConfig()`（零 import 期副作用，落调用方自己的 store）。
 * - `keysByPhase` 等纯表工具请直接从 `./fields.js` 引，不要经由本文件（会把上面那颗雷拖进来）。
 */

import { config, getAll, defaults, type AppConfig, type ConfigKey } from "./store.js";
import { readAuthUsers } from "./auth-users.js";
import { readAcl } from "./acl.js";
import { logger } from "@/utils/logger.js";
import { applyUpstreamUrl } from "@/utils/upstream-url.js";
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
  collectIntRangeErrors,
  assertAuthConfig,
  resolveFieldEntries,
} from "./fields.js";

// ── 重导出：保持原有 import 路径兼容 ──
export { keysByPhase } from "./fields.js";
export { parseStartupArgs } from "./fields.js";
export { assertAuthConfig } from "./fields.js";

/**
 * `loadConfig` 住在 `./load.js`（零 import 期副作用），此处仅为兼容既有 import 路径转发。
 * **库入口 `src/index.ts` 必须直接引 `./config/load.js`**，不许引本文件——
 * 本文件底部有 `initConfig()` 自执行，静态引入它会把 CLI 副作用拖进库入口。
 */
export { loadConfig } from "./load.js";
export type { LoadConfigOptions, LoadedConfig } from "./load.js";

/** 初始化幂等标记：模块加载时执行一次，重复调用直接返回快照 */
let _inited = false;

/**
 * 初始化全局配置：CLI > env 文件 > 终端 > 默认值
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

  for (const d of FIELDS) {
    config.set(d.key, resolved[d.key] as AppConfig[ConfigKey]);
  }

  // 全部解析/校验通过、store 已写：此刻置幂等位；此前任何一步抛错都不置位，
  // 从而首次失败后重试 initConfig() 会重跑并再次抛错，而非静默返回默认配置
  _inited = true;

  // 写库之后再告警：此刻 LOG_LEVEL/LOG_FILE 等已生效，告警不会绕过用户设定的等级
  if (clobbered.length) {
    logger.warn(`[config] UPSTREAM_URL 已设置，覆盖了同时提供的拆项: ${clobbered.join(", ")}`);
  }

  return getAll();
}


// import 即初始化：坏配置直接 throw、无降级，调用方（测试/孤立 import store）需 try/catch 或显式 initConfig()
initConfig();
