/**
 * @fileoverview 屏幕几何：每一个可点击 / 可滚动 / 可拖动矩形由这一个纯函数算出
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
 * ## ⚠️ 入参是**一个对象**，不是六个位置参数
 * @description
 * 位置参数的第 4 与第 5 位曾经是「侧边栏宽」与「输入行数」这一类**同种**的数，而两个调用点
 * （`@/app.tsx` 拿它做命中测试、`layout.tsx` 拿它做绘制）必须喂**逐字相同**的那一份。
 * 写成位置参数时，「两个调用点传反了」在类型上完全合法，而症状是「点右边那格选中左边那格」——
 * 一类只有真终端才看得见的错。故入参是**一个对象**：字段名自带判据，而少传一个字段编译期就红。
 *
 * ## ⚠️ 输入框的**行数**是本层算出来的，不是调用点给的
 * @description
 * 「输入折成几行」依赖两件事：输入串本身与主区宽度 —— 后者依赖侧边栏宽，而侧边栏宽**可拖**。
 * 若让调用点先算行数再算几何，那就是**两份**折行判据（绘制的那份与命中测试的那份），而它们
 * 会在某次改动里差一行，症状是「输入框比框矮一行」或「点输入行落在错一个字上」。
 * 故 {@link GeometryInput.input} 收的是**原文**，折行与行数都过 {@link wrapInput} 这一个出口。
 *
 * ## 坐标系
 *
 * 全部是**终端绝对坐标**（0 起的行、列），与鼠标上报的坐标同一套（上报是 1-based，
 * 转换在 `@/ui/mouse.ts` 里做）。矩形一律**半开区间** `[x, x+width)` × `[y, y+height)`：
 * 紧邻的两个矩形在整除边界上不会同时命中，「点右边那格」永远不会被判成「点左边那格」。
 *
 * ## 一屏长什么样（侧边栏 = **会话**；整屏**只有输入区**带框；状态行在框**外**）
 *
 * ```
 * ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│/help    列出命令，或给一条命令看用法      ← 结果区
 * ▓▓ 会话 1     ▓│  /status  服务进程与代理的现状
 * ▓▓ live-ok    ▓│  /config  配置项（给键名只看那一个）
 * ▓▓ 会话 2     ▓│  /user    账号的增删改
 * ▓▓ 未选控制面  ▓│  ⇅ 下方还有 12 行 · PgDn 下翻
 * ▓▓▓▓▓▓▓▓▓▓▓▓▓│ …（这一屏只有一个面板，宽度 = 主区宽）…
 * ╭────────────────────────────────────────────╮ ← 命令面板（至多内容行的 40%）
 * │ ❯ /user add charlie▌                         │
 * ╰────────────────────────────────────────────╯ ← 输入区（**只有它**有框）
 *  ● 3   ▲ 1   ○ 2                              v5.2.0   ← 状态行在框**外**：左边状态数、右边版本号
 * ```
 *
 * ⚠️ 侧边栏那一列与主区之间**恒隔 {@link SIDEBAR_GAP} 列**（谁的底色都不占），而手柄就是
 * 侧边栏**最右那一列**（{@link Geometry.sidebarHandle}）。⚠️ 每一项会话占
 * {@link SESSION_ROWS} **两行**：第一行会话名、第二行它连的是哪个控制面 —— 「我这条命令打给
 * 谁」在屏上必须有一个地方回答，而状态行按约定**不显示链接**，于是只剩这一处。
 *
 * @module
 */

import stringWidth from "string-width";

/** 侧边栏的**缺省**宽度（用户拖过之后以那个为准，见 {@link GeometryInput.sidebarWidth}） */
export const SIDEBAR_WIDTH = 22;
/** 侧边栏最窄能拖到几列（再窄会话名与控制面名一起没地方放） */
export const SIDEBAR_MIN_WIDTH = 14;
/** 侧边栏最宽能拖到几列（⚠️ 上限之外还有一道「主区至少留 {@link MAIN_MIN_WIDTH} 列」的夹） */
export const SIDEBAR_MAX_WIDTH = 44;
/**
 * 侧边栏与主区之间**恒隔**几列
 * @description ⚠️ 这一列**不属于任何一边**：它没有侧边栏的底色，于是它本身就是那条分隔线。
 * 反过来（把它算进侧边栏的宽度里、只是少画一列）的话，那一列的底色会让「分隔」看起来像
 * 「侧边栏有一条更宽的边」，而拖动手柄的落点也会与看到的那条边差一列。
 */
export const SIDEBAR_GAP = 1;
/**
 * 主区至少留几列
 * @description 它是侧边栏宽上限的**真正**来源：`{@link SIDEBAR_MAX_WIDTH}` 在宽屏上先撞上，
 * 而窄屏上先撞上的是这一条 —— 后者才是会真的把主区挤没的那一种。
 */
export const MAIN_MIN_WIDTH = 34;
/** 侧边栏一项（= **一个会话**）占几行：第 1 行会话名、第 2 行它连的控制面 */
export const SESSION_ROWS = 2;
/** 窄终端下侧边栏让位给主区的阈值：低于此宽度就不画侧边栏 */
export const MIN_TERMINAL_COLUMNS = 60;

