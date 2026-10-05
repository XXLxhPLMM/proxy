/**
 * @fileoverview 屏幕几何：呈现层按它画、鼠标命中按它判（两边读**同一份数字**）；⚠️ 全部是**终端绝对坐标**（0 起），矩形一律**半开区间** `[x, x+width)` × `[y, y+height)`
 */

import stringWidth from "string-width";

import { LOGO_ROWS, LOGO_WIDTH } from "@/features/output/logo.js";

/** 侧边栏的**缺省**宽度（用户拖过之后以那个为准，见 {@link GeometryInput.sidebarWidth}） */
export const SIDEBAR_WIDTH = 32;
/** 侧边栏最窄能拖到几列（再窄会话名与控制面名一起没地方放） */
export const SIDEBAR_MIN_WIDTH = 14;
/** 侧边栏最宽能拖到几列（⚠️ 上限之外还有一道「主区至少留 {@link MAIN_MIN_WIDTH} 列」的夹） */
export const SIDEBAR_MAX_WIDTH = 44;
/** 侧边栏与主区之间**恒隔**几列（⚠️ 这一列**不属于任何一边**，它本身就是那条分隔线） */
export const SIDEBAR_GAP = 1;
/** 主区至少留几列（它是侧边栏宽上限的**真正**来源：窄屏上先撞上的是这一条） */
export const MAIN_MIN_WIDTH = 34;
/** 侧边栏一项（= **一个会话**）占几行：第 1 行会话名、第 2 行它连的控制面 */
export const SESSION_ROWS = 2;
/**
 * 相邻两项之间留几行空白（⚠️ **第一项之上另有 {@link SIDEBAR_TOP_PAD_ROWS}** —— 两个不同的留白）
 */
// ⚠️ 少它的后果是相邻两项的行块贴在一起，一列长名与一列控制面名互相读串
export const SESSION_GAP_ROWS = 1;
/** 清单**第一项之上**留几行空白（⚠️ 与 {@link SESSION_GAP_ROWS} 分开：那一个在项与项之间，这一个在清单之上） */
// ⚠️ 少它的症状不是「看着挤」：那一列的第一行与主区的第一行同高，而两侧的行号会互相读串
export const SIDEBAR_TOP_PAD_ROWS = 1;
/** 清单里从一项走到下一项**下移几行**（= 项本身 {@link SESSION_ROWS} + 它上面那 {@link SESSION_GAP_ROWS}） */
export const SESSION_STRIDE = SESSION_ROWS + SESSION_GAP_ROWS;
/** 会话名**前面**恒留几列给「运行中 / 跑完了」那一枚记号（⚠️ 与「有没有记号」无关，两帧的列位必须一样） */
// ⚠️ **奇数**：记号字形居中于这几列 = 左若干列 + 字形 + 右同样多列 —— 偶数列上「居中」不成立。
// 至少三列（与 {@link SESSION_CLOSE_COLUMNS} 同一条理由）：`●` 与 `⠋` 的 East Asian Width 是
// **Ambiguous**，按 CJK 宽度渲染的终端里它们是**两列** —— 少留一列的话那一帧的会话名会整体右移一列。
export const SESSION_MARK_COLUMNS = 3;
/** 每一项右侧为那枚「关闭」**恒预留**几列（⚠️ 与「指针在哪儿」无关，悬停只决定**画不画**） */
// ⚠️ **两列而不是一列**：`✕`（U+2715）的 East Asian Width 是 **Ambiguous**，按 CJK 宽度渲染的终端里
// 它是**两列**而 `string-width` 按一列算 —— 只留一列的那种终端会把那一行顶宽一列，于是 Ink 静默软换行。
export const SESSION_CLOSE_COLUMNS = 2;
/** 侧边栏**最窄**也要给会话名留几列（窄到放不下「名字 + 关闭」时那一枚**不画**：0 列宽的按钮点不中） */
export const SIDEBAR_CLOSE_MIN_NAME = 4;
/** 窄终端下侧边栏让位给主区的阈值：低于此宽度就不画侧边栏 */
export const MIN_TERMINAL_COLUMNS = 60;

/** 会话菜单**一项**占几行（⚠️ 菜单是命令列表：每一项**恒一行**，而它的可点区域**恒等于**画出来的那一行） */
export const MENU_ROWS = 1;
/** 菜单左缘那一格留白（⚠️ 右缘同宽：两项的记号在左缘，于是右边只需要补到卡片宽度） */
export const MENU_PAD_X = 1;
/** 菜单的宽下限几列（⚠️ 「新建会话」四个汉字 + 左右缩进 = 10 —— 再窄就把「重命名」切成两个字） */
export const MENU_MIN_WIDTH = 12;

/** 输入区框内**瞬时消息**那一行的行数（⚠️ 它**在框内**：框是「我现在能敲字的地方」） */
export const NOTICE_ROWS = 1;
/** 「提供商 · 推理强度」那一行的行数（⚠️ 它在输入框**框外**、状态行之上，见 {@link Geometry.modelStatus}） */
// ⚠️ **它吃输入区的高度**：那一行恒占一格，而框的高度是「折行 + 消息 + 框」——
// 漏掉它的话输入框会盖住这一行，而屏上「模型与推理强度都不见了」而零解释。
export const MODEL_STATUS_ROWS = 1;
/** 底部状态行的高度（⚠️ 它在输入框**框外**，见 {@link Geometry.statusLine}） */
export const STATUS_LINE_HEIGHT = 1;

/** 一个矩形（**半开区间**：`[x, x+width)` × `[y, y+height)`） */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 模态窗口内容区里的一格（⚠️ **槽位 = 占一行的东西；能不能被选中由 `kind` 决定**） */
export type WindowSlot =
  /** 说明那一行（不可选。例：「台账里还没有控制面 · 先加一个」） */
  | { readonly kind: "note" }
  /** 分组标题那一行（不可选。例：「今天」/「3 天前」/「按提供商」） */
  | { readonly kind: "group" }
  /** 一个可选行（**唯一**能被 `↑↓` 与鼠标命中选中的那一档） */
  | { readonly kind: "row" }
  /** 单行文本输入那一行（改名框 / 表单字段 / 过滤框；不可选，焦点由窗口状态答） */
  | { readonly kind: "input" }
  /** 下拉选择那一行（`↑↓` 在**这一行之内**换档，`Enter` 定；例：API 格式） */
  | { readonly kind: "select" }
  /** 勾选那一行（模型清单：`Space` 切换高亮的那一个；⚠️ 与 `row` 的差别是**多一个勾选位**） */
  | { readonly kind: "check" };

