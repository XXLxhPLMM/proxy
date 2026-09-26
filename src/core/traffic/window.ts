/**
 * @fileoverview 配额窗口的**键计算**：某个时刻属于哪个窗口
 * @module core/traffic/window
 * @description
 * 「配额是每天 / 每月重置」这句话要变成代码，就只需要一件事：**给每个时刻算一个窗口键**。
 * 账本按「用户 + 窗口键」存一份用量，键一变即视为新窗口（见 `./memory.ts` 的惰性滚动）。
 *
 * ## 为什么只有 `day` / `month` 两个字面量（裁决，不是「先占个位」）
 *
 * 账面上看，「30 天内 100GB」这种**滚动窗**是自然的需求。但滚动窗的代价与本项目的
 * 结构直接冲突：
 * - **解释成本**：窗口边界随时间连续滑动，运维看到「已用 98GB / 100GB」时无法回答
 *   「为什么现在被拒了」——按天/按月重置则一眼可答（今天/这个月）。配额是**要被运维
 *   解释**的东西，不是要被数学优雅的东西。
 * - **聚合成本**：滚动窗不能只存一个标量，得存「最近 N 天的每一条日用量」（或滑窗队列），
 *   判定要在队列上求和；而账本还要被**惰性滚动**驱动（无定时器、无后台协程），滚动聚合
 *   在「跨 30 次窗口切换」这件事上无法用「滚动即清账」一句话收口。
 * - **本项目处于设计期**：不需要「预留占位值」。真出现滚动窗需求时，正确做法是**连同
 *   账本形态一起设计**（滑窗队列 + 明确的落盘格式），而不是现在塞一个 `window: "rolling"`
 *   却让它按日历窗语义跑——那会造出「配了 rolling、行为其实还是 month」的假安全感。
 *
 * 故本期只认 `day` / `month` 两个**日历窗**，其它值（`"week"` / `"hour"` / 非字符串）在
 * `config/files/users.ts:validateUserQuota` 判**整组非法 → 启动期 abort**。
 *
 * ## 语义：先减 `shiftHours` 小时，再取本地日历字段
 *
 * `shiftHours` = `QUOTA_RESET_HOUR`（0..23，本地时区）。所以 `resetHour=3` 时，
 * 当天 `01:00` 仍属于**前一天**的窗口，`03:00` 才是新窗口的第一刻。
 * 键形态：`day` → `YYYY-MM-DD`，`month` → `YYYY-MM`。
 *
 * **取本地字段（`getFullYear`/`getMonth`/`getDate`）而不是 `toISOString()`**：配额窗口是
 * **运维所在时区**的日历概念，UTC 键会让「今天」在早上 8 点前指错一天。
 *
 * ## 为什么是「减毫秒再读字段」而不是手工日历进位
 *
 * 手工进位（`d -= shiftHours*3600e3` 之后自己算 day-1、月底回 1、闰年 2/29…）是这类代码
 * 经典的事故源：闰年、月末、跨年各有一次特例，漏一个就静默错一天。减毫秒后交给 `Date`
 * 的本地字段，**日历规则由引擎负责**，本文件只关心「往前推 N 小时后是哪一天」。
 *
 * **DST 边界下这是近似（刻意接受并记录）**：夏令时切换会让某一小时在本地重复或消失，
 * 于是「往前推 N 小时」在墙钟上可能落在 `23:00` 或 `01:00` 而不是 `00:00`——窗口切换点
 * 因此最多偏移 1 小时。**这是自觉的取舍**：要精确就得引入时区规则库或自己维护 tzdata，
 * 而配额窗口的诉求是「每天早上大致清零」，为 ±1 小时引入一整条时区依赖链不值得。
 * 护栏按这个取舍断言（`tests/unit/traffic-window.test.ts`：切换点必落在本地午夜 ±1h 内）。
 *
 * ## 零依赖、零 IO
 *
 * 本文件不 import 任何东西（含 `@/config/**`）：它是一枚纯函数，让调用方
 * （`memory.ts`）决定「窗口类型与重置小时从哪来」（配置文件经 `ConfigAccessor` 现读）。
 */

export type QuotaWindow = "day" | "month";

/** 未配 `quota.window` 时的缺省窗口：与 5a 起的语义一致，**按月**重置。 */
export const DEFAULT_QUOTA_WINDOW: QuotaWindow = "month";

