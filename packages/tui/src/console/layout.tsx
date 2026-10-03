/**
 * @fileoverview console 布局：把几何与状态画成一屏
 * @module console/layout
 * @description
 * 全屏 console 的**纯呈现**。所有位置来自 `@/console/geometry.ts` 的那一份算术 ——
 * **本文件不算任何坐标**，也**不认识**控制面数据的字段语义。
 *
 * ## 一屏长什么样
 *
 * ```
 * ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ 进程    running    pid 12345        ← 结果区（可滚）
 * ▓▓ 会话 1     ▓│ 名称    状态    上限      本月用量
 * ▓▓ live-ok    ▓│ alice   启用    1.0 GB    128.4 MB
 * ▓▓ 会话 2     ▓│  ⇅ 下方还有 12 行 · PgDn 下翻
 * ▓▓ 未选控制面  ▓│ ╭──────────────────────────────────────╮  ← 命令面板（≤ 内容行 40%）
 * ▓▓ …还有 3 个  ▓│ │  ▍ /help    列出命令，或给一条命令看用法 │
 * ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ ╰──────────────────────────────────────╯  ← 输入区（**只有它**有框）
 * ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  ● 3   ▲ 1   ○ 2                    v5.2.0   ← 状态行在框**外**
 * ```
 *
 * ## 七条呈现判据
 *
 * - **屏幕顶部没有横向区域**：本屏的全部会话级事实都在**底部状态行**，而「现在是哪个会话」由
 *   侧边栏那一项的**文字颜色**回答。⚠️ 顶部留一行放这些，等于花掉整屏最贵的一行去重复信息。
 * - **侧边栏列的是会话**，每个会话占**两行**：第一行名字、第二行它连的是哪个控制面。
 *   ⚠️ 第二行不是装饰：控制面**不进侧边栏**之后，「我这条命令打给谁」在屏上必须有唯一一处回答，
 *   而状态行按约定**不显示链接**（链接在 `/managers` 窗口里），于是只剩这一处。
 * - **整屏只有输入区与模态窗口带框**：侧边栏与主区那两条竖线在满屏上把一屏切成了两块
 *   「小窗口」。侧边栏改用**一整条底色** + 与主区之间**隔一列**与主区分开。
 * - **输入框随内容长高**：输入串折成几行，框就多几行（`@/console/geometry.ts` 算术）。
 *   ⚠️ 而**状态行在框外** —— 框是「我现在能敲字的地方」，把这一局的统计圈进去等于宣称那些数字
 *   也是可编辑内容。
 * - **选中态是「最亮的那一档 + 加粗」，没有反底色**：面板与侧边栏都是这样。⚠️ 那一列的底色
 *   归 hover（它**整条**都有底色），再叠一层会让「选中的那一个」与「指针在的那一个」互相盖过 ——
 *   而两者要答的是两件不同的事。⚠️ 所以「选中」不能只剩颜色：**加粗**是颜色之外的第二通道，
 *   它在 `NO_COLOR` / `TERM=dumb` 下也还成立，而那种环境里它是「哪一个被选中了」的唯一线索。
 * - **每一行都裁到它的可用宽度**（`@/ui/format.js:ellipsis` 是**唯一**裁剪出口）：Ink 对过宽的
 *   `<Text>` 是**静默软换行**，一换行整屏就往下移，而屏幕上没有任何东西解释它去哪了。
 * - **模态窗口开着时背后**变浅**：整屏铺一层比 {@link Tone.surface} 浅的 `scrim`，而窗口自己
 *   是比 `scrim` 更深的 `panel` —— 于是窗口是那块画面上最重的地方。⚠️ 代价是窗口开着时背后
 *   那些行变得半可读，那是模态的正常代价。
 *
 * ## 已知缺口（是「不变量」，不是「没来得及」）
 *
 * - **窗口开着时，背后的点击全部被吞掉**：这是模态的定义，不是缺陷。⚠️ 但它意味着
 *   「关掉窗口」只有两条路（点右上角那枚 `esc` / 按 `Esc`），而这两条路必须**都在**——
 *   只有一条的话，另一种终端（或者一种鼠标坏了的终端）上窗口就成了一个出不来的地方。
 *
 * @module
 */

import { Box, Text } from "ink";
import { BANNER, TAGLINE } from "@/ui/logo.js";
import {
  connectionMark,
  themeOf,
  type ConnectionState,
  type Theme,
  type Tone,
} from "@/ui/theme.js";
import { ellipsis, padToWidth, widthOf } from "@/ui/format.js";
import { visibleLines, type FlatLog, type LogLine } from "@/console/log.js";
import {
  MAIN_TEXT_X,
  SESSION_ROWS,
  SIDEBAR_GAP,
  SIDEBAR_TEXT_X,
  WINDOW_CLOSE_COLUMNS,
  geometry,
  type Geometry,
  type Rect,
  type WrappedRow,
} from "@/console/geometry.js";

/**
 * 侧边栏一项（= **一个会话**，占两行）
 * @description ⚠️ 第二行（{@link SessionRow.manager}）答的是「这条命令打给谁」，
 * 而控制面本身**不在侧边栏**（它在 `/managers` 窗口里）。故它必须是 `null` 而不是空串 ——
 * 「还没选控制面」与「选了个名字叫空的控制面」是两种状态。
 */
