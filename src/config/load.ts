/**
 * 唯一配置加载器：把显式 CLI/env/env 文件来源解析成一个 ConfigContext。
 *
 * 本模块 import 期零副作用：不读宿主 env/argv，不扫描文件，不写宿主环境。调用方必须
 * 显式传入数据源；只有所有解析与启动期校验成功后，才一次性 merge 到目标 ConfigStore。
 *
 * 编排顺序（每步只操作局部副本，全部成功后才落库）：
 * `sources/`（argv 归一 → argv 未知键闸门 → 定 configDir → 读 env 文件 → env 文件
 * 未知键闸门）→ `schema/`（解析 → def/defaults
 * → 范围校验 → 管理面交叉校验）→ `normalize/`（路径绝对化 → UPSTREAM_URL 拆项，只收集
 * warning）→ `files/`（账号表启动期强校验）+ `datasource/acl/`（名单驱动解析 + 启动期强校验）
 * → auth 交叉校验 → 唯一一次 `store.merge()` + `createConfigContext()`。
 *
 * 未知键闸门与「显式非法值不静默回退」是同一条原则：拼错的键静默回落缺省值 = 一次
 * 配置事故没有任何信号。判据与容忍名单都在本模块（`FIELDS` 与宿主快照只有这里同时可见）。
 */

import path from "node:path";
import { defaults, ConfigStore } from "./store.js";
import type { AppConfig, StoreDriver } from "./types.js";
import { createConfigContext, type ConfigContext, type ConfigSourceMetadata } from "./context.js";
import { aclSourceFor } from "@/datasource/acl/index.js";
import { accountLocatorFrom } from "./account-locator.js";
import { readAuthUsersAsyncStartup } from "@/datasource/users/index.js";
import { aclLocatorFrom } from "./acl-locator.js";
import { applyUpstreamUrlToConfig, resolveConfigPaths } from "./normalize/index.js";
import { HOME_CONFIG_KEY, getConfigDir, parseRawArgv, readEnvFiles } from "./sources/index.js";
import {
  FIELDS,
  assertAuthConfig,
  assertManagerConfig,
  collectIntRangeErrors,
  resolveFieldEntries,
  toBoolean,
} from "./schema/index.js";

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
 * 容忍名单：允许出现在 argv / env 文件里、但**不在 `FIELDS` 里**的键。
 *
 * 它不是第二张别名表（那由 `FIELDS` 的表头注释独占），只收「本应用自己在别处读、
 * 但它不是一个配置项」的键，因此每个成员都必须在本仓有唯一一处真实读取：
 * - `NODE_ENV` — `env-files.ts: defaultEnvFileNames` 用它选 `.env.<NODE_ENV>` 候选。
 * - `NO_COLOR` — `cli.ts` 从宿主快照里取出来显式传给 `runServer` 的 `noColor`。
 *
 * **不得扩大，也不得收入 `FIELDS` 已有的键**：多收一个键 = 多放行一类拼错，多放行一个
 * 拼错的键 = 它又静默回落缺省值。而收进一个 `FIELDS` 键更隐蔽：那份字段被删掉时名单会
 * **继续放行**它，把一次删除掩盖成「这键本来就合法」。
 *
 * ⚠️ `USE_HOME_CONFIG` **刻意不在**本名单，尽管 `loadConfig` 早于字段解析地单独读它
 * （`config-dir.ts: HOME_CONFIG_KEY`——configDir 必须在读 env 文件之前定下来）。
 * 「读取时机早」与「键名不合法」是两件事：闸门判的是后者，而 `useHomeConfig` 是
 * `FIELDS` 里的字段（`schema/fields.ts`），它的键名早已合法。
 */
const NON_CONFIG_ENV_KEYS: ReadonlySet<string> = new Set([
  "NODE_ENV",
  "NO_COLOR",
]);

/** 键名合法性的唯一判据 = `FIELDS` 的 env 名 + 容忍名单。 */
const KNOWN_ENV_KEYS: ReadonlySet<string> = new Set([
  ...FIELDS.map((f) => f.env),
  ...NON_CONFIG_ENV_KEYS,
]);