/**
 * {@link geometry} 的入参（`input` 是**原文**而不是行数）⚠️ **一个对象**：字段名自带判据，少传一个编译期就红
 */
export interface GeometryInput {
  readonly columns: number;
  readonly rows: number;
  /** 侧边栏宽度（**调用点给的那个值**；本层按 {@link sidebarWidthBounds} 夹一次再往下算） */
  readonly sidebarWidth: number;
  /** 会话一共几个（几何层据此判「装不下」并决定要不要留那一行说明，见 {@link Geometry.sidebarOverflowRow}） */
  // ⚠️ 这个数**就是侧边栏清单本身**（不在 `sidebar_sessions` 上的会话不进侧边栏，故不占行）
  readonly sessionCount: number;
  /** 会话清单**滚到第几项**（**下标**；本层再夹一次，夹过的那一份是 {@link Geometry.sessionFirst}） */
  // ⚠️ 本层**只夹不推**：「当前会话必须留在可见窗口里」是**状态层**的活（`@/AppState.js`）——
  // 几何层一并接管的话，滚轮翻看别的会话会在下一帧被拽回来。
  readonly sessionsTop: number;
  /** 输入行那串原文（折行与行数由本层算，见 {@link wrapInput}） */
  readonly input: string;
  /** 命令面板有几行候选（`0` = 面板没开，于是 {@link Geometry.paletteRows} 是空的） */
  readonly paletteCount: number;
  /** 内容区里**逐槽**装什么（`[]` = 没开窗口；⚠️ `[]` 是「没开」的**唯一**写法，不设可选） */
  readonly window: readonly WindowSlot[];
  /** 右上角画不画那枚 `esc 关窗`（`false` ⇒ 几何层**同时不为它预留列**，标题于是能用满整行） */
  readonly windowCloseHint: boolean;
  /** 会话菜单（`null` = 没开）；⚠️ `x` / `y` 是那次右键的落点，**夹进屏内由本层做** */
  readonly menu: MenuRequest | null;
}

/** 一次右键弹出的会话菜单（⚠️ `items` 是**给人看的那几行**，本层按它们算卡片宽度于是绘制不必再算一次） */
export interface MenuRequest {
  readonly x: number;
  readonly y: number;
  readonly items: readonly string[];
}

