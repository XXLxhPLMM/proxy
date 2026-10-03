/**
 * @fileoverview 人读形态的格式化（**纯函数**，本目录最需要被测的一块）
 * @module ui/format
 * @description
 * 本模块把「数字 / 时刻 / 布尔」变成**一列宽的文本**。它必须是纯函数，原因与
 * `src/admin/out.ts` 相同：命令层的输出要在单测里逐字断言，捕获 `console` 是一种会漏
 * （异步交错、格式化被重定向）的间接做法 —— 而这里更甚一层，Ink 组件在测试里渲染要起
 * stdin/stdout，把判据挪到纯函数上，列宽与截断才有牙齿。
 *
 * ## 三条贯穿全模块的纪律
 * @description
 * 1. **非法输入抛，不装。** 一个 `NaN` 落在用量列里，操作者会把它读成「这个数我不知道」，
 *    而真相是「上游给坏了」。把坏数据渲染成一个看起来像数据的字符串，就是**用假事实换掉
 *    界面**，所以 {@link bytes} / {@link duration} / {@link percent} 一律 `RangeError`。
 *    （`src/admin/out.ts:formatBytes` 刻意选择原样回显，那是**一次性打印**的另一个判断：
 *    那里坏数据只污染一行，这里坏数据每 200ms 重绘一次。）
 * 2. **两种不同的事实不许渲染成同一个值，也一种不许渲染成三个空形态。** 故 {@link dash}
 *    把 `null` / `undefined` **统一**成 `—`（一个符号说「这里没值」），而空串**保持空串**
 *    （「配了个空」与「没配」是两件事，见 `src/admin/out.ts:renderPairs` 同源纪律）。
 * 3. **显示层不做换算。** {@link isoOrNull} 原样透传服务端给的 ISO 串：在显示层把带偏移的
 *    时刻换算成本地时间，就等于给「同一时刻」两种说法，两种说法迟早会在某张截图里对上，
 *    然后没人说得清哪个是当时看到的。
 *
 * ## 度量一律走 `string-width`，不走 `String.length`
 * @description `账号` 的 `length` 是 2、显示宽度是 4；`😀` 的 `length` 是 2、宽度也是 2；
 * 组合字符的 `length` 常常大于显示宽度。按 `length` 排版，中文表格必然歪、emoji 必然溢出。
 * 故本模块的每一个宽度判断都过 {@link widthOf}。
 *
 * @module
 */

import stringWidth from "string-width";

/** 「这里没有值」的**唯一**写法（整屏只准有这一个空形态） */
export const EM_DASH = "—";

/** 「不限流」（`0` 字节配额）的**唯一**写法 */
export const UNLIMITED = "∞";

/**
 * 已下发凭据的打码形态（**固定长度**）
 * @description ⚠️ 固定长度是**纪律**，不是省事：打码串的长度若与真实长度成正比，长度就成了一个
 * 可以二分的信号 —— 与 `src/manager/http/auth.ts` 「比摘要而不是比原串，好让长度不外泄」
 * 同源。那条纪律管的是时序侧，本条管的是**屏幕侧**：两条的结论一致。
 */
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

/**
 * 把「非负有限数」以外的输入变成一次明确的失败
 * @description
 * ⚠️ 这里**不是** `if (bad) return String(x)`：那是把上游的 bug 渲染成一个看起来合法的数，
 * 而一个看起来合法的数会被拿去对账、会被拿去告警、会被抄进工单。见文件头纪律 1。
 */