/**
 * 输入区框内**瞬时消息**那一行的行数
 * @description ⚠️ 它**在框内**：它是「这条命令正在跑 / 刚刚发生了什么」，而框是「我现在能敲字的
 * 地方」—— 把消息放到框外，那一行就与状态行争同一行，而两者一个会消失一个永不消失。
 */
export const NOTICE_ROWS = 1;
/** 底部状态行的高度（⚠️ 它在输入框**框外**，见 {@link Geometry.statusLine}） */
export const STATUS_LINE_HEIGHT = 1;

/** 一个矩形（**半开区间**：`[x, x+width)` × `[y, y+height)`） */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * {@link geometry} 的入参（⚠️ **一个对象**：理由见文件头那一节）
 * @description
 * `input` 是**原文**而不是行数（行数由本层折行算出来），而 `window` / `windowRows` /
 * `windowFooter` 三件只回答「窗口开没开、有几行、底部有没有说明」—— 窗口的**尺寸与坐标**
 * 是本层的算术，呈现层与命中测试都读它，故这里只给「事实」。
 */
export interface GeometryInput {
  readonly columns: number;
  readonly rows: number;
  /** 侧边栏宽度（**调用点给的那个值**；本层按 {@link sidebarWidthBounds} 夹一次再往下算） */
  readonly sidebarWidth: number;
  /** 输入行那串原文（折行与行数由本层算，见 {@link wrapInput}） */
  readonly input: string;
  /** 命令面板有几行候选（`0` = 面板没开，于是 {@link Geometry.paletteRows} 是空的） */
  readonly paletteCount: number;
  /** 模态窗口开着没有（`false` ⇒ 四个窗口矩形全是 `null`） */
  readonly window: boolean;
  /** 窗口里有几行可选（`0` = 只有表头与说明） */
  readonly windowRows: number;
  /** 窗口底部有没有那一条说明（`false` ⇒ 不占那一行） */
  readonly windowFooter: boolean;
}