/** Levenshtein 编辑距离（键名都在 20 字符内，滚动两行 DP 足够，不引第三方依赖）。 */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * 猜最接近的合法键名；离得太远就返回 undefined——给错建议比不给更糟，运维会去改一个
 * 本来就对的键。门槛最多 2 且不超过两键较长者的一半（长键放宽到 2 足以覆盖「少打一个
 * 字符」与「前后串错一段」，再远就是另一个键而不是这个键写错了）。
 */
function suggestEnvKey(unknown: string): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of KNOWN_ENV_KEYS) {
    const d = editDistance(unknown, name);
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  const limit = Math.min(2, Math.floor(Math.max(unknown.length, best?.length ?? 0) / 2));
  return best !== undefined && bestDistance <= limit ? best : undefined;
}

/** 单个未知键的措辞：点名键 + 指名来源，近邻时附最接近的合法键（建议缺失就不提）。 */
function unknownKeyMessage(key: string, origin: string): string {
  const hint = suggestEnvKey(key);
  const suffix = hint === undefined ? "" : `，最接近的合法键是 ${hint}`;
  return `未知配置项 ${key}（来源：${origin}）${suffix}`;
}

/**
 * argv 与 env 文件里的未知键一律让启动失败。
 *
 * 判据是**键名本身**在不在 `KNOWN_ENV_KEYS` 里，不看这个键的值有没有被用上——落选的键
 * 今天拼错就静默回落 `defaults`，等于让一次配置事故没有任何信号：`--quota-ledger-driver`
 * 这种已删除的旧键照样起服务，实际跑的是缺省档。与「驱动名拼错必须让启动失败」同一条原则。
 *
 * ⚠️ 只查 argv 与 env 文件，**不查显式 `env` 入参**：宿主环境里有成千上万个与本应用无关的
 * 变量（`PATH` / `TEMP` / CI 的几十项），对它们 fail-fast 是纯噪音。判据的形状因此是
 * 「两个显式用户意图来源」，不是「所有键」。
 *
 * 抛错发生在任何 `store.merge()` 之前（调用点都在合并之前），所以失败不留半份配置。
 */
function assertKnownKeys(keys: Iterable<string>, originOf: (key: string) => string): void {
  const unknown = [...keys].filter((key) => !KNOWN_ENV_KEYS.has(key));
  if (!unknown.length) {
    return;
  }
  const detail = unknown.map((key) => unknownKeyMessage(key, originOf(key))).join("; ");
  throw new Error(`配置校验失败: ${detail}`);
}