function requireNonNegative(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${what} 只接受非负有限数，收到 ${String(value)}`);
  }
  return value;
}

/**
 * 去掉一位小数末尾的 `.0`（假精度）
 * @description `1.0` → `1`、`1.5` → `1.5`。表格里的一列写 `1.0 KiB` 只是在给列宽多加一位。
 */
function trimFixed(text: string): string {
  return String(Number(text));
}

/**
 * 字节数的人读形态（1024 进制，一位小数，无 `.0`）
 * @description
 * ⚠️ **刻意不像 `src/admin/out.ts:formatBytes` 那样带上精确字节数**：那边的形态是为了对账
 * （`1073741824 B (1.0 GiB)`，精确值在前），而这里是一列 —— 一列里每个数都带十位精确值的话，
 * 数字的个位比它的量级还多，那列就没人读了。需要精确值的那一处是「账号详情」的单行键值表，
 * 它自己写完整形态，不复用本函数。
 *
 * @param n - 字节数（**非负**；`0` 是合法值，表示「不限流」时该显示的是配额列的 `∞`，不是字节数）
 * @throws RangeError `n` 为负数、`NaN` 或无穷
 * @example bytes(0) // => "0 B"
 * @example bytes(1536) // => "1.5 KiB"
 */
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
 * 时长的人读形态：**只给两位**（天/小时、小时/分、分/秒）
 * @description
 * 刻意**不给秒以下**：一个控制面读数的秒级以下精度没有任何决策价值，而一位小数（`1.5s`）
 * 在「刚失败、正在重试」那一段是需要的 —— 那正是秒级唯一有意义的场景。
 * 位数递减是天生的一一对应：看到 `1d2h` 就知道它后面没有 `m`；看到 `2m` 就知道秒是 0
 * （而不是「没显示」—— 那与 `dash` 统一空形态是同一条纪律）。
 *
 * @param ms - 毫秒数（**非负**）
 * @throws RangeError `ms` 为负数、`NaN` 或无穷
 * @example duration(0) // => "0s"
 * @example duration(90_000) // => "1m30s"
 * @example duration(90_000_000) // => "1d1h"
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

/**
 * 已运行时长；⚠️ **「没在监听」没有运行时长**
 * @description
 * `null` 不是 `0`：`StatusBody.proxy.uptimeMs` 为 `null` 表示**这个进程不持有数据面**
 * （cluster master 那类部署：端口由 worker 持有）。把它显示成 `0s` 等于宣称「它刚起来」，
 * 而 {@link EM_DASH} 说的是「这里没有这个数」—— 后者才是真的。
 *
 * @param ms - `StatusBody.proxy.uptimeMs` 的原值
 */
export function uptime(ms: number | null): string {
  return ms === null ? EM_DASH : duration(ms);
}

/**
 * 时刻的显示：**原样透传**，不做时区换算
 * @description
 * 服务端给的是**带偏移的 ISO 串**（`AccountBody.expiresAtIso`，服务端由
 * `new Date(...).toISOString()` 生成）。换算成本地时间看着更亲切，代价是给「同一时刻」两种
 * 说法 —— 而配额的到期判定是按绝对时刻做的，操作者拿本地时间去核一个绝对时刻时，差的那几个小时
 * 会变成一次「过期了却还能用」的假事故。
 * ⚠️ 空串也走 {@link EM_DASH}：空串不是一个时刻，它是「没有时刻」的另一种写法，与 `null`
 * 语义相同（收敛，不是丢信息）。
 */
export function isoOrNull(iso: string | null): string {
  return iso === null || iso === "" ? EM_DASH : iso;
}

/**
 * 配额的百分比形态
 * @description
 * ⚠️ **`total === 0` 是「不限流」，不是「除零」**：`AuthAccount.quota.bytes` 的 `0` 就是这个
 * 意思（见 `@/api/types.ts:AccountBody` 与服务端同一条纪律）。把它当分母算出来的是
 * `NaN`，而一列 `NaN` 会被读成「这个数我不知道」—— 于是**唯一确定的事实**（不限流）在界面上
 * 变成了未知。故这里是 {@link UNLIMITED}。
 * ⚠️ **不夹逼到 100**：超配额（`used > total`）是**必须看得见的**事实，夹掉它就等于把一次
 * 超额用得毫无痕迹。
 *
 * @param used - 已用
 * @param total - 配额（`0` = 不限流）
 * @throws RangeError 任一为负数或非有限数
 * @example percent(1, 0) // => "∞"
 * @example percent(512, 1024) // => "50.0%"
 */
export function percent(used: number, total: number): string {
  requireNonNegative(used, "已用量");
  requireNonNegative(total, "配额");
  if (total === 0) {
    return UNLIMITED;
  }
  return `${((used / total) * 100).toFixed(1)}%`;
}

/**
 * 已下发的 token / 密钥的显示
 * @description ⚠️ **固定长度，不透露长度**：见 {@link MASKED}。`""` → {@link EM_DASH}
 * （「没配凭据」与「配了一个凭据」必须能分开，否则 `unauthorized` 会被误读成 token 错了）。
 */
export function maskToken(token: string): string {
  return token === "" ? EM_DASH : MASKED;
}

/**
 * 按**显示宽度**截断并补 `…`
 * @description
 * ⚠️ 按 **code point** 走（`for…of`），不按 UTF-16 code unit：后者会把一个代理对劈成两半，
 * 屏幕上出现一个替换字符（豆腐块），而且补齐宽度时按 2 算、按 1 打印。
 * ⚠️ 本函数**保证结果宽度 `<= width`**：一个宽度 2 的字符在只剩 1 格时整字丢弃，绝不切半 ——
 * 宁可少一个字形，也不让这一列越出它占的位置。
 *
 * @param s - 原串
 * @param width - 可用显示宽度（`<= 0` 一律返回空串）
 */
export function ellipsis(s: string, width: number): string {
  return fitTo(s, width).text;
}

/**
 * 按显示宽度截断，**并报出裁过没有**（本包**唯一**的裁剪实现）
 * @description
 * 判据必须在**裁之前**下：裁完的串宽恰好等于上限（省略标记刚好补上那一格），
 * 于是「裁过没有」由裁后串比不出来。而 {@link log.ts} 那一层要靠它决定要不要说「已截断」，
 * 有了它就不必在调用处重写一遍「要不要说」。
 *
 * ⚠️ `ellipsis` 是本函数的薄包装（不报标志的那个形状）。两者**不许**各写一份宽度算术 ——
 * 那会让「表格截断」与「日志截断」在中文行上给出不同结果。
 */
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

/**
 * 按**显示宽度**补空格到 `width`
 * @description
 * ⚠️ **不在这里截断**：截断只有 {@link ellipsis} 一个出口。两处都做就会有两个「切」的位置，
 * 而调用方分不清自己那一格是被切了还是被补了。`planColumns` 里两者按
 * 「先 {@link ellipsis} 再 {@link padToWidth}」的固定顺序调用（本层的纪律：切与补是两个动作）。
 * ⚠️ 右对齐补的是**空格**、按**显示宽度**数：中文右对齐若按 `String.padStart` 补，中文那几格
 * 会比它实际占的窄，整列就歪了。
 */
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

/**
 * 「没值」的唯一形态
 * @description
 * ⚠️ **空串保持空串**（见文件头纪律 2）：`AuthAccount.quota` 缺省是「不限流」而 Windows 上
 * 「配了个空文件」也是空表 —— 那两种在本层看到的都是 `""`，但它们由上层各自的页面分别渲染，
 * 本函数不该替它们决定。**只**把「压根没有这个值」收敛成一个符号。
 */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined ? EM_DASH : String(value);
}

/**
 * 开关型布尔的显示：**「开」/「关」**
 * @description
 * 刻意不是「是/否」：`AccountBody.disabled` 那一列的表头已经写着 `disabled`，配「是」要再补
 * 一个宾语才读得通，而表里补不起宾语。「开/关」把它读成开关本身。
 */
export function onOff(value: boolean): string {
  return value ? "开" : "关";
}
