/**
 * @fileoverview 语义 → 视觉的**唯一**映射面（颜色 token 与连接状态标记，零 React、零 `process.*`）
 * @module ui/theme
 * @description
 * 本模块是本包**唯一**回答「这个东西该长什么样（颜色 / 字形）」的地方。理由是一条纪律：
 * **同一个语义不许在两个地方有两种颜色**。一旦 `frame.tsx` 觉得「未连接」是灰的、`badge.tsx`
 * 觉得它是黄的，那么界面上那两种颜色到底意味着什么就只能靠猜，而 `warn` / `danger` 的区别正是
 * 操作者判断「要不要立刻处理」的唯一依据。故 `toneColor()` 是全包**唯一**的「档 → 颜色」函数，
 * 谁想上色都必须先选一个 {@link Tone} 档再过它。
 *
 * ## 为什么「要不要上色」是参数而不是读 `process.env`
 * @description
 * ⚠️ 本层**不读 `process.*`**：`process` 是**组合根**的采集面（终端宽度、`NO_COLOR`、`CI`、
 * 版本号都由 `src/cli.tsx` 在组合根一次性采集后往下传）。让叶子模块自己去摸全局环境，等于把
 * 「这份配置从哪来」从一处拆成 N 处 —— 组合根也就再也不能保证自己传下去的那份快照是一致的了。
 * 与 `src/admin/out.ts`「零 `process.*`」是同一条纪律的同一个理由。
 *
 * ## 颜色之外必有第二通道
 * @description
 * 状态**不许只靠颜色**区分：色盲用户看不出 `ok` 与 `warn` 的差别，无色终端（`NO_COLOR`、
 * `TERM=dumb`、管道重定向）里颜色根本不存在。故 {@link connectionMark} 同时给出**字形**
 * （`●` / `▲` / `○` / `·`）—— 那才是状态的主通道，颜色是它的一层修饰。
 *
 * ## 「探活结果 → 呈现档」也是本目录的事（对 `@/ledger` 的一条 **type-only** 依赖）
 * @description
 * {@link connectionStateOf} 的**输入与输出**（{@link ProbeSlot} / {@link ConnectionState}）都住在
 * 本目录，故它是全包**唯一**的一份「探活结果 → 呈现档」换算：目标条与台账页的表格都过它，于是
 * **同一个目标在任何地方都说出同一个词**。⚠️ 它的入参里那个 `ProbeResult` 来自 `@/ledger/index.js`，
 * 而那只是 **type-only** 引用（编译期擦除），**本目录零运行期依赖**于台账 —— 拨号的唯一入口仍然只有
 * `@/client/index.js`。
 *
 * @module
 */

import type { TuiCode } from "@/client/index.js";
import type { ProbeResult } from "@/ledger/index.js";

/**
 * 语义色档 —— 本包全部颜色的**唯一**坐标系
 * @description
 * 刻意**不是**「红黄蓝绿」：那把颜色名绑在观感上，而真正稳定的坐标是「这件事对操作者的意义」
 * —— `ok`（正常）/ `warn`（要处理但还能继续）/ `danger`（坏了或信息缺失）/ `idle`（没有这回事）。
 * ⚠️ 后两档（`surface` / `hover`）是**背景**而不是前景：它们只给一张可点的表（侧边栏）区分层级。
 * 它们与前八档写在**同一个坐标系**里，才能给「这个语义出一种色」这条纪律真的说法 ——
 * 写成另一个表（「背景色表」）就等于承认「同一个语义两种颜色」这件事是可接受的。
 */
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
  /** 模态窗口**开着时整屏**的底色：比 {@link surface} 浅，于是背后的内容退到后面去 */
  | "scrim"
  /** 模态窗口**自己**的底色（比 {@link scrim} 深，于是窗口是那块画面上最重的地方） */
  | "panel";

/**
 * 一份主题：**档 → Ink 颜色字符串**，`undefined` 即「不上色」
 * @description
 * 不上色时**每个档都是 `undefined`**（而不是换一套灰阶）：灰阶仍然会被读成「这里有分级」，
 * 而真无色时唯一诚实的形态是「全一样」。`undefined` 直接落在 Ink 的 `<Text color>` 上，
 * 于是「不上色」这条路不经过任何第二套代码。
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
  // ⚠️ **全场最亮的那一档**：面板与侧边栏的「选中」**没有反底色**（那一列的底色归 hover），
  // 于是这一档与 `muted` 的差距就是「哪一个被选中了」的唯一**颜色**线索 —— 拉不开的话整个清单
  // 看起来一样亮，而屏上没有任何东西解释为什么。⚠️ 它也**不许暗于 `accent`**：面板的高亮行、
  // 窗口里那一行的记号与插入符都用它，暗于 `accent` 时「高亮」与「普通」读起来是一档。
  selected: "#e6e8ff",
  // ⚠️ 四档底色的**相对深浅是判据，不是审美**：`hover` 必须比 `surface` 深（「悬停看不见」是
  // 一种无法归因的失败），`scrim` 必须比 `surface` 浅（窗口开着时背后**变浅**），而 `panel`
  // 必须比 `scrim` 深（否则窗口自己也被冲淡，「浮在上面」就变成了「铺在下面」）。
  surface: "#181a26",
  hover: "#24283b",
  scrim: "#333a52",
  panel: "#0f1017",
};

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
};

/**
 * 按「要不要上色」取一份主题
 * @description `false` → 无色（`NO_COLOR` / `TERM=dumb` / CI 都归它管，判断在组合根做）。
 * @param color - 传 `false` 得到无色主题
 */
