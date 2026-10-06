/**
 * @fileoverview 失败面的**宽松读法**：服务端自己的错误体 `{error:{code,message,requestId}}` 读出三样东西
 * @module api/error
 * @description
 * ⚠️ **这里刻意不用 zod**（而 `send.ts` 那一侧全线用）：对面升级后加一个新 `code` 是它的自由，
 * 而一个严格 schema 会把一句服务端认真写的中性事实陈述换成本包的「形状不对」四个字。故这里的判据是
 * 「认得出就原样透传 `message`」，而认不出的 `code` 降级成 `internal` 并**保留 `requestId`**
 * （唯一还能接上服务端日志的线索）。
 */

import type { WireCode } from "./types.js";

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