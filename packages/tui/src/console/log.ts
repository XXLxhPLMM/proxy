/**
 * @fileoverview 控制台输出日志：条目模型 + 摊平成行 + 滚动定位
 * @module console/log
 * @description
 * 「上方结果区」的全部状态都在这里。它是**纯数据 + 纯函数**：不 import React、不碰终端、
 * 不发请求、不读文件。呈现（怎么画一行、怎么上色）在 `@/console/layout.tsx`。
 *
 * ## 为什么是「条目 → 摊平成行」两层
 *
 * 滚动需要的是**行**（滚轮一格 = 一行），而命令产出的是**条目**（一条命令的结果是一个整体，
 * 可能是一个表）。中间这层摊平是必需的，且它**必须显式存在**——把行高算在呈现层里，
 * 就会出现「滚动位置」这个数字一会儿按条目算、一会儿按行算，而两套单位混用是滚动错位的
 * 唯一来源。摊平之后，滚动位置**永远以行为单位**，与「上面画的是什么」无关。
 *
 * ## 摊平必须知道列宽，因为行高取决于换行
 *
 * 一行的行高不恒等于 1：宽字符（CJK 占 2 列）会吃掉两格，窄的 `i`/`l` 只吃一格，故
 * 「能放几个字符」得按**显示宽度**算，用的是 `string-width` 而不是 `String.length`。
 * 这一点在本仓是硬要求：`src/ui/format.ts` 的列宽计算已经踩过同一个坑，而两处若各算各的，
 * 结果区会**少算或多数行**，滚动条位置与实际内容对不上。
 *
 * ## 哪些行允许换行，哪些不允许
 *
 * - `text` / `note` / `err` / `echo`（散文）：**换行**。它们是自然语言，截断会把一句话变成
 *   骗人的半句，而本仓最恨的就是「显示的东西不完整却不提示」。
 * - `kv`（键值对）与 `table`（表）：**不换行，按宽度截断**。理由是它们是**对齐过的**：换行会
 *   撕开列对齐，而一张对不齐的表比一张被截短的表更难读。表在进来之前已经由
 *   `@/ui/columns.ts:planColumns` 按可用宽度排过版，截断只会在**最长的那一列**末尾发生，
 *   并带一个明确的省略标记（见 `src/AGENTS.md` 关于 `planColumns.truncated` 的说明）。
 *
 * @module
 */

import stringWidth from "string-width";

import { fitTo, padToWidth as padTo } from "@/ui/format.js";

/** 语义色档（`@/ui/theme.ts:Tone`）—— 本模块只用它做数据标注，不自己上色 */
export type LogTone = "accent" | "ok" | "warn" | "danger" | "muted" | "idle";

/**
 * 一行输出的内容类别
 * @description
 * 类别**只影响两件事**：能不能换行、以及默认色档。**不许**往里加「这是标题」这种纯装饰类别 ——
 * 那会让摊平层开始关心排版，而摊平层的职责是「算出几行」，不是「决定好不好看」。
 */
export type LogRow =
  /** 回显用户敲的那条命令（凭据已被掩码，见 {@link maskEcho}） */
  | { readonly kind: "echo"; readonly text: string; readonly tone?: LogTone }
  /** 小节标题（例：`账号`） */
  | { readonly kind: "head"; readonly text: string; readonly tone?: LogTone }
  /** 键值对，一行一对（例：`模式  master`） */
  | { readonly kind: "kv"; readonly key: string; readonly value: string; readonly tone?: LogTone }
  /** 一张表。⚠️ `head` 与每一行 `row` 长度必须相等（**不**是「短的对齐补齐」） */
  | {
      readonly kind: "table";
      readonly head: readonly string[];
      readonly rows: readonly (readonly string[])[];
      /** 哪些列右对齐（例：字节数、毫秒）。`undefined` = 全左对齐 */
      readonly right?: readonly number[];
      readonly tone?: LogTone;
    }
  /** 限定语（例：`账本可能滞后 1.2s`）。⚠️ 这类文字**必须逐字来自服务端**，本包不改写 */
  | { readonly kind: "note"; readonly text: string; readonly tone?: LogTone }
  /** 一次失败。⚠️ `text` 是**人读的判据**，不是原始异常 */
  | { readonly kind: "err"; readonly text: string; readonly tone?: LogTone };

