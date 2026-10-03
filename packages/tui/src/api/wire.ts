/**
 * @fileoverview 端点 ↔ 响应形状的对照（`./decode.ts` 组合子装配出的**逐字段判据**）
 * @module api/wire
 * @description
 * 本模块把 {@link ./endpoints.ts:ENDPOINTS} 那张表补全成「每个端点的响应长什么样」，是本包对 wire 契约的
 * **完整**声明。
 *
 * ⚠️ **每个形状都有一条编译期断言**（`AssertCovers`）：手写接口与字段表各写一遍就是两份真相源，故任何一侧
 * 改了而另一侧没跟 `pnpm typecheck` 就红。判据**单向**（`DecodeResult extends Interface`）就够 —— 反方向
 * （接口为了可赋值性刻意把数组写成 `readonly`，而解码器产出可变数组）会恒红，而恒红的断言就是没有断言。
 *
 * ⚠️ **`undefined` 字段在 JSON 里是「键不存在」，不是「值为 null」**：服务端可能为 undefined 的字段
 * （`fileOrigin` / `quota` / `acl` / `expiresAt`）一律用 `optional(...)` —— 用 `nullable` 收窄会让「服务端没
 * 配配额」被判成「配了个坏配额」。
 *
 * @module
 */

import {
  arr,
  bool,
  nullable,
  num,
  obj,
  oneOf,
  opaque,
  optional,
  str,
  strArr,
  type Decode,
} from "./decode.js";
import type {
  AclBody,
  AccountBody,
  ChangeBody,
  ConfigBody,
  StatusBody,
  UsageBody,
  UsersBody,
  WireCode,
} from "./types.js";

/** 「解码器的输出必须可赋值给手写接口」的单向断言（见文件头「为什么单向就够」） */
type AssertCovers<A, B> = [A] extends [B] ? true : never;

const statusShape = obj({
  process: obj({
    pid: num,
    startedAt: num,
    uptimeMs: num,
    node: str,
    platform: str,
    cwd: str,
  }),
  proxy: obj({
    mode: str,
    protocol: nullable(str),
    host: nullable(str),
    port: nullable(num),
    running: bool,
    startedAt: nullable(num),
    uptimeMs: nullable(num),
  }),
  runningMeans: str,
  data: obj({
    configDir: str,
    envFiles: strArr,
    accounts: obj({ driver: str, path: str }),
    acl: obj({ driver: str, path: str }),
    // ⚠️ 只有 dir、没有 path —— 那是服务端的刻意取舍（给文件名就要造一个数据源，见 ops/report.ts）
    usage: obj({ driver: str, dir: str }),
    auth: obj({ enabled: bool, type: str }),
    quotaResetHour: num,
    defaultQuotaWindow: str,
    flushIntervalMs: num,
  }),
});

const configKeyShape = obj({
  key: str,
  env: str,
  phase: oneOf(["startup", "runtime"]),
  restartRequired: bool,
  secret: bool,
  // 唯一一个刻意透传的字段：类型由服务端的配置 schema 决定，本包不猜（见 decode.ts:opaque）
  value: opaque,
  // ⚠️ 可缺省而非可为 null —— 见文件头
  fileOrigin: optional(str),
  fromEnv: bool,
  fromArgv: bool,
});

const configShape = obj({
  configDir: str,
  envFiles: strArr,
  keys: arr(configKeyShape),
  summary: obj({ total: num, startup: num, runtime: num, secrets: strArr }),
});

const accountShape = obj({
  username: str,
  // 只写不读：服务端一律给 `{set}`，明文永不上线（routes/users.ts 文件头）
  password: obj({ set: bool }),
  disabled: bool,
  quota: optional(obj({ bytes: num, window: optional(str) })),
  expiresAt: optional(num),
  expiresAtIso: nullable(str),
  acl: optional(obj({ target: obj({ whitelist: strArr, blacklist: strArr }) })),
});

const usersShape = obj({ accounts: arr(accountShape) });

const changeShape = obj({
  changed: bool,
  message: str,
  notice: optional(nullable(str)),
  effective: optional(nullable(str)),
});

const aclListShape = obj({ whitelist: strArr, blacklist: strArr });

const aclShape = obj({
  acl: obj({ clientIp: aclListShape, target: aclListShape, upstream: aclListShape }),
});

const usageRowShape = obj({ user: str, windowKey: str, total: num });

const usageShape = obj({
  usage: arr(usageRowShape),
  errors: strArr,
  lagMs: num,
  sideEffect: str,
  note: str,
});