/**
 * 归一「该用哪个窗口」：未显式配置 → 缺省 `month`
 * @description
 * **缺省为什么在消费侧而不是校验侧**：`validateUserQuota` 只回显磁盘上写了什么，
 * 缺省时**不写 `window` 键**（写了就等于在归一化产物里塞一个运维没配过的值，
 * 并让「旧文件产物逐字不变」那条不变量失效）。故「缺省 = month」是**消费侧裁决**，
 * 落在这里由账本统一调用，`memory.ts` 因此不出现字面量 `"month"`。
 * @param configured - 磁盘上读到的 `quota.window`（未配 → undefined）
 * @returns 生效的窗口类型
 */
export function quotaWindow(configured: QuotaWindow | undefined): QuotaWindow {
  return configured ?? DEFAULT_QUOTA_WINDOW;
}

/** 一小时的毫秒数（窗口位移的换算基数）。 */
const HOUR_MS = 3_600_000;

/** `QUOTA_RESET_HOUR` 的定义域：本地时区的 24 个整小时。 */
const MAX_SHIFT_HOURS = 23;

/**
 * 把 `shiftHours` 夹到 `[0, 23]`
 * @description
 * **为什么夹取而不是产出畸形键**（这条与「档位键要落盘」直接相关）：
 * `quotaResetHour` 在**配置层**已被 FIELDS 的 `int: { min: 0, max: 23 }` 校验过，越界即
 * 启动期 abort。但**库调用方可以绕过 `loadConfig`**：`createProxyRuntime({ config: … })`
 * 走的是纯内存模式，把 `preset + config` 灌进 `new ConfigStore(...)`，而 `ConfigStore`
 * **零校验**（不跑逐字段解析/范围校验，那是 `loadConfig` 的职责）。所以「配置层保证 0..23」
 * 这条前置条件对库路径**不成立**，`windowKey` 只能自己守住定义域。
 *
 * 不夹取的代价是**具体的**而不是理论上的：键会被写进落盘账本的条目里（`ts` → 窗口键），
 * `NaN-NaN-NaN` 这类畸形值会一路传播成「某个用户当前窗口的键」并参与恢复期的求和判定；
 * 夹到定义域的后果只是「按最近的一个合法边界算窗口」——**位置错了但形状仍然是合法键**，
 * 运维在账本里看到的是 `2026-03-15` 而不是一眼就知道坏掉的 `NaN-NaN-NaN`。
 *
 * **非有限值按 0 夹**（等价于「午夜重置」这一 FIELDS 缺省）：`NaN` 没有可夹的方向，
 * 而 `Infinity`/`-Infinity` 分别夹到 23/0 只会把一个明显的配置错误伪装成「差 23 小时重置」。
 * 正确修法在配置校验层（重启一次即可），本层只保证**不产出畸形键**。
 */
function clampShiftHours(shiftHours: number): number {
  if (!Number.isFinite(shiftHours)) {
    return 0;
  }
  const truncated = Math.trunc(shiftHours);
  if (truncated < 0) {
    return 0;
  }
  return truncated > MAX_SHIFT_HOURS ? MAX_SHIFT_HOURS : truncated;
}

/** 两位补零：月/日在键里必须占两位，否则 `2026-3-5` 与 `2026-03-05` 会是两个键。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 当前时刻所属窗口的键
 * @param nowMs - 时刻（毫秒时间戳）。**必须可注入**：窗口边界是这类代码里最容易写错的
 *   地方，靠真实时钟只能写出「今天大概对」这种测不出回归的用例，故本函数收显式入参、
 *   由调用方（账本）决定时钟源。
 * @param window - 窗口类型
 * @param shiftHours - 窗口重置小时（**本地时区**），由 `QUOTA_RESET_HOUR` 经
 *   `ConfigAccessor` 现读。**越界与非有限值一律夹到 `[0, 23]`**（见 `clampShiftHours`）。
 * @returns `day` → `YYYY-MM-DD`；`month` → `YYYY-MM`（均为本地时区）
 */
export function windowKey(nowMs: number, window: QuotaWindow, shiftHours: number): string {
  // 减毫秒而不是手工做日历进位：闰年/月末/跨年交给 Date 的本地字段（见文件头）
  const shifted = new Date(nowMs - clampShiftHours(shiftHours) * HOUR_MS);
  const year = shifted.getFullYear();
  const month = pad2(shifted.getMonth() + 1);
  if (window === "month") {
    return `${year}-${month}`;
  }
  return `${year}-${month}-${pad2(shifted.getDate())}`;
}
