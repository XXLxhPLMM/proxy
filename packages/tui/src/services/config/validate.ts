/**
 * @fileoverview 台账的**形状判据**：磁盘形态、用户输入面与 provider 那几张表的逐字段判据各一份，加上本层唯一的失败类型；⚠️ 读面「坏内容即拒」**绝不**降级成空台账
 */

import { TuiError } from "@/lib/errors.js";
import { normalizeBaseUrl } from "@/lib/http.js";
import {
  MODEL_API_FORMATS,
  NAME_MAX_LEN,
  REASONING_EFFORTS,
  TIMEOUT_BOUNDS,
  type Ledger,
  type ModelApiFormat,
  type ModelRecord,
  type ProviderRecord,
  type SessionModelRef,
  type Target,
  type TargetInput,
  splitModelRef,
} from "./types.js";

/** 本层的失败分档；⚠️ 刻意**不**收「连不上」—— 那是 `TuiError` 的地界（两者的处置动作相反） */
export type LedgerErrorCode = "unreadable" | "invalid-target";

export class LedgerError extends Error {
  public readonly code: LedgerErrorCode;

  public constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

/** `id` 的字符集：台账内的引用键，绝不许含路径分隔符或空白 */
const ID_SHAPE = /^[a-z0-9-]+$/;

/** 抛一个 `LedgerError`，并让控制流分析把该处收窄成 `never`（于是判据能写成一句「判不过就抛」） */
function reject(code: LedgerErrorCode, message: string): never {
  throw new LedgerError(code, message);
}

/**
 * 这个字符串里有没有控制字符（含 DEL）
 * @description 按码点判而不是靠一张正则：控制字符在源码里是**不可见字节**，写成正则字面量就得把它们放进源
 * 文件。挡的是显示名 —— 终端里一个换行符会把一行顶掉。
 */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 把一个值描述成一句可读的事实（**只描述形状，绝不引用 `token` 的内容**） */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return `${typeof value}（${String(value)}）`;
}