/** 各区域的几何。⚠️ 整屏**只有输入区**带框（见 {@link Geometry.inputFramed}），其余都是无边界的 */
export interface Geometry {
  readonly columns: number;
  readonly rows: number;
  /** 侧边栏整体（`null` = 本终端太窄，画不出来）。⚠️ 它**占满整屏高度**且**没有框** */
  readonly sidebar: Rect | null;
  /**
   * 侧边栏里每个会话各自的位置（与 `sidebar` 同序，长度 = 会话数）
   * @description ⚠️ **每一项占 {@link SESSION_ROWS} 行**（`height === SESSION_ROWS`），
   * 于是命中测试的回查下标**就是**会话下标 —— 不必在「行下标 → 会话下标」之间再做一次换算，
   * 而那种换算少写一次 `Math.floor(y / 2)` 就是「点第二行切到上一个会话」。
   * ⚠️ 每一项**横跨整列**（`x === 0`、`width === 侧边栏宽`），而文字从 {@link SIDEBAR_TEXT_X}
   * 起画：hover 那一格的底色因此是**整条**，不会在右边留下一截不同色的残边。
   */
  readonly sidebarRows: readonly Rect[];
  /**
   * 侧边栏**最右那一列** = 拖宽的手柄（`null` = 没有侧边栏）
   * @description ⚠️ 它**与 {@link Geometry.sidebarRows} 重叠**：点在那一列上既落在某一项里、
   * 也落在这个矩形里。故命中测试**必须先判手柄**（`@/app.tsx` 的 `down` 分支就是那个顺序）——
   * 反过来（先判会话行）的话「按着最右那列拖宽」会在起手那一瞬把会话切掉，而那一下切换是
   * **真的**（会话换了控制面），屏上却只有一条边在动。
   */
  readonly sidebarHandle: Rect | null;
  /** 结果区（可滚动、可滚轮）。⚠️ 它的**下缘**可能被命令面板占掉（见 `paletteRows`） */
  readonly output: Rect | null;
  /** 输入区的**外框**（含上下框那两行；**不含**框外那一行状态行）。`null` = 主区画不出来 */
  readonly input: Rect | null;
  /**
   * 输入区的**框内**内容矩形（已扣上下框与左右框）
   * @description ⚠️ {@link inputFramed} 为假时它**就是** {@link input} 本身（一个都没扣）——
   * 呈现层据此少画那一层，而不是自己再判一次「框画不画得下」。
   */
  readonly inputContent: Rect | null;
  /**
   * 输入串折出来的**每一视觉行**各自的文本矩形（长度 = {@link Geometry.inputRows}）
   * @description ⚠️ **第 0 行的 x 与其余各行不同**：只有第一行前面有提示符 `❯ `，
   * 折出来的续行顶格（理由见 {@link PROMPT_COLUMNS}）。而**每一行的宽度相同**且等于
   * {@link Geometry.inputRows} 折行时用的那个宽度 —— 少算那两列的话第 0 行会压到右边框上。
   * ⚠️ 绘制与「点输入行落点」读的是**这一个数组**（`@/console/layout.tsx:CaretLines` 与
   * {@link caretFromWrappedPoint}），故「字画在哪」与「点哪落在哪」不可能错开。
   */
  readonly inputTextRows: readonly Rect[];
  /**
   * 输入串折出来的**那几行文字**（{@link Geometry.inputTextRows} 与它**同序、同长度**）
   * @description ⚠️ 它必须由几何层**一起给**：呈现层要画的就是它，而「点在第 2 行第 3 个字落在
   * 原串哪儿」要用的也是它（{@link caretFromWrappedPoint}）。让呈现层自己再折一遍就有**两份**
   * 折行判据，而它们的症状是「画出来的第二行与点得着的第二行不是同一行」——
   * 一类只有真点才看得见的错，且极难归因。
   */
  readonly inputWrapped: readonly WrappedRow[];
  /** 输入串折成几行（**至少 1**：空串也是一行，否则框会塌成一条边） */
  readonly inputRows: number;
  /**
   * 框内那条**瞬时消息**行（`null` = 框内放不下，于是这一帧不显示它）
   * @description ⚠️ 它是**判据**：呈现层只按「它是不是 `null`」决定画不画，而本层**优先保证
   * 文本行**（{@link Geometry.inputTextRows}）。屏够高时它恒占 {@link NOTICE_ROWS} 行。
   */
  readonly inputNotice: Rect | null;
  /** 输入区的框**画不画得下**（`true` = 上下左右各 1 列都还在，且至少留得下 1 行内容） */
  readonly inputFramed: boolean;
  /**
   * 底部状态行（⚠️ 它在输入框**框外**，宽度与输入框**同**、高度 {@link STATUS_LINE_HEIGHT}）
   * @description 框是「我现在能敲字的地方」，而这一行里是**这一局的统计**（各状态的控制面台数）
   * 与版本号 —— 把统计圈进「能敲字的地方」里，等于宣称那些数字也是可编辑内容。故它**不占框内的
   * 高度**，而输入区因此是「框内 n 行 + 上下框 2 行 + 框外状态行 1 行」。
   */
  readonly statusLine: Rect | null;
  /**
   * 命令面板那几行候选各自的位置（**下标序 = 绘制序**；面板没开时是空数组）
   * @description ⚠️ 它**贴着输入框的上边**（最后一行候选的下缘 == 输入框的上缘），
   * 且高度**至多** {@link PALETTE_MAX_RATIO} × 结果区内容行 —— 故它是一块**浮在输入框上方**的
   * 下拉，而不是接管整块结果区：面板开着时**结果区仍在它上面**（至少六成）。
   * ⚠️ 而 {@link Geometry.outputRows} 已经扣掉了它占的那些行，于是呈现层把两者**依次**画在
   * 同一个列里就自然贴住了，不需要「重叠」这个本模块刻意不表达的概念（见文件头坐标系那一节）。
   */
  readonly paletteRows: readonly Rect[];
  /**
   * 面板里给**候选**留几行（总高减去那一条「装不下」的说明行）
   * @description ⚠️ 它与 {@link paletteRows} **必须**一起算：呈现层按它切窗口，而
   * {@link ../cmd/palette.js:paletteWindow} 也拿它算首行号 —— 两处各算一次的话，
   * 「高亮那一行被面板最后一行压住」的形状只在**装不下**时出现（命令少于几行时两处必然相同）。
   */
  readonly paletteViewportRows: number;
  /**
   * 面板那一条「装不下」说明行的位置（`null` = 全部装得下，于是**不占**那一行）
   * @description ⚠️ 它是**判据**而不只是坐标：呈现层与上层都靠「它是不是 `null`」来决定
   * 画不画那句话，两处各判一次就会在某次改动里分叉。
   */
  readonly paletteFooterRow: Rect | null;
  /** 结果区的**内容宽度** —— `@/console/log.ts:flatten` 的 `width` 就是它 */
  readonly outputWidth: number;
  /**
   * 结果区里「结果文本 + 滚动提示那一行」共占几行（**已扣掉命令面板**）
   * @description ⚠️ 呈现层画 {@link Output} 要的是**这个**而不是 {@link outputRows}：两者差一行
   * （滚动提示），而在极矮的屏上两者**都是 0**。⚠️ 与 {@link paletteRows} 相加**恒等于**内容行数。
   */
  readonly outputBlockRows: number;
  /** 结果区里**结果文本**可用几行（已扣滚动提示那一行与面板占掉的那些） */
  readonly outputRows: number;
  /**
   * 模态窗口的**外框**（`null` = 没开窗口）
   * @description ⚠️ 它是**绝对坐标**：窗口是浮在整屏之上的一层，而 Ink 的绝对定位以**父容器**的
   * 内容框原点为准（父是整屏那个根，故与终端屏幕坐标同一套 —— 见 `@/ui/mouse.ts` 文件头）。
   */
  readonly windowBox: Rect | null;
  /** 窗口的**框内**内容矩形（已扣上下框与左右框） */
  readonly windowContent: Rect | null;
  /** 窗口里那些可选行各自的位置（`null` 行 = 没开窗口） */
  readonly windowRows: readonly Rect[];
  /**
   * 窗口**右上角**那枚「esc」（`null` = 没开窗口）
   * @description ⚠️ 它**画在窗口的上边框那一行上**（故它比框**先**画、**后**覆盖，否则被边框吃掉），
   * 而它的坐标同样来自本层 —— 点它关窗与看见它，这是**同一份**数字。
   */
  readonly windowClose: Rect | null;
}

