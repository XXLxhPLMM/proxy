/**
 * @fileoverview 列宽规划：若干行 + 一个总宽 → 每列多宽、每格显示什么（**纯函数**，零 React）
 * @module ui/columns
 * @description
 * 本模块是本包表格的**全部**排版逻辑，`table.tsx` / `keyvalue.tsx` 只是把它算好的结果打出去。
 * 单独成文件而不是塞进组件的理由与 `@/ops`（零渲染）/`@/admin`（渲染）那条分界同源：排版是
 * 纯计算，在单测里逐格断言「这一格被切了没有、这一列有多宽」才有牙齿；一旦它藏进组件，
 * 唯一能验它的手段就是起一个 Ink 渲染，而那对宽度断言几乎没有分辨力。
 *
 * ## 度量一律走 `string-width`
 * @description
 * ⚠️ 本模块**没有一处**用 `String.length` 做宽度判断。`账号` 的 `length` 是 2、显示宽度是 4；
 * 按 `length` 排出来的中文表格必然在右边错开一格，而那一格里的内容是谁会在一屏之内答不出来。
 * 牙齿见 `tests/columns.test.ts` 里那组「含中文的行」断言。
 *
 * ## 裁剪顺序：先右后左，砍不到 `min` 就丢列，**并说一声**
 * @description
 * 空间不够时 {@link planColumns} 从**最右**往左收 `flex` / `auto` 列，每列不越过 `min`
 * （默认 {@link DEFAULT_MIN}）；收到所有下限仍然不够，就从右边**丢掉整列**并把
 * {@link ColumnPlan.truncated} 置真。
 * - **为什么从右往左**：最左那几列通常是「谁」（名字 / 键名 / 坐标），最右那几列通常是自由
 *   文本或数字 —— 砍掉尾部保住的正是「这一行是谁」这条唯一不能丢的信息。
 * - **为什么固定列不参与收窄**：`width: number` 是一句**承诺**（例如一个字形宽的状态列），
 *   悄悄把它收窄等于让 spec 说谎。
 * - **为什么丢掉的是列而不是字符**：字符级截断会把一列的值切成半句，读到半句的人会去猜，
 *   而猜出来的东西会被当成真的。丢列至少是「这一屏没显示它」。
 * - ⚠️ **`truncated` 绝不许被忽略**：界面必须能说「这一屏显示不全」，否则「少显示」与
 *   「没有更多」在屏幕上长得一模一样。
 *
 * @module
 */

import { dash, ellipsis, padToWidth, widthOf, type Align } from "./format.js";

/** 列与列之间的空格数（两格：一格呼吸、一格看得见的分隔） */
export const COLUMN_GAP = 2;

/** 列宽的下限缺省值（默认 {@link COLUMN_GAP} 之外还要留得下一个字形 + 一点余量） */
export const DEFAULT_MIN = 4;

/** 列宽的写法：定值 / 取内容（`auto`）/ 吃掉剩余（`flex`） */
export type ColumnWidth = number | "auto" | "flex";

/** 一列的描述（**列宽怎么来**是本层的决定，`align` 也是 —— 字节数右对齐是呈现决定） */
export interface ColumnSpec {
  readonly header: string;
  /** 缺省 `auto` */
  readonly width?: ColumnWidth;
  /** 收窄下限，缺省 {@link DEFAULT_MIN}；对三种宽度都生效 */
  readonly min?: number;
  /** 上限，缺省无穷；对三种宽度都生效 */
  readonly max?: number;
  /** 缺省 `left` */
  readonly align?: Align;
}

/** 表格里的一个格可以是这些；`null` / `undefined` 由 {@link dash} 收敛成 `—` */
export type CellValue = string | number | null | undefined;

/** 一行（**不必**与 specs 等长：短的那几格与显式的 `undefined` 同义，都渲染成 `—`） */
export type PlanRow = readonly CellValue[];

/** 一列的规划结果（`header` 已按 {@link ColumnPlan.width} 切好并补齐，可直接渲染） */
export interface PlannedColumn {
  /** 已按该列宽度切好并补齐的表头 */
  readonly header: string;
  readonly width: number;
  readonly align: Align;
}

/** 规划结果（`table.tsx` 的全部输入） */
export interface ColumnPlan {
  readonly columns: readonly PlannedColumn[];
  /** 每格都是**切好并补齐**的终形态；`rows[i].join(gap)` 就是那一行的成品 */
  readonly rows: readonly (readonly string[])[];
  /**
   * 列间的分隔串（长度恒为 {@link COLUMN_GAP}；单列时是空串）
   * @description 存**串**而不是列数：渲染那一侧要的就是 `join(gap)` 的那个实参，存成串之后
   * 「算宽度用的」与「拼行用的」不可能是两个值（列数那份是 {@link COLUMN_GAP}，唯一出口）。
   */
  readonly gap: string;
  /** 渲染后一行的总宽（含 gap）；**恒 `<= totalWidth`**，除非只剩一列而终端比它还窄 */
  readonly width: number;
  /** ⚠️ 内容被切了或列被丢了 —— 界面**必须**拿它说「这一屏显示不全」 */
  readonly truncated: boolean;
  readonly rowCount: number;
  /** 计划中的列数（**含**被丢掉的那几列；与 `columns.length` 的差 = 被丢了几列） */
  readonly columnCount: number;
}

/** 该列是不是定值列（定值列是承诺：不参与收窄、默认也不受下限约束） */
function fixed(spec: ColumnSpec): boolean {
  return typeof (spec.width ?? "auto") === "number";
}

/**
 * 该列的下限
 * @description
 * ⚠️ **`min` 缺省值只约束会被收窄的列**：定值列的下限缺省是 `0` 而不是 {@link DEFAULT_MIN}。
 * 否则一个 `width: 1` 的字形列会被自己的下限抬到 4 —— 那正是「定值是一句承诺」被自己推翻：
 * 一格宽的状态列（`●`）会变成四格，而右边那列还得再让出三格。
 */
