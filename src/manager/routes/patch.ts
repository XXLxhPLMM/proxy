/**
 * @fileoverview HTTP 请求体 → `@/ops` 的 `AccountPatch` 词汇
 * @module manager/routes/patch
 * @description
 * `AccountPatch` 是**数据的词汇**（`@/ops/accounts.ts` 定义，读写两面都要用），而
 * 「JSON 请求体长什么样」是**传输层的词汇**。本模块只做后者的活：把一份 `unknown` 的
 * JSON 对象读成 `AccountPatch`，并把「这个键拼错了」当场拒掉。
 *
 * ## 为什么这里**不**重写任何一条语义判据
 *
 * `expiresAt` 的时刻形态、`quota` 的字段依附关系、`targetWhitelist` 的条目语法——全部
 * 由 `@/ops` 的 `applyPatch` 与数据源层的 `validateAuthUsers` 判（理由见 ops 与
 * `datasource/users/validate.ts` 的文件头：判据的第二份真相源正是「写得进去、读不出来」的
 * 来源）。本模块只判**JSON 形状**：`quotaBytes` 是不是 number、`disabled` 是不是 boolean、
 * 键名在不在白名单里。这些判据在本层是**必要的**，因为 `unknown` 到 TS 类型之间必须有
 * 一次显式收窄——否则「`quotaBytes: "42"`（字符串）」会一路走到 `applyPatch` 才炸，
 * 而那里报的是「字段互相依附」这类与真实原因无关的错。
 *
 * ## 未知键一律拒（不是忽略）
 *
 * `{"quota": 42}`（键名拼错）被静默忽略的后果是：调用方拿到 200 + 「已更新」，
 * 而磁盘上**一个字节都没变**。这正是本仓最恨的假绿。故白名单外的键抛
 * `OpsError("invalid")` → HTTP 400。
 *
 * 本模块**零 console、零 process**、不 import `@/admin/*`。
 *
 * @module
 */

import { OpsError, type AccountPatch } from "@/ops/index.js";

/** `AccountPatch` 的键白名单（**闭合集**：改 ops 的词汇必须改这里，反之亦然） */
const PATCH_KEYS: ReadonlySet<string> = new Set([
  "password",
  "quotaBytes",
  "quotaWindow",
  "expiresAt",
  "disabled",
  "targetWhitelist",
  "targetBlacklist",
]);

/** `quotaWindow` 的取值（含 `clear`；`day` / `month` 之外的判据归数据源） */
const WINDOWS: ReadonlySet<string> = new Set(["day", "month", "clear"]);

/** `expiresAt` 的取值（`clear` = 删键；其余是带时区偏移的 ISO 串，形态判据归数据源） */
const EXPIRY: ReadonlySet<string> = new Set(["clear"]);

function fail(message: string): never {
  throw new OpsError("invalid", message);
}

/** `number | "clear"`：本层只判「是 number 或 clear」，**非负安全整数**由 `validateAuthUsers` 判 */
function readQuotaBytes(value: unknown): number | "clear" {
  if (value === "clear") {
    return "clear";
  }
  if (typeof value === "number") {
    return value;
  }
  return fail("quotaBytes 只能是非负整数（字节）或字符串 \"clear\"");
}

/** `"day" | "month" | "clear"` —— 闭合集就三个值，这里判掉拼错的 */
function readQuotaWindow(value: unknown): "day" | "month" | "clear" {
  if (typeof value === "string" && WINDOWS.has(value)) {
    return value as "day" | "month" | "clear";
  }
  return fail('quotaWindow 只能是 "day" / "month" / "clear"');
}

/** 字符串或 `"clear"`；ISO 形态判据归 `normalizeAccountExpiry` */
function readExpiresAt(value: unknown): string | "clear" {
  if (typeof value === "string") {
    if (EXPIRY.has(value)) {
      return "clear";
    }
    return value;
  }
  return fail('expiresAt 只能是带时区偏移的 ISO 8601 串（如 2030-01-01T00:00:00+08:00）或 "clear"');
}

/** 字符串数组；元素形状（是不是合法 host / IP）由 `validateAuthUsers` 判 */
function readEntryList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return fail(`${key} 必须是字符串数组（空数组 = 清空这份名单）`);
  }
  return value as string[];
}

/**
 * 把一份 JSON 对象读成 `AccountPatch`
 * @description
 * 逐键收窄，**不认识的键抛 `invalid`**。已出现的键**逐字保留**给 `applyPatch`
 * （那里才做「字段依附 / 条目语法 / 时刻形态」的判据）。
 *
 * @param body - 请求体（`RequestContext.body`）
 * @returns `AccountPatch`
 * @throws {OpsError} `invalid`：键名拼错 / 值类型不符
 * @example accountPatchFrom({ quotaBytes: 1024, disabled: true })
 *   // => { quotaBytes: 1024, disabled: true }
 * @example accountPatchFrom({ quota: 1024 }) // => throws OpsError("invalid")
 */
export function accountPatchFrom(body: Record<string, unknown>): AccountPatch {
  const patch: {
    -readonly [K in keyof AccountPatch]: AccountPatch[K];
  } = {};

  for (const [key, value] of Object.entries(body)) {
    if (!PATCH_KEYS.has(key)) {
      fail(
        `未知字段 ${key}；可改的字段是 ${[...PATCH_KEYS].sort().join(" / ")}`,
      );
    }
    switch (key) {
      case "password":
        if (typeof value !== "string") {
          fail("password 必须是字符串");
        }
        patch.password = value;
        break;
      case "quotaBytes":
        patch.quotaBytes = readQuotaBytes(value);
        break;
      case "quotaWindow":
        patch.quotaWindow = readQuotaWindow(value);
        break;
      case "expiresAt":
        patch.expiresAt = readExpiresAt(value);
        break;
      case "disabled":
        // ⚠️ 判据用 `typeof` 而不是真值：`"false"` / `0` / `null` 静默归一成「启用」正是
        // 「看着配了禁用、实际按没配跑」的假安全感（`validateAuthUsers` 的同一条纪律）。
        if (typeof value !== "boolean") {
          fail("disabled 必须是布尔值（true / false，不吃字符串 \"true\"）");
        }
        patch.disabled = value;
        break;
      case "targetWhitelist":
        patch.targetWhitelist = readEntryList(value, key);
        break;
      case "targetBlacklist":
        patch.targetBlacklist = readEntryList(value, key);
        break;
    }
  }
  return patch;
}