/**
 * 侧边栏文字的起始列（**缩进**，相对于那一列的左缘）
 * @description
 * ⚠️ **呈现层画字必须用这一个数**，不许自己数「几格留白」。侧边栏**没有框**，故这里量的
 * 就是缩进而已 —— 而 {@link Geometry.sidebarRows}[i] 的 `x` 是 **0**（整项可点），两者量的
 * **不是**同一件事：那个是「命中区域从哪一列起」，这个是「字从哪一列起」。
 */
export const SIDEBAR_TEXT_X = 2;

/**
 * 主区那几行文字前面的**缩进**（边框之内的空格数）
 * @description ⚠️ 它**只**归呈现层，几何层**不在矩形里减它**：几何层给的是**可点区域**而缩进是
 * **排版**。而 {@link Geometry.inputTextRows}[0] 的起点**不含**它 —— 输入行那行**没有**这一列
 * 缩进（它前面是提示符）。
 */
export const MAIN_TEXT_X = 2;

/** 一带边框的框里**左边框**占掉的列数（⚠️ 整屏**只有输入区与窗口**画框，故两个都用它） */
export const BORDER_LEFT_COLUMN = 1;

/**
 * 输入行提示符占掉的列数
 * @description ⚠️ 呈现层画的是 `❯ `（{@link PROMPT} 在 `@/console/layout.tsx`），而**本模块不认识字形**：
 * 提示符的宽度必须在这里有一份数，否则「点输入行定位插入符」那个矩形就得由呈现层算。
 * ⚠️ 折行时**所有行都按「减掉它」的那个宽度算**：续行顶格，于是它右边恒多出两列没人用 ——
 * 反过来（按各自行的宽度折）第 0 行会比别的行少折两个字，而「每行折行宽度相同」这条不变式
 * 一破，「点在第 2 行第 k 列」与「第 2 行画出来的第 k 列」就必然错开。
 */
export const PROMPT_COLUMNS = 2;

/** 一带**上下框**占掉的行数 */
export const BORDER_ROWS = 2;

/** 一带**左右框**占掉的列数 */
export const BORDER_COLUMNS = 2;

/** 命令面板最多占**结果区内容行**的几成（⚠️ 连同它那一条「装不下」说明行一起算，见下） */
export const PALETTE_MAX_RATIO = 0.4;

/** 窗口最宽占几列（⚠️ 之外还有「屏宽减 {@link WINDOW_MARGIN}×2」那一道夹） */
export const WINDOW_MAX_WIDTH = 76;
/** 窗口四周至少留几列（留不出来时窗口自己让位，见 {@link geometry}） */
export const WINDOW_MARGIN = 2;
/** 窗口高度至少几行（⚠️ 3 = 上下框 2 + 1 行内容 —— 少一行就只剩框） */
export const WINDOW_MIN_ROWS = 3;
/** 右上角那枚「esc」占几列（` esc`，含首尾那一列空隙） */
export const WINDOW_CLOSE_COLUMNS = 4;

function rect(x: number, y: number, width: number, height: number): Rect {
  // ⚠️ 四边一律夹到非负：负坐标的矩形在命中测试里会**吃掉上方区域的点击**（`y` 从 -1 起的
  // 那一块包含第 0 行）。⚠️ 这一句今天是**防御**而不是**必需** —— 每一个调用点的入参都已经被
  // 各自的边界夹过。留着是因为这一层夹住的是**不变量**（矩形坐标非负）而不是某一次调用的巧合。
  return {
    x: Math.max(0, Math.trunc(x)),
    y: Math.max(0, Math.trunc(y)),
    width: Math.max(0, Math.trunc(width)),
    height: Math.max(0, Math.trunc(height)),
  };
}

/* 折行是「输入串 → 视觉行」这一个出口，绘制与命中测试共用它 */

/** 折出来的一个视觉行 */
export interface WrappedRow {
  /** 这一行的文字（**不含**提示符） */
  readonly text: string;
  /** 这一行的第一个字符在**原串**里的下标（UTF-16 code unit，与插入符同一套下标） */
  readonly start: number;
}

/**
 * 把输入串折成视觉行（**纯函数**；`width` 是每行可用**显示列**数）
 * @description
 * ⚠️ **按显示列断，不按字符个数断**：一个 CJK 字符占两列，按 `String.length` 折出来的第二行
 * 会**超宽**，而 Ink 对超宽的 `<Text>` 是**静默软换行**（`@/console/layout.tsx` 文件头）——
 * 一换行框里就多出一行，而框的高度是本层给的，于是那句话被挤出框外。
 * ⚠️ **宁可折在词中间也不丢字符**：这是命令行，长 token（URL、token）比短词常见，而「少画一个
 * 字符」意味着回车执行的东西与屏上显示的东西**不是同一条**。故判据是「放不下就换行」，
 * 不是「词边界换行」。
 * ⚠️ **空串也返回一行**（`start: 0`）：否则输入区在清空的那一帧会塌成零行，而框的高度由行数
 * 决定 —— 敲一下退格整块界面就往上跳一行。
 * ⚠️ `width <= 0` 时按 1 处理：那不是「不折」，那是一条**除零**（死循环）与一个零宽矩形。
 */