export function themeOf(color: boolean): Theme {
  return color ? COLORED : PLAIN;
}

/**
 * 档 → 颜色（**全包唯一**的颜色出口）
 * @description
 * 各组件只准调它。**不存在**「这里我想用青色」这种用法：想加一种意思就加一个档，理由写在
 * 档的定义上，而不是在某处偷偷换个 hex。
 */
export function toneColor(tone: Tone, theme: Theme): string | undefined {
  return theme[tone];
}

/**
 * 失败码 → 色档的真值表
 * @description
 * ⚠️ 类型是 **`Record<TuiCode, Tone>`** 而不是 `Partial`：这让「服务端加一档 code / 本包加一档
 * `LocalCode`」在 `pnpm typecheck` 阶段就把这张表打红，逼着这一处同步。那是本层与
 * `@/client` 之间的一道**编译期**牙（wire 形状那道牙在 `@/client/wire.ts`）—— 两处各管一半：
 * 那边管字段，这边管「它长成什么颜色」。
 *
 * 分档理由是**处置动作**：凭据错 / 网络不通 / 输入非法都是「改点东西就能继续」，故 `warn`；
 * `internal`、只读驱动、源码不可读是「环境坏了，去查日志」，故 `danger`；`not-found` 与
 * `bad-shape` 各有特殊处理（见下），不混进上面两档。
 */
const SEVERITY_TONE: Readonly<Record<TuiCode, Tone>> = {
  // 改输入或改配置就能继续 → 要处理，但没坏
  unauthorized: "warn",
  unreachable: "warn",
  timeout: "warn",
  invalid: "warn",
  "bad-request": "warn",
  "already-exists": "warn",
  "method-not-allowed": "warn",
  // 环境坏了，或者对面说的话本包听不懂 → 只能去查
  internal: "danger",
  "read-only-driver": "danger",
  "source-unreadable": "danger",
  // 余下两档各有各的读法，不混进上面那两档
  "not-found": "idle",
  "bad-shape": "danger",
};

/**
 * 失败码 → 颜色（**唯一**的「失败 → 颜色」出口）
 * @description
 * `bad-shape` 归 `danger` 而不是 `muted`：那意味着对面跑着一个本包不认识版本的进程，
 * 继续操作只会得到更多看不懂的东西 —— 必须让操作者停下。`not-found` 归 `idle`：
 * 「你给的那个东西没有」是一条**正常的答案**，染成红只会让每一次查空都变成一次告警。
 */
export function severityColor(code: TuiCode, theme: Theme): string | undefined {
  return toneColor(SEVERITY_TONE[code], theme);
}

/**
 * 一个 id 在探活期间持有的那个值
 * @description
 * ⚠️ 「在飞」与「结果」**同容器**（一个 `Map`、一个 id 一个值），不是两份：第二个容器一出现，
 * 目标条与表格就能再次对同一个目标说两个词，而那正是本包最贵的一条纪律曾经真的破掉过的地方。
 * ⚠️ 故本目录**只**给「在飞」一个**值**（`{ pending: true }`），不给它第二个存处。
 */
export type ProbeSlot = ProbeResult | { readonly pending: true };

/**
 * 一个控制面目标的连接状态
 * @description
 * 这几档是**本包自己的**状态机（`@/client` 的失败码是「一次调用失败了什么」，不是「这个目标
 * 现在怎么样」），且是**呈现坐标**：它只回答「这个目标此刻连着没有」，由 {@link connectionStateOf}
 * 从探活持有的那个值换算而来。
 *
 * ⚠️ **`connecting` 是「还没问出结果」**，且它必须与 `unknown`（**还没试过**）分开成两个词：一个
 * `timeoutMs` 4000 的死目标在飞那 4 秒里说「连接中」，而说「未知」的话，操作者分不出「还没开始」
 * 与「卡住了」—— 前者等一下就好，后者要去看那台机器。
 * ⚠️ 反过来，它**只**认「在飞」那一个输入（{@link ProbeSlot} 的 `pending` 分支），不认任何别的
 * 「还没结论」的形状；判据只有 {@link connectionStateOf} 那一处，表格与目标条都过它。
 */
export type ConnectionState =
  "connecting" | "connected" | "unauthorized" | "unreachable" | "unknown";

