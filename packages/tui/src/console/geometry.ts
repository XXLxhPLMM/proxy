/**
 * @fileoverview 屏幕几何：每一个可点击 / 可滚动矩形由这一个纯函数算出
 * @module console/geometry
 * @description
 * 本模块是**渲染与命中测试的唯一真相来源**。呈现层按它画，鼠标命中按它判，两者读的是同
 * 一份数字。
 *
 * ## 为什么必须只有一份
 *
 * 如果「画在哪」由 JSX 的 `flexDirection` / `width` 决定，而「点在算哪」由另一处算，那么
 * **两边必然在某次改动后错开**，而症状是「点了左边那行却切到了右边那台机器」——一个只在
 * 真实终端里点得到、而 `tsc` / `eslint` / 全部单测都看不见的错误（子包历史上这类 bug 已经
 * 逮到过好几个：同屏两句话、过期响应盖新结果、控制字符插进凭据）。
 *
 * 所以本模块**不接受任何「Ink 会替我算」的前提**：所有位置都由 `columns` / `rows` 与几个
 * 常量**算术**得出。代价是排版不再有弹性（Ink 的一行 `<Box flexGrow>` 本可以自己适应），
 * 换来的是「画的」与「点的」在类型上就不可能不一致。
 *
 * ## 坐标系
 *
 * 全部是**终端绝对坐标**（0 起的行、列），与鼠标上报的坐标同一套（上报是 1-based，
 * 转换在 `@/ui/mouse.ts` 里做）。矩形一律**半开区间** `[x, x+width)` × `[y, y+height)`：
 * 紧邻的两个矩形在整除边界上不会同时命中，「点右边那格」永远不会被判成「点左边那格」。
 *
 * @module
 */

import stringWidth from "string-width";

/** 侧边栏宽度（含它自己的右边框列）。⚠️ 窄于此值时下方的表格会开始软换行，故这是下限 */
export const SIDEBAR_WIDTH = 22;
/** 侧边栏里「控制面」那一节标题的行数（⚠️ **一行**：目标数归底部状态行，故标题下没有第二行数字） */
export const SIDEBAR_HEADER_HEIGHT = 1;
/** 底部输入区的高度：输入行 + 瞬时消息行 + 状态行 */
export const INPUT_LINE_HEIGHT = 1;
/**
 * 底部状态行的高度（左边是「连的是哪台机器」，右边是「会话是什么」）
 * @description ⚠️ 它**恒占一行**，哪怕两半都空着 —— 输入区因此是一个**定高**矩形，
 * 而「输入行往上会长」这件事在本屏上不存在（{@link INPUT_BLOCK_HEIGHT} 是定值）。
 */
export const STATUS_LINE_HEIGHT = 1;
export const INPUT_BLOCK_HEIGHT = INPUT_LINE_HEIGHT + 1 + STATUS_LINE_HEIGHT;
/** 窄终端下侧边栏让位给主区的阈值：低于此宽度就不画侧边栏（否则表格只剩十几列） */
export const MIN_TERMINAL_COLUMNS = 60;

/** 一个矩形（**半开区间**：`[x, x+width)` × `[y, y+height)`） */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 各区域的几何 */
export interface Geometry {
  readonly columns: number;
  readonly rows: number;
  /** 侧边栏整体（`null` = 本终端太窄，画不出来） */
  readonly sidebar: Rect | null;
  /** 侧边栏里那几行目标各自的位置（与 `sidebar` 同序，长度 = 目标数） */
  readonly sidebarRows: readonly Rect[];
  /** 结果区（可滚动、可滚轮）。⚠️ **命令面板开着时这一块被面板接管**（见 `paletteRows`） */
  readonly output: Rect | null;
  /** 输入区（含输入行、瞬时消息行与状态行） */
  readonly input: Rect | null;
  /**
   * 命令面板那几行候选各自的位置（**下标序 = 绘制序**；面板没开时是空数组）
   * @description ⚠️ 它**复用结果区的那一块**（不是另开一块）：面板是「此刻你在挑命令」对
   * 「此刻你在读上一条命令的结果」的替换，两者占同一个矩形，于是**开面板不会让结果区重排** ——
   * 而另开一块的话每敲一个字符结果区就要矮一行，操作者看着输出被一格格挤走。
   */
  readonly paletteRows: readonly Rect[];
  /**
   * 面板里给**候选**留几行（总行数减去那一条「装不下」的说明行）
   * @description ⚠️ 它与 {@link paletteRows} **必须**一起算：呈现层按它切窗口，而
   * {@link ../cmd/palette.js:paletteWindow} 也拿它算首行号 —— 两处各算一次的话，
   * 「高亮那一行被面板最后一行压住」的形状只在**装不下**时出现（命令少于几行时两处必然相同）。
   */
  readonly paletteViewportRows: number;
  /** 结果区的**内容宽度**（已扣边框与内边距）——`@/console/log.ts:flatten` 的 `width` 就是它 */
  readonly outputWidth: number;
  /** 结果区的**内容行数**（视口高度） */
  readonly outputRows: number;
  /** 输入行的内容列区间（点击定位插入符用） */
  readonly inputText: Rect | null;
}

