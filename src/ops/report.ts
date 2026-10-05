/**
 * @fileoverview 此刻**正在操作哪三份数据** —— 只给事实，不给排版
 * @module ops/report
 * @description
 * 「按 env 文件决定操作哪个数据源」这件事**必须可核对**：一条命令改的是哪份文件、哪个库，
 * 不该靠「我以为 `.env` 里是这么写的」。所以本模块把三份数据的**驱动名 + 解析后的绝对路径**
 * 原样取出来——路径是 `resolveConfigPaths` 归一之后的最终值，而不是 env 文件里那个相对串。
 *
 * 它取的是**接线**（`accountLocatorFor` / `aclLocatorFor` 现取的那两个闭包），与代理运行时
 * 用的是同一份接线对象。**未注册的驱动在这一步就会抛错**（注册表判据，fail-fast）——那正是
 * 「以为接上了数据库、实际读的是 users.json」这件事唯一能提前暴露的地方。
 *
 * ## 为什么这里只出**结构化字段**而不是「一行行给人看的键值」
 *
 * 键名、顺序、缩进、`驱动 X → Y` 那串模板全归渲染层：本层一旦开始排版，它就绑死在某一个界面上，
 * 而这些事实（配置目录 / 读到的 env 文件 / 三份数据的驱动与路径 / 鉴权 / 窗口口径 / 落盘周期）
 * 恰恰是所有界面都要的同一份。分开之后，「换个界面重打一遍这几行」不再是一次「顺手改」。
 *
 * @module
 */

import { quotaWindow, type QuotaWindow } from "@/datasource/quota/index.js";
import { FIELDS, type AuthType, type ConfigKey } from "@/config/index.js";
import type { OpsSources } from "./sources.js";

/** 一份数据「哪个驱动、落在哪」 */
export interface OpsDataRef {
  /** 驱动名（注册表判据；未注册驱动在这一步就抛错） */
  readonly driver: string;
  /** **解析后的绝对路径**，不是配置文件里那个相对串 */
  readonly path: string;
}

/** 账本的位置 —— ⚠️ 只有目录，没有文件名（理由见 {@link OpsConfigReport.usage}） */
export interface OpsUsageRef {
  readonly driver: string;
  /** 账本所在目录 */
  readonly dir: string;
}

/** 「此刻操作的是哪几份数据」这份报告的全部事实 */
export interface OpsConfigReport {
  /** 配置目录锚点 */
  readonly configDir: string;
  /** 实际读到的那几个 env 文件（可能为空） */
  readonly envFiles: readonly string[];
  readonly accounts: OpsDataRef;
  readonly acl: OpsDataRef;
  /**
   * ⚠️ **这里只给目录，不给文件名**：文件名的算法住在两个数据源实现器里
   * （`usageDbFileName` / `sharedUsageFileName`），而本层**不造**那个数据源（造它会带上一整套
   * 规格闭包，而这份报告要的只是路径）。要确切文件名就跑一次读账本的命令——那条命令会真的造出
   * 数据源，而账本构造期就纯算出了 `file`。
   *
   * 这条限制是刻意的：为了多打一行而在报告里造一个数据源，等于让「看一眼配置」这个**无副作用**
   * 的动作变成「可能建出一个账本文件」。**字段名叫 `dir` 而不是 `path` 就是这条约束在类型上的
   * 牙齿**——想把它变成一个文件路径，必须先在这里造一个数据源，而那一眼就能看出代价。
   */
  readonly usage: OpsUsageRef;
  readonly auth: { readonly enabled: boolean; readonly type: AuthType };
  /** 配额重置小时（**本地时区**口径） */
  readonly quotaResetHour: number;
  /** 账号没配 `quota.window` 时生效的缺省窗口 */
  readonly defaultQuotaWindow: QuotaWindow;
  /** 账本落盘周期（毫秒）；镜像误差上界是它的两倍 */
  readonly flushIntervalMs: number;
}

/** 装配出这份报告（**只读配置与接线，不造任何数据源**） */
export function reportConfig(sources: OpsSources): OpsConfigReport {
  const config = sources.config;
  const accountsLocator = sources.accountsLocator;
  const usersDriver = accountsLocator.driver();

  return {
    configDir: sources.context.configDir,
    envFiles: sources.context.sources.envFiles,
    accounts: { driver: usersDriver, path: accountsLocator.pathFor(usersDriver) },
    acl: { driver: sources.acl.driver, path: sources.acl.locator() },
    usage: { driver: config.get("quotaUsageDriver"), dir: config.get("quotaUsageDir") },
    auth: { enabled: config.get("authEnabled"), type: config.get("authType") },
    quotaResetHour: config.get("quotaResetHour"),
    defaultQuotaWindow: quotaWindow(undefined),
    flushIntervalMs: config.get("quotaFlushInterval"),
  };
}

/** 一个配置键的**相位**：与 `FieldDef.phase` 同名同义（startup = 改完要重启进程） */
export type OpsConfigPhase = "startup" | "runtime";

/** 一条配置键的完整事实（传输层排版 / 渲染成表格或 JSON 的原料） */
export interface OpsConfigEntry {
  /** store 键名（`AppConfig` 字段名） */
  readonly key: ConfigKey;
  /** env 名（`FIELDS` 的唯一真相源，本模块不另起别名表） */
  readonly env: string;
  /** 生效时机 */
  readonly phase: OpsConfigPhase;
  /** 该键是否属于必须打码的那几档（见 `CONFIG_SECRET_KEYS`） */
  readonly secret: boolean;
  /** 生效值。**`secret` 为真时是打码后的值**（`"***"` / 掩掉 userinfo 的 URL），
   * 永不是明文——脱敏判据只有 `CONFIG_SECRET_KEYS` 一份。 */
  readonly value: unknown;
  /** 该键的值来自哪个 env 文件；**不在任何文件里**（来自宿主 env / CLI / 缺省）时为 undefined */
  readonly fileOrigin: string | undefined;
  /** 该键是否被宿主 env 显式给出（`ConfigSourceMetadata.envKeys`） */
  readonly fromEnv: boolean;
  /** 该键是否被 CLI argv 显式给出（`ConfigSourceMetadata.argvKeys`） */
  readonly fromArgv: boolean;
}