export function wrapInput(text: string, width: number): readonly WrappedRow[] {
  const limit = Math.max(1, Math.trunc(width));
  const rows: WrappedRow[] = [];
  let start = 0;
  let col = 0;
  let index = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    // ⚠️ `index > start` 那个半边是**防御**：一个字符比整行还宽时它仍要占一行，绝不丢。
    if (index > start && col + w > limit) {
      rows.push({ text: text.slice(start, index), start });
      start = index;
      col = 0;
    }
    col += w;
    index += ch.length;
  }
  rows.push({ text: text.slice(start), start });
  return rows;
}

/**
 * 插入符（**原串**里的下标）落在第几个视觉行、行内第几个字符
 * @description ⚠️ 判据是「**从后往前**第一个 `start <= cursor` 的行」：光标在行末时它同时是
 * 上一行的末尾与下一行的开头，从后往前扫给出的正是**折出来的那一行**的末尾 —— 于是
 * 「光标画在行末」与「行末确实有那一格」是同一件事。
 * ⚠️ 返回值夹住：`cursor` 越界时落在某一行的行内末尾，而不是 `-1`（那会让调用方拿它去索引）。
 */
export function caretRowOf(
  wrapped: readonly WrappedRow[],
  cursor: number,
): { readonly row: number; readonly offset: number } {
  if (wrapped.length === 0) return { row: 0, offset: 0 };
  const last = wrapped[wrapped.length - 1]!;
  const at = Math.max(0, Math.min(cursor, last.start + last.text.length));
  for (let i = wrapped.length - 1; i >= 0; i -= 1) {
    const row = wrapped[i]!;
    if (at >= row.start) return { row: i, offset: at - row.start };
  }
  return { row: 0, offset: 0 };
}

/**
 * 点输入区 → 插入符的**原串**下标（`null` = 点的那一格不属于任何一行文本）
 * @description ⚠️ `rects` 与 `wrapped` **必须同源**（都是 {@link geometry} 那一次调用给的），
 * 而 `start` 的偏移是这一层加的 —— 于是「点第 2 行第 3 个字」落在**原串**里哪个下标，
 * 与「第 2 行是从原串哪儿开始的」由**同一份**折行结果回答。
 * ⚠️ 点在行**右侧留白**上落在行末（终端的常态行为），点在行首左侧落在行首：夹住而不是回 `null`，
 * 因为「点击空白处不移动光标」会让人以为界面卡住了。
 */
export function caretFromWrappedPoint(
  clickX: number,
  clickY: number,
  rects: readonly Rect[],
  wrapped: readonly WrappedRow[],
): number | null {
  const row = hitTest(clickX, clickY, rects);
  if (row < 0) return null;
  const line = wrapped[row];
  if (line === undefined) return null;
  return line.start + caretFromColumn(clickX, rects[row]!, line.text);
}

/**
 * 侧边栏宽度的**合法区间**（纯函数；屏宽 → 一个区间）
 * @description ⚠️ 上限是**两道夹**的结果：`{@link SIDEBAR_MAX_WIDTH}` 与「主区至少留
 * {@link MAIN_MIN_WIDTH} 列」。窄屏上先撞上的是**后者** —— 那才是会真的把主区挤没的那一种，
 * 而只按 {@link SIDEBAR_MAX_WIDTH} 夹的话，60 列的屏上拖到最宽会把主区留成十几列。
 * ⚠️ `min > max` 时（屏太窄）返回 `min = max`：一个空区间会让 `clamp` 产出 `NaN`，
 * 而 `NaN` 坐标在命中测试里**恒不命中** —— 症状是「侧边栏整列点不动」且屏上完全看不出原因。
 */
export function sidebarWidthBounds(columns: number): {
  readonly min: number;
  readonly max: number;
} {
  const room = Math.trunc(columns) - SIDEBAR_GAP - MAIN_MIN_WIDTH;
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, room));
  return { min: SIDEBAR_MIN_WIDTH, max };
}

/**
 * 由终端尺寸算出全部区域
 * @description
 * 行的分配（自上而下）：**顶部没有横向区域** → 侧边栏（无框、占满整屏高度）与主区（无框）并列，
 * 两者之间恒隔 {@link SIDEBAR_GAP} 列 → 输入区**带框**贴在状态行上面，而状态行在**框外**。
 * ⚠️ 屏幕上**只有输入区与模态窗口**有框：侧边栏与主区那两条竖线在满屏上把一屏切成了两块
 * 「小窗口」，而侧边栏靠**底色**与主区分开（`@/ui/theme.ts` 的 `surface` 档）再加那一列间隔。
 * ⚠️ `rows` 极小时（拖到 1-4 行）不做特殊处理：各区高度夹到 0，于是画出来的就是一个只剩边框的屏。
 * **这是诚实的**——比在 3 行里硬塞侧边栏+输入框+结果区要清楚（那样三样都读不了）。
 *
 * @param spec - 终端尺寸、侧边栏宽、输入原文、面板与窗口的**事实**（形状见 {@link GeometryInput}）
 * @returns 全部区域
 */