/**
 * 侧边栏文字的起始列（相对边框之内的**缩进**）
 * @description
 * ⚠️ **呈现层画字必须用这一个数**，不许自己数「边框 1 + 内边距 1」。这里与
 * {@link geometry} 算出的 `sidebarRows[i].x` 是**同一个常量** —— 而 `sidebarRows[i].x` 是
 * `SIDEBAR_TEXT_X` **加上 {@link BORDER_LEFT_COLUMN}**（边框那一列），两者一旦各写一份，
 * 「点第 i 行」与「第 i 行画在哪」就会错开一列，而症状是点 A 行切到 B 机。
 */
export const SIDEBAR_TEXT_X = 2;

/**
 * 主区那几行文字前面的**缩进**（边框之内的空格数）
 * @description
 * ⚠️ 它**只**归呈现层（`@/console/layout.tsx` 用它缩进滚动提示行、瞬时消息行与状态行）；
 * 几何层**不在矩形里减它**，理由写在 {@link Geometry.outputWidth} 那条注释里。
 * ⚠️ 而 {@link Geometry.inputText} 的起点**不含**它 —— 输入行那行**没有**这一列缩进
 * （它前面是提示符），差这一列就是「点一个字得到它右边那个位置」。
 */
export const MAIN_TEXT_X = 2;

/**
 * 一带边框的框里**左边框**占掉的列数 —— 也就是「框的 x」与「框里第一个字符的列」之差
 * @description
 * ⚠️ 它是 **1**，因为 Ink 的 `<Box>` **没有默认内边距**（`ink/build/styles.js` 里是
 * `setPadding(…, style.padding ?? 0)`，而 `padding` 不在 props 里就**整条不执行**）：
 * 边框那一列**不是**内容，内容从 `box.x + 1` 开始。
 * ⚠️ 少算它一列的后果**不是**「命中区域偏了一格」这么轻—— 它让「点某个字得到的是它**右边**那个
 * 位置」，而插入符落在相邻两字之间时终端上看不出差别，只在真去点的时候才发现少了一格。
 * ⚠️ 与 {@link SIDEBAR_TEXT_X} / {@link MAIN_TEXT_X} 的关系：那两个是**缩进**（画几个空格），
 * 本常量是**边框本身**。文字的真实起点 = 框的 x + 本常量 + 缩进。
 */
export const BORDER_LEFT_COLUMN = 1;

/**
 * 输入行提示符占掉的列数
 * @description ⚠️ 呈现层画的是 `❯ `（{@link PROMPT} 在 `@/console/layout.tsx`），而**本模块不认识字形**：
 * 提示符的宽度必须在这里有一份数，否则「点输入行定位插入符」那个矩形就得由呈现层算 ——
 * 而那正是本模块存在的理由被拆成两半。牙齿：`tests/layout.test.ts` 断言**渲染出来的**
 * 第一个输入字符恰好落在 {@link Geometry.inputText} 的 `x` 上，故两个数漂了它就红。
 */
export const PROMPT_COLUMNS = 2;

/**
 * 一带**上下框**占掉的行数
 * @description
 * 侧边栏与主区都画了 `borderStyle="round"`，故它们的内容高度比外框高度少 2。
 * ⚠️ 漏掉这 2 行的话，最后一行内容会撞到下框上被**裁掉**——症状是「状态行看不见」，
 * 而那恰恰是输入框下方那一行「我现在连的是哪台机器 · v… · N 个控制面」。
 */
export const BORDER_ROWS = 2;

/**
 * 一带**左右框**占掉的列数
 * @description
 * 同 {@link BORDER_ROWS}：左右各 1 列。
 */
export const BORDER_COLUMNS = 2;

function rect(x: number, y: number, width: number, height: number): Rect {
  // ⚠️ 坐标一律夹到非负：负坐标的矩形在命中测试里会**吃掉上方区域的点击**（见 `bottomY` 那条）
  return {
    x: Math.max(0, Math.trunc(x)),
    y: Math.max(0, Math.trunc(y)),
    width: Math.max(0, Math.trunc(width)),
    height: Math.max(0, Math.trunc(height)),
  };
}

/** 侧边栏第一条目标行的 y */
function firstRowY(): number {
  // 侧边栏上框 1 行 + 标题 1 行
  return 1 + SIDEBAR_HEADER_HEIGHT;
}

