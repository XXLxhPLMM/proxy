/**
 * @fileoverview 失败面的**类型与验证**：`WireCode` 闭合集 + 错误体的**宽松**读法 `readErrorBody`
 * @module api/error/schema
 * @description ⚠️ **这里刻意不用 zod**：对面升级加一个新 `code` 是它的自由，严格 schema 会把一句中性事实
 * 判成「形状不对」。故认得出就透传 `message`，认不出的 `code` 降级成 `internal` 并**保留 `requestId`**。
 */

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

/** 错误响应体（服务端 `http/respond.ts:ErrorBody` 的线上同形；⚠️ **只是文档**，判据在下面的宽松读法那一侧） */
export interface ErrorBodyWire {
  readonly error: {
    /** ⚠️ `internal` 的 `message` 是固定文案（细节只在服务端日志里）；`requestId` 是 grep 日志的关联 id，界面必须给出 */
    readonly code: WireCode;
    readonly message: string;
    readonly requestId?: string;
  };
}

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