/** 一个状态的完整标记：字形 + 色档 + 中文标签 */
export interface ConnectionMark {
  /** 字形（**状态的第二通道**：色盲与无色终端靠它） */
  readonly glyph: string;
  readonly tone: Tone;
  readonly label: string;
}

/** 各档的真值表（表外状态没有第二出口，见 {@link connectionMark}） */
const CONNECTION_MARKS: Readonly<Record<ConnectionState, ConnectionMark>> = {
  connecting: { glyph: "◌", tone: "muted", label: "连接中" },
  connected: { glyph: "●", tone: "ok", label: "已连接" },
  unauthorized: { glyph: "▲", tone: "warn", label: "未授权" },
  unreachable: { glyph: "○", tone: "idle", label: "未连接" },
  unknown: { glyph: "·", tone: "idle", label: "未知" },
};

/**
 * 连接状态 → 字形 + 色档 + 标签（**唯一**出口）
 * @description
 * 字形刻意选成**轮廓差异明显**的一组（虚线圆点 / 实心圆 / 三角 / 空心圆 / 中点）而不是同一形状的
 * 五种颜色：色盲用户与 `NO_COLOR` 环境下，前者靠形状读、后者靠形状读，两者都不会退化成
 * 「一排一样的灰点」。
 */
export function connectionMark(state: ConnectionState): ConnectionMark {
  return CONNECTION_MARKS[state];
}

/**
 * 探活持有的值 → 连接状态（**全包唯一**的这份换算）
 * @description
 * 一个目标在屏上的连接结论只有这一个出口：目标条（`@/ui/frame.tsx:TargetBar`）与台账页表格的
 * 「连接」那一格都过它。⚠️ 这不是「省几行字」：分头写两份的后果是**同一屏上两句话**（那一格说
 * 「未知」而目标条说「未连接」，而两处各自都没 bug）—— `tsc` 与 eslint 都看不见它，只有真渲染
 * 看得见，而它比「多打一次请求」贵得多。
 *
 * 剩下两条判据的理由（`@/client` 的 `TuiError` 三档就是按**处置动作**分的，故这里逐档对上）：
 * - **`unauthorized` 单独一档**：服务端**答了**，答案是「凭据不对」⇒ 处置是改 token。而
 *   `unreachable` 是**根本没答上** ⇒ 处置是查地址与网络。合成一档就把两个方向相反的排查动作并成
 *   一句，「服务没起来」会被显示成「token 不对」，把人带去改一份完全正确的凭据。
 * - **`shape` 落 `unknown` 而不是 `unreachable`**：它意味着「对面跑着一个本包不认识版本的进程」，
 *   处置是「升级本包或对面那个进程」，说成「连不上」会把人带去查一台根本没问题的机器。
 *   ⚠️ 它与「还没探过」共用一档是**已知缺口**（写在 `src/AGENTS.md`），显示成「未连接」同样是
 *   带错方向，故宁可弱化。
 *
 * ⚠️ 入参是 `undefined`（**还没探过**）时返回 `unknown`，**绝不许**替它编一个探活结果出来：判据是
 * 「没探过就说没探过」。数据侧的「没探过」由 `probeOf` 的 `undefined` 承载，界面据此说
 * 「还没探过（按 r 探一次）」，而呈现侧的档在这一处收敛成 `unknown`。
 * ⚠️ 入参是 `{ pending: true }`（**在飞**）时返回 `connecting`：那一档与 `unknown` 分开正是
 * {@link ProbeSlot} 存在的理由，而它之所以不用第二个容器就能分开，是因为**判据只有这一处**。
 */
export function connectionStateOf(slot: ProbeSlot | undefined): ConnectionState {
  if (slot === undefined) return "unknown";
  if ("pending" in slot) return "connecting";
  if (slot.ok) return "connected";
  if (slot.error.code === "unauthorized") return "unauthorized";
  if (slot.error.kind === "transport") return "unreachable";
  return "unknown";
}

/** 瞬时消息的四档（`overlays.tsx:Toast` 用它上色与选字形） */
export type ToastKind = "info" | "ok" | "warn" | "err";

/** 四档 → 字形 + 色档 */
const TOAST_MARKS: Readonly<Record<ToastKind, ConnectionMark>> = {
  info: { glyph: "·", tone: "accent", label: "" },
  ok: { glyph: "●", tone: "ok", label: "" },
  warn: { glyph: "▲", tone: "warn", label: "" },
  err: { glyph: "✗", tone: "danger", label: "" },
};

/**
 * 瞬时消息档 → 字形 + 色档（**唯一**出口）
 * @description 与 {@link connectionMark} 是同一条纪律的第二个面：同一个字形在不同语境里
 * 必须指同一件事（`▲` 在目标条与提示条里都是「要你处理」），所以两张表刻意共用字形。
 */
export function toastMark(kind: ToastKind): ConnectionMark {
  return TOAST_MARKS[kind];
}