/**
 * 由终端尺寸算出全部区域
 * @description
 * 行的分配（自上而下）：**顶部没有横向区域** → 侧边栏 / 主区占满整屏 → 输入区固定 3 行。
 * ⚠️ `rows` 极小时（拖到 1-4 行）不做特殊处理：各区高度夹到 0，于是画出来的就是一个只剩边框的屏。
 * **这是诚实的**——比在 3 行里硬塞侧边栏+输入框+结果区要清楚（那样三样都读不了）。
 *
 * @param columns - 终端列数
 * @param rows - 终端行数
 * @param targetCount - 目标个数（决定侧边栏画几行）
 * @param paletteCount - 命令面板有几行候选（`0` = 面板没开，于是 {@link Geometry.paletteRows} 是空的）
 * @returns 全部区域
 */
export function geometry(
  columns: number,
  rows: number,
  targetCount: number,
  paletteCount: number,
): Geometry {
  const w = Math.max(0, Math.trunc(columns));
  const h = Math.max(0, Math.trunc(rows));

  const mainY = 0;
  const mainHeight = h;
  // ⚠️ **输入区从主区的底部往上占，且最多**占 {@link INPUT_BLOCK_HEIGHT}。
  // 两条都在这里而不是在渲染层，理由是「主区只有 1 行」那种屏必须让某样东西诚实地变成 0，
  // 而不是**往上长**：输入区的高度恒是 `min(3, 主区高度)`，故它**永不越过主区顶边** ——
  // 在 2 行的屏上它只拿到 1 行而不是 3 行，于是输入行下面那两行（消息 / 状态）**如实地没有**。
  // 「屏太矮就少画一行输入框」与「输入框长出屏顶」两句里，只有第一句是诚实的。
  const mainBottom = mainY + mainHeight;
  const inputHeight = Math.min(INPUT_BLOCK_HEIGHT, mainHeight);
  const inputY = mainBottom - inputHeight;

  const tooNarrow = w < MIN_TERMINAL_COLUMNS;
  const sidebarWidth = tooNarrow
    ? 0
    : Math.min(SIDEBAR_WIDTH, Math.max(0, w - MIN_TERMINAL_COLUMNS + 12));
  const mainX = sidebarWidth;
  const mainWidth = Math.max(0, w - sidebarWidth);

  // ⚠️ 内容高度扣掉上下框：那 2 行是边框的，忘了扣的话最后一行内容会被下框裁掉
  const sidebarContentHeight = Math.max(0, mainHeight - BORDER_ROWS);
  const sidebar = sidebarWidth === 0 ? null : rect(0, mainY, sidebarWidth, mainHeight);

  // 侧边栏的行：只画装得下的那些。
  // ⚠️ 没有侧边栏时**必须给空数组**，不能给「宽度 0 的 n 行」——那会让命中测试拿着一份
  // 「有 3 行可点」的数据，而屏上一个侧边栏都没有，点下去什么也不会发生（静默无响应）。
  const rowsThatFit =
    sidebar === null
      ? 0
      : Math.max(0, Math.min(targetCount, sidebarContentHeight - SIDEBAR_HEADER_HEIGHT));
  const sidebarRows: Rect[] = [];
  for (let i = 0; i < rowsThatFit; i += 1) {
    const x = BORDER_LEFT_COLUMN + SIDEBAR_TEXT_X;
    sidebarRows.push(
      rect(
        x,
        firstRowY() + i,
        // 右边框 1 列：命中区域不许盖到框上，否则点在框那一列会选中这一行
        Math.max(0, sidebarWidth - x - 1),
        1,
      ),
    );
  }

  const input =
    mainWidth === 0 ? null : rect(mainX, inputY, mainWidth, inputHeight);
  const output =
    mainWidth === 0 || input === null
      ? null
      : rect(mainX, mainY, mainWidth, Math.max(0, inputY - mainY));

  // ⚠️ 面板**复用结果区**，且只在装不下时留一行说「还有几条」—— 少留那一行会让最后一条候选
  // 被下一行（状态行的上框）压掉半行，而那半行的症状是「最后一条命令的说明缺了个字」。
  const paletteAvail = output === null ? 0 : Math.max(0, output.height - BORDER_ROWS);
  const paletteViewportRows =
    Math.trunc(paletteCount) > paletteAvail
      ? Math.max(0, paletteAvail - 1)
      : paletteAvail;
  const paletteRows: Rect[] = [];
  if (output !== null) {
    const shown = Math.min(Math.max(0, Math.trunc(paletteCount)), paletteViewportRows);
    for (let i = 0; i < shown; i += 1) {
      // ⚠️ y = 「上框之下第 i 行」：框内侧起算，故候选行**不会**骑在边框上。
      paletteRows.push(
        rect(
          output.x + BORDER_LEFT_COLUMN,
          output.y + BORDER_LEFT_COLUMN + i,
          Math.max(0, output.width - BORDER_COLUMNS),
          1,
        ),
      );
    }
  }

  return {
    columns: w,
    rows: h,
    sidebar,
    sidebarRows,
    output,
    input,
    paletteRows,
    paletteViewportRows,
    // ⚠️ 主区带上下框 → 内容高度扣 BORDER_ROWS；视口另留 1 行给「下面还有多少」。
    // ⚠️ 内容宽度扣 BORDER_COLUMNS（左右框各 1），**不**再多扣：呈现层画在框**内侧**，
    // 它自己会用 MAIN_TEXT_X 补上左边框 + 内边距。多扣一列的结果是右边空一列，
    // 而那一列紧挨着右框，看着像「右框画歪了一格」。
    outputWidth: output === null ? 0 : Math.max(0, output.width - BORDER_COLUMNS),
    outputRows: output === null ? 0 : Math.max(0, output.height - BORDER_ROWS - 1),
    inputText:
      input === null
        ? null
        : rect(
            // ⚠️ 起点 = 框 x + 左边框 + 提示符：**三个都要在**。提示符那一列漏了，于是点第一个字
            // 得到的是它右边那个位置（见 {@link BORDER_LEFT_COLUMN}）。
            input.x + BORDER_LEFT_COLUMN + PROMPT_COLUMNS,
            // 输入行在框内侧：跳过上框那一行（点击定位插入符靠它对齐）
            input.y + 1,
            // 宽度到**右边框之内**为止：提示符右边那一列留白可以点（那落在行末，行为已定）
            Math.max(0, input.width - BORDER_LEFT_COLUMN - PROMPT_COLUMNS - 1),
            INPUT_LINE_HEIGHT,
          ),
  };
}