/** 各区域的几何。⚠️ 整屏**只有输入区**带框（见 {@link Geometry.inputFramed}），其余都是无边界的 */
export interface Geometry {
  readonly columns: number;
  readonly rows: number;
  /** 侧边栏整体（`null` = 本终端太窄，画不出来）。⚠️ 它**占满整屏高度**且**没有框** */
  readonly sidebar: Rect | null;
  /** 侧边栏里**可见窗口**内每个会话各自的位置（与 `sidebar` 同列，长度 = 窗口内那一段的项数） */
  // ⚠️ **`sidebarRows[i]` 是第 `sessionFirst + i` 个会话**，不再是第 `i` 个：命中测试与呈现层切片
  // 都必须加上它。⚠️ 每一项**横跨整列**（`x === 0`）而名字从 `SIDEBAR_TEXT_X` 起画，且第一项之下
  // 恒有 {@link SIDEBAR_TOP_PAD_ROWS} 行留白。
  readonly sidebarRows: readonly Rect[];
  /** 与 {@link sidebarRows} **同序同长**：每一项右上角那枚「关闭」的矩形（`null` = 太窄，画不下） */
  // ⚠️ 它是**真实可点区域**，与画出来的那一枚是**同一个矩形** —— 呈现层只在悬停时画它，而命中测试
  // **不看悬停**（悬停状态来自**上一次 move 事件**）。
  readonly sidebarCloseRows: readonly (Rect | null)[];
  /** 可见窗口的第一项是第几个会话（**加在命中测试的下标上才是会话下标**） */
  // ⚠️ 它是**夹过**的那一份，于是「删掉会话之后窗口越界」由本层一次性兜住。
  readonly sessionFirst: number;
  /** 侧边栏**放得下几项**会话（⚠️ 已扣顶部那 {@link SIDEBAR_TOP_PAD_ROWS} 行与末尾那一行说明，见下） */
  readonly sessionViewportRows: number;
  /** 侧边栏**最底下那一行**的「第 x–y / 共 n 个」说明（`null` = 全部装得下，于是**不占**那一行） */
  // ⚠️ 它**只在装不下时**才占一行，而「装不下」要先按「不含它」的容量判 —— 故 `sessionViewportRows`
  // 是两趟算出来的。⚠️ 它是**判据**而不只是坐标。
  readonly sidebarOverflowRow: Rect | null;
  /** 侧边栏**最右那一列** = 拖宽的手柄（`null` = 没有侧边栏） */
  // ⚠️ 它**与 `sidebarRows` 重叠**：点在那一列上既落在某一项里、也落在这个矩形里，故命中测试
  // **必须先判手柄** —— 反过来「按着最右那列拖宽」会在起手那一瞬把会话切掉。
  readonly sidebarHandle: Rect | null;
  /** 结果区（可滚动、可滚轮）。⚠️ 它的**下缘**可能被命令面板占掉（见 `paletteRows`） */
  readonly output: Rect | null;
  /** 输入区的**外框**（含上下框那两行；**不含**框外那一行状态行）。`null` = 主区画不出来 */
  readonly input: Rect | null;
  /** 输入区的**框内**内容矩形（已扣上下框与左右框） */
  // ⚠️ `inputFramed` 为假时它**就是** `input` 本身（一个都没扣）—— 呈现层据此少画那一层。
  readonly inputContent: Rect | null;
  /** 输入串折出来的**每一视觉行**各自的文本矩形（长度 = {@link Geometry.inputRows}） */
  // ⚠️ **第 0 行的 x 与其余各行不同**（只有第一行前面有提示符 `❯ `，折出来的续行顶格），而**每一行
  // 的宽度相同**。⚠️ 绘制与「点输入行落点」读的是**这一个数组**，故两者不可能错开。
  readonly inputTextRows: readonly Rect[];
  /** 输入串折出来的**那几行文字**（与 {@link inputTextRows} **同序、同长度**） */
  // ⚠️ 它必须由几何层**一起给**：让呈现层自己再折一遍就有**两份**折行判据。
  readonly inputWrapped: readonly WrappedRow[];
  /** 输入串折成几行（**至少 1**：空串也是一行，否则框会塌成一条边） */
  readonly inputRows: number;
  /** 框内那条**瞬时消息**行（`null` = 框内放不下，于是这一帧不显示它） */
  // ⚠️ 它是**判据**：呈现层只按「它是不是 `null`」决定画不画，而本层**优先保证文本行**。
  readonly inputNotice: Rect | null;
  /** 输入框**左侧那一列箭头槽**（宽 {@link PROMPT_COLUMNS}；`null` = 主区画不出来或那一列放不下） */
  // ⚠️ **它贯穿整个框内高度**（含所有折行），而文字恒从 `inputContent.x + PROMPT_COLUMNS` 起
  readonly inputGutter: Rect | null;
  /** 输入区的框**画不画得下**（`true` = 上下左右各 1 列都还在，且至少留得下 1 行内容） */
  readonly inputFramed: boolean;
  /** 「提供商 · 推理强度」那一行（`null` = 极矮的屏上它放不下；⚠️ 框外，底部状态行之上） */
  // ⚠️ 与 {@link inputNotice} 同一纪律：`null` 就是**判据**，呈现层只按它决定画不画
  readonly modelStatus: Rect | null;
  /** 底部状态行（⚠️ 它在输入框**框外**，宽度与输入框**同**：那一行里是统计与版本号，不是可编辑内容） */
  readonly statusLine: Rect | null;
  /** 命令面板那几行候选各自的位置（**下标序 = 绘制序**；面板没开时是空数组） */
  // ⚠️ 它**贴着输入框的上边**，且高度**至多** `PALETTE_MAX_RATIO` × 结果区内容行 —— 而
  // `outputRows` 已经扣掉了它占的那些行，于是呈现层把两者**依次**画就自然贴住。
  readonly paletteRows: readonly Rect[];
  /** 面板里给**候选**留几行（总高减去那一条「装不下」的说明行） */
  // ⚠️ 它与 `paletteRows` **必须**一起算：呈现层按它切窗口，而 `@/commands/palette.js:paletteWindow`
  // 也拿它算首行号。
  readonly paletteViewportRows: number;
  /** 面板那一条「装不下」说明行的位置（`null` = 全部装得下，于是**不占**那一行） */
  // ⚠️ 它是**判据**而不只是坐标：呈现层与上层都靠「它是不是 `null`」来决定画不画那句话。
  readonly paletteFooterRow: Rect | null;
  /** 结果区的**内容宽度** —— `@/lib/log/rows.ts:flatten` 的 `width` 就是它 */
  readonly outputWidth: number;
  /** 结果区里「结果文本 + 滚动提示那一行」共占几行（**已扣掉命令面板**） */
  // ⚠️ 呈现层画 {@link Output} 要的是**这个**而不是 `outputRows`（两者差一行，而极矮的屏上都是 0）。
  // ⚠️ 与 `paletteRows` 相加**恒等于**内容行数。
  readonly outputBlockRows: number;
  /** 结果区里**结果文本**可用几行（已扣滚动提示那一行与面板占掉的那些） */
  readonly outputRows: number;
  /** 引导屏那块**标记**（艺术字 + 下面那行小字）在结果区里的矩形（`null` = 这一屏放不下它） */
  // ⚠️ **居中**：横向按 `LOGO_WIDTH`、纵向按它的高度在 `outputBlockRows` 那一块里居中。
  // ⚠️ `null` 有两个成因，**都不许用「缩一点」糊过去**：宽度不足 `LOGO_WIDTH` 列或高度不足 `LOGO_ROWS` 行。
  readonly welcome: Rect | null;
  /** 模态窗口那一块**卡片**（`null` = 没开窗口；⚠️ 它**没有框**） */
  // ⚠️ 它是**绝对坐标**：Ink 的绝对定位以**父容器**的内容框原点为准（父是整屏那个根）。
  readonly windowBox: Rect | null;
  /** 卡片**标题那一行**（`null` = 没开窗口）⚠️ 恒高 1，它与卡片之间隔着 {@link WINDOW_PADDING} */
  readonly windowHeader: Rect | null;
  /** 内容区 = 内区**扣掉标题那一行**（`null` = 没开窗口）⚠️ 它的**第一行是分隔**（见 {@link windowSlots}） */
  // ⚠️ 它与 {@link windowBox} **分叉**（上下左右各差 `WINDOW_PADDING` 加一行标题）：
  // 呈现层按它铺行，按 `windowBox` 铺底色 —— 两者恒等的话卡片右缘那一列会是遮罩的颜色。
  readonly windowContent: Rect | null;
  /** 内容区里**逐槽**的矩形（**与 {@link GeometryInput.window} 同序同长**；装不下的那些是 `null`） */
  // ⚠️ **长度恒等于**入参那串槽位而**不是**画得下的那一段：呈现层与命中测试都是按「第 i 槽」问的，
  // 少一个元素就与彼此错开一位（症状是「点第 2 行选中第 3 个」而屏上完全看不出异常）。
  readonly windowSlots: readonly (Rect | null)[];
  /** {@link windowSlots} 里 `kind === "row"` 的那些（**同序**；⚠️ 命中测试读它，故它**只**含可选行） */
  readonly windowRows: readonly Rect[];
  /** {@link windowSlots} 里 `kind === "group"` 的那些（**同序**） */
  readonly windowGroups: readonly Rect[];
  /**
   * {@link windowSlots} 里 `kind === "check"` 的那些（**同序**；⚠️ 命中测试读它 ⇒ 勾选点得中哪一行）
   */
  readonly windowChecks: readonly Rect[];
  /** {@link windowSlots} 里 `kind === "select"` 的那些（**同序**；⚠️ 命中测试读它 ⇒ 点它落那一档的换档） */
  readonly windowSelects: readonly Rect[];
  /** `input` 槽**各自**整行的矩形（**与 {@link windowSlots} 同序同长**，其余档位与装不下的都是 `null`） */
  // ⚠️ **单数投影表达不了表单**（五个字段）：下标 i 是第 i 个槽位，不是「装得下的第 i 个」
  readonly windowInputs: readonly (Rect | null)[];
  /** `input` 槽**各自**里「文字」那一格（已让开提示符；与 {@link windowInputs} **同序同长**） */
  // ⚠️「点它落插入符」与绘制读的是**同一个**矩形 —— 整行**含提示符**，按整行算会偏掉那几列
  readonly windowInputTexts: readonly (Rect | null)[];
  /** 窗口**标题那一行**上「窗口叫什么」那几个字的位置（`null` = 没开窗口） */
  // ⚠️ **它必须由本层给**：那一行的右端坐着 `windowClose` 那一枚，标题的裁剪预算要把那几列让出来 ——
  // 两处各算一次的话「标题压住 esc」与「esc 盖住标题末字」是同一个 bug 的两种长相。
  readonly windowTitle: Rect | null;
  /** 卡片右上角那枚「esc」提示（`null` = 没开窗口，**或** {@link GeometryInput.windowCloseHint} 为假） */
  readonly windowClose: Rect | null;
  /** 会话菜单那块卡片（`null` = 没开菜单）；⚠️ 它**没有框也没有遮罩**：菜单不是模态，点它外面就是关掉它 */
  // ⚠️ 落点由本层夹进屏内（`x + y` 是那次右键的落点，而贴着右下角的一次右键会让半张菜单掉出屏外）。
  readonly menu: Rect | null;
  /** 菜单里那些项各自的位置（与 {@link menu} 同序同长；⚠️ **没有它就没有命中测试**：菜单浮在侧边栏上，
   *  而菜单那一格同时落在某一项的矩形里，不按「菜单先判」的话点菜单等于切会话） */
  readonly menuRows: readonly Rect[];
}

