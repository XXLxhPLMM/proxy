/**
 * 显式配置加载（库模式） - 零 import 期副作用
 * 职责：把「配置从哪来、落到哪去」整体交给调用方
 * 设计：
 * - 本模块**绝不**在 import 期做任何事（不读 env / argv / 文件、不写 process.env、不碰全局单例），
 *   因此库入口 `src/index.ts` 可以静态 re-export 它而不引入 CLI 初始化副作用
 * - 与 `initConfig`（`./loader.ts`，CLI 专用、仅显式调用）**共用同一张 FIELDS 表、同一套
 *   解析/校验/抛错口径**，差别只在数据源与落点
 * - 落点是调用方给的（或新建的）`ConfigStore`，绝不写全局 `config` Map
 *
 * 反面教材（勿回退）：曾把 `loadConfig` 放在 `loader.ts` 里，导致库入口不得不与 CLI
 * 初始化模块耦合。配置加载必须由调用方显式调用，且库模式只能落进调用方自己的 store。
 */

import { defaults, ConfigStore, type AppConfig, type ConfigKey } from "./store.js";
import { readAuthUsers } from "./auth-users.js";
import { readAcl } from "./acl.js";
import { logger } from "@/utils/logger.js";
import { applyUpstreamUrl } from "@/utils/upstream-url.js";
import {
  getConfigDir,
  ensureConfigDir,
  parseRawArgv,
  readEnvFileOverrides,
  toBoolean,
  HOME_CONFIG_KEY,
} from "./config-helpers.js";
import {
  FIELDS,
  collectIntRangeErrors,
  assertAuthConfig,
  resolveFieldEntries,
  keysByPhase,
} from "./fields.js";

/**
 * `loadConfig` 的显式入参：把「配置从哪来」整体交给调用方
 * （CLI 模式由终端/环境文件决定，见 `initConfig`；库模式不该读宿主进程的环境）
 */
export interface LoadConfigOptions {
  /** 显式 env 源（其 NODE_ENV 也决定 `.env.<NODE_ENV>` 候选名），缺省 process.env */
  env?: Record<string, string | undefined>;
  /** 显式 CLI argv（不含 node 与脚本路径），缺省 [] */
  argv?: readonly string[];
  /** 显式配置目录根；缺省按 useHomeConfig 推导。显式给出时代建目录、且不再推导（目录归调用方） */
  cwd?: string;
  /** 目标 store；缺省新建一个 ConfigStore */
  store?: ConfigStore;
  /**
   * 是否把 env 文件里的值写进 process.env。
   * 缺省 true（保持 CLI 现有行为）；**库调用方必须传 false** 以免污染宿主进程
   */
  writeProcessEnv?: boolean;
  /**
   * 是否跳过 cfg/users.json / cfg/acl.json 的启动期强制校验；缺省 false（保持现有 fail-fast）。
   * 跳过时也一并跳过依赖账号数的 `assertAuthConfig`（账号数只能来自该文件），
   * 鉴权组合的合法性由调用方自行保证
   */
  skipFileValidation?: boolean;
}

/** `loadConfig` 的返回值：目标 store + 生效的目录/相位信息 */
export interface LoadedConfig {
  /** 已被灌入解析结果的目标 store（与传入的同一实例） */
  store: ConfigStore;
  /** 本次生效的配置目录根（各路径类字段的默认值基于它解析成绝对路径） */
  configDir: string;
  /** 实际生效的启动相位键（改了要重启进程，机器可读源同 fields.ts:keysByPhase） */
  startupKeys: ConfigKey[];
}

/**
 * 显式加载配置到目标 store（库模式入口）
 * @description 与 `initConfig` 同一张 FIELDS 表、同一套解析/校验/抛错口径，差别只在**数据源与落点**：
 * - 不碰全局单例 `config`：`get()`/`set()` 读到的仍是 CLI 那份配置
 * - 不隐式改 `process.env`（`writeProcessEnv: false` 时 env 文件只参与本次解析）
 * - 值落进调用方给的（或新建的）`ConfigStore`，多份配置可并存
 * @param options - 显式数据源与落点，见 `LoadConfigOptions`
 * @returns 目标 store、配置目录与启动相位键
 * @throws 配置非法（显式值解析失败 / int 越界 / users.json·acl.json 内容非法 / 鉴权交叉非法）时抛错，绝不静默回退默认值
 * @example
 * const { store } = loadConfig({ env: { PORT: "8080" }, argv: [], writeProcessEnv: false });
 * store.get("port"); // => 8080，process.env 与全局 get("port") 均未受影响
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const store = options.store ?? new ConfigStore();
  const baseEnv = options.env ?? process.env;
  const rawCli = parseRawArgv([...(options.argv ?? [])]);

  // 先定 useHomeConfig（决定 env 目录；CLI > 终端 env，与 initConfig 同一优先级与同一容错口径）
  const homeRaw = rawCli[HOME_CONFIG_KEY] ?? baseEnv[HOME_CONFIG_KEY];
  // 值非法时先按 false 定位配置目录即可：下面的 FIELDS 循环会报错并终止
  const useHomeConfig = homeRaw === undefined ? false : (toBoolean(homeRaw) ?? false);

  // 显式 cwd 即配置目录根（目录归调用方，不代建）；缺省沿用现有推导并在缺失时创建
  if (options.cwd === undefined) {
    ensureConfigDir(useHomeConfig);
  }
  const configDir = options.cwd ?? getConfigDir(useHomeConfig);

  // env 文件增量：终端/显式 env 源里已有的键不被覆盖（与 dotenv / CLI 同款）
  const fileEnv = readEnvFileOverrides(configDir, baseEnv);
  if (options.writeProcessEnv ?? true) {
    for (const [k, v] of Object.entries(fileEnv)) {
      process.env[k] = v;
    }
  }
  const envOf = (name: string): string | undefined => baseEnv[name] ?? fileEnv[name];

  // 解析循环抽在 fields.ts:resolveFieldEntries（与 initConfig 共用同一张表同一套判定）
  const provided = new Set<string>();
  const { resolved, bad } = resolveFieldEntries((env) => {
    const raw = rawCli[env] ?? envOf(env);
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

  // 账号表与访问控制名单的启动期强校验：内容非法即抛，不做静默降级；
  // 此刻尚未写 store，故显式把解析出的路径传给读取器（其默认路径取自全局 store，会读到 CLI 那份）
  if (!(options.skipFileValidation ?? false)) {
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

    // 交叉字段校验（与 bad/badRange 同阶段、写 store 之前）：开启鉴权就必须真正能拦人
    assertAuthConfig({
      authEnabled: resolved.authEnabled as boolean,
      authType: resolved.authType as string,
      accountCount: usersRead.value.length,
      jwtSecret: resolved.jwtSecret as string,
    });
  }

  // 全部校验通过才落库，失败不留半份配置；merge 只在值真变时通知订阅者
  store.merge(resolved as unknown as Partial<AppConfig>);

  // 写库之后再告警：与 initConfig 同一口径（此刻等级相关配置已生效，告警不会绕过用户设定）
  if (clobbered.length) {
    logger.warn(`[config] UPSTREAM_URL 已设置，覆盖了同时提供的拆项: ${clobbered.join(", ")}`);
  }

  return { store, configDir, startupKeys: keysByPhase().startup };
}
