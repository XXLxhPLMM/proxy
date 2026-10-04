/**
 * @fileoverview 三张主题表与盖遮罩的那一道变换；⚠️ 本层**不读 `process.*`**（组合根采一次往下传）
 */

/** 语义色档 —— 本包全部颜色的**唯一**坐标系 */
// ⚠️ 后五档（`surface` / `hover` / `scrim` / `panel` / `panelHot`）是**背景**，与前景写在**同一个坐标系**
// 里 —— 写成另一个表就等于承认「同一个语义两种颜色」是可接受的。
export type Tone =
  | "accent"
  | "ok"
  | "warn"
  | "danger"
  | "muted"
  | "idle"
  | "selected"
  /** 侧边栏**整条**的底色（两侧都去掉框之后，屏上靠它和主区分开） */
  | "surface"
  /** 鼠标悬停在某一项上时那一项的底色（比 {@link surface} 浅一档，否则看不出来） */
  | "hover"
  /** 模态开着时整屏的**遮罩**底色（那一层里**最亮**的一档；⚠️ 终端里没有半透明，「看得见后面一点」只由前景与它的差决定） */
  | "scrim"
  /** 模态窗口**自己**的底色（**深**的一档：一张深色卡片压在浅色遮罩上，靠明暗差「浮起来」） */
  | "panel"
  /** 指针落在窗口里某个按钮上时那一枚的底色（比 {@link panel} 浅一档） */
  | "panelHot";

/**
 * 一份主题：**档 → Ink 颜色字符串**，`undefined` 即「不上色」
 * @description 不上色时**每个档都是 `undefined`**（而不是换一套灰阶）：灰阶仍然会被读成「这里有分级」。
 */
export type Theme = Readonly<Record<Tone, string | undefined>>;

/** 上色时的取值（Tokyo Night 一组，终端色表差异下仍然互相可辨） */
const COLORED: Theme = {
  accent: "#7aa2f7",
  ok: "#9ece6a",
  warn: "#e0af68",
  danger: "#f7768e",
  muted: "#6b7394",
  idle: "#414868",
  // ⚠️ **全场最亮的那一档**：面板与侧边栏的「选中」**没有反底色**（那一列的底色归 hover），于是这一档
  // 与 `muted` 的差距就是「哪一个被选中了」的唯一**颜色**线索；它也**不许暗于 `accent`**。
  selected: "#e6e8ff",
  // ⚠️ 四档底色的**相对明暗是判据，不是审美**：遮罩开着时 `panel` < `panelHot` < `hover` < `surface`
  // < `scrim`（卡片最深、遮罩最亮）；平时只剩下 `surface` < `hover` 这一条。
  surface: "#181a26",
  hover: "#24283b",
  scrim: "#c3c8dc",
  panel: "#14161f",
  panelHot: "#232838",
};

/** 遮罩期间**背后那一层的前景**：七档**全部**是这一个色 */
// ⚠️ 「基本只能看到后面一点」在终端里只有一种实现：**前景与遮罩几乎同色**；逐档调淡看着精细，实际是
// 「七档都还读得出来」。
const VEIL_TEXT = "#9ba1bd";
/** 遮罩期间侧边栏那一列的底色：比 {@link VEIL_TEXT} 略浅（列的边界还要读得出来） */
const VEIL_SURFACE = "#a7acc6";
/** 遮罩期间悬停那一项的底色：比 {@link VEIL_SURFACE} 浅一档，两者在遮罩下仍可分 */
const VEIL_HOVER = "#b3b8d0";

/** 把一份主题**盖上遮罩**（只动背景那两档与全部前景） */
// ⚠️ `panel` / `panelHot` 不动：被一起洗白的话卡片与遮罩同色，屏上就只剩「整屏亮了一块」。
function veiled(theme: Theme): Theme {
  return {
    ...theme,
    accent: VEIL_TEXT,
    ok: VEIL_TEXT,
    warn: VEIL_TEXT,
    danger: VEIL_TEXT,
    muted: VEIL_TEXT,
    idle: VEIL_TEXT,
    selected: VEIL_TEXT,
    surface: VEIL_SURFACE,
    hover: VEIL_HOVER,
  };
}

/** 遮罩开着时的那一份（= {@link veiled} 过 {@link COLORED}；⚠️ 不是另一个表，故两处不会漂） */
const SCRIMMED: Theme = veiled(COLORED);

/** 不上色时的取值（每档都是 `undefined`，理由见 {@link Theme}） */
const PLAIN: Theme = {
  accent: undefined,
  ok: undefined,
  warn: undefined,
  danger: undefined,
  muted: undefined,
  idle: undefined,
  selected: undefined,
  // ⚠️ **底色也归 `undefined`**：无色终端里侧边栏与主区**长得一样**，而那条
  // 「hover 不动鼠标也能看见」的测试（`tests/layout.test.ts`）在无色档上**恒红** ——
  // 它本来就只在 `color: true` 下有意义，与着色那一档的其余测试同规格。
  surface: undefined,
  hover: undefined,
  scrim: undefined,
  panel: undefined,
  panelHot: undefined,
};

/** 一份主题的入参（⚠️ **一个对象**：两个 `boolean` 位置参数写反了在类型上完全合法） */
export interface ThemeOptions {
  /** 终端能不能上色（组合根从 `NO_COLOR` / `TERM=dumb` 采一次） */
  readonly color: boolean;
  /** 模态窗口开着吗（开着则整屏铺一层遮罩，背景那一层退成「洗白的轮廓」） */
  readonly scrimmed: boolean;
}

/**
 * 按「要不要上色」「有没有遮罩」取一份主题；⚠️ 入参是**一个对象** —— 两个 `boolean` 写反了在类型上合法
 */
export function themeOf(options: ThemeOptions): Theme {
  if (!options.color) return PLAIN;
  return options.scrimmed ? SCRIMMED : COLORED;
}