/** 会话名的**起始列**（**缩进**，相对于那一列的左缘） */
// ⚠️ **呈现层画字必须用这一个数**：而 `sidebarRows[i]` 的 `x` 是 **0**（整项可点）—— 那个是
// 「命中区域从哪一列起」，这个是「名字从哪一列起」。⚠️ 它**恒等于**记号位（{@link SESSION_MARK_COLUMNS} 列）
// 的右缘，故那一枚记号与这 {@link SIDEBAR_TEXT_X} 列缩进**是同一批列**，不许叠加成两倍。
export const SIDEBAR_TEXT_X = 3;

/** 主区那几行文字前面的**缩进**（边框之内的空格数） */
// ⚠️ 它**只**归呈现层，几何层**不在矩形里减它**：几何层给的是**可点区域**而缩进是排版。
export const MAIN_TEXT_X = 2;

/** 一带边框的框里**左边框**占掉的列数（⚠️ 整屏**只有输入区**画框 —— 模态窗口是**没有框**的一块卡片） */
export const BORDER_LEFT_COLUMN = 1;

/** 输入行提示符占掉的列数（呈现层画的是 `❯ ` 而**本模块不认识字形**：宽度必须在这里有一份数） */
export const PROMPT_COLUMNS = 2;
// ⚠️ 折行时**所有行都按「减掉它」的那个宽度算**：续行顶格，于是它右边恒多出两列没人用 —— 按各自行
// 的宽度折的话，「点在第 2 行第 k 列」与「第 2 行画出来的第 k 列」就必然错开。

/** 一带**上下框**占掉的行数 */
export const BORDER_ROWS = 2;

/** 一带**左右框**占掉的列数 */
export const BORDER_COLUMNS = 2;

/** 命令面板最多占**结果区内容行**的几成（⚠️ 连同它那一条「装不下」说明行一起算，见下） */
export const PALETTE_MAX_RATIO = 0.4;

/** 窗口的宽占**整屏宽**的几成（⚠️ 它是**上限**：见下面那条下限） */
// ⚠️ **按整屏宽**而不是按主区宽：模态是「这一屏」的事，按主区算的话宽屏上它整个泡在主区里。
export const WINDOW_WIDTH_RATIO = 0.7;
/** 窗口的宽下限几列（70% 算出来比它还窄时按它，而**不是**缩到「标题与 `esc` 一起消失」） */
export const WINDOW_MIN_WIDTH = 50;
/** 视口比这一档还窄时窗口**占满整屏宽**（⚠️ 与上一档之间有一格不连续：见 {@link windowRect}） */
export const WINDOW_FULL_WIDTH_BELOW = 60;
/** 窗口的高占屏高的几成（⚠️ **唯一**的一项：内容行数与期望下限都不参与，见 {@link windowRect}） */
export const WINDOW_HEIGHT_RATIO = 0.5;
/** 卡片**最少**几行高（= 上下 padding 2 + 标题 1 + 分隔 1；再矮就不画） */
// ⚠️ **不画 `esc` 那一枚时也不降**：`note` / `input` 那一行顶上它的位置，而「装不下自己标题的模态
// 是纯噪音」这条判据与 `esc` 在不在无关。
export const WINDOW_MIN_ROWS = 4;
/** 卡片那一圈**内边距**（⚠️ 它是 {@link Geometry.windowContent} 与 {@link Geometry.windowBox} 分叉的唯一原因） */
export const WINDOW_PADDING = 1;
/** 标题从**内区**左缘起缩进几列 */
export const WINDOW_HEADER_INDENT = 3;
/** 那枚 `esc` 提示离**内区**右缘几列 */
export const WINDOW_CLOSE_INSET = 3;
/** 右上角那枚「esc」提示占几列（` esc 关窗` = 1 + 3 + 1 + 4） */
export const WINDOW_CLOSE_COLUMNS = 9;
/** 改名输入框提示符占掉的列数（呈现层画的是 `✎ `，而几何层不认识字形） */
export const WINDOW_INPUT_PROMPT_COLUMNS = 2;

