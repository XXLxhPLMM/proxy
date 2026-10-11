/**
 * @fileoverview 纯数据结构的深遍历两件套：`deepFreeze`（冻到叶子）/ `deepEqual`（结构相等）
 * @module lib/obj-util
 * @description 与业务无关：配置快照、状态快照那类「值就是全部」的纯数据都用它。
 * ⚠️ 只认 JSON 形状（对象 / 数组 / 原始值）：`Map` / `Date` / class 实例那类**身份型**对象不在射程内，
 * 硬比会给出误导性的结论。
 */

/** 深冻结（原地冻 + 原样返回；`null` / 原始值直接放过） */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** 深比较两个纯 JSON 形状的值是否结构相等 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
