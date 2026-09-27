/**
 * 所有解析器统一约定：返回 `undefined` 表示**非法**，由上层（`validate.ts` / `loadConfig`）
 * 统一报错阻止启动——显式给出的非法值一律不静默回退。
 *
 * 布尔实现全项目只有 `toBoolean` 一份（`FIELDS` 与 `loadConfig` 共用），禁止再写第二份。
 */

/** 字符串原样返回（唯一永不返回 undefined 的解析器，故永远不会进 `bad` 清单） */
export const parseStr = (v: string): string => v;

/**
 * 有限数值；空串 / NaN / Infinity 一律 undefined，**由上层抛错阻止启动，不回退默认**
 * （护栏：`config-loader.test.ts`「显式非法值和越界值不静默回退」）。
 * 接受 0x / 1e3 等 `Number()` 面；小数与越界本层不拦，由字段表 `int` 约束最终校验。
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