function rect(x: number, y: number, width: number, height: number): Rect {
  // ⚠️ 四边一律夹到非负：负坐标的矩形在命中测试里会**吃掉上方区域的点击**。留着是因为这一层
  // 夹住的是**不变量**（矩形坐标非负）而不是某一次调用的巧合。
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

/** 把输入串折成视觉行（`width` 是每行可用**显示列**数）⚠️ **先按 `\n` 切硬行，再对每一段按显示列软折** */
  // ⚠️ 每行的 `start` 是**原串**里的下标（不是那一段里的），`caretRowOf` 靠它把光标定位回那一行
  // ⚠️ **空串也返回一行**：否则输入区在清空的那一帧塌成零行，而框的高度由行数决定
export function wrapInput(text: string, width: number): readonly WrappedRow[] {
  // ⚠️ `width <= 0` 按 1 处理：那不是「不折」，那是一条除零与一个零宽矩形
  const limit = Math.max(1, Math.trunc(width));
  const rows: WrappedRow[] = [];
  let origin = 0;
  for (const segment of text.split("\n")) {
    // ⚠️ `origin` 累加的是「这一段 + 那个 `\n`」：下一段的第一个字在原串里正好是 `origin + 1`
    for (const row of softWrap(segment, limit)) {
      rows.push({ text: row.text, start: origin + row.start });
    }
    origin += segment.length + 1;
  }
  return rows;
}

/**
 * 折**一段**（不含 `\n`）成若干视觉行（私有；**只有 {@link wrapInput} 调它**）
 * @description `start` 是**这一段里**的下标 —— 落在原串里的那一份由 {@link wrapInput} 加偏移
 */
function softWrap(segment: string, limit: number): readonly WrappedRow[] {
  const rows: WrappedRow[] = [];
  let start = 0;
  let col = 0;
  let index = 0;
  for (const ch of segment) {
    const w = stringWidth(ch);
    // ⚠️ `index > start` 那个半边是**防御**：一个字符比整行还宽时它仍要占一行，绝不丢。
    if (index > start && col + w > limit) {
      rows.push({ text: segment.slice(start, index), start });
      start = index;
      col = 0;
    }
    col += w;
    index += ch.length;
  }
  rows.push({ text: segment.slice(start), start });
  return rows;
}

/** 插入符（**原串**里的下标）落在第几个视觉行、行内第几个字符 */
// ⚠️ 判据是「**从后往前**第一个 `start <= cursor` 的行」：光标在行末时它同时是上一行的末尾与下一行
// 的开头，从后往前扫给出的正是**折出来的那一行**的末尾。
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

/** 点输入区 → 插入符的**原串**下标（`null` = 点的那一格不属于任何一行文本） */
// ⚠️ `rects` 与 `wrapped` **必须同源**（都是 {@link geometry} 那一次调用给的）——「点第 2 行第 3 个字」
// 落在原串哪儿，与「第 2 行是从原串哪儿开始的」由**同一份**折行结果回答。
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

/** 侧边栏宽度的**合法区间**（纯函数；屏宽 → 一个区间） */
// ⚠️ 上限是**两道夹**的结果（窄屏上先撞上的是「主区至少留 `MAIN_MIN_WIDTH` 列」）；⚠️ 屏太窄时返回
// `min = max` —— 空区间会让 `clamp` 产出 `NaN`，而 `NaN` 坐标在命中测试里**恒不命中**。
export function sidebarWidthBounds(columns: number): {
  readonly min: number;
  readonly max: number;
} {
  const room = Math.trunc(columns) - SIDEBAR_GAP - MAIN_MIN_WIDTH;
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, room));
  return { min: SIDEBAR_MIN_WIDTH, max };
}

/**
 * 由终端尺寸算出全部区域（`spec` 见 {@link GeometryInput}）⚠️ 屏上**只有输入区**有框；⚠️ `rows` 极小时各区高度夹到 0
 */