export function geometry(spec: GeometryInput): Geometry {
  const w = Math.max(0, Math.trunc(spec.columns));
  const h = Math.max(0, Math.trunc(spec.rows));

  // 侧边栏：宽度先夹一次（拖出来的那个值不许越界），太窄则整个让位 ────────────
  const tooNarrow = w < MIN_TERMINAL_COLUMNS;
  const bounds = sidebarWidthBounds(w);
  const sidebarWidth = tooNarrow
    ? 0
    : Math.max(bounds.min, Math.min(bounds.max, Math.trunc(spec.sidebarWidth)));
  const mainX = sidebarWidth + SIDEBAR_GAP;
  const mainWidth = Math.max(0, w - mainX);

  // ⚠️ 侧边栏**占满整屏高度**（与输入区那一圈上下框齐平），且**没有框** ⇒ 画一整条底色。
  const sidebar = sidebarWidth === 0 ? null : rect(0, 0, sidebarWidth, h);

  // 输入区：**框内 n 行 + 上下框 + 框外状态行**，故它的高度随输入折行数变化 ───────
  // ⚠️ 折行宽度依赖**主区宽度**，而主区宽度此刻**已经算出来了**（它只依赖侧边栏宽）：顺序不能反。
  const frameWidth = Math.max(0, mainWidth - BORDER_COLUMNS);
  // ⚠️ **每一行都按第 0 行那个宽度折**（第 0 行前面有提示符，见 {@link PROMPT_COLUMNS}）：
  // 少减这两列的话第 0 行会压到右边框上，而那正是「拉到最满 + 折行」那一档。
  const textWidth = Math.max(1, frameWidth - PROMPT_COLUMNS - 1);
  const wrapped = wrapInput(spec.input, textWidth);
  const inputRows = wrapped.length;

  const blockHeight = inputRows + NOTICE_ROWS + BORDER_ROWS + STATUS_LINE_HEIGHT;
  // ⚠️ 输入区**从底部往上占**，而**状态行在最底**：输入区的高度恒是 `min(blockHeight, 屏高)`，
  // 故它**永不越过主区顶边**，而状态行在被它盖住时整体变成 0（`rect` 的 height 夹 0）。
  const statusHeight = Math.min(STATUS_LINE_HEIGHT, h);
  const inputHeight = Math.min(Math.max(0, blockHeight - STATUS_LINE_HEIGHT), Math.max(0, h - statusHeight));
  const inputY = h - statusHeight - inputHeight;

  // ⚠️ **框画得下才画**：Ink 的圆角边框放进宽度 1 / 高度 1 的框里会渲染成**两列两行**，
  // 已经越过终端一列一格，而「每一行都不许超宽」正是本包用来逮「Ink 静默软换行」的那把尺 ——
  // 尺自己先坏了，后面每一条宽度断言都跟着失效。故这里给出一个**判据**，呈现层只读它。
  const inputFramed =
    mainWidth > 0 && inputHeight >= BORDER_ROWS + 1 && mainWidth >= BORDER_COLUMNS;
  const input = mainWidth === 0 ? null : rect(mainX, inputY, mainWidth, inputHeight);
  const inputContent =
    input === null
      ? null
      : rect(
          input.x + (inputFramed ? BORDER_LEFT_COLUMN : 0),
          input.y + (inputFramed ? BORDER_LEFT_COLUMN : 0),
          input.width - (inputFramed ? BORDER_COLUMNS : 0),
          // ⚠️ 框内要装「折行 + 瞬时消息」；画不下框时（极矮的屏）**如实少给**，而呈现层
          // 少画的那几行不是「凭空少一行的结果」，而是这一帧真的放不下。
          input.height - (inputFramed ? BORDER_ROWS : 0),
        );

  // ⚠️ 每一行的 x：第 0 行前面有提示符，续行顶格（{@link Geometry.inputTextRows}）。
  // ⚠️ **只画放得下的那些行**，而「放不下」时**文本行优先于瞬时消息**：框内放得下时那一条
  // 消息恒占一行（{@link Geometry.inputNotice}），放不下时文本赢 —— 它是**正在敲的东西**，
  // 而消息会自己消失（{@link MESSAGE_TTL_MS}）。反过来优先给消息的话，屏一矮操作者敲的字
  // 就少显示一行，而那行内容**就在结果区之外**（输入框每多一行才过一次回车）。
  const contentHeight = inputContent?.height ?? 0;
  const drawableRows = Math.min(
    inputRows,
    Math.max(0, contentHeight - (contentHeight > inputRows ? NOTICE_ROWS : 0)),
  );
  const inputTextRows: Rect[] = [];
  for (let i = 0; i < drawableRows; i += 1) {
    // ⚠️ **每一行的 x 与宽度都相同**（`content.x + PROMPT_COLUMNS` 与 `textWidth`）：折出来的
    // 续行与第 0 行**左对齐**（悬挂缩进），而右边恒多出 {@link PROMPT_COLUMNS} 列没人用 ——
    // 那正是「每行都按第 0 行那个宽度折」换来的（见 {@link PROMPT_COLUMNS}）。
    inputTextRows.push(rect((inputContent?.x ?? 0) + PROMPT_COLUMNS, (inputContent?.y ?? 0) + i, textWidth, 1));
  }
  const noticeHeight = contentHeight - drawableRows;
  const inputNotice =
    inputContent === null || noticeHeight < 1
      ? null
      : rect(inputContent.x, inputContent.y + drawableRows, inputContent.width, noticeHeight);
  // ⚠️ 状态行**在框外**，宽度与输入框**同**：它不是「框里的一行」，所以它不与框内抢高度。
  const statusLine =
    statusHeight === 0 || mainWidth === 0 ? null : rect(mainX, inputY + inputHeight, mainWidth, statusHeight);

  const output = mainWidth === 0 ? null : rect(mainX, 0, mainWidth, inputY);

  // 侧边栏的会话项：每项 {@link SESSION_ROWS} 行、横跨整列 ──────────────────
  // ⚠️ 没有侧边栏时**必须给空数组**，不能给「宽度 0 的 n 行」——那会让命中测试拿着一份
  // 「有 3 行可点」的数据，而屏上一个侧边栏都没有，点下去什么也不会发生（静默无响应）。
  const sessionsThatFit = sidebar === null ? 0 : Math.max(0, Math.floor(h / SESSION_ROWS));
  const sidebarRows: Rect[] = [];
  for (let i = 0; i < sessionsThatFit; i += 1) {
    sidebarRows.push(rect(0, i * SESSION_ROWS, sidebarWidth, SESSION_ROWS));
  }
  // ⚠️ 手柄 = 侧边栏**最右那一列**（与上面那些项重叠，故命中测试必须先判它，见那条注释）。
  const sidebarHandle = sidebar === null ? null : rect(sidebar.width - 1, 0, 1, h);

  // 命令面板：一块**贴着输入框**、高度至多 40% 的浮层 ────────────────────────
  // ⚠️ 顺序是**这份算术的全部**：先按比例定上限，再决定那一条「装不下」说明行**算不算在
  // 上限内**，最后才从内容行里减掉面板占的那些。反过来（先按候选数裁、再补说明行）会占 41%。
  // ⚠️ **`contentRows` 就是结果区的整块高度**（不多留一行）：各区高度之和必须**恒等于**终端
  // 行数，否则 Ink 的列向 flex 会把差出来的那一行摊到别处 —— 症状是「整屏往上挪了一行、
  // 状态行画在了输入框上面那一行」（实测踩过一次）。
  const contentRows = output === null ? 0 : Math.max(0, output.height);
  // ⚠️ **上限就是 40%，不给「至少一行」的兜底**：内容区只有两行时 `floor(0.8) = 0`，而一块
  // 0 行的面板就是「这一帧没有面板」—— 那比「面板比 40% 高」诚实（后者是**说了 40% 却没做到**）。
  const cap = Math.floor(contentRows * PALETTE_MAX_RATIO);
  const count = Math.max(0, Math.trunc(spec.paletteCount));
  const fits = count <= cap;
  const paletteViewportRows = cap === 0 ? 0 : fits ? count : cap - 1;
  const wantsFooter = cap !== 0 && !fits && output !== null;
  const panelRows = paletteViewportRows + (wantsFooter ? 1 : 0);
  // ⚠️ **结果区那一块** = 结果文本 + 滚动提示，而它与面板**相加恰好**等于内容行数。
  const outputBlockRows = Math.max(0, contentRows - panelRows);
  const outputRows = Math.max(0, outputBlockRows - 1);
  // ⚠️ 说明行紧跟在**最后一行候选之下**：两者的 y 共用 `outputBlockRows` 这一个基数
  // （各写一遍的话，说明行会与最后一行候选重叠 —— 症状是「那句话压在命令名上面半个字」）
  const paletteFooterRow = wantsFooter
    ? rect(mainX, outputBlockRows + paletteViewportRows, mainWidth, 1)
    : null;
  const paletteRows: Rect[] = [];
  for (let i = 0; i < paletteViewportRows; i += 1) {
    // ⚠️ y 从「结果文本区之下」起算，而它的高度**已经扣掉了面板**（`outputBlockRows`）——
    // 候选 + 说明行相加恰好贴住 `inputY`，于是一片「重叠」都不需要。
    paletteRows.push(rect(mainX, outputBlockRows + i, mainWidth, 1));
  }

  // 模态窗口：居中一块，带一圈框，右上角那枚「esc」画在上边框那一行上 ────────
  const win = spec.window ? windowRect(h, w, spec.windowRows, spec.windowFooter) : null;
  const windowBox = win === null ? null : rect(win.x, win.y, win.width, win.height);
  const windowContent =
    windowBox === null
      ? null
      : rect(
          windowBox.x + BORDER_LEFT_COLUMN,
          windowBox.y + BORDER_LEFT_COLUMN,
          windowBox.width - BORDER_COLUMNS,
          Math.max(0, windowBox.height - BORDER_ROWS),
        );
  // ⚠️ 窗口框内**第一行是标题**，故那些行从 `content.y + 1` 起算 —— 少了这一行偏移，
  // 第 1 行会与标题**重叠**（Ink 后写的覆盖先写的 → 标题被第一行盖掉，而「窗口叫什么」就没人知道了）。
  // ⚠️ x 与 width 把**缩进与记号**都让出来（`MAIN_TEXT_X + 2`）：呈现层画的就是这两段，
  // 而「名字从哪一列起」是它的排版预算从哪儿算的根 —— 两处不一致时症状是「名字压着记号」。
  const winRowCount =
    windowContent === null
      ? 0
      : Math.max(0, windowContent.height - 1 - (spec.windowFooter ? 1 : 0));
  const windowRows: Rect[] = [];
  for (let i = 0; i < Math.min(Math.max(0, Math.trunc(spec.windowRows)), winRowCount); i += 1) {
    windowRows.push(
      rect(
        (windowContent?.x ?? 0) + MAIN_TEXT_X + 2,
        (windowContent?.y ?? 0) + 1 + i,
        Math.max(0, (windowContent?.width ?? 0) - MAIN_TEXT_X - 2),
        1,
      ),
    );
  }
  // ⚠️ 那一枚 `esc` **紧贴右边框内侧**（右边留一列），于是它不会压住右上那个圆角
  const windowClose =
    windowBox === null
      ? null
      : rect(
          Math.max(0, windowBox.x + windowBox.width - BORDER_LEFT_COLUMN - WINDOW_CLOSE_COLUMNS),
          windowBox.y,
          WINDOW_CLOSE_COLUMNS,
          1,
        );

  return {
    columns: w,
    rows: h,
    sidebar,
    sidebarRows,
    sidebarHandle,
    output,
    input,
    inputContent,
    inputTextRows,
    inputWrapped: wrapped,
    inputRows,
    inputNotice,
    inputFramed,
    statusLine,
    paletteRows,
    paletteViewportRows,
    paletteFooterRow,
    // ⚠️ 主区与侧边栏都**没有框** ⇒ 内容宽度就是矩形宽度，**一个列都不多扣**。
    outputWidth: output === null ? 0 : output.width,
    outputBlockRows,
    outputRows,
    windowBox,
    windowContent,
    windowRows,
    windowClose,
  };
}