export interface SessionRow {
  /**
   * 会话内唯一标识
   * @description ⚠️ **选中与 hover 都按它认，不按名字**：会话名**可以重复**（用户自己起的），
   * 而按下标存的 hover 会在 `/new` 之后指着另一个 —— 症状是「高亮自己跳到别的会话上」。
   */
  readonly id: string;
  readonly name: string;
  /** 这个会话连的是哪个控制面（`null` = 还没选） */
  readonly manager: string | null;
}

/**
 * 命令面板的一行（**已经裁到视口**，故长度 = `geometry` 的 `paletteRows`）
 * @description ⚠️ 它是**行号序**而不是候选序：面板可滚，屏上看到的是「首行号之后的那几条」，
 * 而「首行号是多少」由上层算（`@/cmd/palette.js:paletteWindow`）。⚠️ 命中测试拿这个下标回查候选
 * 序时**必须**经过同一个首行号，否则点第 2 行会填出第 3 条命令 —— 而那两行在屏上长得一样。
 */
export interface PaletteRowView {
  /** 给人看的命令名 */
  readonly text: string;
  /** 那条命令的一句说明（`null` = 这一行没有说明可给） */
  readonly summary: string | null;
}

/** 命令面板（`null` = 面板没开，呈现结果区） */
export interface PaletteView {
  readonly rows: readonly PaletteRowView[];
  /** 高亮那一行的**行号**（`-1` = 没有高亮） */
  readonly at: number;
  /**
   * 面板**一共有**几行候选（**不是** {@link PaletteView.rows} 的长度）
   * @description ⚠️ 它喂给 {@link geometry} —— 几何层要靠它决定「装不下时留不留那一条说明行」。
   */
  readonly total: number;
  /** 装不下时的那一句（`null` = 全部装得下，于是不占那一行） */
  readonly footer: string | null;
}

/** 模态窗口里的一行（一个控制面） */
export interface WindowRow {
  /** 台账里的那个 `id`（命中测试回查目标时用它，**不按名字**—— 名字可以重复） */
  readonly id: string;
  readonly name: string;
  /** 链接与超时（⚠️ 凭据只以掩码形态出现，见 `@/ui/format.js:maskToken`） */
  readonly detail: string;
  /** 连接状态（`null` = 这一行没有状态可言，屏上不画字形） */
  readonly state: ConnectionState | null;
  /** 这个会话当前连的就是它（`true` 时那一行右侧给一个记号） */
  readonly current: boolean;
}

/**
 * 一个模态窗口的内容（**公共组件** {@link Window} 的输入）
 * @description ⚠️ 它**不认识**控制面：窗口画的是「标题 + 若干行（名字 + 详情）+ 可选的一条说明」，
 * 而每一行是什么由调用方排好版。下一个窗口（改密码 / 账号）要的形状与它一样，故抽出来。
 */
export interface WindowView {
  readonly title: string;
  readonly rows: readonly WindowRow[];
  /** 高亮那一行的**下标**（`-1` = 没有高亮；那一帧整个窗口没有加粗行） */
  readonly at: number;
  /** 底部那一条操作说明（`null` = 不占那一行） */
  readonly footer: string | null;
}

/** 一屏需要的全部状态。⚠️ 这里**没有一个字段是坐标** —— 坐标只由几何层算 */
export interface LayoutProps {
  readonly columns: number;
  readonly rows: number;
  /** 是否上色（组合根从 `NO_COLOR` / `TERM=dumb` 采一次） */
  readonly color: boolean;
  readonly version: string;
  /**
   * 侧边栏宽度（状态层那个值 —— **几何层再夹一次**，故拖出界的那个中间值不会画歪）
   * @description ⚠️ 它与 {@link Geometry.sidebarWidth} 同名同义，但那是**夹过之后**的数。
   * 两者不许各夹一次：呈现层拿夹过的画、状态层拿夹过的判，两处必须读到**同一份**。
   */
  readonly sidebarWidth: number;
  /** 左侧栏那几行会话（每项 {@link SESSION_ROWS} 行；**没有标题行**） */
  readonly sessions: readonly SessionRow[];
  /** 当前是哪个会话 `id`（`null` = 一个都没有） */
  readonly selectedSessionId: string | null;
  /** 指针悬停着的会话 `id`（`null` = 指针不在侧边栏上） */
  readonly hoveredSessionId: string | null;
  /** 指针在不在拖宽手柄上（那一列给一层底色，于是「能拖」这件事看得见） */
  readonly handleHot: boolean;
  /**
   * 台账里**每个**控制面的连接状态（**顺序 = 台账顺序**）
   * @description ⚠️ 状态行按它**数台数**：左半是「各状态各几个」，右半是版本号。⚠️ 它是
   * **全局**的一份（控制面是所有会话共享的），而「当前会话连的是哪一个」在侧边栏第二行 ——
   * 两处各答各的问题，故不冲突。
   */
  readonly managerStates: readonly ConnectionState[];
  readonly flat: FlatLog;
  /** 滚动位置（行号，**必须**已由上层用 `clampTop` 夹过） */
  readonly top: number;
  readonly input: string;
  /** 插入符的字符下标（`0` = 行首，`input.length` = 行末；**原串**的下标） */
  readonly cursor: number;
  /** 补全建议的**剩余部分**（`null` = 没有建议） */
  readonly ghost: string | null;
  /** 瞬时消息（写操作结果、错误摘要）；`null` = 没有 */
  readonly notice: string | null;
  /** 鼠标不可用时的提示；`null` = 不显示 */
  readonly mouseHint: string | null;
  /** 该不该显示 logo（= 当前会话还没有任何输出） */
  readonly showLogo: boolean;
  /** 命令面板（`null` = 没开） */
  readonly palette: PaletteView | null;
  /** 环形缓冲丢掉过历史时的那一句（`null` = 没丢过） */
  readonly droppedHint: string | null;
  /** 模态窗口（`null` = 没开；开了则整屏铺一层 `scrim`） */
  readonly window: WindowView | null;
  /** 指针在不在右上角那枚 `esc` 上（给它一层底色，于是「点它能关窗」看得见） */
  readonly closeHot: boolean;
}

