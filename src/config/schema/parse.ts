/**
 * 原始标量解析原语：字符串 → 字段标量值。
 *
 * 本模块只做「一个字符串解析成什么标量」，不认识任何具体字段名，因此零字段表依赖。
 * 所有解析器统一约定：返回 `undefined` 表示**非法**，由上层（`validate.ts` / `loadConfig`）
 * 统一报错阻止启动——显式给出的非法值一律不静默回退。
 *
 * 布尔实现全项目只有 `toBoolean` 一份（`FIELDS` 与 `loadConfig` 共用），禁止再写第二份。
 */

/** 字符串（永非法） */
export const parseStr = (v: string): string => v;

/**
 * 有限数值（空串/NaN/Infinity 视为非法，回退默认）；
 * 接受 0x/1e3 等 Number() 面，小数/越界不拦，由字段表 int 约束最终校验
 */
export const parseNum = (v: string): number | undefined => {
  if (v.trim() === "") {
    return undefined;
  }
  const n = Number(v);
  if (Number.isFinite(n)) {
    return n;
  }
  return undefined;
};

/** 枚举：大小写不敏感白名单 */
export const parseEnum =
  <T extends string>(values: readonly T[]) =>
  (v: string): T | undefined => {
    const s = v.toLowerCase().trim();
    if ((values as readonly string[]).includes(s)) {
      return s as T;
    }
    return undefined;
  };

/**
 * 字符串转布尔。
 *
 * 无法识别时返回 undefined，让显式配置值在统一字段解析阶段报错，而不是静默变成 false。
 */
export function toBoolean(value: string): boolean | undefined {
  const v = value.toLowerCase().trim();
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(v)) {
    return true;
  }
  if (["false", "0", "no", "off", "disable", "disabled"].includes(v)) {
    return false;
  }
  return undefined;
}