/** 取一个 JSON 对象的字段面；不是对象（含数组与 null）即判失败 */
function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("unreadable", `${where} 必须是 JSON 对象，实际是 ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

/** 归一后的基址；形状不对时换成 {@link LedgerError}（读面**只**抛 `LedgerError`） */
function normalizeStoredBaseUrl(raw: unknown, where: string): string {
  if (typeof raw !== "string") {
    reject("unreadable", `${where}.baseUrl 必须是字符串，实际是 ${describe(raw)}`);
  }
  try {
    return normalizeBaseUrl(raw);
  } catch (err) {
    // ⚠️ 转述 `TuiError` 的**判据**而不转述它的档位：把它原样抛出去会让读面冒出一种「连不上」的失败类
    const why = err instanceof TuiError ? err.message : String(err);
    reject("unreadable", `${where}.baseUrl 不是可用的控制面地址：${why}`);
  }
}

/** 显示名：非空、trim 后不超长、不含控制字符；返回**trim 后**的形态 */
function normalizedName(raw: unknown, code: LedgerErrorCode, where: string): string {
  if (typeof raw !== "string") {
    reject(code, `${where} 必须是字符串，实际是 ${describe(raw)}`);
  }
  const trimmed = raw.trim();
  if (trimmed === "") reject(code, `${where} 不能为空`);
  if (hasControlChars(trimmed)) reject(code, `${where} 不能含控制字符（会打乱终端排版）`);
  if ([...trimmed].length > NAME_MAX_LEN) reject(code, `${where} 超过 ${NAME_MAX_LEN} 个字符`);
  return trimmed;
}

/** 超时：必须是区间内的整数 */
function normalizedTimeout(raw: unknown, code: LedgerErrorCode, where: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    reject(code, `${where} 必须是整数毫秒，实际是 ${describe(raw)}`);
  }
  if (raw < TIMEOUT_BOUNDS.min || raw > TIMEOUT_BOUNDS.max) {
    reject(
      code,
      `${where} 必须在 ${TIMEOUT_BOUNDS.min}–${TIMEOUT_BOUNDS.max} 毫秒之间，实际是 ${raw}`,
    );
  }
  return raw;
}

/** 磁盘上的一个 target（`id` 的唯一性由 {@link validateLedger} 判） */
function validateStoredTarget(raw: unknown, where: string): Target {
  const obj = asObject(raw, where);
  const id = obj["id"];
  if (typeof id !== "string" || !ID_SHAPE.test(id)) {
    reject("unreadable", `${where}.id 必须是 [a-z0-9-] 的 slug，实际是 ${describe(id)}`);
  }
  const baseUrl = normalizeStoredBaseUrl(obj["baseUrl"], where);
  // ⚠️ `token` 只判「是字符串」而**不判内容**：服务端比的是 SHA-256 摘要，任何字节都合法 —— 在本层
  // 再造一份字符集就是一份会漂的假约束。端部空白 trim 掉（服务端 `BEARER_TOKEN` 以 `$` 锚定）。
  const token = obj["token"];
  if (typeof token !== "string") {
    reject("unreadable", `${where}.token 必须是字符串，实际是 ${describe(token)}`);
  }
  return {
    id,
    name: normalizedName(obj["name"], "unreadable", `${where}.name`),
    baseUrl,
    token: token.trim(),
    timeoutMs: normalizedTimeout(obj["timeoutMs"], "unreadable", `${where}.timeoutMs`),
  };
}

/**
 * 磁盘形态 → {@link Ledger}（次序 **version → targets → selected**）；⚠️ **遇到第一个问题就抛**，⚠️ `baseUrl` 在这里被归一（**不**做的事是「悄悄接受一份非法地址」，那会把失败推迟到网络上）
 */
export function validateLedger(raw: unknown): Ledger {
  const obj = asObject(raw, "台账");
  if (obj["version"] !== 1) {
    reject(
      "unreadable",
      `台账 version 必须是数字 1，实际是 ${describe(obj["version"])}（本包没有第二个版本，也没有迁移层）`,
    );
  }
  const rawTargets = obj["targets"];
  if (!Array.isArray(rawTargets)) {
    reject("unreadable", `台账 targets 必须是数组，实际是 ${describe(rawTargets)}`);
  }
  const targets = rawTargets.map((one, index) => validateStoredTarget(one, `targets[${index}]`));

  const ids = new Set<string>();
  for (const target of targets) {
    if (ids.has(target.id)) {
      reject(
        "unreadable",
        `台账里 id 重复：${target.id}（id 是 selected 的引用键，重复就没有确定的指向）`,
      );
    }
    ids.add(target.id);
  }

  const selected = obj["selected"];
  if (selected !== null && typeof selected !== "string") {
    reject("unreadable", `台账 selected 必须是字符串或 null，实际是 ${describe(selected)}`);
  }
  if (typeof selected === "string" && !ids.has(selected)) {
    reject(
      "unreadable",
      `台账 selected 指向不存在的 target：${selected}（不静默置 null —— 那会让「上次选中的不见了」显示成「没选过」）`,
    );
  }
  return { version: 1, selected, targets };
}

/**
 * 用户填的一个端点 → 归一后的同一形状
 * @description 与 {@link validateLedger} 的区别有两条，都是有意的：① **基址的判据是 `@/lib/http.js`
 * 那一份**，本层不重打（两份漂了就是「界面说合法、落盘判非法」），故这里让 `TuiError` 原样向上抛；
 * ② **`token` 判非空但不判字符集**（字符级的可接受性由服务端那条**唯一**判据回答）。
 * @param raw 用户输入（界面文本框的值逐字传进来，本层不做任何预处理）
 * @throws {LedgerError} `invalid-target`：名字 / token / 超时不合法
 * @throws {TuiError} `unreachable`：地址形状不合法
 */
export function validateTargetInput(raw: TargetInput): TargetInput {
  const name = normalizedName(raw.name, "invalid-target", "name");
  if (typeof raw.baseUrl !== "string") {
    reject("invalid-target", `baseUrl 必须是字符串，实际是 ${describe(raw.baseUrl)}`);
  }
  if (typeof raw.token !== "string") {
    reject("invalid-target", `token 必须是字符串，实际是 ${describe(raw.token)}`);
  }
  if (raw.token.trim() === "") {
    reject(
      "invalid-target",
      "token 不能为空（服务端对空 token 恒 401，存一条连不上的记录等于骗人）",
    );
  }
  return {
    name,
    // 判据抛 `TuiError` 是**有意**的（见本函数说明第 1 条）
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    token: raw.token.trim(),
    timeoutMs: normalizedTimeout(raw.timeoutMs, "invalid-target", "timeoutMs"),
  };
}

/** 一格非空文本（不含控制字符）；⚠️ **不 trim 回去**：id 是身份，悄悄改它等于换一个身份 */
function identifier(raw: unknown, where: string, label: string): string {
  if (typeof raw !== "string") reject("unreadable", `${where}.${label} 必须是字符串，实际是 ${describe(raw)}`);
  if (raw.trim() === "") reject("unreadable", `${where}.${label} 不能为空`);
  if (hasControlChars(raw)) reject("unreadable", `${where}.${label} 不能含控制字符（会打乱终端排版）`);
  return raw;
}

/** 提供商的 `id`：非空且**不含 `/`** */
function providerId(raw: unknown, where: string): string {
  const value = identifier(raw, where, "providerId");
  // ⚠️ 模型存储键按**第一个** `/` 切，providerId 里再有一个 `/` 的话那个键会被切错，
  // 于是「选中的模型」指向另一个 provider，而界面上两者一模一样
  if (value.includes("/")) reject("unreadable", `${where}.providerId 不能含「/」`);
  return value;
}

/** API 格式：必须是 {@link MODEL_API_FORMATS} 里的一档（文案点的是**合法档位**而不是用户敲的那几个字） */
function apiFormat(raw: unknown, where: string): ModelApiFormat {
  const hit = typeof raw === "string" ? MODEL_API_FORMATS.find((one) => one === raw) : undefined;
  if (hit === undefined) {
    reject("unreadable", `${where}.api 必须是 ${MODEL_API_FORMATS.join(" / ")} 之一`);
  }
  return hit;
}

/** 一格凭据：非空；⚠️ **文案一个字都不许描述它**（`describe` 会把字符串原样打出来） */
function apiKey(raw: unknown, where: string): string {
  if (typeof raw !== "string") reject("unreadable", `${where}.apiKey 必须是字符串（形状不对，不转述它）`);
  const value = raw.trim();
  if (value === "") reject("unreadable", `${where}.apiKey 不能为空（配了个空串的 provider 一样连不通）`);
  return value;
}

/** 提供商的地址：非空、无控制字符；⚠️ **不归一**（`normalizeBaseUrl` 是控制面那份判据，provider 可以是任何兼容端点） */
function providerBaseUrl(raw: unknown, where: string): string {
  if (typeof raw !== "string") {
    reject("unreadable", `${where}.baseUrl 必须是字符串，实际是 ${describe(raw)}`);
  }
  const value = raw.trim();
  if (value === "") reject("unreadable", `${where}.baseUrl 不能为空`);
  if (hasControlChars(value)) reject("unreadable", `${where}.baseUrl 不能含控制字符（会打乱终端排版）`);
  return value;
}

/** 置顶位：盘上是 INTEGER 0/1（两处都放行，于是手工塞进去的 `true` 也读得回来） */
function pinned(raw: unknown, where: string): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === 0 || raw === 1) return raw === 1;
  reject("unreadable", `${where}.pinned 必须是 0 或 1（置顶位）`);
}

/** 一个提供商（读面与写面共用这一份）；⚠️ `code` 只有 `unreadable` 一档：失败档位不许增殖 */
export function validateProviderRecord(raw: unknown, where = "providers"): ProviderRecord {
  const obj = asObject(raw, where);
  return {
    id: providerId(obj["id"], where),
    name: normalizedName(obj["name"], "unreadable", `${where}.name`),
    baseUrl: providerBaseUrl(obj["baseUrl"], where),
    api: apiFormat(obj["api"], where),
    apiKey: apiKey(obj["apiKey"], where),
  };
}

/** 一个模型（⚠️ `modelId` 是协议标识，它**可含 `/`**；能显示的是 `label`） */
export function validateModelRecord(raw: unknown, where = "provider_models"): ModelRecord {
  const obj = asObject(raw, where);
  return {
    providerId: providerId(obj["providerId"], where),
    modelId: identifier(obj["modelId"], where, "modelId"),
    label: normalizedName(obj["label"], "unreadable", `${where}.label`),
    pinned: pinned(obj["pinned"], where),
  };
}

/** 一个会话选的模型键：`null` = 没选；非空时必须能被 {@link splitModelRef} 拆成一对 */
function modelRefOf(raw: unknown, where: string): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || splitModelRef(raw) === null) {
    reject("unreadable", `${where}.modelRef 必须是 <提供商 id>/<模型 id> 或 null`);
  }
  return raw;
}

/** 一个会话选的模型与推理强度（⚠️ 判的是「键能不能被拆回来」，**不**判那个 provider 还在不在） */
export function validateSessionModelRef(raw: unknown, where = "sessions"): SessionModelRef {
  const obj = asObject(raw, where);
  const reasoning = obj["reasoning"];
  const hit = typeof reasoning === "string" ? REASONING_EFFORTS.find((one) => one === reasoning) : undefined;
  if (hit === undefined) {
    reject("unreadable", `${where}.reasoning 必须是 ${REASONING_EFFORTS.join(" / ")} 之一`);
  }
  // ⚠️ 悬空的键**放行**：provider 被删掉之后那个会话仍要能显示「没选」，而拦住写入只会让人改不掉
  return { modelRef: modelRefOf(obj["modelRef"], where), reasoning: hit };
}