/** 结果区每类行的默认色档 */
const TONE_OF: Record<LogLine["kind"], Tone> = {
  echo: "accent",
  head: "accent",
  kv: "muted",
  table: "muted",
  note: "warn",
  err: "danger",
};

/** 高亮那一行的记号（**形状通道**：无色终端里它是「选中了哪一行」的唯一可读物） */
const MARK_SELECTED = "▍";
/** 未高亮行左侧的等宽留白 —— 少了它，高亮那一帧会整行左移一格 */
const MARK_BLANK = " ";
/** 输入行的提示符 */
const PROMPT = "❯ ";
/** 命令回显的前缀（与输入行的提示符同一个字符，于是「敲过的」与「正在敲的」认得出是同一条） */
const ECHO_PREFIX = "❯ ";
/** 右上角那枚 `esc` 的字面（⚠️ 它**画在上边框那一行**上，故必须是「有底色的一小块」才认得出是按钮） */
const CLOSE_LABEL = "esc";
/** 窗口底部那条说明里的换行分隔（两段操作之间空一列） */
const FOOT_GAP = "  ";
/**
 * 侧边栏第二行「这个会话还没连任何控制面」那一句
 * @description ⚠️ **它必须是一句人话而不是空串**：空串与「选了个名字是空的控制面」在屏上
 * 长得一样，而 `/new` 出来的会话**恒**是这一档 —— 空串的话新会话那一行只画得出一道底色，
 * 而屏上没有任何东西解释它为什么空着。
 */
const NO_MANAGER_TEXT = "未选控制面";

function tone(theme: Theme, t: Tone): string | undefined {
  return theme[t];
}

export function Layout(props: LayoutProps): React.JSX.Element {
  const theme = themeOf(props.color);
  // ⚠️ **与 `@/app.tsx` 喂的是同一个对象上的同一组字段**（那份对象就是本 props），
  // 故两处 {@link geometry} 的结果逐字相同 —— 画与点在类型上不可能错开。
  const g = geometry({
    columns: props.columns,
    rows: props.rows,
    sidebarWidth: props.sidebarWidth,
    input: props.input,
    paletteCount: props.palette === null ? 0 : props.palette.total,
    window: props.window !== null,
    windowRows: props.window === null ? 0 : props.window.rows.length,
    windowFooter: props.window !== null && props.window.footer !== null,
  });
  const mainWidth = g.output === null ? 0 : g.output.width;
  return (
    // ⚠️ **顶部零横向区域**：这一行的 `height` 就是整屏，故侧边栏与主区从第 0 行起。
    // ⚠️ **窗口开着时这一行铺一层 `scrim`**（比 `surface` 浅）：这就是「窗口背面的颜色变浅」
    // 那一句话的实现 —— 它是**这一行自己的底色**，而背景由 Ink 按整块矩形铺（`ink/build/
    // render-background.js`），所以侧边栏那一列、间隔列与主区一起变浅，一处不漏。
    <Box
      flexDirection="row"
      width={props.columns}
      height={props.rows}
      backgroundColor={props.window === null ? undefined : tone(theme, "scrim")}
    >
      {g.sidebar === null ? null : <Sidebar {...props} g={g} theme={theme} />}
      {/* ⚠️ **那一列间隔必须真的占掉一个元素**：Ink 只把**兄弟**排在一起，而几何层给的主区
          `x` 是「侧边栏宽 + 1」。不插这一个空盒子的话主区就贴在侧边栏右边（`x` 少一列），
          于是「画出来的」与「算给命中测试用的」错开一列 —— 症状是点输入行定位插入符偏一个字，
          而屏上完全看不出那根竖线本该在哪。
          ⚠️ `flexShrink={0}`：Ink 的 `<Box>` 默认 `flexShrink: 1`，而一个零内容的盒子被压缩时
          塌成零宽（间隔列随之消失）。 */}
      <Box width={SIDEBAR_GAP} height={props.rows} flexShrink={0} />
      {/* ⚠️ 主区**不画框**，宽**必须正好**是 `mainWidth`：给窄一列，Ink 的 flex 会把这一个框压缩，
          而框里的子元素仍按 `mainWidth` 要宽度 —— 症状是**每一行内容都比视口宽一格**，于是 Ink
          静默软换行，整屏内容往下掉（最难归因的那种花屏）。 */}
      <Box flexDirection="column" width={mainWidth} height={props.rows}>
        {/* ⚠️ 几何层**必须**知道面板有几行，否则它算不出 {@link Geometry.paletteRows}。 */}
        {props.palette === null && props.showLogo ? (
          <Welcome {...props} g={g} theme={theme} />
        ) : (
          <Output {...props} g={g} theme={theme} />
        )}
        {props.palette === null ? null : <Palette {...props} g={g} theme={theme} />}
        <InputBlock {...props} g={g} theme={theme} />
        <StatusLine {...props} g={g} theme={theme} />
      </Box>
      {/* ⚠️ **窗口是绝对定位的两个兄弟**（框 + 右上角那枚 esc），且必须**排在最后**：
          Ink 逐个把节点写进同一张格子表（`ink/build/render-node-to-output.js`），
          后写的覆盖先写的 —— 故「esc 压在窗口上边框上」这一形状不需要任何负偏移。 */}
      {props.window === null ? null : <Window {...props} g={g} theme={theme} />}
      {props.window === null || g.windowClose === null ? null : (
        <CloseChip {...props} g={g} theme={theme} />
      )}
    </Box>
  );
}