/**
 * 优先级固定为 CLI > 显式 env > env 文件（输入顺序，后者覆盖前者）> defaults。
 * env 文件相对路径相对最终 configDir 解析，绝对路径原样使用；缺失文件跳过，其它
 * 读取/解析错误拒绝。argv 与 env 文件里的未知键拒绝（显式 `env` 入参不查，宿主环境
 * 的无关变量不是配置错误）。所有校验成功后才执行一次 `store.merge`，所以失败不会留下
 * 半份配置，也不会改变传入的 env 或宿主 process env。
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ConfigContext> {
  const env = { ...(options.env ?? {}) };
  const envFiles = [...(options.envFiles ?? [])];
  const argv = [...(options.argv ?? [])];
  const store = options.store ?? new ConfigStore();
  const rawCli = parseRawArgv(argv);
  assertKnownKeys(Object.keys(rawCli), () => "CLI 参数");

  // useHomeConfig 必须在 env 文件读取前决定：home 模式固定使用 ~/.proxy，其它模式
  // 使用显式 cwd 或进程 cwd；绝不创建目录。
  const homeRaw = rawCli[HOME_CONFIG_KEY] ?? env[HOME_CONFIG_KEY];
  const useHomeConfig = homeRaw === undefined ? false : (toBoolean(homeRaw) ?? false);
  const configDir = getConfigDir(useHomeConfig, options.cwd);
  const envFilePaths = resolveEnvFilePaths(envFiles, configDir);
  const { merged: mergedEnv, fileOrigins } = await readEnvFiles(envFilePaths, env);
  assertKnownKeys(
    fileOrigins.keys(),
    (key) => `env 文件 ${fileOrigins.get(key) ?? ""}`,
  );

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

  // 管理面交叉校验：**刻意排在文件读取之前、且不受 skipFileValidation 管辖**——那一位开关
  // 跳过的是 users.json / acl.json 的启动期读取，而「端口撞车 / 空 token」是纯标量判据，
  // 没有任何读盘依据可依赖。skip 掉它等于让该选项把配置校验整段绕开。
  assertManagerConfig({
    port: resolved.port as number,
    managerEnabled: resolved.managerEnabled as boolean,
    managerPort: resolved.managerPort as number,
    managerToken: resolved.managerToken as string,
    managerCorsOrigins: resolved.managerCorsOrigins as string,
  });

  // 启动期 JSON 校验走直接异步读取：不使用热加载缓存，也不触发 json-file-log。
  if (!(options.skipFileValidation ?? false)) {
    // ⚠️ **解析驱动在这一行、在读之前**：未注册的驱动名必须让启动失败，且错误信息列出全部
    // 已注册项。放在读之后的话「驱动名拼错」会退化成「名单文件缺失 = 空名单 = 静默放行」——
    // 那是一次配置事故变成一次安全事故，且没有任何信号。判据是注册表这个运行时事实，
    // 故它落在装配点（这里）而不是字段解析层。
    const aclDriver = resolved.aclDriver as string;
    const aclSource = aclSourceFor(
      aclLocatorFrom(aclDriver, resolved.aclFile as string),
    );
    const [usersRead, aclRead] = await Promise.all([
      readAuthUsersAsyncStartup(
        resolved.authUsersDriver as StoreDriver,
        accountLocatorFrom(
          resolved.authUsersDriver as StoreDriver,
          resolved.authUsersFile as string,
          resolved.authUsersDb as string,
        ).pathFor,
      ),
      aclSource.readStartup(),
    ]);
    const badFiles: string[] = [];
    if (usersRead.error) {
      // 报错文案点名**实际生效的那个路径**：驱动是 sqlite 时 `AUTH_USERS_FILE` 根本没被读，
      // 报它等于让运维去查一个无关文件。键名也跟着驱动走（`AUTH_USERS_DB` / `AUTH_USERS_FILE`）。
      const driver = resolved.authUsersDriver as StoreDriver;
      const usersKey = driver === "sqlite" ? "AUTH_USERS_DB" : "AUTH_USERS_FILE";
      badFiles.push(`${usersKey}=${usersRead.path} ${usersRead.error}`);
    }
    if (aclRead.error) {
      // 键名跟着驱动走：非 `json` 档时 `ACL_FILE` 根本没被读，报它等于把运维指去查一个无关文件。
      badFiles.push(`${aclDriver === "json" ? "ACL_FILE" : `ACL_DRIVER=${aclDriver}`}=${aclRead.path} ${aclRead.error}`);
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
      usersDriver: resolved.authUsersDriver as string,
    });
  }

  // 原子落库：此前任何读取、解析或交叉校验失败都不会触发 merge。
  store.merge(resolved as unknown as Partial<AppConfig>);

  const sources: ConfigSourceMetadata = {
    envKeys: Object.keys(env),
    envFiles: envFilePaths,
    argvKeys: Object.keys(rawCli),
    // 本层算出来的归属此前只用在未知键报错上、算完即丢。「某键来自哪个文件」这件事**只能**
    // 从 `readEnvFiles` 取（重读文件会与合并结果漂移，见该函数的注释），而它对「这份配置
    // 到底怎么拼出来的」这个问题是唯一的真相源 —— 丢了就再也拿不回来。
    fileOrigins,
  };
  return createConfigContext({
    store,
    configDir,
    sources,
    warnings,
  });
}
