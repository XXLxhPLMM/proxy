/**
 * @fileoverview 契约的 **type 面**：`WireCode` 闭合集 + `ErrorBodyWire`（⚠️ 响应体的形状**不在这里** —— 那由 zod 推）
 * @module api/types
 * @description
 * ⚠️ **这一份从 221 行缩到今天这个规模**：响应体类型曾经在这里逐字段手抄一遍，而判据（`obj({...})`）在
 * 另一处手抄一遍 —— 那是**两份可以各自漂的真相源**，只靠一行 `tsc` 顶着。今天判据是 zod schema，
 * 类型是 `z.infer<typeof 那个 schema>`，**同源**，故漂不了。
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

/** 错误响应体（服务端 `http/respond.ts:ErrorBody` 的线上同形；⚠️ **只是文档**，判据在 `./error.ts` 那一侧刻意宽松） */
export interface ErrorBodyWire {
  readonly error: {
    /** ⚠️ `internal` 的 `message` 是固定文案（细节只在服务端日志里）；`requestId` 是 grep 日志的关联 id，界面必须给出 */
    readonly code: WireCode;
    readonly message: string;
    readonly requestId?: string;
  };
}