/**
 * `GET /api/usage/:username` 的形状 —— ⚠️ `usage` 是**一个对象**，不是数组
 * @description 服务端这两条路由共用同一套旁路字段，但这一条把数组换成单条记录（`routes/usage.ts`）。当成同
 * 一个形状会让「查一个人的用量」渲染成一个长度为 1 的表 —— 看起来能跑，显示的是错的形态。
 */
const usageOneShape = obj({
  usage: usageRowShape,
  errors: strArr,
  lagMs: num,
  sideEffect: str,
  note: str,
});
/** `GET /api/usage/:username` 的响应体 */
export type UsageOneBody = ReturnType<typeof usageOneShape>;

/** 服务端闭合集（`WireCode` 的运行时形态；**唯一**出口，别处不许另起一份 `Set`） */
export const WIRE_CODES: ReadonlySet<string> = new Set<WireCode>([
  "not-found",
  "already-exists",
  "invalid",
  "read-only-driver",
  "source-unreadable",
  "internal",
  "unauthorized",
  "method-not-allowed",
  "bad-request",
]);

/** 从一个错误体里**尽力**读出的三样东西 */
export interface ErrorBodyRead {
  readonly code: WireCode;
  readonly message: string;
  readonly requestId: string | null;
}

/**
 * 错误体的宽松收窄：**表外的 `code` 降级成 `internal`，但保留 `requestId`**
 * @description ⚠️ 为什么错误体**不走**上面那套严格解码器：对面加了新 code 时严格解码器会判它「形状不对」，
 * 而那会把一句**服务端认真写的**中性事实陈述（`quotaBytes 只能是非负整数…`）换成本包四个字。故认得出就
 * **原样透传** `message`；认不出 code 就降级而**把 `requestId` 带上**（唯一还能接上服务端日志的线索）。
 *
 * @param value - `JSON.parse` 后的 `unknown`
 * @returns 尽力读出的三样；整个 body 不是错误形状则 `null`（由调用方降级成「只有状态码」那条）
 */
export function readErrorBody(value: unknown): ErrorBodyRead | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const e = error as Record<string, unknown>;
  const message = typeof e.message === "string" ? e.message : null;
  if (message === null) return null;
  const rawCode = typeof e.code === "string" ? e.code : "";
  return {
    code: WIRE_CODES.has(rawCode) ? (rawCode as WireCode) : "internal",
    message,
    requestId: typeof e.requestId === "string" ? e.requestId : null,
  };
}

/** 每个端点的响应解码器（按端点路径取，见 `./client.ts`） */
export interface WireShapes {
  readonly status: Decode<StatusBody>;
  readonly config: Decode<ConfigBody>;
  readonly users: Decode<UsersBody>;
  readonly user: Decode<{ account: ReturnType<typeof accountShape> }>;
  readonly change: Decode<ChangeBody>;
  readonly acl: Decode<AclBody>;
  readonly usage: Decode<UsageBody>;
  readonly usageOne: Decode<UsageOneBody>;
}

/** 全部形状（**单例**：这些解码器无状态，复用一份即可，每次调用现造只是白花 CPU） */
export const SHAPES: WireShapes = {
  status: statusShape,
  config: configShape,
  users: usersShape,
  user: obj({ account: accountShape }),
  change: changeShape,
  acl: aclShape,
  usage: usageShape,
  usageOne: usageOneShape,
};

/**
 * **全部**编译期断言的并集 —— 解码器输出必须逐字段可赋值给对应的手写接口
 * @description ⚠️ 必须是**导出的**并集而不是局部 `type`：类型别名在运行时不存在，局部那个会被 eslint 的
 * `no-unused-vars` 判死，而「判据被 lint 判死」与「判据不存在」在效果上一样 —— 它会静默消失。⚠️ 它只钉
 * **字段的集合与类型**，不钉「路径对应哪个字段」（那是根仓 `tests/unit/manager-tui-contract.test.ts` 的职责）。
 * 两道牙各管一半。
 */
export type WireContractAssertions =
  | AssertCovers<ReturnType<typeof statusShape>, StatusBody>
  | AssertCovers<ReturnType<typeof configShape>, ConfigBody>
  | AssertCovers<ReturnType<typeof usersShape>, UsersBody>
  | AssertCovers<ReturnType<typeof accountShape>, AccountBody>
  | AssertCovers<ReturnType<typeof changeShape>, ChangeBody>
  | AssertCovers<ReturnType<typeof aclShape>, AclBody>
  | AssertCovers<ReturnType<typeof usageShape>, UsageBody>
  | AssertCovers<ReturnType<typeof usageOneShape>, Omit<UsageBody, "usage">>;