/**
 * @fileoverview 控制面响应体的**形状**（本包对 wire 契约的另一半声明）
 * @module api/types
 * @description
 * 与 `endpoints.ts` 同源：这里是「每个端点回什么 JSON」。字段名与可选性**逐条对照**根仓
 * `src/manager/routes/{status,config,users,acl,usage}.ts` 的 `reply()` 调用抄，改那边必须改这里。本文件**零判据**
 * —— 逐字段判据在 `wire.ts`。
 *
 * ⚠️ **打码是服务端的决定，本包不重打码**：密钥值一律是 `***`（空串保持空串）、密码一律是 `{set: boolean}`，本包
 * 一个字明文都拿不到。⚠️ 本包**不许**再判一次「哪些键是秘密」：那是服务端 `CONFIG_SECRET_KEYS` 一份清单的读
 * 者，读一份拷贝就是清单漂移的起点，而漂了的后果是一处打码一处明文。
 *
 * @module
 */

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

/**
 * `GET /api/status` 的响应体
 * @description `runningMeans` 是服务端**逐字随响应带出**的那句限定，界面上必须能读到它 —— cluster master 那种
 * 「端口由 worker 持有」的部署报 `mode: "master"` + `running: false`，那**不是**异常，是如实。
 */
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

/**
 * 一条账号（`GET /api/users` 与 `GET /api/users/:username` 共用这个形状）
 * @description ⚠️ `password` 是**只写**的：服务端一律渲染成 `{set: boolean}`，明文**永不**上线 —— 所以「忘
 * 了密码」的唯一处置是重设，那本来就是对的。
 */
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

/**
 * 写操作的响应体（账号写与名单写**共用**这一个形状）
 * @description ⚠️ `changed: false` 是**一次成功的 no-op**，不是失败：服务端既不报 4xx（那会让调用方以为坏了并重试）
 * 也不谎报「已改」，本包因此**不许**把它当错误处理，提示里必须说「没动」。⚠️ `notice`（账号写特有，
 * `AUTH_TYPE=jwt` 下 expiresAt / disabled 不生效）与 `effective`（名单写特有）是**强制限定**而非可选信息：丢掉
 * 前者，「以为把这个账号封住了」会活到下一次重启；后者**不承诺一件没发生的事**（`changed: false` 时为 `null`）。
 */
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

/**
 * `GET /api/usage` 的响应体
 * @description ⚠️ 三段限定**都是必答项**：`lagMs`（这个读数最多比运行中代理的判定新这么多毫秒，不带它就把「账本
 * 此刻记着多少」读成「现在还能用多少」）、`sideEffect`（本次读取**会物化账本文件**，不带上它一次会落文件的读取
 * 就被当成纯读）、`note`（本工具**不能清账**，以及为什么）。
 */
export interface UsageBody {
  readonly usage: readonly UsageRowBody[];
  readonly errors: readonly string[];
  readonly lagMs: number;
  readonly sideEffect: string;
  readonly note: string;
}

/**
 * 失败码的**闭合集**：服务端 `OpsErrorCode` 五档 + 传输层自造四档
 * @description ⚠️ 这是**手抄的一份**，与服务端 `src/ops/error.ts` 与 `src/manager/http/respond.ts:ErrorBody`
 * 互为镜像，故**只抄不加**。⚠️ `not-found` 出现两次是**同一档**（ops 的「账号不存在」与路由的「路径不存在」在
 * wire 上无法区分，而本包不需要区分）。
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
    /**
     * ⚠️ `internal` 的 `message` 是**固定文案**（细节只在服务端日志里），而 `requestId` 是拿去 grep
     * 日志的关联 id —— 界面上要给出它，否则 500 就成了死路。
     */
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

/**
 * `POST /api/users` 的入参
 * @description ⚠️ **服务端对未知键直接 400**（不是静默忽略）—— 拼错的字段名会让「我以为改了配额」变成「什么
 * 都没改」，故这里只拼白名单里的键。
 */
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

/**
 * `PUT /api/users/:username` 的入参
 * @description ⚠️ **空 patch 会被服务端 400 拒掉**：ops 的 `setAccount` 把「一个字段都没给」当成「整条重写」，而那
 * 与「不改」在磁盘上逐字相同 —— 调用方却拿到一条「已更新」。故类型上就要求至少一个键（判据见
 * {@link ./client.ts:assertNonEmptyPatch}）。⚠️ **`password` 不在排除项里**：服务端的 `PATCH_KEYS` 收它，故
 * 「重设一个已存在账号的密码」是这条端点**唯一**的通路（`POST` 撞名会 409）。
 */
export interface AccountUpdateInput {
  readonly password?: string;
  readonly quotaBytes?: number;
  readonly quotaWindow?: "day" | "month" | "clear";
  readonly expiresAt?: string | "clear";
  readonly disabled?: boolean;
  readonly targetWhitelist?: string[];
  readonly targetBlacklist?: string[];
}