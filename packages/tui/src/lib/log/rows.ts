/** @fileoverview 控制台输出日志：条目模型 + 摊平成行 + 滚动定位（纯数据 + 纯函数） */
/** ⚠️ 每一格装的是 `Turn`（对话模型，`./turn.js`），不是 `LogRow`；这一层只答「这一行画在哪、折几行」 */
/** 滚动需要的是**行**而对话产出的是**格**，故中间这层摊平**必须显式存在** —— 摊平之后滚动位置**永远以行为单位** */

import stringWidth from "string-width";

import { fitTo, padToWidth as padTo } from "../format.js";
import { rowsOfTurn, type Turn } from "./turn.js";

/** 语义色档（`@/theme/index.js:Tone`）—— 本模块只用它做数据标注，不自己上色 */
export type LogTone = "accent" | "ok" | "warn" | "danger" | "muted" | "idle";

/** 一行输出的内容类别；⚠️ **不许**往里加「这是标题」这种纯装饰类别 —— 摊平层的职责是「算出几行」，不是「决定好不好看」 */
export type LogRow =
  /** 回显用户敲的那条命令（凭据已被掩码，见 {@link maskEcho}） */
  | { readonly kind: "echo"; readonly text: string; readonly tone?: LogTone }
  /** 操作者敲进来的**那一句话**（⚠️ 与 {@link kind:"echo"} 分开是判据：「我说的」与「要执行的那条」是两件事） */
  | { readonly kind: "user"; readonly text: string; readonly tone?: LogTone }
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

/** 一格输出（⚠️ 里面装的是 {@link Turn} 而不是 `LogRow`：**「谁说的」与「画成什么形状」是两层**） */
export interface LogEntry {
  readonly id: number;
  /** 墙钟毫秒（`Date.now()`，由调用方在**执行那一刻**取，本模块不读时钟） */
  readonly at: number;
  readonly turns: readonly Turn[];
}

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

export interface FlatLog {
  readonly lines: readonly LogLine[];
  /** 总行数（滚动上界） */
  readonly height: number;
  /** 是否有任何内容（空台账 / 刚启动时区分「空」与「有内容」要用） */
  readonly any: boolean;
}

const DEFAULT_TONE: Record<LogRow["kind"], LogTone> = {
  echo: "accent",
  // ⚠️ **六个色档里唯一不带处置动作语义的那一档**：其余每一档都在说一件事（要执行 / 成了 / 要你处理 /
  // 失败了 / 什么都没有），而这句话是**等着被回答的** —— 染上任何带处置动作的色档都是一句假事实；
  // 与 `echo` 的 `accent` 分开，「我说的」与「要执行的那条」才在**文字色**上也分得开
  user: "muted",
  head: "accent",
  kv: "muted",
  table: "muted",
  note: "warn",
  err: "danger",
};

/** 表与键值对之间的间隔（两格）。⚠️ 一格不够：中文一格紧挨着下一列会看着粘在一起 */
const TABLE_GAP = "  ";

/** 单元格数组 → 一行**已排版**文本（表**不换行**：换行会撕开列对齐）；⚠️ **列宽在这里定死，不许呈现层再排一遍** */
/** ⚠️ **跨行仍然不对齐**是刻意的：跨行对齐要整张表一起算宽，那需要知道**总宽** */
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

/** 按**显示宽度**左对齐补空格到 `width`；⚠️ 不用 `String.padEnd`（它按 code unit 数，而中文标签的 code unit 数是它显示宽度的一半） */
function padToWidth(text: string, width: number): string {
  return padTo(text, width, "left");
}