function minOf(spec: ColumnSpec): number {
  const min = spec.min ?? (fixed(spec) ? 0 : DEFAULT_MIN);
  return Math.max(0, Math.floor(min));
}

/** 该列的上限 */
function maxOf(spec: ColumnSpec): number {
  return spec.max === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(spec.max));
}

/** 该列能不能被收窄（定值列是承诺，不参与，见文件头） */
function shrinkable(spec: ColumnSpec): boolean {
  return !fixed(spec);
}

/** 该列是不是吃剩余宽度的列 */
function flexible(spec: ColumnSpec): boolean {
  return spec.width === "flex";
}

/** 前 `count` 列摆在一起有多宽（含 gap） */
function widthOfPrefix(widths: readonly number[], count: number, gap: number): number {
  let total = 0;
  for (let j = 0; j < count; j += 1) {
    total += widths[j] ?? 0;
  }
  return count > 1 ? total + gap * (count - 1) : total;
}

/**
 * 排一张表
 * @description
 * 流程（顺序是判据的一部分，改动会让下列断言失去意义）：
 * 1. 逐格 {@link dash}、逐列取**自然宽度**（表头与本格的最大者）；
 * 2. 定宽 / `auto` 列取自然宽度并被 `min` / `max` 夹住，`flex` 列**先按下限起步**；
 * 3. 空间不足则从右往左收 `flex` / `auto` 列到下限为止；
 * 4. 空间有余则把余量**均分**给 `flex` 列（余数给最左边那几列，分配因此是确定的），
 *    撞上 `max` 的那部分就留成右边空白 —— 不去抢别的列的宽度；
 * 5. 仍然超宽就从右边丢整列，**至少保留第一列**（一张没有列的表连「有数据」都说不出来）；
 * 6. 逐格 {@link ellipsis} 切、再 {@link padToWidth} 补；被切过就置 `truncated`。
 *
 * @param specs - 列描述（**列顺序即呈现顺序**，本函数不排序）
 * @param rows - 数据行
 * @param totalWidth - 终端可用宽度（调用方从组合根拿，本层不读 `process.*`）
 */
export function planColumns(
  specs: readonly ColumnSpec[],
  rows: readonly PlanRow[],
  totalWidth: number,
): ColumnPlan {
  const gapWidth = specs.length > 1 ? COLUMN_GAP : 0;
  const cells = rows.map((row) => specs.map((_, j) => dash(row[j])));
  const count = specs.length;

  // 1 + 2：自然宽度与起步宽度
  const natural: number[] = [];
  const base: number[] = [];
  for (let j = 0; j < count; j += 1) {
    let widest = widthOf(specs[j]?.header ?? "");
    for (const row of cells) {
      widest = Math.max(widest, widthOf(row[j] ?? ""));
    }
    natural.push(widest);
    const spec = specs[j];
    const lo = minOf(spec);
    const hi = maxOf(spec);
    const wanted = spec.width ?? "auto";
    const raw = typeof wanted === "number" ? wanted : wanted === "flex" ? lo : widest;
    base.push(Math.min(Math.max(raw, lo), Math.max(lo, hi)));
  }

  const budget = Math.max(0, totalWidth - gapWidth * Math.max(0, count - 1));
  let used = base.reduce((sum, w) => sum + w, 0);

  // 3：从右往左收
  for (let j = count - 1; j >= 0 && used > budget; j -= 1) {
    const spec = specs[j];
    if (!shrinkable(spec)) {
      continue;
    }
    const lo = minOf(spec);
    const give = Math.min(base[j] - lo, used - budget);
    if (give <= 0) {
      continue;
    }
    base[j] -= give;
    used -= give;
  }

  // 4：把余量分给 flex 列
  const flexIndexes = specs.map((_, j) => j).filter((j) => flexible(specs[j]));
  if (used < budget && flexIndexes.length > 0) {
    const spare = budget - used;
    const per = Math.floor(spare / flexIndexes.length);
    let extra = spare - per * flexIndexes.length;
    for (const j of flexIndexes) {
      const want = per + (extra > 0 ? 1 : 0);
      if (extra > 0) {
        extra -= 1;
      }
      const add = Math.min(Math.max(0, want), maxOf(specs[j]) - base[j]);
      base[j] += add;
      used += add;
    }
  }

  // 5：仍然超宽就从右边丢列（至少留第一列）
  let keep = count;
  while (keep > 1 && widthOfPrefix(base, keep, gapWidth) > totalWidth) {
    keep -= 1;
  }

  const width = widthOfPrefix(base, keep, gapWidth);
  let truncated = keep < count;

  // 6：切 + 补
  const columns: PlannedColumn[] = [];
  for (let j = 0; j < keep; j += 1) {
    const spec = specs[j];
    const align: Align = spec.align ?? "left";
    const header = ellipsis(spec.header, base[j]);
    if (header !== spec.header) {
      truncated = true;
    }
    columns.push({
      header: padToWidth(header, base[j], align),
      width: base[j],
      align,
    });
  }

  const plannedRows = cells.map((row) => {
    const out: string[] = [];
    for (let j = 0; j < keep; j += 1) {
      const raw = row[j];
      const cut = ellipsis(raw, base[j]);
      if (cut !== raw) {
        truncated = true;
      }
      out.push(padToWidth(cut, base[j], specs[j].align ?? "left"));
    }
    return out;
  });

  return {
    columns,
    rows: plannedRows,
    gap: " ".repeat(gapWidth),
    width,
    truncated,
    rowCount: cells.length,
    columnCount: count,
  };
}
