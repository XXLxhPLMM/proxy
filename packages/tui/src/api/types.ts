/** @fileoverview 响应体的**形状**（**零判据**）：逐条对照根仓 `src/manager/routes/*.ts` 的 `reply()` 抄 */

/** 一条数据的「哪个驱动、落在哪」（`根仓 src/ops/report.ts:OpsDataRef` 的线上同形） */
export interface DataRef {
  readonly driver: string;
  readonly path: string;
}

/** 账本位置 —— ⚠️ **只有目录**（服务端刻意不给文件名，给了就要造一个数据源，见 `ops/report.ts`） */
export interface UsageRef {
  readonly driver: string;
  readonly dir: string;
}

/** `GET /api/status` 的 `data` 段（`根仓 src/ops/report.ts:OpsConfigReport` 的线上同形） */
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

/** `GET /api/status` 的响应体；⚠️ `runningMeans` 逐字上屏（本进程尚无数据面时它报 `running: false`，那是如实，不是异常） */
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
  /** startup 相位 = 改完必须重启进程（服务端由 `phase` 派生，本包不重算） */
  readonly restartRequired: boolean;
  readonly secret: boolean;
  readonly value: unknown;
  /** ⚠️ `undefined` 的含义是「**不在任何 env 文件里**」（可能来自宿主 env / CLI / 缺省，三者不可区分） */
  readonly fileOrigin?: string;
  readonly fromEnv: boolean;
  readonly fromArgv: boolean;
}

/** `GET /api/config` 的响应体 */
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

/** 一条账号（`GET /api/users` 与 `GET /api/users/:username` 共用这个形状）；⚠️ `password` 只写，明文永不上线 */
export interface AccountBody {
  readonly username: string;
  readonly password: { readonly set: boolean };
  readonly disabled: boolean;
  /** `bytes` 归一化后恒为 number，**0 = 不限流**；`window` 缺省即 `month` */
  readonly quota?: { readonly bytes: number; readonly window?: string };
  /** epoch 毫秒；`undefined` = 永不过期 */
  readonly expiresAt?: number;
  /** 人读形态（服务端同时给两种，理由见 `routes/users.ts:accountView`） */
  readonly expiresAtIso: string | null;
  /** 按用户的个人名单（判定在代理的 personal 层，与全局名单是两类语义） */
  readonly acl?: {
    readonly target: {
      readonly whitelist: readonly string[];
      readonly blacklist: readonly string[];
    };
  };
}

/** `GET /api/users` 的响应体 */
export interface UsersBody {
  readonly accounts: readonly AccountBody[];
}

/** 名单的三个组（与 `acl.json` 的键同名，`clientIp` 在 HTTP 面上是 `clientip`） */
export type AclGroupName = "clientip" | "target" | "upstream";

/** 名单的两个方向 */
export type AclListName = "whitelist" | "blacklist";

/** 一份名单的一格 */
export interface AclListBody {
  readonly whitelist: readonly string[];
  readonly blacklist: readonly string[];
}

/** `GET /api/acl` 的响应体（服务端 `readAcl` 的归一化形态：三组两个方向都补齐） */
export interface AclBody {
  readonly acl: {
    readonly clientIp: AclListBody;
    readonly target: AclListBody;
    readonly upstream: AclListBody;
  };
}

/** 写操作的响应体（账号写与名单写**共用**这一个形状）；⚠️ `changed: false` 是**成功的 no-op**，不许当错误 */
export interface ChangeBody {
  readonly changed: boolean;
  readonly message: string;
  /** 账号写特有；`AUTH_TYPE=jwt` 下的失效提醒 */
  readonly notice?: string | null;
  /** 名单写特有；`changed: false` 时为 `null`（不承诺一件没发生的事） */
  readonly effective?: string | null;
}

/** 账本里一个用户的当前窗口用量 */
export interface UsageRowBody {
  readonly user: string;
  readonly windowKey: string;
  readonly total: number;
}

/** `GET /api/usage` 的响应体；⚠️ `lagMs` / `sideEffect` / `note` 三段限定**都是必答项**（少一段 = 把落文件的读取当成纯读） */
export interface UsageBody {
  readonly usage: readonly UsageRowBody[];
  readonly errors: readonly string[];
  readonly lagMs: number;
  readonly sideEffect: string;
  readonly note: string;
}

/**
 * 失败码的**闭合集**：服务端 `OpsErrorCode` 五档 + 传输层自造四档（⚠️ 手抄自服务端 `src/ops/error.ts`，只抄不加）
 */
export type WireCode =
  | "not-found"
  | "already-exists"
  | "invalid"
  | "read-only-driver"
  | "source-unreadable"
  | "internal"
  | "unauthorized"
  | "method-not-allowed"
  | "bad-request";

/** 错误响应体（服务端 `http/respond.ts:ErrorBody` 的线上同形） */
export interface ErrorBodyWire {
  readonly error: {
    /** ⚠️ `internal` 的 `message` 是固定文案（细节只在服务端日志里）；`requestId` 是 grep 日志的关联 id，界面必须给出 */
    readonly code: WireCode;
    readonly message: string;
    readonly requestId?: string;
  };
}

/** `POST /api/users` 成功（201）时带回来的写结果 */
export type CreatedAccountBody = ChangeBody;

/** `POST /api/acl` / `DELETE /api/acl` 的入参（**三个字段全必填**） */
export interface AclMutationInput {
  readonly group: AclGroupName;
  readonly list: AclListName;
  readonly entry: string;
}

/** `POST /api/users` 的入参；⚠️ 服务端对未知键直接 400（不是静默忽略），故只拼白名单里的键 */
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

/** `PUT /api/users/:username` 的入参；⚠️ **空 patch 会被服务端 400**；⚠️ `password` 不在排除项里（重设已有账号的密码是这条端点唯一的通路） */
export interface AccountUpdateInput {
  readonly password?: string;
  readonly quotaBytes?: number;
  readonly quotaWindow?: "day" | "month" | "clear";
  readonly expiresAt?: string | "clear";
  readonly disabled?: boolean;
  readonly targetWhitelist?: string[];
  readonly targetBlacklist?: string[];
}