/**
 * 一条输出（一条命令 = 一条）
 * @description
 * `id` 是**给 React 的 key 与滚动锚点**用的序号，单调递增。⚠️ 它必须单调：若用「文本内容」当
 * 锚点，两条一模一样的 `users` 结果会共用一个 key，于是第二条在第一次重绘时就被当成
 * 「已渲染过」而跳过（症状是第二条与第一条同时消失）。
 */
export interface LogEntry {
  readonly id: number;
  /** 墙钟毫秒（`Date.now()`，由调用方在**执行那一刻**取，本模块不读时钟） */
  readonly at: number;
  readonly rows: readonly LogRow[];
}

/** 摊平后的一行 */
export interface LogLine {
  /** 属于哪一条（用于「滚到某条」与高亮） */
  readonly entryId: number;
  /** 原始内容（未截断） */
  readonly text: string;
  readonly kind: LogRow["kind"];
  readonly tone: LogTone | undefined;
  /** 这一行是原文的第几段（换行后的片段序号，从 0 起） */
  readonly part: number;
  /** 该行是否被截断（只在不换行的类别上为真） */
  readonly clipped: boolean;
  /** 所属条目是不是最后一条（用于「↓ 有新内容」提示） */
  readonly isNewestEntry: boolean;
}

/** 摊平结果 */
export interface FlatLog {
  readonly lines: readonly LogLine[];
  /** 总行数（滚动上界） */
  readonly height: number;
  /** 是否有任何内容（空台账 / 刚启动时区分「空」与「有内容」要用） */
  readonly any: boolean;
}

const DEFAULT_TONE: Record<LogRow["kind"], LogTone> = {
  echo: "accent",
  head: "accent",
  kv: "muted",
  table: "muted",
  note: "warn",
  err: "danger",
};

/** 表与键值对之间的间隔（两格）。⚠️ 一格不够：中文一格紧挨着下一列会看着粘在一起 */
const TABLE_GAP = "  ";

/**
 * 单元格数组 → 一行**已排版**文本（表**不换行**：换行会撕开列对齐，见文件头）
 * @description
 * ⚠️ **列宽在这里定死，不许呈现层再排一遍。** 本函数按「本行最宽的那一格」给每格补到等宽，
 * 于是**同一行内**是对齐的。
 *
 * ⚠️ **跨行仍然不对齐**，而这是刻意的：每行各按自己定宽，列宽就依赖了那一行的内容，于是
 * 「alice 启用 1.0 GB」与「bob 停用 ∞ 0 B」两行的「状态」列会落在不同列上。要跨行对齐就必须
 * 整张表**一起**算宽（`@/ui/columns.ts:planColumns` 那条路），那需要知道**总宽**——
 * 而本函数拿到的宽度是**结果区**的，两者不是一回事。
 * 所以整张表的列宽由**产出它的那一档**（`@/console/exec.ts`）用 `planColumns` 算好后
 * **连同已排版的文本**交进来：`cells` 里每一格已经是定宽的。
 * @see LogRow.table 的 `right` 与「表由上游排版」那条不变式
 */
function tableLine(cells: readonly string[], width: number): { text: string; clipped: boolean } {
  return fitTo(cells.join(TABLE_GAP), width);
}

function kvLine(
  row: Extract<LogRow, { kind: "kv" }>,
  width: number,
): { text: string; clipped: boolean } {
  // 标签补到 12 显示列：⚠️ `padEnd` 按 code unit 数，中文标签会补少（`账号`.length = 2 而显示宽 4）
  return fitTo(`${padToWidth(row.key, 12)}${TABLE_GAP}${row.value}`, width);
}