export function geometry(spec: GeometryInput): Geometry {
  const w = Math.max(0, Math.trunc(spec.columns));
  const h = Math.max(0, Math.trunc(spec.rows));

  // 侧边栏：宽度先夹一次（拖出来的那个值不许越界），太窄则整个让位
  const tooNarrow = w < MIN_TERMINAL_COLUMNS;
  const bounds = sidebarWidthBounds(w);
  // ⚠️ **`sessionCount` 必须先算**：「一个会话都没有」与「屏太窄」是**同一个**答案（这一列不存在），
  // 而顺序反了的话宽度会按「有会话」算出来、`sidebar` 却给 `null` —— 于是主区左边空出 32 列。
  const sessionCount = Math.max(0, Math.trunc(spec.sessionCount));
  const sidebarWidth =
    tooNarrow || sessionCount === 0
      ? 0
      : Math.max(bounds.min, Math.min(bounds.max, Math.trunc(spec.sidebarWidth)));
  const mainX = sidebarWidth + SIDEBAR_GAP;
  const mainWidth = Math.max(0, w - mainX);

  // ⚠️ 侧边栏**占满整屏高度**（与输入区那一圈上下框齐平），且**没有框** ⇒ 画一整条底色。
  const sidebar = sidebarWidth === 0 ? null : rect(0, 0, sidebarWidth, h);

  // 输入区：**框内 n 行 + 上下框 + 框外状态行**，故它的高度随输入折行数变化
  // ⚠️ 折行宽度依赖**主区宽度**，而主区宽度此刻**已经算出来了**（它只依赖侧边栏宽）：顺序不能反。
  const frameWidth = Math.max(0, mainWidth - BORDER_COLUMNS);
  // ⚠️ **每一行都按第 0 行那个宽度折**（第 0 行前面有提示符）：少减这两列的话第 0 行会压到右边框上。
  const textWidth = Math.max(1, frameWidth - PROMPT_COLUMNS - 1);
  const wrapped = wrapInput(spec.input, textWidth);
  const inputRows = wrapped.length;

  // ⚠️ 整块 = 框（框内 `inputRows` + 消息 + 上下框）+ 「提供商 · 推理强度」一行 + 底部状态行。
  // ⚠️ **模型状态行是必须加上的一格**：它是「这一次的问话发去哪里」，漏算它的话输入框会盖住它，
  // 而症状是「换了个模型也看不出来」。
  const blockHeight = inputRows + NOTICE_ROWS + BORDER_ROWS + MODEL_STATUS_ROWS + STATUS_LINE_HEIGHT;
  // ⚠️ 底部状态行**恒在最底**，而输入区**从底部往上占**：两者都不越过主区顶边，
  // 而状态行被盖住时整体变成 0。
  const statusHeight = Math.min(STATUS_LINE_HEIGHT, h);
  const room = Math.max(0, h - statusHeight);
  // ⚠️ **输入区先占，模型状态行拿剩下的**（不是反过来）：极矮的屏上先丢的是那一行，
  // 因为「正在敲的东西」每一行都要过一次回车，而那一行自己会一直显示 —— 与
  // 「放不下时文本行优先于瞬时消息」同族（框内那一格消息也是最后才被丢的那一格）。
  const inputHeight = Math.min(
    Math.max(0, blockHeight - MODEL_STATUS_ROWS - STATUS_LINE_HEIGHT),
    room,
  );
  const modelHeight = Math.min(MODEL_STATUS_ROWS, Math.max(0, room - inputHeight));
  const inputY = h - statusHeight - modelHeight - inputHeight;

  // ⚠️ **框画得下才画**：Ink 的圆角边框放进宽度 1 / 高度 1 的框里会渲染成**两列两行**，已经越过
  // 终端一列一格 —— 而「每一行都不许超宽」正是本包用来逮「Ink 静默软换行」的那把尺，尺自己先坏了
  // 后面每一条宽度断言都跟着失效。故这里给出一个**判据**，呈现层只读它。
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
          input.height - (inputFramed ? BORDER_ROWS : 0),
        );

  // ⚠️ 放不下时**文本行优先于瞬时消息**：框内放得下时那一条消息恒占一行，放不下时文本赢 ——
  // 它是**正在敲的东西**（每多一行才过一次回车），而消息会自己消失。
  const contentHeight = inputContent?.height ?? 0;
  const drawableRows = Math.min(
    inputRows,
    Math.max(0, contentHeight - (contentHeight > inputRows ? NOTICE_ROWS : 0)),
  );
  const inputTextRows: Rect[] = [];
  for (let i = 0; i < drawableRows; i += 1) {
    // ⚠️ **每一行的 x 与宽度都相同**（悬挂缩进），右边恒多出 `PROMPT_COLUMNS` 列没人用。
    inputTextRows.push(rect((inputContent?.x ?? 0) + PROMPT_COLUMNS, (inputContent?.y ?? 0) + i, textWidth, 1));
  }
  const noticeHeight = contentHeight - drawableRows;
  const inputNotice =
    inputContent === null || noticeHeight < 1
      ? null
      : rect(inputContent.x, inputContent.y + drawableRows, inputContent.width, noticeHeight);
  // ⚠️ 箭头槽 = **整个框内内容**那么高（含所有折行），而它的右缘就是**每一行文字**的起点：
  // 少它的话续行顶格画，第一个字与输入区左缘差着两列（症状是「敲了换行之后字串到左边去了」）。
  const inputGutter =
    inputContent === null || inputContent.width < PROMPT_COLUMNS
      ? null
      : rect(inputContent.x, inputContent.y, PROMPT_COLUMNS, inputContent.height);
  const modelStatus =
    modelHeight < MODEL_STATUS_ROWS || mainWidth === 0
      ? null
      : rect(mainX, inputY + inputHeight, mainWidth, modelHeight);
  const statusLine =
    statusHeight === 0 || mainWidth === 0 ? null : rect(mainX, inputY + inputHeight + modelHeight, mainWidth, statusHeight);

  const output = mainWidth === 0 ? null : rect(mainX, 0, mainWidth, inputY);

  // ⚠️ 没有侧边栏时**必须给空数组**：给「宽度 0 的 n 行」会让命中测试拿着一份「有 3 行可点」的数据
  // ⚠️ **两趟**：那一行说明只在「装不下」时占一行，而「装不下」要先按**不含它**的容量判（反过来会让容量
  // 恰好等于项数的那一档凭空多扣一行）
  const capacity = sidebar === null ? 0 : itemsWithin(h);
  const overflows = sessionCount > capacity;
  const sessionViewportRows = sidebar === null || !overflows ? capacity : itemsWithin(h - 1);
  // ⚠️ 夹进 `[0, sessionCount - sessionViewportRows]`：删掉会话之后 `sessionsTop` 会越界，
  // 而越界的首项号会让「命中下标 + sessionFirst」指向一个**不存在的会话**（点得中、切不动）。
  const sessionFirst = Math.max(
    0,
    Math.min(Math.max(0, sessionCount - sessionViewportRows), Math.trunc(spec.sessionsTop)),
  );
  // ⚠️ 那一行说明**贴着侧边栏最底下**，而它与最后一项之间不强制留白：于是「还有几个」与
  // 「当前看到的是哪几个」是紧挨着的两行。
  const sidebarOverflowRow =
    !overflows || sidebar === null || h < 1
      ? null
      : rect(0, h - 1, sidebarWidth, 1);
  const sidebarRows: Rect[] = [];
  const sidebarCloseRows: (Rect | null)[] = [];
  // ⚠️ 那一枚「关闭」放不下时给 `null` 而不是给一个 0 列的矩形：0 列宽的矩形**恒不命中**
  // （`hitTest` 的 `x >= r.x + r.width` 对 `width === 0` 恒真）。
  const closeFits = sidebarWidth - SIDEBAR_TEXT_X - SESSION_CLOSE_COLUMNS >= SIDEBAR_CLOSE_MIN_NAME;
  for (let i = 0; i < sessionViewportRows && sessionFirst + i < sessionCount; i += 1) {
    const row = rect(0, SIDEBAR_TOP_PAD_ROWS + i * SESSION_STRIDE, sidebarWidth, SESSION_ROWS);
    sidebarRows.push(row);
    sidebarCloseRows.push(
      closeFits
        ? rect(row.x + row.width - SESSION_CLOSE_COLUMNS, row.y, SESSION_CLOSE_COLUMNS, 1)
        : null,
    );
  }
  // ⚠️ 手柄 = 侧边栏**最右那一列**（与上面那些项重叠，故命中测试必须先判它）。
  const sidebarHandle = sidebar === null ? null : rect(sidebar.width - 1, 0, 1, h);

  // 命令面板：一块**贴着输入框**、高度至多 40% 的浮层
  // ⚠️ 顺序是**这份算术的全部**：先按比例定上限，再决定那一条「装不下」说明行**算不算在上限内**，最后
  // 才从内容行里减掉面板占的那些 —— 反过来（先按候选数裁、再补说明行）会占 41%。
  const contentRows = output === null ? 0 : Math.max(0, output.height);
  // ⚠️ `contentRows` 就是结果区的整块高度（各区高度之和**恒等于**终端行数，否则 Ink 会摊到别处）；
  // ⚠️ 上限就是 40%，不给「至少一行」的兜底 —— 一块 0 行的面板就是「这一帧没有面板」。
  const cap = Math.floor(contentRows * PALETTE_MAX_RATIO);
  const count = Math.max(0, Math.trunc(spec.paletteCount));
  const fits = count <= cap;
  const paletteViewportRows = cap === 0 ? 0 : fits ? count : cap - 1;
  const wantsFooter = cap !== 0 && !fits && output !== null;
  const panelRows = paletteViewportRows + (wantsFooter ? 1 : 0);
  const outputBlockRows = Math.max(0, contentRows - panelRows);
  const outputRows = Math.max(0, outputBlockRows - 1);
  // ⚠️ 说明行紧跟在**最后一行候选之下**：两者的 y 共用 `outputBlockRows` 这一个基数（各写一遍的话，
  // 说明行会与最后一行候选重叠 —— 症状是「那句话压在命令名上面半个字」）
  const paletteFooterRow = wantsFooter
    ? rect(mainX, outputBlockRows + paletteViewportRows, mainWidth, 1)
    : null;
  const paletteRows: Rect[] = [];
  for (let i = 0; i < paletteViewportRows; i += 1) {
    // ⚠️ y 从「结果文本区之下」起算，而它的高度**已经扣掉了面板**（`outputBlockRows`）。
    paletteRows.push(rect(mainX, outputBlockRows + i, mainWidth, 1));
  }

  // 引导屏那块标记：**在结果区里居中**，放不下就**如实不画**
  // ⚠️ 判据是 `LOGO_WIDTH` 列 × `LOGO_ROWS` 行（素材住在 `@/features/output/logo.js`，本层只读尺寸）；⚠️ 高度按
  // **`outputBlockRows`** 而不是 `outputRows` —— 后者扣掉了「没有输出」那一帧根本不存在的滚动提示。
  const welcome =
    output === null || outputBlockRows < LOGO_ROWS || output.width < LOGO_WIDTH
      ? null
      : rect(
          output.x + Math.floor((output.width - LOGO_WIDTH) / 2),
          Math.floor((outputBlockRows - LOGO_ROWS) / 2),
          LOGO_WIDTH,
          LOGO_ROWS,
        );

  // 模态窗口：居中一块**没有框**的卡片，标题与右上角那枚「esc」**同一行** ──────
  // ⚠️ **「开着」的唯一判据是「槽位非空」**：于是「忘了传」与「没开」在类型上分不开（没有可选字段可漏）
  const win = spec.window.length > 0 ? windowRect(h, w) : null;
  const windowBox = win === null ? null : rect(win.x, win.y, win.width, win.height);
  // ⚠️ **内区四边各缩一格**（`WINDOW_PADDING`）：它是「卡片」与「里面的东西」之间唯一的缝
  const inner =
    win === null
      ? null
      : rect(win.x + WINDOW_PADDING, win.y + WINDOW_PADDING, win.width - WINDOW_PADDING * 2, win.height - WINDOW_PADDING * 2);
  const windowHeader = inner === null ? null : rect(inner.x, inner.y, inner.width, 1);
  const windowContent = inner === null ? null : rect(inner.x, inner.y + 1, inner.width, inner.height - 1);
  // ⚠️ 内容区**第一行恒是分隔**（可见的那一道），槽位从它**下面**起铺：少这一行的话第 1 槽盖掉分隔
  const slotTop = (windowContent?.y ?? 0) + 1;
  const slotCapacity = windowContent === null ? 0 : Math.max(0, windowContent.height - 1);
  const windowSlots: (Rect | null)[] = [];
  const windowRows: Rect[] = [];
  const windowGroups: Rect[] = [];
  const windowChecks: Rect[] = [];
  const windowSelects: Rect[] = [];
  // ⚠️ **`input` 槽的那两个投影与 `windowSlots` 同序同长**（不是「只装得下的那几个」）：
  // 表单有五个字段，命中测试与绘制都是按「第几个槽位」问的，单数与「只装得下的」两种形状都答不出
  // 「第二个字段的点落在哪一格」。
  const windowInputs: (Rect | null)[] = [];
  const windowInputTexts: (Rect | null)[] = [];
  for (let i = 0; i < spec.window.length; i += 1) {
    // ⚠️ 装不下的槽给 `null` 而**长度不变**（呈现层按「第 i 槽是不是 `null`」决定画不画）
    if (i >= slotCapacity) {
      windowSlots.push(null);
      windowInputs.push(null);
      windowInputTexts.push(null);
      continue;
    }
    const slot = spec.window[i]!;
    // ⚠️ **四档缩进**：可选行与勾选行让开记号（`MAIN_TEXT_X + 2`）、标题与说明让开缩进、
    // 文本输入**满宽**（它要画提示符）、下拉与它同族（表单里五个字段左缘必须一样）
    const indent =
      slot.kind === "row" || slot.kind === "check"
        ? MAIN_TEXT_X + 2
        : slot.kind === "input" || slot.kind === "select"
          ? 0
          : MAIN_TEXT_X;
    const at = rect(
      (windowContent?.x ?? 0) + indent,
      slotTop + i,
      Math.max(0, (windowContent?.width ?? 0) - indent),
      1,
    );
    windowSlots.push(at);
    const isInput = slot.kind === "input";
    windowInputs.push(isInput ? at : null);
    windowInputTexts.push(
      isInput
        ? rect(
            at.x + WINDOW_INPUT_PROMPT_COLUMNS,
            at.y,
            Math.max(0, at.width - WINDOW_INPUT_PROMPT_COLUMNS),
            1,
          )
        : null,
    );
    // ⚠️ 四个投影**必须由这一趟循环给出**：各自再算一遍的话绘制与命中测试会错开一行
    if (slot.kind === "row") windowRows.push(at);
    else if (slot.kind === "group") windowGroups.push(at);
    else if (slot.kind === "check") windowChecks.push(at);
    else if (slot.kind === "select") windowSelects.push(at);
  }
  // ⚠️ 那枚 `esc` **紧贴内区右缘**（右边留 {@link WINDOW_CLOSE_INSET} 列）且坐在**标题那一行**上；
  // 提示不画时**连列都不留**，于是「留不留」只剩下面那一个判据。
  const windowClose =
    windowHeader === null || !spec.windowCloseHint
      ? null
      : rect(
          windowHeader.x + windowHeader.width - WINDOW_CLOSE_INSET - WINDOW_CLOSE_COLUMNS,
          windowHeader.y,
          WINDOW_CLOSE_COLUMNS,
          1,
        );
  // ⚠️ 标题的预算**恒**扣掉 `esc` 那一枚占的那几列，而「扣不扣」判的是 `windowClose === null` **同一个值** ——
  // 两处各判一次的话，一处留空一处不留，标题要么被吃掉、要么空出那几列。
  const windowTitle =
    windowHeader === null
      ? null
      : rect(
          windowHeader.x + WINDOW_HEADER_INDENT,
          windowHeader.y,
          windowClose === null
            ? Math.max(0, windowHeader.width - WINDOW_HEADER_INDENT)
            : Math.max(0, windowClose.x - windowHeader.x - WINDOW_HEADER_INDENT),
          1,
        );

  // 会话菜单：一块**没有框也没有遮罩**的浮层，贴着那次右键的落点 ──────
  // ⚠️ 它**不是模态**：点它外面就是关掉它（背后那一层照旧可点），故整屏不铺遮罩、也不吞按键。
  const menu = spec.menu === null ? null : menuRect(h, w, spec.menu);
  const menuRows: Rect[] = [];
  if (menu !== null && spec.menu !== null) {
    for (let i = 0; i < spec.menu.items.length; i += 1) {
      menuRows.push(
        rect(menu.x + MENU_PAD_X, menu.y + i * MENU_ROWS, menu.width - MENU_PAD_X * 2, MENU_ROWS),
      );
    }
  }

  return {
    columns: w,
    rows: h,
    sidebar,
    sidebarRows,
    sidebarCloseRows,
    sidebarHandle,
    sessionFirst,
    sessionViewportRows,
    sidebarOverflowRow,
    output,
    input,
    inputContent,
    inputTextRows,
    inputWrapped: wrapped,
    inputRows,
    inputNotice,
    inputGutter,
    inputFramed,
    modelStatus,
    statusLine,
    paletteRows,
    paletteViewportRows,
    paletteFooterRow,
    // ⚠️ 主区与侧边栏都**没有框** ⇒ 内容宽度就是矩形宽度，**一个列都不多扣**。
    outputWidth: output === null ? 0 : output.width,
    outputBlockRows,
    outputRows,
    welcome,
    windowBox,
    windowHeader,
    windowContent,
    windowSlots,
    windowRows,
    windowGroups,
    windowChecks,
    windowSelects,
    windowInputs,
    windowInputTexts,
    windowTitle,
    windowClose,
    menu,
    menuRows,
  };
}

