/**
 * 唯一配置加载器：把显式 CLI/env/env 文件来源解析成一个 ConfigContext。
 *
 * 本模块 import 期零副作用：不读宿主 env/argv，不扫描文件，不写宿主环境。调用方必须
 * 显式传入数据源；只有所有解析与启动期校验成功后，才一次性 merge 到目标 ConfigStore。
 */

import path from "node:path";
import { defaults, ConfigStore, type AppConfig } from "./store.js";
import { createConfigContext, type ConfigContext, type ConfigSourceMetadata } from "./accessor.js";
import { readAuthUsersAsync } from "./auth-users.js";
import { readAclAsync } from "./acl.js";
import { applyUpstreamUrlToConfig, resolveConfigPaths } from "./runtime-config.js";
import {
  getConfigDir,
  parseRawArgv,
  readEnvFiles,
  toBoolean,
  HOME_CONFIG_KEY,
} from "./config-helpers.js";
import {
  FIELDS,
  collectIntRangeErrors,
  assertAuthConfig,
  resolveFieldEntries,
} from "./fields.js";

/** `loadConfig` 的全部显式入参；未提供的数据源均为空，不从宿主进程猜测。 */
export interface LoadConfigOptions {
  /** 显式环境变量源；缺省为空对象。 */
  env?: Readonly<Record<string, string | undefined>>;
  /** 显式 env 文件列表；缺省为空数组，不会自动生成或扫描候选文件。 */
  envFiles?: readonly string[];
  /** 显式 CLI argv；缺省为空数组。 */
  argv?: readonly string[];
  /** 非 home 模式下的配置目录；缺省使用进程 cwd。 */
  cwd?: string;
  /** 目标 store；缺省新建一个。 */
  store?: ConfigStore;
  /** 是否跳过 users.json/acl.json 启动期强校验；缺省 false。 */
  skipFileValidation?: boolean;
}

function resolveEnvFilePaths(files: readonly string[], configDir: string): string[] {
  return files.map((file) => (path.isAbsolute(file) ? file : path.resolve(configDir, file)));
}

/**
 * 加载配置并返回上下文。
 *
 * 优先级固定为 CLI > 显式 env > env 文件（输入顺序，后者覆盖前者）> defaults。
 * env 文件相对路径相对最终 configDir 解析，绝对路径原样使用；缺失文件跳过，其它
 * 读取/解析错误拒绝。所有校验成功后才执行一次 `store.merge`，所以失败不会留下半份
 * 配置，也不会改变传入的 env 或宿主 process env。
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ConfigContext> {
  const env = { ...(options.env ?? {}) };
  const envFiles = [...(options.envFiles ?? [])];
  const argv = [...(options.argv ?? [])];
  const store = options.store ?? new ConfigStore();
  const rawCli = parseRawArgv(argv);

  // useHomeConfig 必须在 env 文件读取前决定：home 模式固定使用 ~/.proxy，其它模式
  // 使用显式 cwd 或进程 cwd；绝不创建目录。
  const homeRaw = rawCli[HOME_CONFIG_KEY] ?? env[HOME_CONFIG_KEY];
  const useHomeConfig = homeRaw === undefined ? false : (toBoolean(homeRaw) ?? false);
  const configDir = getConfigDir(useHomeConfig, options.cwd);
  const envFilePaths = resolveEnvFilePaths(envFiles, configDir);
  const mergedEnv = await readEnvFiles(envFilePaths, env);

  // source 对每个字段恰好取一次；CLI 值优先，显式 env 次之，env 文件再次。
  const provided = new Set<string>();
  const { resolved: parsed, bad } = resolveFieldEntries((name) => {
    const raw = rawCli[name] ?? mergedEnv[name];
    if (raw !== undefined) {
      provided.add(name);
    }
    return raw;
  });

  // 未提供字段回退 def / defaults；此时仍只操作局部 resolved，不会触碰 store。
  let resolved = parsed;
  for (const d of FIELDS) {
    if (d.key in resolved) {
      continue;
    }
    if (d.def !== undefined) {
      resolved[d.key] = typeof d.def === "function" ? d.def(configDir) : d.def;
    } else {
      resolved[d.key] = defaults[d.key];
    }
  }

  // 所有字段（包括显式 env 的相对路径）先走与 runtime/context 相同的路径归一化，
  // 后续范围校验、URL 覆盖与启动期 JSON 读取都只看到最终绝对路径。
  resolved = resolveConfigPaths(resolved, configDir);
  if (bad.length) {
    throw new Error(`配置校验失败: ${bad.join(", ")} 非法`);
  }

  // UPSTREAM_URL 覆盖拆项时只收集警告，不在配置层直接写日志；调用方决定如何呈现。
  const warnings: string[] = [];
  const upstreamUrlRaw = resolved.upstreamUrl as string;
  if (upstreamUrlRaw) {
    warnings.push(...applyUpstreamUrlToConfig(resolved, upstreamUrlRaw, provided));
  }

  const badRange = collectIntRangeErrors(resolved);
  if (badRange.length) {
    throw new Error(`配置校验失败: ${badRange.join(", ")} 越界`);
  }

  // 启动期 JSON 校验走直接异步读取：不使用热加载缓存，也不触发 json-file-log。
  if (!(options.skipFileValidation ?? false)) {
    const [usersRead, aclRead] = await Promise.all([
      readAuthUsersAsync(resolved.authUsersFile as string),
      readAclAsync(resolved.aclFile as string),
    ]);
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

    // 账号数只能来自启动期读取结果；skipFileValidation 时整段跳过，避免伪造校验依据。
    assertAuthConfig({
      authEnabled: resolved.authEnabled as boolean,
      authType: resolved.authType as string,
      accountCount: usersRead.value.length,
      jwtSecret: resolved.jwtSecret as string,
    });
  }

  // 原子落库：此前任何读取、解析或交叉校验失败都不会触发 merge。
  store.merge(resolved as unknown as Partial<AppConfig>);

  const sources: ConfigSourceMetadata = {
    envKeys: Object.keys(env),
    envFiles: envFilePaths,
    argvKeys: Object.keys(rawCli),
  };
  return createConfigContext({
    store,
    configDir,
    sources,
    warnings,
  });
}
