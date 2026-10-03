/**
 * @fileoverview 人读形态的格式化（**纯函数**）；⚠️ 非法输入**抛**不装、两种事实不许同形、显示层不做换算
 */

import stringWidth from "string-width";

/** 「这里没有值」的**唯一**写法（整屏只准有这一个空形态） */
export const EM_DASH = "—";

/** 「不限流」（`0` 字节配额）的**唯一**写法 */
export const UNLIMITED = "∞";

/** 已下发凭据的打码形态（**固定长度**） */
// ⚠️ 固定长度是**纪律**：打码串的长度若与真实长度成正比，长度就成了一个可以二分的信号。
export const MASKED = "••••••";

/** 字节单位（1024 进制，末尾一档够用到zettabyte 之前的所有实际值） */
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] as const;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 文本的**显示宽度**（本包唯一的度量入口） */
export function widthOf(text: string): number {
  return stringWidth(text);
}

/** 把「非负有限数」以外的输入变成一次明确的失败 */
// ⚠️ 这里**不是** `if (bad) return String(x)`：那是把上游的 bug 渲染成一个看起来合法的数。
function requireNonNegative(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${what} 只接受非负有限数，收到 ${String(value)}`);
  }
  return value;
}

/** 去掉一位小数末尾的 `.0`（假精度）：`1.0` → `1` */
function trimFixed(text: string): string {
  return String(Number(text));
}

/** 字节数的人读形态（1024 进制，一位小数，无 `.0`；⚠️ 刻意**不带精确字节数**，否则一列里数字的个位比量级还多） */
export function bytes(n: number): string {
  requireNonNegative(n, "字节数");
  if (n < 1024) {
    return `${Math.floor(n)} B`;
  }
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${trimFixed(value.toFixed(1))} ${BYTE_UNITS[unit]}`;
}

/**
 * 时长的人读形态：**只给两位**（天/小时、小时/分、分/秒；位数递减是一一对应）
 * @param ms - 毫秒数（**非负**）
 * @throws RangeError `ms` 为负数、`NaN` 或无穷
 */
export function duration(ms: number): string {
  requireNonNegative(ms, "时长");
  const total = Math.floor(ms);
  if (total < MINUTE) {
    return `${trimFixed((total / SECOND).toFixed(1))}s`;
  }
  if (total < HOUR) {
    const m = Math.floor(total / MINUTE);
    const s = Math.floor((total % MINUTE) / SECOND);
    return s === 0 ? `${m}m` : `${m}m${s}s`;
  }
  if (total < DAY) {
    const h = Math.floor(total / HOUR);
    const m = Math.floor((total % HOUR) / MINUTE);
    return m === 0 ? `${h}h` : `${h}h${m}m`;
  }
  const d = Math.floor(total / DAY);
  const h = Math.floor((total % DAY) / HOUR);
  return h === 0 ? `${d}d` : `${d}d${h}h`;
}

/** 已运行时长（⚠️ `null` 不是 `0`：它表示**这个进程不持有数据面**，显示成 `0s` 等于宣称「它刚起来」） */
export function uptime(ms: number | null): string {
  return ms === null ? EM_DASH : duration(ms);
}

/** 时刻的显示：**原样透传**，不做时区换算 */
// ⚠️ 换算成本地时间看着更亲切，代价是给「同一时刻」两种说法，而配额到期判定按绝对时刻做；⚠️ 空串
// 也走 {@link EM_DASH} —— 它是「没有时刻」的另一种写法。
export function isoOrNull(iso: string | null): string {
  return iso === null || iso === "" ? EM_DASH : iso;
}

/** 配额的百分比形态（⚠️ **`total === 0` 是「不限流」**而不是除零；⚠️ **不夹逼到 100**） */
export function percent(used: number, total: number): string {
  requireNonNegative(used, "已用量");
  requireNonNegative(total, "配额");
  if (total === 0) {
    return UNLIMITED;
  }
  return `${((used / total) * 100).toFixed(1)}%`;
}

/** 已下发的 token / 密钥的显示（⚠️ **固定长度**；`""` → `—`：「没配」与「配了但不给你看」必须能分开） */
export function maskToken(token: string): string {
  return token === "" ? EM_DASH : MASKED;
}

/** 按**显示宽度**截断并补 `…`（⚠️ 保证结果宽度 `<= width`：宁可少一个字形也不越出位置） */
// ⚠️ 按 code point（`for…of`）走：不按 UTF-16 code unit 的话一个代理对会被劈成两半，屏上出现豆腐块。
export function ellipsis(s: string, width: number): string {
  return fitTo(s, width).text;
}

/** 按显示宽度截断，**并报出裁过没有**（本包**唯一**的裁剪实现） */
// ⚠️ 判据必须在**裁之前**下：裁完的串宽恰好等于上限；`ellipsis` 是本函数的薄包装，不许各写一份算术。
export function fitTo(s: string, width: number): { text: string; clipped: boolean } {
  if (width <= 0) {
    return { text: "", clipped: stringWidth(s) > 0 };
  }
  if (stringWidth(s) <= width) {
    return { text: s, clipped: false };
  }
  if (width === 1) {
    return { text: "…", clipped: true };
  }
  const budget = width - 1;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const w = stringWidth(ch);
    if (used + w > budget) {
      break;
    }
    out += ch;
    used += w;
  }
  return { text: `${out}…`, clipped: true };
}

/** 对齐方式（字节数、毫秒右对齐是**呈现决定**，故归本层） */
export type Align = "left" | "right";

/** 按**显示宽度**补空格到 `width` */
// ⚠️ **不在这里截断**（截断只有 {@link ellipsis} 一个出口）；⚠️ 右对齐补的是**空格**且按**显示宽度**
// 数 —— 按 `String.padStart` 会让中文右对齐整列歪掉。
export function padToWidth(s: string, width: number, align: Align): string {
  if (width <= 0) {
    return "";
  }
  const gap = width - stringWidth(s);
  if (gap <= 0) {
    return s;
  }
  const pad = " ".repeat(gap);
  return align === "right" ? `${pad}${s}` : `${s}${pad}`;
}

/** 「没值」的唯一形态（⚠️ **空串保持空串**：「配了个空」与「没配」是两件事） */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined ? EM_DASH : String(value);
}

/** 开关型布尔的显示：**「开」/「关」**（刻意不是「是/否」：表里补不起宾语） */
export function onOff(value: boolean): string {
  return value ? "开" : "关";
}
