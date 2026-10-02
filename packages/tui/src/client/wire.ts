/**
 * @fileoverview 端点 ↔ 响应形状的对照（`./decode.ts` 组合子装配出的**逐字段判据**）
 * @module client/wire
 * @description
 * 本模块把 {@link ./endpoints.ts:ENDPOINTS} 那张表补全成「每个端点的响应长什么样」，是本包
 * 对 wire 契约的**完整**声明。根仓的 `tests/unit/manager-tui-contract.test.ts` 从两侧源码现取
 * `(method, path)` 比集合；本模块则保证**形状**两侧一致 —— 两道牙，一个管路径集合，一个管字段。
 *
 * ## 每个形状都有一条**编译期**断言（`AssertCovers`）
 * @description
 * {@link ./decode.ts:obj} 的返回类型是从字段表推出来的，而它必须与 `./types.ts` 里手写的接口
 * 逐字段同形。⚠️ **手写接口与字段表各写一遍就是两份真相源**，故这里用类型断言把它们锁在一起：
 * 任何一侧加了 / 改了 / 删了一个字段而另一侧没跟，`pnpm typecheck` 就红。
 *
 * 判据**单向**（`DecodeResult extends Interface`）就够，理由：接口缺字段时输出多不出那个键、
 * 不满足可赋值性 → 红；接口多字段时输出缺那个键 → 同样红。反方向（`Interface extends
 * DecodeResult`）不判，因为接口为了可赋值性刻意把数组写成 `readonly`，而解码器产出的是可变
 * 数组 —— 那条反向断言会恒红，且它的失败模式**不含任何信息**（恒红的断言就是没有断言）。
 *
 * ## ⚠️ `undefined` 字段在 JSON 里是「键不存在」，不是「值为 null」
 * @description
 * `JSON.stringify({a: undefined})` 产出 `{}`。服务端把 `fileOrigin` / `quota` / `acl` /
 * `expiresAt` 这些**可能为 undefined** 的字段直接放进响应体，于是它们在**缺省时根本不是
 * `null` 而是「没这个键」**。故这几处一律用 `optional(...)` 而不是 `nullable(...)` ——
 * 用 `nullable` 收窄会让「服务端没配配额」被判成「配了个坏配额」，而那种错会一路流到界面才炸。
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

/**
 * 「解码器的输出必须可赋值给手写接口」的单向断言
 * @description 见文件头「为什么单向就够」。
 */
type AssertCovers<A, B> = [A] extends [B] ? true : never;

/* ── /api/status ────────────────────────────────────────────────────────── */

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

/* ── /api/config ────────────────────────────────────────────────────────── */

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

/* ── /api/users ─────────────────────────────────────────────────────────── */

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

/* ── 写面（账号写与名单写共用同一个形状）───────────────────────────────── */

const changeShape = obj({
  changed: bool,
  message: str,
  notice: optional(nullable(str)),
  effective: optional(nullable(str)),
});

/* ── /api/acl ───────────────────────────────────────────────────────────── */

const aclListShape = obj({ whitelist: strArr, blacklist: strArr });

const aclShape = obj({
  acl: obj({ clientIp: aclListShape, target: aclListShape, upstream: aclListShape }),
});

/* ── /api/usage ─────────────────────────────────────────────────────────── */

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
 * @description 服务端这两条路由共用同一套旁路字段，但 `usageFor` 那条把数组换成单条记录
 * （`routes/usage.ts`）。把它们当成同一个形状会让「查一个人的用量」在界面上渲染成一个长度为
 * 1 的表 —— 看起来能跑，而显示的是错的形态。
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

/* ── 错误体（**宽松**收窄，与上面几条的严格收窄刻意不同）───────────────── */

/** 服务端闭合集（`WireCode` 的运行时形态；**唯一**出口，别处不许另起一份 `Set`） */
export const WIRE_CODES: ReadonlySet<string> = new Set<WireCode>([
  // ops 五档
  "not-found",
  "already-exists",
  "invalid",
  "read-only-driver",
  "source-unreadable",
  // 传输层四档
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
 * @description
 * 为什么错误体不走上面那套严格解码器：对面升级后加了新 code 时，严格解码器会判它「形状不对」，
 * 而那会把一句**服务端认真写的**中性事实陈述（`quotaBytes 只能是非负整数…`）换成本包的
 * 「形状不对」四个字 —— 操作者拿到的信息严格变少，而服务端明明已经答清楚了。
 *
 * 故这里：认得出就**原样透传** `message`（传输面不改写对方的文案，与 `src/admin` 对称）；认不出
 * code 就降级成 `internal` 而**把 `requestId` 带上**（那是唯一还能接上服务端日志的线索）。
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
 * @description
 * 为什么是一个**导出的**联合而不是若干局部 `type`：局部别名会被 eslint 的 `no-unused-vars`
 * 判死（类型别名在运行时不存在），而「判据被 lint 判死」与「判据不存在」在效果上一样 ——
 * 它会静默消失。导出即引用，故这条**必须**有人用上它；改了接口没改字段表时
 * `pnpm typecheck` 立刻红。
 *
 * ⚠️ 这条断言只钉**字段的集合与类型**，不钉「路径对应哪个字段」（那是根仓
 * `tests/unit/manager-tui-contract.test.ts` 里端点表互锁的职责）。两道牙各管一半。
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
