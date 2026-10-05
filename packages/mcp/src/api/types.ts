/**
 * @fileoverview 控制面响应体的**形状**（零判据）—— 逐条对照根仓 `src/manager/routes/*.ts` 的 `reply()` 抄
 * @module api/types
 * @description
 * ⚠️ **手抄的弱耦合**：对面可能跑着旧版本的服务端。这份类型是「我们以为的形状」，
 * 而运行时拿到的东西**不保证**符合它 —— 故消费面（`src/tools/`）把每一份响应都当作
 * `unknown` 处理，只在**给模型看**之前才挑字段，绝不因为「类型上应该是」就直接转述。
 */

/** 一个数据源落在哪（服务端 `src/ops/report.ts:OpsDataRef` 的线上同形） */
export interface DataRef {
  readonly driver: string;
  readonly path: string;
}

/** 账本位置 —— ⚠️ **只有目录**（服务端刻意不给文件名） */
export interface UsageRef {
  readonly driver: string;
  readonly dir: string;
}

/** `GET /api/status` 的 `data` 段 */
export interface StatusData {
  readonly configDir: string;
  readonly envFiles: readonly string[];
  readonly accounts: DataRef;
  readonly acl: DataRef;
  readonly usage: UsageRef;
  readonly auth: { readonly enabled: boolean; readonly type: string };
  readonly quotaResetHour: number;
  readonly defaultQuotaWindow: string;
  readonly flushIntervalMs: number;
}

export interface StatusBody {
  readonly process: {
    readonly pid: number;
    readonly startedAt: number;
    readonly uptimeMs: number;
    readonly node: string;
    readonly platform: string;
    readonly cwd: string;
  };
  readonly proxy: {
    readonly mode: string;
    readonly protocol: string | null;
    readonly host: string | null;
    readonly port: number | null;
    readonly running: boolean;
    readonly startedAt: number | null;
    readonly uptimeMs: number | null;
  };
  readonly runningMeans: string;
  readonly data: StatusData;
}

/** `GET /api/config` 的一个键（**值可能已被服务端打码**） */
export interface ConfigKeyBody {
  readonly key: string;
  readonly env: string;
  readonly phase: "startup" | "runtime";
  /** startup 相位 = 改完必须重启进程 */
  readonly restartRequired: boolean;
  readonly secret: boolean;
  readonly value: unknown;
  readonly fileOrigin?: string;
  readonly fromEnv: boolean;
  readonly fromArgv: boolean;
}

export interface ConfigBody {
  readonly configDir: string;
  readonly envFiles: readonly string[];
  readonly keys: readonly ConfigKeyBody[];
  readonly summary: {
    readonly total: number;
    readonly startup: number;
    readonly runtime: number;
    readonly secrets: readonly string[];
  };
}

/** 一条账号；⚠️ `password` 只回「设没设」，明文永不上线 */
export interface AccountBody {
  readonly username: string;
  readonly password: { readonly set: boolean };
  readonly disabled: boolean;
  /** `bytes` 归一化后恒为 number，**0 = 不限流** */
  readonly quota?: { readonly bytes: number; readonly window?: string };
  readonly expiresAtIso: string | null;
  readonly acl?: {
    readonly target: {
      readonly whitelist: readonly string[];
      readonly blacklist: readonly string[];
    };
  };
}

export interface UsersBody {
  readonly accounts: readonly AccountBody[];
}

/** 名单的三个组（`acl.json` 的键同名，`clientIp` 在 HTTP 面上是 `clientip`） */
export type AclGroupName = "clientip" | "target" | "upstream";

/** 名单的两个方向 */
export type AclListName = "whitelist" | "blacklist";

export interface AclBody {
  readonly acl: {
    readonly clientIp: { readonly whitelist: readonly string[]; readonly blacklist: readonly string[] };
    readonly target: { readonly whitelist: readonly string[]; readonly blacklist: readonly string[] };
    readonly upstream: { readonly whitelist: readonly string[]; readonly blacklist: readonly string[] };
  };
}

/** 写操作的响应体；⚠️ `changed: false` 是**成功的 no-op**，不是错误 */
export interface ChangeBody {
  readonly changed: boolean;
  readonly message: string;
  readonly notice?: string | null;
  readonly effective?: string | null;
}

export interface UsageRowBody {
  readonly user: string;
  readonly windowKey: string;
  readonly total: number;
}

export interface UsageBody {
  readonly usage: readonly UsageRowBody[];
  readonly errors: readonly string[];
  readonly lagMs: number;
  readonly sideEffect: string;
  readonly note: string;
}

/**
 * `GET /api/usage/:username`
 * @description ⚠️ `usage` 是一个**对象**而不是数组，与全量那条不同形；而 `errors` / `sideEffect`
 * / `note` 三段限定**一个都不能少**（少一段 = 把「落文件的读取」当成纯读，理由见服务端
 * `routes/usage.ts` 文件头）
 */
export interface UsageOneBody {
  readonly usage: { readonly user: string; readonly windowKey: string; readonly total: number };
  readonly errors: readonly string[];
  readonly lagMs: number;
  readonly sideEffect: string;
  readonly note: string;
}

/** `POST /api/users` 的入参；⚠️ 服务端对未知键直接 400，故只拼白名单里的键 */
export interface AccountCreateInput {
  readonly username: string;
  readonly password: string;
  readonly quotaBytes?: number;
  readonly quotaWindow?: "day" | "month" | "clear";
  readonly expiresAt?: string | "clear";
  readonly disabled?: boolean;
  readonly targetWhitelist?: string[];
  readonly targetBlacklist?: string[];
}

/** `PUT /api/users/:username` 的入参；⚠️ **空 patch 会被服务端 400** */
export interface AccountUpdateInput {
  readonly password?: string;
  readonly quotaBytes?: number;
  readonly quotaWindow?: "day" | "month" | "clear";
  readonly expiresAt?: string | "clear";
  readonly disabled?: boolean;
  readonly targetWhitelist?: string[];
  readonly targetBlacklist?: string[];
}

/** `POST /api/acl` / `DELETE /api/acl` 的入参（三个字段全必填） */
export interface AclMutationInput {
  readonly group: AclGroupName;
  readonly list: AclListName;
  readonly entry: string;
}