/**
 * 侧边栏：一条**整列底色**的会话清单，没有框、没有标题行、每一项**两行**铺满整列
 * @description
 * ⚠️ **底色只在这一列的 `<Box>` 上给一次**：Ink 让内层 `<Text>` 从父 `<Box>` 继承背景色
 * （`ink/build/components/Text.js` 的 `backgroundContext`），而指针悬停的那一项自己再给一层
 * `hover`。⚠️ `hover` 必须**比 `surface` 深**（`theme.ts` 里那两个值就是按这条挑的）——
 * 「悬停看不见」是一种无法归因的失败：那一项**什么都没变**。
 * ⚠️ 而**最右那一列**是拖宽手柄：指针在它上面时它自己换一层 `hover`，于是「这一列能拖」看得见。
 */

function Sidebar(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  const rect = g.sidebar!;
  const handle = g.sidebarHandle;
  const inner = Math.max(0, rect.width - SIDEBAR_TEXT_X);
  const pad = " ".repeat(SIDEBAR_TEXT_X);
  const visible = props.sessions.slice(0, g.sidebarRows.length);
  const lines: React.JSX.Element[] = [];

  for (const item of visible) {
    const isSel = item.id === props.selectedSessionId;
    const isHot = item.id === props.hoveredSessionId;
    const bg = isHot ? tone(theme, "hover") : undefined;
    const name = ellipsis(item.name, inner);
    const manager = ellipsis(item.manager ?? NO_MANAGER_TEXT, inner);
    lines.push(
      // ⚠️ `flexDirection="column"` 是**必需**的：Ink 的 `<Box>` 默认是行，而一个行盒会把
      // 「名字」与「控制面名」排在**同一行**上 —— 症状是那一项里两段文字并排，
      // 而屏上完全看不出它本该是两行。
      <Box
        key={item.id}
        flexDirection="column"
        width={rect.width}
        height={SESSION_ROWS}
        backgroundColor={bg}
      >
        <Box width={rect.width} height={1}>
          <Text>{pad}</Text>
          <Text color={tone(theme, isSel ? "selected" : "muted")} bold={isSel}>
            {name}
          </Text>
          {/* ⚠️ **补齐到整列**：不补的话短名字那一行右边那一截就没有底色 */}
          <Text>{" ".repeat(Math.max(0, inner - widthOf(name)))}</Text>
        </Box>
        <Box width={rect.width} height={1}>
          <Text>{pad}</Text>
          <Text color={tone(theme, isSel ? "selected" : "idle")} bold={isSel}>
            {manager}
          </Text>
          <Text>{" ".repeat(Math.max(0, inner - widthOf(manager)))}</Text>
        </Box>
      </Box>,
    );
  }

  const overflow = props.sessions.length - visible.length;
  if (overflow > 0) {
    lines.push(
      <Box key="of" width={rect.width} height={1}>
        <Text>{pad}</Text>
        <Text color={tone(theme, "warn")} dimColor>
          {ellipsis(`…还有 ${overflow} 个会话`, inner)}
        </Text>
      </Box>,
    );
  }

  return (
    <Box
      flexDirection="column"
      width={rect.width}
      height={rect.height}
      backgroundColor={tone(theme, "surface")}
    >
      {lines}
      <Box flexGrow={1} />
      {/* ⚠️ **手柄画在最后**：它是最右那一列，与上面那些项**重叠**，而 Ink 后写的覆盖先写的。
          它的坐标来自 {@link Geometry.sidebarHandle}，而点它拖宽也用同一个矩形
          （`@/app.tsx` 的 `down` 分支**先判手柄**）—— 故「看见的那一列」与「能拖的那一列」
          是同一份数字。 */}
      {handle === null || !props.handleHot ? null : (
        <Box
          position="absolute"
          left={handle.x}
          top={handle.y}
          width={handle.width}
          height={handle.height}
          backgroundColor={tone(theme, "hover")}
        />
      )}
    </Box>
  );
}

/* 这一段答「命令面板怎么画」 */

/**
 * 命令面板：浮在输入框正上方的一小块，逐行「命令名 + 说明」
 * @description
 * ⚠️ **高度由几何层给**（`paletteRows.length` + 有没有那一条说明行），本组件**不许自己算** ——
 * 它一算，「画出来的」与「算给命中测试用的」就会在某次改动里差一行。
 * ⚠️ 而它**至多**占结果区内容行的 40%，且**贴着输入框的上边** —— 于是 `Output` 在它上面还剩六成。
 *
 * ⚠️ **高亮没有反底色**：只有「最亮的那一档 + 加粗 + 记号」三个通道。⚠️ 反底色这一列归 hover
 * （见文件头）、且它只改变那一行的「亮法」而**不改变它与旁边那几行的距离** —— 而操作者要
 * 一眼分出来的是「这几行里哪一个被选中了」。⚠️ **加粗与记号是颜色之外的通道**，故无色终端里
 * 靠那两个认高亮行。
 *
 * ⚠️ **说明那一列按同一行的命令名宽度对齐**（`padToWidth`，按**显示列**补）：不对齐时说明会
 * 跟着命令名的长短左右跳，而这一列是操作者扫的那一列。名字那一列的预算是**这一屏最长的那个
 * 名字**（且不超过一半预算）—— 按整表最长的名字留预算的话短命令那一屏会浪费半行。
 */
