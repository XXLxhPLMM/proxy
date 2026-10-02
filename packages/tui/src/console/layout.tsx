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
 * ┌───────────────┬──────────────────────────────────────────────────────────┐
 * │ 控制面        │ ❯ status                                                 │
 * │ ▍live-ok   ●  │   进程    running    pid 12345                            │
 * │  bad-token ▲ │ ❯ users                                                   │
 * │  no-serv  ○  │   名称    状态    上限      本月用量                        │
 * │ …还有 2 个   │   alice   启用    1.0 GB    128.4 MB                       │
 * │              │   ⇅ 下方还有 12 行 · PgDn 下翻                              │
 * │              ├──────────────────────────────────────────────────────────┤
 * │              │ ❯ user add charlie 512mb▌                                 │  ← 输入行
 * │              │   写入失败                                                 │  ← 瞬时消息
 * │              │   http://127.0.0.1:18080 · 超时 3000ms      v5.2.0 · 3 个控制面│  ← 状态行
 * └───────────────┴──────────────────────────────────────────────────────────┘
 * ```
 *
 * ## 五条呈现判据
 *
 * - **屏幕顶部没有横向区域**：本屏的全部会话级事实（版本号、控制面数量）都在**底部状态行**的右半，
 *   而「现在是哪一台」由侧边栏那一记号 + 反底色回答。⚠️ 顶部留一行放这些，等于花掉整屏最贵的
 *   一行（在 2–3 行的屏上它就是「结果区有没有内容」）去重复屏幕上已经有的信息。
 * - **选中态有两个通道**：左侧的 `▍` 记号 + 反底色。⚠️ 只靠底色在无色终端
 *   （`NO_COLOR` / `TERM=dumb`）里会整个消失，那时操作者就不知道点的是哪一行 —— 而侧边栏的
 *   唯一职责就是回答「现在是哪一台」。
 * - **状态行的两半是两种事实**：左边「连的是哪台机器」（会随选中而变），右边「会话是什么」
 *   （版本 + 台账规模）。⚠️ 左半**按右半占的宽**裁 —— 反过来就是窄终端里先牺牲「我现在连的是
 *   哪台」，而那一半才是操作者每敲一条命令都要用的。
 * - **每一行都裁到它的可用宽度**（`@/ui/format.js:ellipsis` 是**唯一**裁剪出口）：Ink 对过宽的
 *   `<Text>` 是**静默软换行**，一换行整屏就往下移，而屏幕上没有任何东西解释它去哪了。
 * - **滚动位置那一行永远在**：结果区底部固定一行说「下面还有多少」。⚠️ 不画它的话，
 *   「已经到底」与「下面还有内容没显示」在屏幕上长得一样。
 * - **装不下必须说一声**：侧边栏装不下的目标给出「…还有 N 个」。⚠️ 静默少画几行，
 *   操作者会以为台账里就这几个 —— 而点不进去的那几个没有任何提示。
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
  BORDER_COLUMNS,
  BORDER_ROWS,
  MAIN_TEXT_X,
  SIDEBAR_TEXT_X,
  geometry,
  type Geometry,
} from "@/console/geometry.js";

/** 侧边栏一项（字形与色档由上层按 {@link connectionMark} 算好） */
export interface SidebarItem {
  readonly name: string;
  readonly state: ConnectionState;
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
  /** 高亮那一行的**行号**（`-1` = 没有高亮；那一帧整块面板没有反底色） */
  readonly at: number;
  /**
   * 面板**一共有**几行候选（**不是** {@link PaletteView.rows} 的长度）
   * @description ⚠️ 它喂给 {@link geometry} —— 几何层要靠它决定「装不下时留不留那一条说明行」。
   * 少了它，本层就得拿「这一屏画了几行」当「一共有几行」，而那在**装得下**时恰好相等、
   * 装不下时就少算，于是「说明行」有时候占位置有时候不占，边界上少一条命令。
   */
  readonly total: number;
  /** 装不下时的那一句（`null` = 全部装得下，于是不占那一行） */
  readonly footer: string | null;
}

/** 一屏需要的全部状态。⚠️ 这里**没有一个字段是坐标** —— 坐标只由几何层算 */
export interface LayoutProps {
  readonly columns: number;
  readonly rows: number;
  /** 是否上色（组合根从 `NO_COLOR` / `TERM=dumb` 采一次） */
  readonly color: boolean;
  readonly version: string;
  readonly items: readonly SidebarItem[];
  /** 当前选中的目标名；`null` = 还没选中（这时主区显示 logo 与引导语） */
  readonly selected: string | null;
  readonly flat: FlatLog;
  /** 滚动位置（行号，**必须**已由上层用 `clampTop` 夹过） */
  readonly top: number;
  readonly input: string;
  /** 插入符的字符下标（`0` = 行首，`input.length` = 行末） */
  readonly cursor: number;
  /** 补全建议的**剩余部分**（`null` = 没有建议） */
  readonly ghost: string | null;
  /**
   * 底部状态行**左半**：当前目标（`null` 时左半是那句 `target add` 引导）
   * @description ⚠️ 右半（版本号 + 控制面数量）由本层从 {@link LayoutProps.version} 与
   * {@link LayoutProps.items} 算，不是一个 prop —— 那三样都是**会话级**事实，而让它们各走一条
   * 通道就得在两层之间再加一次「谁给它们拼字符串」的约定。
   */
  readonly hint: string | null;
  /** 瞬时消息（写操作结果、错误摘要）；`null` = 没有 */
  readonly notice: string | null;
  /** 鼠标不可用时的提示；`null` = 不显示 */
  readonly mouseHint: string | null;
  /** 该不该显示 logo（= 还没选中任何控制面） */
  readonly showLogo: boolean;
  /**
   * 命令面板（`null` = 没开）
   * @description ⚠️ 它**接管结果区**（`Output` 与 `Welcome` 在它开着时都不画），而它为什么可以
   * 这么干写在 `@/console/geometry.ts:Geometry.paletteRows` 的注释里 —— 一句话是
   * 「开面板不该让结果区重排」。⚠️ 与 {@link LayoutProps.notice} 的关系是**接管**不是并存：
   * 「有哪些命令能敲」曾经由那一行瞬时消息回答，现在由这块面板回答，两者同时开着就是同一屏两句话。
   */
  readonly palette: PaletteView | null;
  /**
   * 环形缓冲丢掉过历史时的那一句（`null` = 没丢过）
   * @description ⚠️ **不许省**：`@/console/log.ts:trim` 会静默丢掉最早的条目，而屏幕上少了那一段
   * 与「本来就没有那一段」长得**完全一样**。操作者据此以为「刚才那条命令没跑过」，而它跑过、
   * 只是被挤出缓冲了。
   */
  readonly droppedHint: string | null;
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

/** 选中态的记号（颜色之外的第二通道） */
const MARK_SELECTED = "▍";
/** 未选中行左侧的等宽留白 —— 少了它，选中那一帧会整行左移一格 */
const MARK_BLANK = " ";
/**
 * 名字那一格要让出几列（记号 1 + 空隙 1 + 字形 1 + 空隙 1）
 * @description ⚠️ 与 `@/console/geometry.ts:SIDEBAR_TEXT_X` 同物种但**不是同一个数**：
 * 那一个量的是「边框 + 内边距」（文字从哪一列开始），这一个量的是「一行里名字前面占了几列」。
 * 两者都住在呈现层，因为它们量的都是**呈现**；而 {@link Geometry.sidebarRows} 的 `x` 与 `width`
 * 由几何层算，呈现层必须与它逐字一致 —— 牙齿是 `tests/layout.test.ts` 那条「每一行等宽」。
 */
const NAME_BUDGET_OFFSET = 4;
/** 输入行的提示符 */
const PROMPT = "❯ ";
/** 命令回显的前缀（与输入行的提示符同一个字符，于是「敲过的」与「正在敲的」认得出是同一条） */
const ECHO_PREFIX = "❯ ";

function tone(theme: Theme, t: Tone): string | undefined {
  return theme[t];
}

export function Layout(props: LayoutProps): React.JSX.Element {
  const theme = themeOf(props.color);
  const g = geometry(
    props.columns,
    props.rows,
    props.items.length,
    props.palette === null ? 0 : props.palette.total,
  );
  const mainWidth = g.output === null ? 0 : g.output.width;
  // ⚠️ **框画不下就不画**：Ink 的圆角边框放进宽度 1 的框里会渲染成**两列**，已经越过终端一列，
  // 而「每一行都不许超宽」正是本包用来逮「Ink 静默软换行」的那把尺 —— 尺自己先坏了，
  // 后面每一条宽度断言都跟着失效。一列宽的终端里一个框也装不下任何内容，如实画个无框的内容区更诚实。
  const framed = mainWidth >= BORDER_COLUMNS && props.rows >= BORDER_ROWS;
  return (
    // ⚠️ **顶部零横向区域**：这一行的 `height` 就是整屏，故两个并排的框从第 0 行起。顶上留一行
    // 放会话元信息，等于花掉整屏最贵的一行（在 2–3 行的屏上它就是「结果区有没有内容」）
    // 去重复屏幕上已经有的信息 —— 那些信息在底部状态行里。
    <Box flexDirection="row" width={props.columns} height={props.rows}>
      {g.sidebar === null ? null : <Sidebar {...props} g={g} theme={theme} />}
      {/* ⚠️ 外框宽**必须正好**是 `mainWidth`：给窄一列，Ink 的 flex 会把这一个框压缩，
          而框里的子元素仍按 `mainWidth` 要宽度 —— 症状是**每一行内容都比视口宽一格**，
          于是 Ink 静默软换行，整屏内容往下掉，且掉的位置每帧不同（最难归因的那种花屏）。 */}
      <Box
        flexDirection="column"
        width={mainWidth}
        height={props.rows}
        borderStyle={framed ? "round" : undefined}
        borderColor={framed ? tone(theme, "idle") : undefined}
      >
        {/* ⚠️ 几何层**必须**知道面板有几行，否则它算不出 {@link Geometry.paletteRows} ——
            本层与 {@link App} 喂的是同一个 `paletteCount`，而那一行就是本层的
            `props.palette?.rows.length`（两者读的是同一个对象，同一帧里必然相等）。 */}
        {props.palette !== null ? (
          <Palette {...props} g={g} theme={theme} />
        ) : props.showLogo ? (
          <Welcome {...props} g={g} theme={theme} />
        ) : (
          <Output {...props} g={g} theme={theme} />
        )}
        <InputBlock {...props} g={g} theme={theme} />
      </Box>
    </Box>
  );
}

/* ── 侧边栏 ──────────────────────────────────────────────────────────────── */

function Sidebar(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  const rect = g.sidebar!;
  // ⚠️ **`inner - NAME_BUDGET_OFFSET` 是名字那一格的宽度预算**，而偏移量必须等于那一行上
  // 「记号 1 + 空隙 1 + 字形 1 + 空隙 1」那四列。少扣一列的后果不是「名字被切短一格」而是
  // **整行超宽**：Ink 对过宽的 `<Text>` 是静默软换行，而一换行**后面所有行都往下移**，
  // 边框随之错位 —— 症状是「侧边栏里有一个名字把整块框顶歪了」，而它在窄名字那一档完全看不出来。
  // 牙齿：`packages/tui/tests/layout.test.ts` 用一个**长 CJK 名字**断言渲染出来的每一行等宽。
  const inner = Math.max(0, rect.width - SIDEBAR_TEXT_X);
  const nameWidth = Math.max(0, inner - NAME_BUDGET_OFFSET);
  const pad = " ".repeat(SIDEBAR_TEXT_X);
  // 侧边栏画得下的行数由**几何**给出（`sidebarRows` 与命中测试读的是同一份）
  const visible = props.items.slice(0, g.sidebarRows.length);
  const selectedAt =
    props.selected === null ? -1 : visible.findIndex((i) => i.name === props.selected);
  // ⚠️ **标题只有一行**：目标数在底部状态行的右半，故这里没有第二行数字 ——
  // 同一个数在一屏里出现两次，操作者会去比它们，而两次都得对才不出错。
  const lines: React.JSX.Element[] = [
    <Box key="h" width={rect.width} height={1}>
      <Text>{pad}</Text>
      <Text color={tone(theme, "muted")} dimColor>
        {ellipsis("控制面", inner)}
      </Text>
    </Box>,
  ];

  for (let i = 0; i < visible.length; i += 1) {
    const item = visible[i]!;
    const mark = connectionMark(item.state);
    const isSel = i === selectedAt;
    // ⚠️ **选中态是一段连续的反底色**：记号、空隙、字形、空隙、名字**五格一个 `<Text>`**。
    // 拆成三段（记号一个、字形一个、名字一个）的话，字形那一格不在反底色里，
    // 于是那一行看起来是「两段高亮中间夹一个亮点」—— 而侧边栏的唯一职责就是回答
    // 「现在是哪一台」，一条断成两截的高亮在 `NO_COLOR` 之外也不像一个选择态。
    // 而字形自己的**色档**在选中时让位给「选中」色档：反底色上的彩色前景在多数终端里读不出来。
    lines.push(
      <Box key={`t${i}`} width={rect.width} height={1}>
        <Text>{pad}</Text>
        <Text
          color={tone(theme, isSel ? "selected" : "selected")}
          backgroundColor={isSel ? tone(theme, "selected") : undefined}
        >
          {isSel ? MARK_SELECTED : MARK_BLANK}
        </Text>
        <Text
          color={tone(theme, isSel ? "selected" : mark.tone)}
          backgroundColor={isSel ? tone(theme, "selected") : undefined}
        >
          {` ${mark.glyph} `}
        </Text>
        <Text
          color={tone(theme, isSel ? "selected" : "muted")}
          backgroundColor={isSel ? tone(theme, "selected") : undefined}
        >
          {ellipsis(item.name, nameWidth)}
        </Text>
      </Box>,
    );
  }

  // 装不下的必须说一声（见文件头第四条）
  const overflow = props.items.length - visible.length;
  if (overflow > 0) {
    lines.push(
      <Box key="of" width={rect.width} height={1}>
        <Text>{pad}</Text>
        <Text color={tone(theme, "warn")} dimColor>
          {ellipsis(`…还有 ${overflow} 个`, inner)}
        </Text>
      </Box>,
    );
  }

  return (
    <Box
      flexDirection="column"
      width={rect.width}
      height={rect.height}
      borderStyle="round"
      // ⚠️ **不画右边框**：主区那个框的左边框就紧挨着（`mainX === sidebarWidth`），
      // 两个都画会在屏上留下**两根并排的竖线** `││`，看起来像渲染坏了。
      // 去掉一根之后 {@link Geometry.sidebarRows} 那一列的 `- 1`（不让命中区域盖到最后一列）
      // 仍然是对的 —— 那一列现在是**主区的左边框**，点它不该选中任何一行。
      borderRight={false}
      borderColor={tone(theme, "idle")}
    >
      {lines}
      <Box flexGrow={1} />
    </Box>
  );
}

/* ── 命令面板 ────────────────────────────────────────────────────────────── */

/**
 * 命令面板：每一行「命令名 + 说明」，可滚，高亮那一行整行反底色
 * @description
 * ⚠️ **它替掉结果区而不是浮在上面**（理由在 `@/console/geometry.ts:Geometry.paletteRows`），
 * 于是本组件与 {@link Output} 互斥 —— 两者同时画的话，同一块矩形里会有两个布局，而 Ink 不会
 * 抱怨（它只把子元素往下堆），症状是「面板开着、结果区在它下面还露着两行」。
 *
 * ⚠️ **说明那一列按同一行的命令名宽度对齐**（{@link padToWidth}，按**显示列**补）：
 * 不对齐时说明会跟着命令名的长短左右跳，而这一列是操作者扫的那一列。
 * 名字那一列的预算是**这一屏最长的那个名字**（且不超过半屏）—— 按整表最长的名字留预算的话
 * 短命令那一屏会浪费半行，19 条命令就少显示两条。
 *
 * ⚠️ **每一格都在反底色里**（记号 / 名字 / 说明三段同一次 `<Text>` 的背景），与侧边栏那条
 * 纪律同源：拆开的话高亮断成两截，而「高亮在哪一行」正是这块面板唯一的交互。
 */
function Palette(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  if (g.output === null) return <Box />;
  const view = props.palette!;
  const width = g.outputWidth;
  // ⚠️ **预算一次算清**：`缩进 2 + 记号 1 + 空隙 1` 是命令名之前的固定开销，命令名与说明之间
  // 再留 1。少算任意一项的结果不是「被裁短」而是**整行超宽** —— 而 Ink 对过宽的 `<Text>`
  // 是静默软换行（见文件头），一换行后面所有行都往下移。
  const budget = Math.max(0, width - MAIN_TEXT_X - 3);
  // ⚠️ 名字预算是「这一屏最长的那个名字」且**不超过一半**：按整表最长的名字留预算的话，
  // 短名字那一屏会白扔半行，19 条命令就少显示两条（而面板正好是那种一眼扫不完的表）。
  const longest = view.rows.reduce((widest, row) => Math.max(widest, widthOf(row.text)), 0);
  const nameWidth = Math.min(longest, Math.floor(budget / 2));
  const summaryWidth = budget - nameWidth;
  const sel = tone(theme, "selected");
  return (
    <Box flexDirection="column" width={g.output.width} height={g.output.height}>
      {view.rows.map((row, i) => {
        const isAt = i === view.at;
        // ⚠️ 三段（记号 / 名字 / 说明）**同一个背景色**：拆开的话高亮断成两截，
        // 而「高亮在哪一行」是这块面板唯一的交互（与侧边栏那条纪律同源）。
        const bg = isAt ? sel : undefined;
        return (
          <Box key={`${row.text}:${i}`} width={width} height={1}>
            <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
            <Text color={isAt ? sel : tone(theme, "idle")} backgroundColor={bg}>
              {`${isAt ? MARK_SELECTED : MARK_BLANK} `}
            </Text>
            <Text
              color={isAt ? sel : tone(theme, "accent")}
              backgroundColor={bg}
              dimColor={!isAt}
            >
              {padToWidth(ellipsis(row.text, nameWidth), nameWidth, "left")}
            </Text>
            <Text color={isAt ? sel : tone(theme, "muted")} backgroundColor={bg} dimColor={!isAt}>
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

/* ── 结果区 ──────────────────────────────────────────────────────────────── */

function Output(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  if (g.output === null) return <Box />;
  const width = g.outputWidth;
  const lines = visibleLines(props.flat, props.top, g.outputRows);
  const below = Math.max(0, props.flat.height - (props.top + g.outputRows));
  const above = Math.max(0, props.top);
  return (
    <Box flexDirection="column" width={g.output.width} height={g.output.height}>
      <Box flexDirection="column" width={width} height={g.outputRows}>
        {lines.map((line, i) => (
          <Text key={`${line.entryId}:${line.part}:${i}`} color={tone(theme, TONE_OF[line.kind])}>
            {ellipsis(line.kind === "echo" ? `${ECHO_PREFIX}${line.text}` : line.text, width)}
          </Text>
        ))}
      </Box>
      <Box width={g.output.width} height={1}>
        <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
        <Text color={tone(theme, below > 0 || above > 0 ? "warn" : "muted")} dimColor={below === 0}>
          {ellipsis(scrollHintOf(above, below, props.droppedHint), Math.max(0, width - MAIN_TEXT_X))}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * 结果区底部那一行
 * @description ⚠️ 「已到底」与「下面还有内容没显示」在屏幕上长得**完全一样**，而这一行是唯一区分它们
 * 的地方 —— 故它**永远在**，哪怕内容装得下（那时它写「已到底」）。
 * ⚠️ **位置**与**丢弃声明**是两句独立的话，故先算位置再缀丢弃：反过来（在丢弃那一支里写死
 * 「PgUp 上翻」）会在**顶部**说「上翻」—— 而上面什么都没有。那是一句骗人的操作提示。
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

/* ── 引导屏（还没选中控制面） ────────────────────────────────────────────── */

function Welcome(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  if (g.output === null) return <Box />;
  const width = g.outputWidth;
  const body: Array<{ readonly text: string; readonly t: Tone }> = [
    ...BANNER.map((text) => ({ text, t: "accent" as const })),
    { text: TAGLINE, t: "muted" as const },
    { text: "", t: "muted" as const },
  ];
  if (props.items.length === 0) {
    body.push({
      text: "台账里还没有控制面。用 target add <名字> <地址> <token> 加一个。",
      t: "muted",
    });
  } else {
    body.push({
      // ⚠️ 这句话里的键位**必须与 `@/app.tsx` 的键位表逐字一致**：说「回车切」而回车是
      // 「执行命令」时，操作者会先按一次回车、看见自己那条空命令没有任何反应，
      // 然后以为这个界面坏了。而这句引导语是**第一次**看到本工具的人唯一读到的东西。
      text: "左边点一个控制面（或按 ↑ ↓ 切换），然后在下面敲命令。help 看全部。",
      t: "muted",
    });
  }
  if (props.mouseHint !== null) body.push({ text: props.mouseHint, t: "warn" });
  return (
    <Box flexDirection="column" width={g.output.width} height={g.output.height}>
      {body.slice(0, g.outputRows).map((line, i) => (
        <Text key={i} color={tone(theme, line.t)}>
          {ellipsis(line.text, width)}
        </Text>
      ))}
    </Box>
  );
}

/* ── 输入区 ──────────────────────────────────────────────────────────────── */

function InputBlock(props: LayoutProps & { g: Geometry; theme: Theme }): React.JSX.Element {
  const { g, theme } = props;
  if (g.input === null) return <Box />;
  // ⚠️ **两套预算，差一个 MAIN_TEXT_X**：输入行（提示符那行）**没有**那一列缩进，
  // 而下面两行有。混用这两者的后果是「某一行压到右边框上」—— 而它只在那一行拉到最满时出现。
  const inner = Math.max(0, g.input.width - BORDER_COLUMNS);
  const width = Math.max(0, inner - MAIN_TEXT_X);
  return (
    <Box flexDirection="column" width={g.input.width} height={g.input.height}>
      <Box width={g.input.width} height={1}>
        <Text color={tone(theme, "accent")}>{PROMPT}</Text>
        <CaretLine
          text={props.input}
          cursor={props.cursor}
          ghost={props.ghost}
          width={Math.max(0, inner - widthOf(PROMPT))}
          theme={theme}
        />
      </Box>
      {/* ⚠️ 中间那一行是**瞬时**的（补全候选 / 执行中 / 一条消息），最底那一行是**状态行**。
          两者**位置不可换**：状态行必须**永远**在同一个地方 —— 操作者是在那一行上找
          「我现在连的是哪台机器」的，而一行会变的文本放在它上面，视线每次都要重新定位。 */}
      <Box width={g.input.width} height={1}>
        <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
        {props.notice === null ? null : (
          <Text color={tone(theme, "warn")}>{ellipsis(props.notice, width)}</Text>
        )}
      </Box>
      <StatusLine {...props} g={g} theme={theme} width={width} />
    </Box>
  );
}

/**
 * 底部状态行：左半「连的是哪台机器」+ 右半「会话是什么（版本 / 台账规模）」
 * @description
 * ⚠️ **左半按右半占掉的宽裁，且两半之间留一列空隙**。反过来（先裁左半再补右半）在窄终端里
 * 就是「先牺牲我现在连的是哪台」，而那一半是操作者每敲一条命令都要用的；右半是会话元信息，
 * 窄屏上少看一次版本号不致命。
 * ⚠️ **右半自己也裁**：两半加起来必须**恒**落在框内 —— 状态行是唯一一行**右对齐**的内容，
 * 而 Ink 对过宽的 `<Text>` 是静默软换行（见文件头），它一换行就把下面所有内容顶下去。
 * ⚠️ **右半不看选中状态**：版本号与控制面数量是**会话级**事实，而左半才是「当前在哪」。
 * 两者混在一句里就会让人读成「地址属于那个选中项」—— 而选中一换地址就换，版本号不会跟着换。
 */
function StatusLine(
  props: LayoutProps & { g: Geometry; theme: Theme; width: number },
): React.JSX.Element {
  const { g, theme, width } = props;
  if (g.input === null) return <Box />;
  const right = ellipsis(statusRightOf(props), width);
  const left =
    props.hint === null ? "" : ellipsis(props.hint, Math.max(0, width - widthOf(right) - 1));
  return (
    <Box width={g.input.width} height={1}>
      <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
      <Text color={tone(theme, "idle")} dimColor>
        {left}
      </Text>
      <Text>{" ".repeat(Math.max(0, width - widthOf(left) - widthOf(right)))}</Text>
      <Text color={tone(theme, "muted")}>{right}</Text>
    </Box>
  );
}

/**
 * 状态行右半的原文：版本号（不知道时**不占位**）+ 台账里的控制面数量
 * @description ⚠️ 版本号空串时**整个 `v` 前缀都不出**：留一个孤零零的 `v` 在屏上，
 * 读者会以为版本号被裁掉了 —— 而真相是构建期没注入（`src/cli.tsx` 那条「逐字读 `APP_VERSION`」）。
 */
function statusRightOf(props: LayoutProps): string {
  return [
    props.version === "" ? null : `v${props.version}`,
    `${props.items.length} 个控制面`,
  ]
    .filter((s): s is string => s !== null)
    .join(" · ");
}

/**
 * 输入行：插入符用反底色（颜色之外的形状通道），补全建议跟在后面用暗色
 * @description
 * ⚠️ 插入符那一格是**反底色**而不是真的移动终端光标：真的移光标会与 Ink 自己的绘制打架
 * （Ink 每次重绘都按它自己的假设重画，而它不知道我们把光标放哪），症状是插入符漂到别处。
 * 画一个反色格子在视觉上完全等价，而它跟着文本走。
 * ⚠️ 光标在行末时（`text[cursor]` 是 `undefined`）要画**一个空格**的反色块，否则行末没有插入符。
 */
function CaretLine(props: {
  readonly text: string;
  readonly cursor: number;
  readonly ghost: string | null;
  readonly width: number;
  readonly theme: Theme;
}): React.JSX.Element {
  const at = Math.max(0, Math.min(props.cursor, props.text.length));
  const before = props.text.slice(0, at);
  const cell = props.text[at] ?? " ";
  const after = props.text.slice(at + 1);
  const sel = tone(props.theme, "selected");
  return (
    <Box width={props.width} height={1}>
      <Text>{ellipsis(before, props.width)}</Text>
      <Text color={sel} backgroundColor={sel}>
        {cell}
      </Text>
      <Text>{after}</Text>
      {props.ghost === null ? null : (
        <Text color={tone(props.theme, "idle")} dimColor>
          {ellipsis(props.ghost, props.width)}
        </Text>
      )}
    </Box>
  );
}