/**
 * 按**显示宽度**左对齐补空格到 `width`
 * @description
 * 为什么不直接 `String.padEnd`：那个按 code unit 数，而一个中文标签的 code unit 数是它显示宽度
 * 的一半，于是「账号」补 10 格而实际只占 8 列 —— 右边那列的值就整体左移了 2 格。
 * 本包已有 `@/ui/format.js:padToWidth` 做这件事（它处理了宽字符），故这里**复用**它而不是
 * 再写一份。
 */
function padToWidth(text: string, width: number): string {
  return padTo(text, width, "left");
}

/**
 * 按显示宽度切成若干片段
 * @description
 * 逐字符累加是因为「一个 CJK 字符 = 两列」——按 `String.slice` 的下标切会在半个宽字符处断开，
 * 而半个宽字符在终端里会被渲染成一个**替换符**（豆腐块），那是在屏幕上凭空造一个不存在的字符。
 */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  let cur = "";
  let used = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (used + w > width) {
      out.push(cur);
      cur = "";
      used = 0;
    }
    cur += ch;
    used += w;
  }
  out.push(cur);
  return out;
}

/** 展平一个条目里的全部行 */
function rowsOf(entry: LogEntry, newestId: number, width: number): LogLine[] {
  const out: LogLine[] = [];
  const isNewest = entry.id === newestId;

  /** 散文类：换行，且**不标截断**（换行已完整呈现全部内容，没有信息丢失） */
  const pushWrapped = (text: string, kind: LogRow["kind"], tone: LogTone | undefined): void => {
    const parts = wrap(text, width);
    for (let i = 0; i < parts.length; i += 1) {
      out.push({
        entryId: entry.id,
        text: parts[i]!,
        kind,
        tone,
        part: i,
        clipped: false,
        isNewestEntry: isNewest,
      });
    }
  };

  /** 对齐类（表 / 键值对）：一行到底，`clipped` 由 `fit` 在**裁之前**判出来 */
  const pushFitted = (
    fitted: { readonly text: string; readonly clipped: boolean },
    kind: LogRow["kind"],
    tone: LogTone | undefined,
  ): void => {
    out.push({
      entryId: entry.id,
      text: fitted.text,
      kind,
      tone,
      part: 0,
      clipped: fitted.clipped,
      isNewestEntry: isNewest,
    });
  };

  for (const row of entry.rows) {
    const tone = row.tone ?? DEFAULT_TONE[row.kind];
    switch (row.kind) {
      case "kv":
        pushFitted(kvLine(row, width), row.kind, tone);
        break;
      case "table":
        pushFitted(tableLine(row.head, width), row.kind, tone);
        for (const line of row.rows) pushFitted(tableLine(line, width), row.kind, tone);
        break;
      default:
        pushWrapped(row.text, row.kind, tone);
        break;
    }
  }
  return out;
}

/**
 * 整个日志 → 一维行数组
 * @description
 * `width` 是**结果区的内容宽度**（已扣掉边框与内边距）。它变了（改窗口宽度）就**必须**重算，
 * 因为行高依赖它 —— 摊平结果**不能缓存**跨宽度的版本，除非缓存键里带宽度。
 *
 * @param entries - 按时间升序的条目
 * @param width - 结果区内容宽度（列数）
 * @returns 行数组 + 总行数
 */
export function flatten(entries: readonly LogEntry[], width: number): FlatLog {
  if (entries.length === 0) return { lines: [], height: 0, any: false };
  const newestId = entries[entries.length - 1]!.id;
  const lines: LogLine[] = [];
  for (const entry of entries) lines.push(...rowsOf(entry, newestId, width));
  return { lines, height: lines.length, any: true };
}

/**
 * 取「从 `top` 开始的 `rows` 行」这一屏
 * @description
 * `top` 是**已夹紧**的（见 {@link clampTop}），所以这里不重复夹。⚠️ 返回的行**保留
 * `entryId`**，让呈现层能画出「这一行属于哪一条命令」的分隔。
 *
 * @param flat - `flatten` 的产物
 * @param top - 顶行号（0 起）
 * @param rows - 视口行数
 */