function Palette(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  if (g.output === null) return <Box />;
  const view = props.palette!;
  const width = g.outputWidth;
  // ⚠️ **预算一次算清**：`缩进 2 + 记号 1 + 空隙 1` 是命令名之前的固定开销，命令名与说明之间
  // 再留 1。少算任意一项的结果不是「被裁短」而是**整行超宽** —— 而 Ink 对过宽的 `<Text>`
  // 是静默软换行，一换行后面所有行都往下移。
  const budget = Math.max(0, width - MAIN_TEXT_X - 3);
  // ⚠️ 名字预算是「这一屏最长的那个名字」且**不超过一半**：按整表最长的名字留预算的话，
  // 短名字那一屏会白扔半行，19 条命令就少显示两条。
  const longest = view.rows.reduce((widest, row) => Math.max(widest, widthOf(row.text)), 0);
  const nameWidth = Math.min(longest, Math.floor(budget / 2));
  const summaryWidth = budget - nameWidth;
  const sel = tone(theme, "selected");
  // ⚠️ **画几行 = 几何层给几行**（候选 + 那一条说明行），而**不是** `g.output.height` ——
  // 后者是结果区的整块高度，含上面那些结果文本行。
  const height = view.rows.length + (view.footer === null ? 0 : 1);
  return (
    <Box flexDirection="column" width={g.output.width} height={height}>
      {view.rows.map((row, i) => {
        const isAt = i === view.at;
        return (
          <Box key={`${row.text}:${i}`} width={width} height={1}>
            <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
            {/* ⚠️ 三段（记号 / 名字 / 说明）**同一个色档且同样加粗**：拆开的话「哪一行被选中」
                要跨三段去拼，而高亮那一行本来就是这块面板唯一的交互。 */}
            <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
              {`${isAt ? MARK_SELECTED : MARK_BLANK} `}
            </Text>
            <Text color={isAt ? sel : tone(theme, "accent")} bold={isAt}>
              {padToWidth(ellipsis(row.text, nameWidth), nameWidth, "left")}
            </Text>
            <Text color={isAt ? sel : tone(theme, "muted")} bold={isAt}>
              {row.summary === null ? "" : ` ${ellipsis(row.summary, summaryWidth)}`}
            </Text>
          </Box>
        );
      })}
      {view.footer === null ? null : (
        <Box width={width} height={1}>
          <Text color={tone(theme, "warn")} dimColor>
            {" ".repeat(MAIN_TEXT_X)}
            {ellipsis(view.footer, Math.max(0, width - MAIN_TEXT_X))}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/* 这一段答「结果区怎么画」 */

function Output(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  if (g.output === null) return <Box />;
  const width = g.outputWidth;
  const lines = visibleLines(props.flat, props.top, g.outputRows);
  const below = Math.max(0, props.flat.height - (props.top + g.outputRows));
  const above = Math.max(0, props.top);
  // ⚠️ **高度 = 几何层给的「结果文本 + 滚动提示」那一块**（`outputBlockRows`），而**不是**
  // `outputRows + 1`：极矮的屏上 `outputRows` 是 0 而那一块也是 0，`+ 1` 会画一行溢出到
  // 输入区上面（症状是「输入行上面凭空多出一条结果」）。少减面板那几行的话结果区会把面板顶出屏。
  const height = g.outputBlockRows;
  return (
    <Box flexDirection="column" width={g.output.width} height={height}>
      <Box flexDirection="column" width={width} height={g.outputRows}>
        {lines.map((line, i) => (
          <Text key={`${line.entryId}:${line.part}:${i}`} color={tone(theme, TONE_OF[line.kind])}>
            {ellipsis(line.kind === "echo" ? `${ECHO_PREFIX}${line.text}` : line.text, width)}
          </Text>
        ))}
      </Box>
      {height > 0 ? (
        <Box width={width} height={1}>
          <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
          <Text
            color={tone(theme, below > 0 || above > 0 ? "warn" : "muted")}
            dimColor={below === 0}
          >
            {ellipsis(scrollHintOf(above, below, props.droppedHint), Math.max(0, width - MAIN_TEXT_X))}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * 结果区底部那一行
 * @description ⚠️ 「已到底」与「下面还有内容没显示」在屏幕上长得**完全一样**，而这一行是唯一区分它们
 * 的地方 —— 故它**永远在**，哪怕内容装得下（那时它写「已到底」）。
 * ⚠️ **位置**与**丢弃声明**是两句独立的话，故先算位置再缀丢弃：反过来会在**顶部**那一帧说「上翻」。
 */
function scrollHintOf(above: number, below: number, droppedHint: string | null): string {
  const position =
    above > 0 && below > 0
      ? `上 ${above} 行 · 下 ${below} 行`
      : above > 0
        ? `上方还有 ${above} 行 · PgUp / 滚轮上翻`
        : below > 0
          ? `下方还有 ${below} 行 · PgDn / 滚轮下翻`
          : "已到底";
  return droppedHint === null ? `⇅ ${position}` : `⇅ ${position} · ${droppedHint}`;
}

/* 这一段答「引导屏怎么画」 */

function Welcome(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  if (g.output === null) return <Box />;
  const width = g.outputWidth;
  const body: Array<{ readonly text: string; t: Tone }> = [
    ...BANNER.map((text) => ({ text, t: "accent" as const })),
    { text: TAGLINE, t: "muted" as const },
    { text: "", t: "muted" as const },
  ];
  if (props.managerStates.length === 0) {
    body.push({
      text: "台账里还没有控制面。用 target add <名字> <地址> <token> 加一个。",
      t: "muted",
    });
  } else {
    body.push({
      // ⚠️ 这句话里的键位**必须与 `@/app.tsx` 的键位表逐字一致**：说「回车切」而回车是
      // 「执行命令」时，操作者会先按一次回车、看见自己那条空命令没有任何反应。
      // ⚠️ 而「控制面在哪选」这一句必须在这里说：控制面**不在侧边栏**了（会话才是），
      // 于是「怎么换控制面」只剩 `/managers` 一个入口 —— 引导屏是第一次看到它的人唯一读到的地方。
      text: "左边点一个会话（或按 ↑ ↓ 切换）。控制面用 /managers 选。help 看全部。",
      t: "muted",
    });
  }
  if (props.mouseHint !== null) body.push({ text: props.mouseHint, t: "warn" });
  // ⚠️ **高度 = 几何层给的「结果文本 + 滚动提示」那一块**，与 {@link Output} 逐字相同。
  return (
    <Box flexDirection="column" width={g.output.width} height={g.outputBlockRows}>
      {body.slice(0, g.outputRows).map((line, i) => (
        <Text key={i} color={tone(theme, line.t)}>
          {ellipsis(line.text, width)}
        </Text>
      ))}
    </Box>
  );
}

/* 这一段答「输入区怎么画」（整屏**唯一**带框的一块，高度随折行数变化） */

/**
 * 输入区：折出来的每一行 + 那一行瞬时消息，**带框**
 * @description
 * ⚠️ **高度不是常量**：框内要装「折行 + 瞬时消息」，而折行数由输入串与主区宽度决定（几何层算，
 * 见 {@link Geometry.inputRows}）。输入每多一行，这一块就往上长一行 —— 于是输入框
 * **恒贴着屏底**，而结果区与命令面板在它上面依次让位。
 * ⚠️ 而**状态行不在这里**（它在框外，见 {@link StatusLine}）：框是「我现在能敲字的地方」，
 * 把这一局的统计圈进去等于宣称那些数字也是可编辑内容。
 */
function InputBlock(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  if (g.input === null || g.inputContent === null) return <Box />;
  return (
    <Box
      flexDirection="column"
      width={g.input.width}
      height={g.input.height}
      // ⚠️ **画不画框读几何层**（`inputFramed`），本层**不自己判**：两处各判一次的话，
      // 几何层算出的 `inputContent` 与本层画的框会对不上，而症状是「输入行比框多出去一行」。
      borderStyle={g.inputFramed ? "round" : undefined}
      borderColor={g.inputFramed ? tone(theme, "idle") : undefined}
    >
      {/* ⚠️ **折出来的文字由几何层给**（`inputWrapped`）而**矩形也由它给**（`inputTextRows`），
          两者**同序同长**：本层**一次都不自己折** —— 一自己折就有两份折行判据，而症状是
          「画出来的第二行与点得着的第二行不是同一行」。 */}
      {g.inputTextRows.map((rect, i) => (
        <CaretRow
          key={i}
          rect={rect}
          row={g.inputWrapped[i] ?? { text: "", start: 0 }}
          prompt={i === 0 ? PROMPT : ""}
          cursor={props.cursor}
          ghost={props.ghost}
          theme={theme}
        />
      ))}
      {/* ⚠️ 瞬时消息在**框内最后一行**，而它画不画读几何层（`inputNotice`）—— 极矮的屏上
          框内放不下时它**整行不出现**，而本层不自己比一次（两处各比一次就会在某次改动里
          分叉，症状是消息压在输入串上）。 */}
      {g.inputNotice === null ? null : (
        <Box width={g.inputNotice.width} height={g.inputNotice.height}>
          <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
          {props.notice === null ? null : (
            <Text color={tone(theme, "warn")}>
              {ellipsis(props.notice, Math.max(0, g.inputNotice.width - MAIN_TEXT_X))}
            </Text>
          )}
        </Box>
      )}
      {/* ⚠️ **框内放不下的那几行留白，不补任何东西**：Ink 的列向 flex 默认 `justifyContent:
          flex-start`，固定高度的子元素加起来不满容器高度时，余下的空间**留在底部**。
          故屏极矮时（{@link Geometry.inputNotice} 是 `null`）框内就是少几行空白 ——
          那正是「这一帧真的放不下」该有的样子。 */}
    </Box>
  );
}

/**
 * 输入串的一个**视觉行**：插入符用反底色（颜色之外的形状通道），补全建议跟在后面用暗色
 * @description
 * ⚠️ 插入符那一格是**反底色**而不是真的移动终端光标：真的移光标会与 Ink 自己的绘制打架
 * （Ink 每次重绘都按它自己的假设重画，而它不知道我们把光标放哪）。⚠️ 而它在**折出来的那一行**
 * 上（判据是「插入符的下标落在这一行的区间里」），不是「第一行」——
 * 少判这一处的症状是「输入超过一行之后按 ← 光标不跟着走」。
 * ⚠️ 光标在行末时要画**一个空格**的反色块，否则行末没有插入符。
 * ⚠️ **提示符那一格只有第 0 行有**，续行让出同样宽的空格 —— 于是折出来的第二行与第一行的
 * 第一个字**左对齐**（悬挂缩进），而那正是 {@link Geometry.inputTextRows} 里那个 x 的意思。
 */
function CaretRow(props: {
  readonly row: WrappedRow;
  readonly prompt: string;
  readonly cursor: number;
  readonly ghost: string | null;
  readonly rect: Rect;
  readonly theme: Theme;
}): React.JSX.Element {
  const { row, rect, theme } = props;
  const at = props.cursor - row.start;
  const inside = at >= 0 && at <= row.text.length;
  const offset = inside ? at : 0;
  const before = row.text.slice(0, offset);
  const cell = inside ? (row.text[offset] ?? " ") : "";
  const after = inside ? row.text.slice(offset + 1) : row.text;
  const sel = tone(theme, "selected");
  const lead = props.prompt === "" ? " " : props.prompt;
  return (
    <Box width={rect.width + widthOf(lead)} height={1}>
      {/* ⚠️ 提示符（续行是同样宽的空格）：它必须**恰好**占 {@link Geometry} 给出的那几列，
          后面那段文字才会落在 `rect.x` 上 —— 而 `rect.x` 正是「点输入行落点」用的那一列。 */}
      <Text color={tone(theme, "accent")}>{lead}</Text>
      <Text>{ellipsis(before, rect.width)}</Text>
      {cell === "" ? null : (
        <Text color={sel} backgroundColor={sel}>
          {cell}
        </Text>
      )}
      <Text>{after}</Text>
      {/* ⚠️ 幽灵文本只画在**光标所在那一行**（`inside` 为假的那一行它无处可跟）：Tab 会插在
          光标后面，而光标不在这一行时把它画在这一行，就是在骗人说「按 Tab 会插在这里」。 */}
      {props.ghost === null || !inside ? null : (
        <Text color={tone(theme, "idle")} dimColor>
          {ellipsis(props.ghost, Math.max(0, rect.width - widthOf(before) - 1))}
        </Text>
      )}
    </Box>
  );
}

/* 这一段答「状态行怎么画」（输入框**框外**，整屏最底那一行） */

/**
 * 底部状态行：**左半是各状态的控制面台数（每个状态一色）**，右半是版本号
 * @description
 * ⚠️ **它不在框里**（见 {@link Geometry.statusLine}）：框内是「我现在能敲字的地方」，
 * 而这一行是**这一局的统计**。⚠️ 左半**不显示链接**：链接在 `/managers` 窗口里，而把它摆在一行
 * 固定位置上只会在切控制面时闪一下 —— 那一行恒定的东西才该恒定。
 * ⚠️ 左半按右半占掉的宽裁，且两半之间留一列空隙：反过来（先裁左半再补右半）在窄终端里就是
 * 「先牺牲各状态的台数」，而那是操作者判断「有几台要处理」的唯一一屏信息。
 * ⚠️ **台数按状态分组、各自上色**，而不是「N 个控制面」一句话：同一个数有五种含义（已连接 /
 * 未授权 / 连不上 / 连接中 / 还没探过），而它们的**处置动作完全不同**（继续 / 改 token /
 * 查地址 / 等 / 看清单）。一个不带档的总数把这五件事压成一件。
 */
function StatusLine(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  const row = g.statusLine;
  if (row === null) return <Box />;
  const right = props.version === "" ? "" : `v${props.version}`;
  const parts = statusCountParts(props.managerStates);
  const used =
    parts.reduce((sum, part) => sum + widthOf(part.text), 0) +
    (parts.length > 1 ? FOOT_GAP.length * (parts.length - 1) : 0);
  const budget = Math.max(0, row.width - MAIN_TEXT_X - widthOf(right) - (right === "" ? 0 : 1));
  // ⚠️ **装不下就整块换成一句话**，而不是半截的台数：那个 `● 3` 是哪三个 3 会被读成「全部」，
  // 而一个空行与「忘了画」在屏上同形。
  const fits = parts.length > 0 && used <= budget;
  const fallback =
    props.managerStates.length === 0 ? "台账里没有控制面" : "控制面清单见 /managers";
  const shown = fits ? used : widthOf(fallback);
  return (
    <Box width={row.width} height={row.height}>
      <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
      {fits
        ? parts.map((part, i) => (
            <Text key={part.state} color={tone(theme, part.tone)}>
              {i === 0 ? part.text : FOOT_GAP + part.text}
            </Text>
          ))
        : (
            <Text color={tone(theme, "muted")} dimColor>
              {fallback}
            </Text>
          )}
      <Text>{" ".repeat(Math.max(0, budget - shown))}</Text>
      <Text color={tone(theme, "muted")}>{right}</Text>
    </Box>
  );
}

/** 一段状态台数（字形 + 个数；色档由 {@link connectionMark} 给，本层不自己配颜色） */
interface StatusCount {
  readonly state: ConnectionState;
  readonly tone: Tone;
  readonly text: string;
}

/**
 * 各状态各几个（**顺序 = {@link connectionMark} 那张表的顺序**，而它按「处置动作」排过）
 * @description ⚠️ **零台的那些档不出现**：五种状态各有五份预算，而一个恒为 0 的「连接中 0」在
 * 一行里占两列、且看起来像「有东西在连接」。⚠️ 反过来「一个都没有」时给的是**一句话**而不是空行
 * —— 空行与「忘了画」在屏幕上长得一样。
 */
function statusCountParts(states: readonly ConnectionState[]): StatusCount[] {
  const order: readonly ConnectionState[] = [
    "connected",
    "unauthorized",
    "unreachable",
    "connecting",
    "unknown",
  ];
  const counts = new Map<ConnectionState, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  const parts: StatusCount[] = [];
  for (const state of order) {
    const count = counts.get(state) ?? 0;
    if (count === 0) continue;
    const mark = connectionMark(state);
    parts.push({ state, tone: mark.tone, text: `${mark.glyph} ${count}` });
  }
  return parts;
}

/* 模态窗口是**公共组件**：它不认识控制面，只画「标题 / 若干行 / 一条说明」 */

/**
 * 一个模态窗口：标题 + 若干行 + 可选的一条底部说明
 * @description ⚠️ **公共组件**：它只画「标题 / 若干行（名字 + 详情）/ 一条说明」，而每一行是什么
 * 由调用方排好版（{@link WindowRow}）。下一个窗口（改密码、账号）要的形状与它一样，故抽出来 ——
 * 而抽出来的**代价**是它不能认识自己的内容，故「哪一行高亮」是**下标**而不是 `id`。
 * ⚠️ 它的框与右上角那枚 `esc` 是**两个绝对定位的兄弟**，而本组件画框、{@link CloseChip} 画那枚
 * —— 后者必须排在更后面（Ink 后写覆盖先写）。两者的坐标都来自几何层，故「看见的」与「点的」同源。
 * ⚠️ **底色比背后的 `scrim` 更深**（`panel`）：窗口开着时背后**变浅**，于是窗口是那块画面上
 * 最重的地方 —— 这就是「浮在上面」在纯文本终端里的全部手段。
 */
function Window(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  const box = g.windowBox;
  const content = g.windowContent;
  if (box === null || content === null) return <Box />;
  const view = props.window!;
  const width = content.width;
  const sel = tone(theme, "selected");
  return (
    <Box
      position="absolute"
      left={box.x}
      top={box.y}
      width={box.width}
      height={box.height}
      flexDirection="column"
      borderStyle="round"
      borderColor={tone(theme, "accent")}
      backgroundColor={tone(theme, "panel")}
    >
      <Box width={width} height={1}>
        <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
        <Text color={tone(theme, "accent")} bold>
          {ellipsis(view.title, Math.max(0, width - MAIN_TEXT_X))}
        </Text>
      </Box>
      {view.rows.map((row, i) => {
        const rect = g.windowRows[i];
        if (rect === undefined) return null;
        const isAt = i === view.at;
        const mark = row.state === null ? null : connectionMark(row.state);
        // ⚠️ 名字与详情**逐段裁**：一段超宽会让整行超宽（Ink 静默软换行 → 窗口里多出一行，
        // 而窗口高度是几何层给的 → 底部那行说明被挤出框外）。
        // ⚠️ 名字的预算是**这一行的一半**（详情里有地址，它比名字长），
        // 而「当前」那个记号占掉的 5 列**先扣掉** —— 少扣的后果是右边框被吃掉一列。
        const tail = row.current ? " ←当前" : "";
        const room = Math.max(0, rect.width - widthOf(tail));
        const nameWidth = Math.min(widthOf(row.name), Math.floor(room / 2));
        return (
          <Box key={row.id} width={width} height={1}>
            <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
            <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
              {`${isAt ? MARK_SELECTED : MARK_BLANK} `}
            </Text>
            <Text color={isAt ? sel : tone(theme, "accent")} bold={isAt}>
              {ellipsis(row.name, nameWidth)}
            </Text>
            <Text color={isAt ? sel : tone(theme, "muted")} bold={isAt}>
              {ellipsis(
                ` ${mark === null ? "" : mark.glyph} ${row.detail}`,
                Math.max(0, room - nameWidth),
              )}
            </Text>
            {/* ⚠️ 右侧那个记号回答「**当前会话连的就是它吗**」—— 与高亮是两件事：
                高亮是「指针/键盘停在哪」，它是「已生效的是哪一台」。 */}
            {row.current ? (
              <Text color={sel} bold>
                {tail}
              </Text>
            ) : null}
          </Box>
        );
      })}
      {view.footer === null ? null : (
        <Box width={width} height={1}>
          <Text color={tone(theme, "warn")} dimColor>
            {" ".repeat(MAIN_TEXT_X)}
            {ellipsis(view.footer, Math.max(0, width - MAIN_TEXT_X))}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * 右上角那枚 `esc`（**窗口的关闭钮**；点它与按 `Esc` 是**同一条路**）
 * @description ⚠️ 它**压在窗口的上边框那一行上**（几何层 {@link Geometry.windowClose} 给的就是
 * 上边框那一行的坐标），而它**必须**排在 {@link Window} 之后 —— Ink 逐个把节点写进同一张格子表，
 * 后写的覆盖先写的，于是不需要任何负偏移。
 * ⚠️ **指针在上面时它自己换一层底色**：否则「点它能关窗」这件事没有任何可见的线索，而一个
 * 看不见能不能点的按钮等于没有。
 */
function CloseChip(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  const chip = g.windowClose;
  if (chip === null) return <Box />;
  const bg = props.closeHot ? tone(theme, "hover") : undefined;
  return (
    <Box
      position="absolute"
      left={chip.x}
      top={chip.y}
      width={chip.width}
      height={chip.height}
      backgroundColor={bg}
    >
      <Text color={tone(theme, "accent")} bold backgroundColor={bg}>
        {` ${CLOSE_LABEL}`.padEnd(WINDOW_CLOSE_COLUMNS, " ")}
      </Text>
    </Box>
  );
}