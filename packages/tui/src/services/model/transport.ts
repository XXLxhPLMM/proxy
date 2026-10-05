/** @fileoverview 方言共用的**拨号那一步**：发出去、判成败、收窄成 `unknown` */
// ⚠️ 这是模型那一侧**唯一**取 `fetch` 的地方；`ManagerClient` 与 `ENDPOINTS` 一步都不许进这里

import { ModelError, type FetchLike } from "./types.js";

/** 一次请求要用的东西（⚠️ `url` **不许**进任何失败文案 —— 它可能带着凭据或用户敲的地址） */
export interface RequestSpec {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal: AbortSignal;
  readonly fetchImpl?: FetchLike;
  /** 失败文案里的那个主语（`模型` / `模型清单`）—— ⚠️ 只用来区分「问模型」与「拉清单」 */
  readonly what: string;
}

/** 发一次请求、交回一个 `unknown`（⚠️ 失败文案**只说状态与形状**，绝不转述响应体） */
export async function requestJson(spec: RequestSpec): Promise<unknown> {
  const headers: Record<string, string> = { ...spec.headers };
  const init: RequestInit = { method: spec.method, headers, signal: spec.signal };
  if (spec.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(spec.body);
  }
  const call = spec.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await call(spec.url, init);
  } catch (err) {
    throw new ModelError("unreachable", `连不上${spec.what}（${describe(err)}）`);
  }
  if (!response.ok) {
    throw new ModelError("shape", `${spec.what}那边回了 HTTP ${String(response.status)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text()) as unknown;
  } catch {
    throw new ModelError("shape", `${spec.what}那边的回答不是 JSON`);
  }
  return parsed;
}

/** 拼一次请求的地址（⚠️ 尾斜杠归一**只在这一处**做 —— 路径是各家方言自己的，不共用） */
export function joinPath(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

/** 收窄：不是一个 JSON 对象就是 `shape` 档（⚠️ **不转述对面给的任何值**） */
export function objectAt(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ModelError("shape", `${what}不是 JSON 对象`);
  }
  return raw as Record<string, unknown>;
}

/** 收窄：不是一个非空数组就是 `shape` 档 */
export function arrayAt(raw: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ModelError("shape", `${what}不是非空数组`);
  }
  return raw as readonly unknown[];
}

/** 收窄：不是字符串就是 `shape` 档 */
export function stringAt(raw: unknown, what: string): string {
  if (typeof raw !== "string") {
    throw new ModelError("shape", `${what}不是字符串`);
  }
  return raw;
}

/** 三个方言共用的清单抽取（⚠️ 字段名是各家自己的 —— 调用方点名「哪一格」，故错处能说清） */
export function listingsFrom(
  rows: readonly unknown[],
  idKey: string,
  what: string,
): readonly { modelId: string }[] {
  return rows.map((row) => ({ modelId: stringAt(objectAt(row, what)[idKey], `${what}里的 ${idKey}`) }));
}

/** 只转述**连接层**那一句话（⚠️ `fetch` 的 message 是「连不上」这一类，响应体一个字都不带） */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}