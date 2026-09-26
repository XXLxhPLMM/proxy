/**
 * 表驱动的字段校验 - 全部「遍历 FIELDS 得出结论」，不持有任何规则
 *
 * 与 `fields.ts` 的分工：表数据与查询在那边，这里只回答「一组已解析（或已 typed）
 * 的值里哪些字段非法」。所有规则都从字段定义读取，本文件不允许出现第二份
 * 枚举、第二份范围、第二份必填清单。
 *
 * 两个入口形态：
 * - `resolveFieldEntries` / `collectIntRangeErrors`：处理 **字符串来源**（CLI / env 文件 / 终端 env）
 * - `validateFieldValue` / `collectFieldValueErrors`：处理 **已通过类型系统的 runtime 值**（reload patch）
 * 两者共用同一批 parse 与 int 约束，因此 runtime 改值和启动期读文件的判定完全一致。
 */
import { defaults } from "../defaults.js";
import type { ConfigKey } from "../types.js";
import { FIELDS, getFieldDef } from "./fields.js";
import type { ConfigFieldPhase } from "./field.js";

export interface FieldValueValidation {
  readonly valid: boolean;
  /** 归一后的值；仅 valid=true 时有意义。 */
  readonly value?: unknown;
  /** 不包含原始输入值，避免密码/token 被错误消息带走。 */
  readonly error?: string;
}

/**
 * 校验一个已经通过类型系统进入 runtime 的字段值。
 *
 * 运行时 API 接收的是 AppConfig 值而不是 env 字符串，但仍复用 FIELDS 的
 * parse 规则：枚举会归一到表中的规范值，字符串/URL 走同一解析器，数字和
 * 布尔先做运行时类型检查。整数上下界仍由 collectIntRangeErrors 统一检查。
 */
export function validateFieldValue(key: ConfigKey, value: unknown): FieldValueValidation {
  const definition = getFieldDef(key);
  if (definition === undefined) {
    return { valid: false, error: "未知配置字段" };
  }

  // 显式清空某些可选字符串（如 upstreamUrl/preset）是合法操作；默认值本身
  // 不需要再次经过可能拒绝空串的 parse（例如 PRESET 枚举）。
  if (Object.is(value, defaults[key])) {
    return { valid: true, value };
  }

  if (typeof value === "string") {
    if (typeof defaults[key] !== "string") {
      return { valid: false, error: `${definition.env} 值非法` };
    }
    const parsed = definition.parse(value);
    return parsed === undefined
      ? { valid: false, error: `${definition.env} 值非法` }
      : { valid: true, value: parsed };
  }

  if (typeof value === "number") {
    if (typeof defaults[key] !== "number") {
      return { valid: false, error: `${definition.env} 值非法` };
    }
    // parse 负责 NaN/Infinity/非数值等基础拒绝；保留原始数值，随后由
    // collectIntRangeErrors 统一执行整数与上下界检查，避免悄悄截断小数。
    return definition.parse(String(value)) === undefined
      ? { valid: false, error: `${definition.env} 值非法` }
      : { valid: true, value };
  }

  if (typeof value === "boolean") {
    if (typeof defaults[key] !== "boolean" || definition.parse(String(value)) === undefined) {
      return { valid: false, error: `${definition.env} 值非法` };
    }
    return { valid: true, value };
  }

  return { valid: false, error: `${definition.env} 值非法` };
}

/** 对候选快照逐字段执行表驱动校验；返回 env 名，不回显原始值。 */
export function collectFieldValueErrors(
  resolved: Record<string, unknown>,
  phase?: ConfigFieldPhase,
): string[] {
  const bad: string[] = [];
  for (const definition of FIELDS) {
    if (phase !== undefined && definition.phase !== phase) {
      continue;
    }
    if (!(definition.key in resolved)) {
      continue;
    }
    if (!validateFieldValue(definition.key, resolved[definition.key]).valid) {
      bad.push(definition.env);
    }
  }
  return bad;
}

/**
 * 整数范围校验（initConfig 与 parseStartupArgs 共用）
 * @description 遍历 FIELDS 的 `int` 约束，对已出现在 resolved 表中的字段检查整数性与上下界，
 * 返回 `ENV=value` 形式的越界清单（空数组表示全部合法）；未出现在表中的字段跳过（parseStartupArgs 只含显式提供的键）
 * @param resolved - 已解析的字段表（键为 `ConfigKey`）
 * @returns 越界字段的 `ENV=value` 列表
 * @example collectIntRangeErrors({ port: 70000 }) // => ["PORT=70000"]
 */
export function collectIntRangeErrors(resolved: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const d of FIELDS) {
    if (d.int === undefined || !(d.key in resolved)) {
      continue;
    }
    const v = resolved[d.key] as number;
    const { min, max } = d.int;
    if (!Number.isInteger(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
      bad.push(`${d.env}=${v}`);
    }
  }
  return bad;
}

/**
 * 按 FIELDS 逐字段解析一组原始 env 键值（initConfig 与 parseStartupArgs 共用）
 * @description 遍历 `FIELDS`，对 `source(env)` 返回的每个已给出的原始值调用字段的 `parse`：
 * 成功写入 `resolved[d.key]`，失败记入 `bad`（`ENV=value` 形式，空数组表示全部合法）；
 * 只收录显式提供的键——默认值回退与抛错留给调用方各自的后处理
 * （initConfig 补 def/defaults 并另带文件错误消息，parseStartupArgs 仅显式表解析）
 * @param source - 按 env 名取原始值的回调（返回 undefined 表示未提供）
 * @returns 已解析字段表 `resolved` 与非法项清单 `bad`
 * @example resolveFieldEntries((env) => rawCli[env] ?? process.env[env])
 */
export function resolveFieldEntries(source: (env: string) => string | undefined): {
  resolved: Record<string, unknown>;
  bad: string[];
} {
  const resolved: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const d of FIELDS) {
    // 显式给出的值（CLI 优先于 env）一律不允许静默丢弃：解析失败记入 bad，由调用方统一抛错
    const raw = source(d.env);
    if (raw === undefined) {
      continue;
    }
    const parsed = d.parse(raw);
    if (parsed === undefined) {
      bad.push(`${d.env}=${raw}`);
      continue;
    }
    resolved[d.key] = parsed;
  }
  return { resolved, bad };
}