export function visibleLines(flat: FlatLog, top: number, rows: number): readonly LogLine[] {
  if (rows <= 0) return [];
  return flat.lines.slice(top, top + rows);
}

/**
 * 把滚动位置夹到合法范围
 * @description
 * 「合法」的判据是**要能滚到底、也能滚到顶**：`0`（顶）与 `max(0, height - rows)`（底）之间。
 * ⚠️ `height <= rows` 时**必须**归 0（内容装得下就没有滚动位置可言），否则会停在一个
 * 「往上滚不出东西、往下也到底了」的中间值上——那是死滚动条。
 */
export function clampTop(height: number, rows: number, top: number): number {
  const max = Math.max(0, height - rows);
  if (!Number.isFinite(top)) return max;
  return Math.min(Math.max(Math.trunc(top), 0), max);
}

/**
 * 追加一条，返回新数组（新条目 `id` = 末尾最大 id + 1）
 * @description
 * 返回新数组而不是就地改：React 的 `setState` 靠引用变化判断，而 `readonly` 数组就地 push
 * 是本仓明令禁止的形状（`useState` 的同一个引用不会触发重绘）。
 *
 * ⚠️ **`id` 从 1 起，不是从 0 起。** 因为 {@link dropped} 用 `0` 表示「一条都没丢」，
 * 而若 id 从 0 起，「丢到只剩 id 0 那一条」与「什么都没丢」在返回值上无法区分 —— 一个「从
 * 没丢过」的日志会显示成「丢掉了一整段历史」。让 0 成为一个**不可能取到的 id**，那个歧义就没了。
 */
export function append(
  entries: readonly LogEntry[],
  rows: readonly LogRow[],
  at: number,
): LogEntry[] {
  const id = (entries.length === 0 ? 0 : entries[entries.length - 1]!.id) + 1;
  return [...entries, { id, at, rows }];
}

/**
 * 环形缓冲：只保留最近 `keep` 条
 * @description
 * 结果区是**环形**的，不是审计日志：它服务的是「看看刚才那条命令干了什么」，不是「复盘这周」。
 * 无界增长的后果不是「占内存」这么轻——它会让 {@link flatten} 每帧重算的行数线性增长，
 * 而 {@link flatten} 在**每次渲染**都跑（宽度或内容一变就重摊），于是终端会肉眼可见地变卡。
 * 丢掉的条数在呈现层要说一句（见 {@link dropped}），否则操作者会以为历史是完整的。
 */
export function trim(entries: readonly LogEntry[], keep: number): LogEntry[] {
  if (keep <= 0) return [];
  return entries.length <= keep ? entries.slice() : entries.slice(entries.length - keep);
}

/** 被环形缓冲丢掉的最早一条的 id（0 = 没丢过） */
export function dropped(entries: readonly LogEntry[], keep: number): number {
  if (entries.length <= keep) return 0;
  return entries[0]!.id;
}

/**
 * 凭据掩码：把回显里命令的**凭据参数**换成固定长度圆点
 * @description
 * 屏幕与终端回滚缓冲里**不许**出现明文 token / 密码。这是唯一一处做掩码的地方 —— 掩码散到
 * 各处就等于有第二份「哪些参数是凭据」的清单，而那份清单迟早与命令表走偏。
 *
 * ⚠️ 掩码长度**固定**：按真实长度给点号等于把长度也泄出去。
 * ⚠️ 判据是**命令名 + 位置**，不是「值长得像不像 token」——后者会把一个恰好很长的用户名
 * 也打码，而打码一个不该打的东西比不打更糟（操作者会以为程序认错了自己的输入）。
 *
 * @param kind - 命令的种类（只有含凭据的种类要处理）
 * @param value - 凭据原文
 * @returns 掩码后的定长字符串
 */
export function maskEcho(kind: "user-pass" | "target-add", value: string): string {
  if (value.length === 0) return "";
  return "••••••";
}