/** **先按 `\n` 切硬行，再对每一段按显示宽度**切成若干片段；⚠️ 逐字符累加：按 `String.slice` 的下标切会在半个宽字符处断开，而那在终端里会渲染成一个**替换符**（豆腐块） */
/** ⚠️ **硬行必须落在折行之前切出来**：留在一个片段里的话那个 `\n` 由 Ink 在框内软换行，超出框的那一段整个不画（气泡那个出口是定高的一格）⇒ 折行的续段没有那一行可画 */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  // ⚠️ **段数恒等于 `split("\n")` 的长度**：末尾那个空段与连续两个 `\n` 各占一格，空段不许被吞
  // （输入层的 `wrapInput` 是同一条纪律 —— 两处各判一次的话同一句话在两个出口上折成不同的形状）
  for (const hard of text.split("\n")) {
    // ⚠️ 宽度为 0 时**每个硬行各摊成一格空串**：那不是「不折」，那是屏上没有列可画
    if (width <= 0) {
      out.push("");
      continue;
    }
    let cur = "";
    let used = 0;
    for (const ch of hard) {
      const w = stringWidth(ch);
      // ⚠️ 「`cur` 非空」那个半边是**防御**：一个字符比整行还宽时它仍要占一行，绝不丢、也不许在它前面凭空多出空行
      if (cur !== "" && used + w > width) {
        out.push(cur);
        cur = "";
        used = 0;
      }
      cur += ch;
      used += w;
    }
    out.push(cur);
  }
  return out;
}

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

  // ⚠️ **两层判据各归一层**：`Turn` → `LogRow` 由 `rowsOfTurn` 的穷举 `switch` 管（「谁说的」），
  // 下面那个 `switch` 只管「这一行怎么折」。合成一处的话加一个变体要在排版代码里也加一支。
  for (const row of entry.turns.flatMap(rowsOfTurn)) {
    const tone = row.tone ?? DEFAULT_TONE[row.kind];
    switch (row.kind) {
      case "kv":
        pushFitted(kvLine(row, width), row.kind, tone);
        break;
      case "table":
        pushFitted(tableLine(row.head, width), row.kind, tone);
        for (const line of row.rows) pushFitted(tableLine(line, width), row.kind, tone);
        break;
      case "user":
        // ⚠️ **显式一支而不并进 `default`**：它与 `echo` 同族（按显示列折行、不标截断），而那一族
        // 的语义是「操作者递进来的东西」—— 气泡那一块要在**每一段**上认出它
        pushWrapped(row.text, row.kind, tone);
        break;
      default:
        pushWrapped(row.text, row.kind, tone);
        break;
    }
  }
  return out;
}

/** 整个日志 → 一维行数组；`width` 是**结果区的内容宽度**，它变了就**必须**重算（行高依赖它，故摊平结果**不能缓存**跨宽度的版本） */
export function flatten(entries: readonly LogEntry[], width: number): FlatLog {
  if (entries.length === 0) return { lines: [], height: 0, any: false };
  const newestId = entries[entries.length - 1]!.id;
  const lines: LogLine[] = [];
  for (const entry of entries) lines.push(...rowsOf(entry, newestId, width));
  return { lines, height: lines.length, any: true };
}

/** 取「从 `top` 开始的 `rows` 行」这一屏；`top` 是**已夹紧**的（见 {@link clampTop}），返回的行**保留 `entryId`** */
export function visibleLines(flat: FlatLog, top: number, rows: number): readonly LogLine[] {
  if (rows <= 0) return [];
  return flat.lines.slice(top, top + rows);
}

/** 把滚动位置夹到合法范围：「合法」= 要能滚到底、也能滚到顶，即 `0` 与 `max(0, height - rows)` 之间 */
/** ⚠️ `height <= rows` 时**必须**归 0（内容装得下就没有滚动位置可言），否则会停在「往上滚不出东西、往下也到底了」的中间值上 */
export function clampTop(height: number, rows: number, top: number): number {
  const max = Math.max(0, height - rows);
  if (!Number.isFinite(top)) return max;
  return Math.min(Math.max(Math.trunc(top), 0), max);
}

/** 追加一格，返回新数组（`id` = 末尾最大 id + 1）；就地改 `readonly` 数组不会触发 React 重绘 */
/** ⚠️ **`id` 从 1 起**：{@link dropped} 用 `0` 表示「一条都没丢」，id 从 0 起则「丢到只剩 id 0 那一条」与「什么都没丢」无法区分 */
export function append(
  entries: readonly LogEntry[],
  turns: readonly Turn[],
  at: number,
): LogEntry[] {
  const id = (entries.length === 0 ? 0 : entries[entries.length - 1]!.id) + 1;
  return [...entries, { id, at, turns }];
}

/** 环形缓冲：只保留最近 `keep` 条；⚠️ 无界增长会让 {@link flatten} 每帧重算的行数线性增长（它在**每次渲染**都跑），于是终端肉眼可见地变卡 */
export function trim(entries: readonly LogEntry[], keep: number): LogEntry[] {
  if (keep <= 0) return [];
  return entries.length <= keep ? entries.slice() : entries.slice(entries.length - keep);
}

/** 被环形缓冲丢掉的最早一条的 id（0 = 没丢过） */
export function dropped(entries: readonly LogEntry[], keep: number): number {
  if (entries.length <= keep) return 0;
  return entries[0]!.id;
}

/** 凭据掩码（⚠️ 判据是**凭据类别**逐条对齐的：漏一个类别，那个凭据就**原样上屏**）→ 定长圆点 */
export function maskEcho(kind: "user-pass" | "target-add" | "provider-key", value: string): string {
  if (value.length === 0) return "";
  return "••••••";
}