/**
 * 模态窗口的尺寸与落点（私有；**只有 {@link geometry} 调它**，故「窗口多大」是**一处**算术）
 * @description ⚠️ 高度 = 标题 1 行 + 内容行 + 上下框 + 那一条说明行，而**上限是屏高减上下各留一行**：
 * 窗口顶到屏幕第一行会让「它浮在上面」这件事看不出来（那与「占满整屏」长得一样）。
 * ⚠️ **装不下时按屏高截断，而不是整个不画**：控制面有九个而屏只放得下五行时，
 * 「没有窗口」等于「`/managers` 这一条命令什么都没发生」；而「显示五行 + 底部说一句共九个」
 * 至少还答得上来（那句话由调用方按 {@link Geometry.windowRows} 的长度与总数之差写出来）。
 * ⚠️ **真的连一行内容都放不下**（屏高不足 {@link WINDOW_MIN_ROWS}）时才给 `null`：
 * 那时框会画成一条横线，而那一帧里操作者既看不到内容也看不到「esc」。
 * ⚠️ 宽度**至少** 11 列：那一枚 `esc` 与缩进加起来就要十几列，而一个比它还窄的框里
 * 「窗���叫什么」与「有哪些控制面」会同时消失。
 */
function windowRect(
  screenHeight: number,
  screenWidth: number,
  rowCount: number,
  footer: boolean,
): Rect | null {
  const contentRows = 1 + Math.max(0, Math.trunc(rowCount)) + (footer ? 1 : 0);
  const wanted = contentRows + BORDER_ROWS;
  const maxHeight = screenHeight - 2;
  if (maxHeight < WINDOW_MIN_ROWS) return null;
  const width = Math.max(
    WINDOW_MIN_ROWS + 8,
    Math.min(WINDOW_MAX_WIDTH, screenWidth - WINDOW_MARGIN * 2),
  );
  const used = Math.max(WINDOW_MIN_ROWS, Math.min(wanted, maxHeight));
  return rect(
    Math.floor((screenWidth - width) / 2),
    Math.floor((screenHeight - used) / 2),
    Math.min(width, screenWidth),
    used,
  );
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
 * 一行文本上的某一列 → 该行内的字符下标
 * @description
 * 判据是**显示列**不是字符下标：一个 CJK 字符占两列，所以点它右半边应该把插入符放在它
 * **之后**。因此这里逐字符累加显示宽度，返回「该列之前有多少个字符」。
 *
 * ⚠️ 返回值夹在 `[0, text.length]`：点在行**右侧留白**上时落在末尾（这是终端的常态
 * 行为，也是用户预期）；点在行首左侧落在 0。夹住而不是回 -1，是因为**点击空白处不移动
 * 光标**会让人以为界面卡住了。
 *
 * @param clickX - 终端列（0 起，绝对）
 * @param textRect - 那一行文本的矩形
 * @param text - 那一行的文字
 * @returns 该行内的字符下标
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