/** 一次「全量配置 + 逐键事实」的读面 */
export interface OpsConfigSnapshot {
  /** 加载时的配置目录锚点 */
  readonly configDir: string;
  /** 候选 env 文件（绝对路径，含不存在的——「不在列表里」才是「没读」的事实） */
  readonly envFiles: readonly string[];
  /** 逐键事实，**按 `FIELDS` 的声明顺序**（顺序是数据，不是界面的选择） */
  readonly keys: readonly OpsConfigEntry[];
}

/**
 * 必须打码的配置键（**唯一**一份清单）
 * @description
 * 与 `src/server/log/config-log.ts` 的启动快照脱敏是**同一条判据**：那份把
 * `jwtSecret` / `tlsPassphrase` / `upstreamPassword` / `managerToken` 四项替换成 `***`
 * （空串保持空串），并把 `upstreamUrl` 里的 userinfo 换成 `//***@`。
 * ⚠️ **不许在传输层另起一份**：`logConfig` 的「快照整份进 debug 落盘」与 HTTP 的
 * `GET /api/config` 是**两个读者、同一份秘密**；清单漂了的后果是一处打码一处明文。
 * 护栏：`tests/unit/manager/http/endpoints.test.ts` 断言这份清单与 `logConfig` 的脱敏字段**逐键相同**。
 */
const CONFIG_SECRET_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  "jwtSecret",
  "tlsPassphrase",
  "upstreamPassword",
  "managerToken",
]);

/**
 * 某个配置值的打码形态
 * @description
 * **空串保持空串**（不是 `***`）：`""` 与 `"***"` 表达两种不同的事实——「没配」与
 * 「配了但不给你看」。把它们渲染成同一个值，等于让运维看不出「我配的那个 token 到底有没有
 * 被读进来」（`logConfig` 的启动快照是同一条纪律，见 `tests/unit/manager/config/snapshot.test.ts`）。
 *
 * `upstreamUrl` 不在 {@link CONFIG_SECRET_KEYS} 里（它是路径不是秘密），但它可以带
 * userinfo（`scheme://user:pass@host`），故对它另做一次掩码而不是整项打码。
 *
 * @param key - 配置键
 * @param value - 原始值
 * @returns 打码后的值；非密钥键原样返回
 * @example redactConfigValue("managerToken", "") // => ""
 * @example redactConfigValue("managerToken", "s3cr3t") // => "***"
 * @example redactConfigValue("upstreamUrl", "http://u:p@h:8080") // => "http://***@h:8080"
 */
export function redactConfigValue(key: ConfigKey, value: unknown): unknown {
  if (key === "upstreamUrl" && typeof value === "string") {
    return value.replace(/\/\/[^@/]*@/, "//***@");
  }
  if (!CONFIG_SECRET_KEYS.has(key)) {
    return value;
  }
  return value === "" ? "" : "***";
}

/**
 * 读一次**全量配置**并逐键给出相位 / 打码值 / 来源
 * @description
 * `fileOrigins`（「某键来自哪个 env 文件」）这件事**只能从 `readEnvFiles` 取**（见
 * `@/config/sources/env-files.ts` 的注释：调用方自行重读文件会与合并结果漂移）。而
 * `loadConfig` 把它算完之后只用在未知键报错上、**没有**进 `ConfigSourceMetadata`。
 * 故本模块能如实给出的来源判据是它**确实**有的三份元数据：
 * `envKeys`（宿主 env 显式给出的键）/ `argvKeys`（CLI 显式给出的键）/ `envFiles`（候选文件）。
 * 剩下那一种来源（本文件标记为 `fileOrigin === undefined`）是「来自某个 env 文件**或**缺省」——
 * 两者在本层**不可区分**，而**谎称可区分**比承认不可区分更坏（运维会照着一个错的文件名去查）。
 * 牙齿：`tests/unit/manager/http/endpoints.test.ts` 断言 `fileOrigin` 要么是候选列表里的一条、要么是 `undefined`。
 *
 * 本模块**零 IO、零副作用**：不造任何数据源、不读任何文件。
 *
 * @param sources - 已装配的数据源（只用它的 `config` 端口与 `context`）
 * @returns 全量配置的逐键事实
 */
export function reportConfigKeys(sources: OpsSources): OpsConfigSnapshot {
  const context = sources.context;
  const envKeys = new Set(context.sources.envKeys);
  const argvKeys = new Set(context.sources.argvKeys);
  // ⚠️ `envFiles` 里的键名是 env 名（`readEnvFiles` 的 `fileOrigins` 以 env 名为键），
  // 而 `FIELDS[].env` 正是 env 名 —— 两边同源，故这里可以直接查。
  const fileOrigins = context.sources.fileOrigins;

  return {
    configDir: context.configDir,
    envFiles: context.sources.envFiles,
    keys: FIELDS.map((f) => ({
      key: f.key,
      env: f.env,
      phase: f.phase,
      secret: CONFIG_SECRET_KEYS.has(f.key),
      value: redactConfigValue(f.key, context.config[f.key]),
      fileOrigin: fileOrigins.get(f.env),
      fromEnv: envKeys.has(f.env),
      fromArgv: argvKeys.has(f.env),
    })),
  };
}