/** @fileoverview 端点 ↔ 响应形状的对照：`@/utils/decode.js` 组合子装配出的**逐字段判据** */

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
} from "@/utils/decode.js";
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

/** 「解码器的输出必须可赋值给手写接口」的**单向**断言（反方向会因接口的 `readonly` 恒红） */
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
  // ⚠️ 可缺省而非可为 null —— JSON 里「键不存在」不是 `null`
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

/** `GET /api/usage/:username` 的形状；⚠️ `usage` 是**一个对象**，不是数组（当成数组会渲染成长度为 1 的表） */
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
 * 错误体的宽松收窄：⚠️ 表外的 `code` 降级成 `internal` 但**保留 `requestId`**，认得出的 `message` 原样透传；body 不是错误形状则 `null`
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

/** **全部**编译期断言的并集；⚠️ 必须是**导出的**并集而不是局部 `type`（局部那个会被 eslint 判死 = 没有判据） */
export type WireContractAssertions =
  | AssertCovers<ReturnType<typeof statusShape>, StatusBody>
  | AssertCovers<ReturnType<typeof configShape>, ConfigBody>
  | AssertCovers<ReturnType<typeof usersShape>, UsersBody>
  | AssertCovers<ReturnType<typeof accountShape>, AccountBody>
  | AssertCovers<ReturnType<typeof changeShape>, ChangeBody>
  | AssertCovers<ReturnType<typeof aclShape>, AclBody>
  | AssertCovers<ReturnType<typeof usageShape>, UsageBody>
  | AssertCovers<ReturnType<typeof usageOneShape>, Omit<UsageBody, "usage">>;