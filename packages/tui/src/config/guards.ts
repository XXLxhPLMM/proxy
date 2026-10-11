/**
 * @fileoverview 配置校验的三个通用原语：顶层与各节共用——认不得的项、类型不对都当场抛
 * @module config/guards
 * @description 抛出的消息带文件路径与位置（`顶层` / `database` …），报错直接指到出事的那一格。
 */

/** 必须是普通对象（不是 null / 数组 / 标量） */
export function requireRecord(value: unknown, file: string, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file}：${where} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

/** 必须是非空字符串 */
export function requireString(value: unknown, file: string, where: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${file}：${where} 必须是非空字符串`);
  }
  return value;
}

/** 只许认下的键（防手误写错键名后被静默忽略） */
export function assertKeys(record: Record<string, unknown>, allowed: readonly string[], file: string, where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`${file}：${where} 认不得配置项 "${key}"（可用：${allowed.join(" / ")}）`);
    }
  }
}