/**
 * 命中测试：点在哪个矩形里
 * @description
 * 判据用**半开区间** `[x, x+width)` 与 `[y, y+height)` —— 边界那一列/行归**下一个**元素。
 * ⚠️ 若两端都闭上，两个相邻的等宽矩形在整除的那个边界上会**同时**命中，而那时「后一个赢」意味着
 * 「点右边那格选中左边那格」——这正是表格行选不中的形状，且因为常用的那台恰好在右边，
 * 它会显得「有时是对的」，极难归因。
 *
 * ⚠️ 真重叠（一个矩形套在另一个里面）时**后一个赢**：调用方给的下标序就是绘制序（后画的在上层），
 * 上层必须先拿到这次点击。
 * ⚠️ 非整数坐标直接 `-1`：`parseSgr` 挡掉了终端报 0 的情况，但除法 / 取整写错会让坐标变成
 * `NaN` 或小数，而那两条比较对 `NaN` 恒假 —— 结果是**一次点击静默什么都不做**。
 *
 * @param x - 终端列（0 起）
 * @param y - 终端行（0 起）
 * @param rects - 候选矩形（**下标序 = 绘制序**）
 * @returns 命中的下标；一个都没命中（含坐标非整数）时 `-1`
 */
export function hitTest(x: number, y: number, rects: readonly Rect[]): number {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return -1;
  let hit = -1;
  for (let index = 0; index < rects.length; index += 1) {
    const r = rects[index]!;
    if (x < r.x || x >= r.x + r.width) continue;
    if (y < r.y || y >= r.y + r.height) continue;
    hit = index;
  }
  return hit;
}

/**
 * 输入行上的一列 → 插入符的字符下标
 * @description
 * 判据是**显示列**不是字符下标：一个 CJK 字符占两列，所以点它右半边应该把插入符放在它
 * **之后**。因此这里逐字符累加显示宽度，返回「该列之前有多少个字符」。
 *
 * ⚠️ 返回值夹在 `[0, text.length]`：点在输入行**右侧留白**上时落在末尾（这是终端的常态
 * 行为，也是用户预期）；点在行首左侧落在 0。夹住而不是回 -1，是因为**点击空白处不移动
 * 光标**会让人以为界面卡住了。
 *
 * @param clickX - 终端列（0 起，绝对）
 * @param textRect - 输入行文本区的矩形
 * @param text - 当前输入文本
 * @returns 插入符的字符下标
 */
export function caretFromColumn(clickX: number, textRect: Rect, text: string): number {
  const offset = clickX - textRect.x;
  if (offset <= 0) return 0;
  let col = 0;
  let index = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (col + w > offset) return index;
    col += w;
    index += ch.length;
  }
  return index;
}