/**
 * 侧边栏那一列在「末项的下缘装得进 `lastRow`」时**装得下几项**（私有；**只有 {@link geometry} 调它**）
 * @description 判据是**下缘**而不是「行块加起来几行」：顶部那 {@link SIDEBAR_TOP_PAD_ROWS} 行与
 * 「末项之下不用留项间隔」两件事都落在这一个算式里，而 `h` 与 `h - 1` 是同一件事的两种情形
 * （末尾有那一行说明 / 没有）
 */
function itemsWithin(lastRow: number): number {
  const headroom = lastRow - SIDEBAR_TOP_PAD_ROWS - SESSION_ROWS;
  return headroom < 0 ? 0 : Math.floor(headroom / SESSION_STRIDE) + 1;
}

/**
 * 会话菜单的尺寸与落点（私有；**只有 {@link geometry} 调它**）：宽由**最长那一项**定，落点**夹进屏内**
 * @description 贴着屏角的一次右键会让半张菜单掉出屏外，而 `rect` 只夹坐标不夹溢出 ⇒「右下角那几项点不着」
 * @description 这一条必须在这里解决，而不是让呈现层自己算
 */
function menuRect(screenHeight: number, screenWidth: number, request: MenuRequest): Rect | null {
  const items = request.items;
  // ⚠️ 一项都不给 ⇒ 没有菜单：`{ x, y, width, height: 0 }` 的零行矩形恒不命中（`hitTest` 的
  // `y >= r.y + r.height` 对 `height === 0` 恒真），而它还会占掉一次点击（菜单开着 ⇒ 点外面被吞）。
  if (items.length === 0) return null;
  const text = items.reduce((widest, one) => Math.max(widest, stringWidth(one)), 0);
  const width = Math.min(
    screenWidth,
    Math.max(MENU_MIN_WIDTH, text + MENU_PAD_X * 2),
  );
  const height = Math.min(screenHeight, items.length * MENU_ROWS);
  return rect(
    Math.min(Math.max(0, Math.trunc(request.x)), Math.max(0, screenWidth - width)),
    Math.min(Math.max(0, Math.trunc(request.y)), Math.max(0, screenHeight - height)),
    width,
    height,
  );
}

