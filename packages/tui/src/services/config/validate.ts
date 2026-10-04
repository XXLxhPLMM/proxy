/**
 * @fileoverview 台账的**形状判据**：磁盘形态与用户输入面各一份，加上本层唯一的失败类型；⚠️ 读面「坏内容即拒」**绝不**降级成空台账，⚠️ `selected` 指向不存在的 id 是**报错**而不是「静默置 null」
 */

import { TuiError } from "@/lib/errors.js";
import { normalizeBaseUrl } from "@/lib/http.js";
import {
  NAME_MAX_LEN,
  TIMEOUT_BOUNDS,
  type Ledger,
  type Target,
  type TargetInput,
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