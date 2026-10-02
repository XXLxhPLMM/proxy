/**
 * @fileoverview 控制面响应体的**形状**（本包对 wire 契约的另一半声明）
 * @module client/types
 * @description
 * 与 `endpoints.ts` 同源：这里是「每个端点回什么 JSON」。字段名与可选性**逐条对照**
 * `src/manager/routes/{status,config,users,acl,usage}.ts` 的 `reply()` 调用抄，改那边必须改这里，
 * 反之亦然。
 *
 * ## 为什么这些是 `unknown` 收窄出来的、而不是 `any`
 * @description
 * 服务端是**另一个进程**（甚至另一台机器），它的响应不经过本包任何一行代码的类型检查 ——
 * 把 `await res.json()` 直接当 `StatusBody` 用，等于在跨网络的那一段关掉了类型系统。
 * 故 {@link ./wire.ts}（用 {@link ./decode.ts} 的组合子装配出的逐字段判据）做一次显式收窄：
 * 形状不对就抛 {@link ./error.ts:TuiError}（`shape` 档），**而不是**让 `undefined` 一路流到
 * 界面上变成「页面莫名其妙空白」。
 *
 * ## 打码是**服务端的决定**，本包不重打码
 * @description
 * `GET /api/config` 的密钥键一律是 `***`（空串保持空串），`GET /api/users` 的密码一律是
 * `{set: boolean}`。⚠️ 本包**不许**再判一次「哪些键是秘密」：那是服务端 `CONFIG_SECRET_KEYS`
 * 一份清单的读者，读一份拷贝就是清单漂移的起点（漂了的后果是一处打码一处明文）。
 * 本包只负责把服务端给的 `secret` 标志**如实呈现**。
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
 * @description
 * `proxy` **恒非 null**：`mode` 显式三态（`master` / `starting` / `running` / `stopping` /
 * `stopped` / `error` / `inactive`），而 cluster master 那种「端口由 worker 持有」的部署报
 * `mode: "master"` + `running: false` —— 那**不是**异常，是如实。`runningMeans` 是服务端
 * **逐字随响应带出**的那句限定，界面上必须能读到它（否则 operator 会把正常 cluster 读成「没起来」）。
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
 * @description
 * ⚠️ `password` 是**只写**的：服务端一律渲染成 `{set: boolean}`，明文**永不**上线。本包里
 * 因此没有任何地方能拿到明文密码 —— 「忘了密码」的唯一处置是重设，那本来就是对的。
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
 * @description
 * ⚠️ `changed: false` 是**一次成功的 no-op**，不是失败：目标状态本来就是这样。服务端对它既不报
 * 4xx（那会让调用方以为坏了并重试）也不谎报「已改」（那是一个字节都没动的事实）。本包因此
 * **不许**把它当错误处理，且在提示里必须说「没动」而不是「已改」。
 *
 * `notice` 只在账号写时出现（`AUTH_TYPE=jwt` 下 expiresAt / disabled 不生效）——**必须**
 * 呈现出来，否则「以为把这个账号封住了」会一直活到下一次重启。
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
 * @description
 * ⚠️ 三段限定**都是必答项**，不是可选注释：
 * - `lagMs`：这个读数最多比运行中代理的判定新这么多毫秒。不带它，operator 会把「账本此刻记着
 *   多少」读成「这个账号现在还能用多少」——后者是代理进程内存里的数。
 * - `sideEffect`：本次读取**会物化账本文件**（数据源「目标不存在就物化」的纪律）。悄悄留一个
 *   文件而调用方以为是纯读，是最坏的一类静默副作用。
 * - `note`：本工具**不能清账**，以及为什么。
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
 * @description
 * ⚠️ 这是**手抄的一份**，与服务端 `src/ops/error.ts:OpsErrorCode` 与
 * `src/manager/http/respond.ts:ErrorBody` 互为镜像。同一个 code 在两端各有一个名字时，
 * 「同一种失败两个名字」这条门就开了 —— 故这里只抄不加，且抄来的每一个字面量都能在服务端找到。
 * 服务端加档时必须同步改这里；本包收到表外的 code 时**降级成 `internal`**（理由见
 * `./error.ts`「表外的 code 一律降级」）。
 *
 * 注意 `not-found` 出现两次是**同一档**：ops 的「账号不存在」与路由的「路径不存在」在 wire 上
 * 无法区分，而**本包不需要**区分（两者都是「你给的那个东西没有」）。
 */
export type WireCode =
  // ── ops 的五档（`src/ops/error.ts`）──
  | "not-found"
  | "already-exists"
  | "invalid"
  | "read-only-driver"
  | "source-unreadable"
  // ── 传输层自造的四档（`src/manager/http/respond.ts`）──
  | "internal"
  | "unauthorized"
  | "method-not-allowed"
  | "bad-request";

/** 错误响应体（服务端 `http/respond.ts:ErrorBody` 的线上同形） */
export interface ErrorBodyWire {
  readonly error: {
    /**
     * ⚠️ `internal` 的 `message` 是**固定文案**（细节只在服务端日志里），而 `requestId` 是拿去
     * grep 日志的关联 id —— 界面上要给出它，否则 500 就成了死路。
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
 * @description `username` / `password` 必填；其余是 patch 字段。⚠️ **服务端对未知键直接 400**
 * （不是静默忽略）——拼错的字段名会让「我以为改了配额」变成「什么都没改」，故这里只拼白名单里的键。
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
 * @description ⚠️ **空 patch 会被服务端 400 拒掉**：ops 的 `setAccount` 会把「一个字段都没给」
 * 当成「整条重写」，而那与「不改」在磁盘上逐字相同 —— 调用方却拿到一条「已更新」。故这里在类型上
 * 就要求至少一个键（见 {@link ./client.ts:assertNonEmptyPatch}）。
 *
 * ⚠️ **`password` 在这里而不在 `Omit` 的排除项里**：服务端的 `PATCH_KEYS` 收它，故「重设一个已存在
 * 账号的密码」是这条端点**唯一**的通路（`POST` 撞名会 409）。把它从类型里排掉等于让 TUI 少一个
 * 功能而服务端一直支持着 —— 而「忘了密码」的唯一处置本来就是重设。
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