/**
 * 模态窗口的尺寸与落点（私有；**只有 {@link geometry} 调它**）⚠️ 只认**整屏**、**不认主区**，且窗口**没有框**
 */
function windowRect(screenHeight: number, screenWidth: number): Rect | null {
  // ⚠️ **高恒为屏高的一半，仅此一项**：内容行数与期望下限都不再参与（窗高恒定 ⇒ 卡片不随内容长高）
  const height = Math.round(screenHeight * WINDOW_HEIGHT_RATIO);
  // ⚠️ 装不下标题与分隔那一档（`height < WINDOW_MIN_ROWS`）就**不画**：一个装不下自己标题的模态是纯噪音
  if (height < WINDOW_MIN_ROWS) return null;
  // ⚠️ **比例是上限、`WINDOW_MIN_WIDTH` 是下限**：70% 装不下时让位给下限，而不是缩到装不下；
  // 而 `WINDOW_FULL_WIDTH_BELOW` 之下直接占满（那一档上 70% 与 50% 都太窄）—— ⚠️ 两档之间有一格不连续
  //（59 列占满、60 列落到 50），它是「上限在下限之上」这条不变量的必然结果，不是笔误。
  const width =
    screenWidth < WINDOW_FULL_WIDTH_BELOW
      ? screenWidth
      : Math.max(WINDOW_MIN_WIDTH, Math.round(screenWidth * WINDOW_WIDTH_RATIO));
  return rect(
    Math.floor((screenWidth - width) / 2),
    Math.floor((screenHeight - height) / 2),
    width,
    height,
  );
}

/**
 * 命中测试：点在哪个矩形里（`rects` 的**下标序 = 绘制序**）⚠️ 半开区间：两端都闭上时相邻的等宽矩形会**同时**命中
 */
export function hitTest(x: number, y: number, rects: readonly Rect[]): number {
  // ⚠️ 真重叠时**后一个赢**；非整数坐标直接 `-1` —— 除法 / 取整写错会让坐标变成 `NaN` 或小数，
  // 而那两条比较对 `NaN` 恒假，结果是**一次点击静默什么都不做**。
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
 * 一行文本上的某一列 → 该行内的字符下标（判据是**显示列**：CJK 占两列）⚠️ 返回值夹住而不是回 `-1`
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