/**
 * @fileoverview 三张主题表与盖遮罩的那一道变换；⚠️ 本层**不读 `process.*`**（组合根采一次往下传）
 */

/** 语义色档 —— 本包全部颜色的**唯一**坐标系 */
// ⚠️ 后四档（`surface` / `hover` / `scrim` / `panel`）是**背景**，与前景写在**同一个坐标系**
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
  /** 模态开着时整屏的**遮罩**底色（那一层里**最深**的一档；⚠️ 终端里没有半透明，「压暗后面」只由前景与它的差决定） */
  | "scrim"
  /** 模态窗口**自己**的底色（比 {@link scrim} **亮**一档：卡片浮在遮罩上，明暗差就是「压在上面」） */
  | "panel";

/**
 * 一份主题：`档 → Ink 颜色字符串`，`undefined` 即「不上色」
 * @description 不上色时**每个档都是 `undefined`**（而不是换一套灰阶）：灰阶仍然会被读成「这里有分级」。
 */
export type Theme = Readonly<Record<Tone, string | undefined>>;

/** 上色时的取值（Tokyo Night 一组，终端色表差异下仍然互相可辨） */
// ⚠️ `satisfies` 而不是注解：那让**每一档的取值都确定**（`Theme` 会把它们放宽成 `| undefined`），
// 于是 {@link veiled} 里那些「压向遮罩」的算式不必写 `!`。
const COLORED = {
  accent: "#7aa2f7",
  ok: "#9ece6a",
  warn: "#e0af68",
  danger: "#f7768e",
  muted: "#6b7394",
  idle: "#414868",
  // ⚠️ **全场最亮的那一档**：面板与侧边栏的「选中」**没有反底色**（那一列的底色归 hover），于是这一档
  // 与 `muted` 的差距就是「哪一个被选中了」的唯一**颜色**线索；它也**不许暗于 `accent`**。
  selected: "#e6e8ff",
  // ⚠️ 四档底色的**相对明暗是判据，不是审美**：平时只有 `surface` < `hover`；遮罩开着时
  // `scrim` < `surface` < `hover` < `panel`（**遮罩最深、卡片次之**），而遮罩态的两档侧边栏底色
  // 与全部前景都由 {@link veiled} 从这一张表**推**出来，故那条链不可能漂。
  surface: "#181a26",
  hover: "#24283b",
  scrim: "#04050a",
  panel: "#222636",
} satisfies Theme;

/** 遮罩期间**前景**被压向遮罩的系数：留下一成，于是与遮罩的差**至多**是原差的一成 */
// ⚠️ 压暗的**幅度**由这一个数定死而不是逐档手调：手调出来的「差一点」在某档上会差成「看得清」。
const VEIL_TEXT = 0.1;
/** 遮罩期间**侧边栏那两档底色**被压向遮罩的系数（比前景深一档：列的边界与悬停还要读得出来） */
const VEIL_SURFACE = 0.85;

/** `#rrggbb` → 三通道（⚠️ 它只认六位小写 hex：本包三张表里都是，故没有格式判据） */
function channelsOf(hex: string): readonly [number, number, number] {
  const packed = Number.parseInt(hex.slice(1), 16);
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

/** 一个色**按 `keep` 压向遮罩**（`keep = 1` = 原色）；⚠️ 前景与侧边栏两档底色都走它，故「遮罩态只是暗版」是**机制** */
function veil(hex: string, keep: number): string {
  const base = channelsOf(COLORED.scrim);
  const mixed = channelsOf(hex).map((one, i) => Math.round(base[i]! + (one - base[i]!) * keep));
  return `#${mixed.map((one) => one.toString(16).padStart(2, "0")).join("")}`;
}

/** 把一份主题**盖上遮罩**（只动背景那一层与全部前景；⚠️ `panel` 是卡片，不动） */
// ⚠️ **七档前景仍两两不同**：遮罩负责「读不出来」，而「两个事实不许渲染成同一个东西」是本层的
// 另一条不变量 —— 两者在**暗遮罩**上不冲突（压完仍与遮罩几乎同色），在亮遮罩上才会。
function veiled(theme: typeof COLORED): Theme {
  return {
    ...theme,
    accent: veil(theme.accent, VEIL_TEXT),
    ok: veil(theme.ok, VEIL_TEXT),
    warn: veil(theme.warn, VEIL_TEXT),
    danger: veil(theme.danger, VEIL_TEXT),
    muted: veil(theme.muted, VEIL_TEXT),
    idle: veil(theme.idle, VEIL_TEXT),
    selected: veil(theme.selected, VEIL_TEXT),
    surface: veil(theme.surface, VEIL_SURFACE),
    hover: veil(theme.hover, VEIL_SURFACE),
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
  // ⚠️ **底色也归 `undefined`**：无色终端里侧边栏与主区**长得一样**，而
  // 「hover 那一项换的是**另一层**底色」那几条（`tests/layout/selection.test.ts` 不变量 ③）在无色档上**恒红** ——
  // 它们本来就只在 `color: true` 下有意义，与着色那一档的其余测试同规格。
  surface: undefined,
  hover: undefined,
  scrim: undefined,
  panel: undefined,
};

/** 一份主题的入参（⚠️ **一个对象**：两个 `boolean` 位置参数写反了在类型上完全合法） */
export interface ThemeOptions {
  /** 终端能不能上色（组合根从 `NO_COLOR` / `TERM=dumb` 采一次） */
  readonly color: boolean;
  /** 模态窗口开着吗（开着则整屏铺一层遮罩，背景那一层退成「几乎读不出来」） */
  readonly scrimmed: boolean;
}

/**
 * 按「要不要上色」「有没有遮罩」取一份主题；⚠️ 入参是**一个对象** —— 两个 `boolean` 写反了在类型上合法
 */
export function themeOf(options: ThemeOptions): Theme {
  if (!options.color) return PLAIN;
  return options.scrimmed ? SCRIMMED : COLORED;
}