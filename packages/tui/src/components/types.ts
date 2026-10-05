/**
 * @fileoverview 一屏各组件的**输入形状**（零 React、零 Ink、零坐标）；⚠️ 几何层算出来的坐标不许由调用方塞进来
 */

import type { FlatLog } from "@/lib/log/index.js";
import type { ConnectionState, Theme } from "@/theme/index.js";
import type { Geometry } from "@/lib/index.js";
import type { ReasoningEffort, RunState } from "@/store/index.js";

/** 侧边栏一项（= **一个会话**，占两行） */
// ⚠️ 第二行答的是「这条命令打给谁」，而控制面本身**不在侧边栏**（它在 `/targets` 弹窗里）——
// 故 `manager` 必须是 `null` 而不是空串：那是两种状态。
export interface SessionRow {
  /** 会话内唯一标识 */
  // ⚠️ **选中与 hover 都按它认，不按名字**：会话名**可以重复**，而按下标存的 hover 会在 `/new` 之后指着另一个。
  readonly id: string;
  /** 会话名（⚠️ **原文**：裁到预算内的那一份是 {@link SessionRow.label}，呈现层只读那一格） */
  readonly name: string;
  /** 这个会话连的是哪个控制面（`null` = 还没选，不是空串） */
  readonly manager: string | null;
  /** 名字**前面**那一枚记号的状态（⚠️ 呈现层只画字形，**不自己判**「有没有记号」—— 那是状态层的事） */
  readonly run: RunState;
  /** 「跑完了而你还没看」（⚠️ 与 {@link SessionRow.run} **合成一格**的话，切回来看一眼就把「跑完了」一起清了） */
  // ⚠️ 屏上那枚记号的判据是 `run === "done" && !seen` —— **`run` 三档一个字都不许删**
  // （`@/theme/impl.js:runMarkOf` 的 `Record<RunState, RunMark>` 靠它），而「这一格是不是那个待确认的」
  // 那一族判据**一律**住在状态层，呈现层只读结果。
  readonly seen: boolean;
}

/** 会话菜单（**公共组件** `SessionMenu` 的输入；⚠️ 它不认识会话：`id` 为 `null` 就是「空白处」那一份） */
export interface MenuView {
  /** 这一项作用在哪个会话上（`null` = 空白处弹出的那一份，只有「新建会话」） */
  readonly sessionId: string | null;
  readonly items: readonly string[];
  /** 高亮那一项的**下标**（`-1` = 这一帧没有加粗行） */
  readonly at: number;
  /** 那次右键的落点（**终端绝对坐标**，`[x, y]`；⚠️ 它**不是**菜单自己的坐标 —— 那是几何层算的） */
  // ⚠️ 两处各算一次的话菜单会掉出屏外而没人拦（几何层负责把它夹进屏内，状态层只记落点）
  readonly origin: readonly [number, number];
}

/** 命令面板的一行（**已经裁到视口**，故长度 = 几何层的 `paletteRows`） */
// ⚠️ 它是**行号序**而不是候选序：命中测试拿这个下标回查候选序时**必须**经过同一个首行号，
// 否则点第 2 行会填出第 3 条命令 —— 而那两行在屏上长得一样。
export interface PaletteRowView {
  readonly text: string;
  /** 一句说明（`null` = 这一行没有说明可给） */
  readonly summary: string | null;
}

/** 命令面板（`null` = 面板没开，呈现结果区） */
export interface PaletteView {
  readonly rows: readonly PaletteRowView[];
  /** 高亮那一行的**行号**（`-1` = 没有高亮） */
  readonly at: number;
  /** 面板**一共有**几行候选（**不是** `PaletteView.rows` 的长度） */
  // ⚠️ 几何层靠它决定「装不下时留不留那一条说明行」。
  readonly total: number;
  /** 装不下时的那一句（`null` = 全部装得下，于是不占那一行） */
  readonly footer: string | null;
}

/** 「提供商 · 推理强度」那一行的**内容**（⚠️ **坐标读 `Geometry.modelStatus`**：画不画那一行由几何层答） */
export interface ModelStatusView {
  /** 提供商的**显示名**（⚠️ `null` = 这一会话还没选模型，呈现层给「未选择」那一档） */
  readonly provider: string | null;
  /** 出网时那一档推理强度（⚠️ 恒有一档，缺省在 `@/store` 给） */
  readonly reasoning: ReasoningEffort;
}

/** 输入区那一段选区（⚠️ **两端已按「小的在前」排好**：呈现层不自己比大小） */
export interface InputSelection {
  /** 起点（含；UTF-16 code unit 下标，与 `LayoutProps.cursor` 同一套） */
  readonly start: number;
  /** 终点（**不含**） */
  readonly end: number;
}

/** 改名框（⚠️ **它就是输入行**：`Enter` 确认、`Esc` 取消、可打印键与插入符全归它） */
// ⚠️ 它住在 `LayoutProps.rename` 而**不在**弹窗那一档里：焦点在框上这件事**屏上到处都要读**
// （输入区那一格得压掉自己的插入符、命令面板得恒不开、右上角那枚 `esc` 得让位），
// 埋在某一档弹窗里的话这三处都得先判一遍 `kind`。
export interface RenameField {
  /** **被改名的那一个会话**（⚠️ 它与高亮行**不必是同一个**：`/rename` 打开时高亮会跟着 `id` 走） */
  readonly id: string;
  /** 框里那一串字（⚠️ 它**不写进**会话的 `input` —— 取消之后输入区那一行必须还是取消之前那一串） */
  readonly text: string;
  /** 插入符位置（**UTF-16 code unit 下标**，与输入区那一个同一套算术） */
  readonly cursor: number;
}

/** 清单弹窗里的一行（`targets` / `users` / `providers` **三档共用**：它们行的画法相同，差的只是动作） */
export interface ListRow {
  /** 台账 / 清单里的那个 `id`（⚠️ **不按名字** —— 名字可以重复，而删除与改都按它认） */
  readonly id: string;
  /** 那一项的名字（⚠️ **原文**；⚠️ 呈现层要裁的话自己走 `ellipsis`，而**带留白的那一份**在 `detail` 里） */
  readonly name: string;
  /** 名字**右边**那一段说明（**状态层拼好的那一串**，呈现层一个字都不许自己拼） */
  // ⚠️ 这一格存在的理由是「呈现层不许自己做换算」：链接与超时、流量上限与启用、地址与 API 格式
  // 各不相同，而把它们拼成一句话是**换算** —— 换算只许在 `@/lib` 与状态层做。
  readonly detail: string;
  /** 连接状态（`null` = 这一行没有连接可言，屏上不画字形 —— `users` 与 `providers` 恒 `null`） */
  readonly state: ConnectionState | null;
  /** 「已生效的是哪一条」（`true` 时右侧给一个记号；⚠️ 它与「高亮」是两件事） */
  readonly current: boolean;
  /** 待确认删除（第一次 `Ctrl+D` 之后为真；⚠️ 判据是「**这一行**是不是那个待确认的」，由状态层算好） */
  readonly pending: boolean;
}

/** 历史会话弹窗里的一行（⚠️ **它可能是分组标题而不是会话**，判据是 {@link SessionListRow.header} —— 两者**同处一个数组**，因为屏上它们是同一个列表里的相邻两行，而几何层按行铺位置；拆成两个数组就多一次「标题后面跟哪些会话」的换算，那处换算正是绘制与命中测试会错开的地方） */
export interface SessionListRow {
  /** 会话内唯一标识（⚠️ **分组标题行恒是空串** —— 它不对应任何会话） */
  readonly id: string;
  /** 会话名（⚠️ **分组标题行恒是空串**；那一行的字在 {@link SessionListRow.header} 里） */
  readonly name: string;
  /** 分组标题（`null` = 这一行是一个可选的会话；非 `null` = 这一行是标题，其余字段一律中性值） */
  readonly header: string | null;
  /** 侧边栏上已经列着它吗（`true` 时右侧给一个记号 —— 它答的是「已激活」，与「高亮」是两件事） */
  readonly pinned: boolean;
  /** 它连着哪个控制面（`null` = 还没选，**不是空串**；分组标题行恒 `null`） */
  readonly manager: string | null;
  /** 会话名**裁到预算内**的那一份（⚠️ **呈现层一个字都不许自己裁**，裁剪是排版那一层的事） */
  readonly label: string;
  /** 待确认删除（第一次 `Ctrl+D` 之后为真；⚠️ 与 {@link ListRow.pending} 同一族判据） */
  readonly pending: boolean;
}

/** 表单里的一格（⚠️ **字段按固定顺序排进一个数组**，于是「第 i 格」在几何与命中测试里是同一个下标；
     *  ⚠️ **长度不是五**：改显示名那一族只有一格，按固定五格画的话屏上会多出四行空字段）*/
export interface FieldCell {
  /** 这一格是文本框还是下拉（⚠️ **判据在状态层**：它决定这一格占 `input` 槽还是 `select` 槽） */
  readonly kind: "input" | "select";
  /** 那一格左边的**字段名**（例：「地址」/「API 格式」/「key」） */
  readonly label: string;
  /** 格子里那一串字（⚠️ **凭据那一格的 `value` 恒是掩码或空串**：打码只有 `redactProviderView` 一处出口） */
  readonly value: string;
  /** 焦点在这一格吗（⚠️ **恒恰好一格**为真 —— `Tab` / `Shift+Tab` 在字段之间走，靠的就是它） */
  readonly focused: boolean;
  /** 插入符位置（**UTF-16 code unit 下标**，与 `LayoutProps.cursor` / `RenameField.cursor` 同一套算术）
   *  ⚠️ **不许设成可选**：可选的话「忘了传」与「这一格刻意没有插入符」在类型上分不开，
   *  而漏传的症状是屏上「焦点在这一格、光标在哪儿」答不出来而零报错。 */
  // ⚠️ **呈现层只在 `kind === "input"` 那一格画它**：下拉里没有一段用户敲出来的字（`↑↓` 换的是
  // 闭集里的一档），故那一格画反底色块等于说「这里能落字」。
  // ⚠️ 而它**恒在**：`select` 那一格给 `value.length`，与状态层记的同一个数同源。
  readonly cursor: number;
  /** 下拉可选项（⚠️ **只在 {@link FieldCell.kind} 是 `"select"` 那一格上给**，而那一格恒有它） */
  readonly options?: readonly string[];
}

/** 模型清单弹窗里的一行（`provider-models` 那一档；⚠️ **过滤只影响显示**：勾选状态与它无关） */
export interface ModelCheckRow {
  /** 存储键 `"<providerId>/<modelId>"`（⚠️ 按**第一个** `/` 切，故它是拼好的那一整段） */
  readonly id: string;
  /** 显示名（⚠️ **裁到预算内的那一份**由状态层给，呈现层不自己裁） */
  readonly label: string;
  /** 勾上了吗（`Space` 只切**高亮那一个**；⚠️ 被过滤掉的行**仍在**勾里，故这一格与 `filter` 互不影响） */
  readonly checked: boolean;
  /** 全局置顶（`true` 时左侧给一枚 `★`） */
  readonly pinned: boolean;
  /** 待确认删除（第一次 `Ctrl+D` 之后为真，而**只是没勾上**不是「已删」） */
  readonly pending: boolean;
}

/** 选模型弹窗里的一行（⚠️ 与 {@link SessionListRow} 同一形状：**分组标题与可选项混在同一个数组里**） */
export interface ModelListRow {
  /** 存储键 `"<providerId>/<modelId>"`（⚠️ 分组标题行恒是空串 —— 它不对应任何模型） */
  readonly id: string;
  /** 模型显示名（⚠️ **裁到预算内的那一份**；分组标题行恒是空串） */
  readonly label: string;
  /** 分组标题（按提供商分；`null` = 这一行是一个可选的模型） */
  readonly header: string | null;
  /** 置顶（`true` 时左侧给一枚 `★`；⚠️ 置顶集合是**全局**的，不按会话） */
  readonly pinned: boolean;
}

// 模态此刻是什么（`null` = 没开）—— ⚠️ **判别联合**，判别字段与 `@/store` 的 `WindowState.kind`
// **逐字同名**，而**判别值集合是 `@/store` 的超集**（五种表单要格子从四格到一格不等 ⇒ 呈现的形状；
// 例外表见 `tests/contract/`，推导见 `src/store/AGENTS.md`）。⚠️ 每档都带 `title` / `closeHint`。
export type ModalView =
  /** 历史会话（分组标题 + 可选会话 + 一个改名框；⚠️ **改名框住在 `LayoutProps.rename`**，不在这儿） */
  | {
      readonly kind: "sessions";
      readonly title: string;
      /** 一个历史会话都没有时那一句（`null` = **不占**那一行；⚠️ 它在**内容区**第一行） */
      readonly note: string | null;
      /** 逐行（**行号序**：分组标题行与可选会话混在**同一个数组**里，顺序 = 屏上从上到下） */
      readonly rows: readonly SessionListRow[];
      /** 高亮的是**第几个可选会话**（`-1` = 没有高亮；⚠️ 它数的是**可选行**而不是数组下标 ——
       *  呈现层与命中测试都靠它映射到几何层的 `windowRows`，隔着标题行数下标就错位了） */
      readonly at: number;
      readonly closeHint: boolean;
    }
  /** 控制面清单（增删改查都在这个弹窗里） */
  | { readonly kind: "targets"; readonly title: string; readonly note: string | null; readonly rows: readonly ListRow[]; readonly at: number; readonly closeHint: boolean }
  /** 账号清单（与 {@link ModalView} 的 `targets` 那一档**同构**：行模型相同，动作不同） */
  | { readonly kind: "users"; readonly title: string; readonly note: string | null; readonly rows: readonly ListRow[]; readonly at: number; readonly closeHint: boolean }
  /** 提供商清单（同上） */
  | { readonly kind: "providers"; readonly title: string; readonly note: string | null; readonly rows: readonly ListRow[]; readonly at: number; readonly closeHint: boolean }
  /** 表单那一档（⚠️ **五种共用这一个判别值**：提供商 / 控制面 / 账号 / 改密码 / 改显示名） */
  | {
      readonly kind: "provider-form";
      readonly title: string;
      /** 逐格那一串（⚠️ **顺序即屏上顺序**；每一格占一整行，故第 i 格的下标在几何与命中测试里是同一个数；
       *  ⚠️ **长度不是五** —— 见 `FieldCell` 那一行） */
      readonly fields: readonly FieldCell[];
      /** 校验没过时那一句（`null` = 没话说；⚠️ **绝不转述用户输入**） */
      // ⚠️ 它排在**那些字段之后**（槽位序里那一格在最后）：说明一旦出现在字段**之前**，
      // 校验失败时那几行就整体下移一格 ⇒ 每按一次 `Enter` 字段跳一次。
      readonly note: string | null;
      readonly closeHint: boolean;
    }
  /** 编辑某个提供商的模型清单（最上面一个过滤框 + 若干勾选行） */
  | {
      readonly kind: "provider-models";
      readonly title: string;
      /** 过滤框（⚠️ **恒是 `kind: "input"` 那一格且恒有焦点**；⚠️ 它**只影响显示** —— 呈现层照画收到的那些行）*/
      readonly filter: FieldCell;
      /** 勾选行（**行号序**；⚠️ 状态层已过滤好，故这里**没有**被过滤掉的那些） */
      readonly rows: readonly ModelCheckRow[];
      /** 高亮的是**第几个勾选行**（`-1` = 没有高亮；⚠️ 它数的是**勾选行**，命中测试读 `windowChecks`） */
      readonly at: number;
      /** 「拉取中…」/「一个都没匹配上」那一句（`null` = **不占**那一行） */
      readonly note: string | null;
      readonly closeHint: boolean;
    }
  /** 选模型（按提供商分组；⚠️ **置顶的排在最前**） */
  | { readonly kind: "models"; readonly title: string; readonly note: string | null; readonly rows: readonly ModelListRow[]; readonly at: number; readonly closeHint: boolean };

/** 一屏需要的全部状态（见 `@/app.js:Layout`）。⚠️ 这里**没有一个字段是坐标** —— 坐标只由几何层算 */
export interface LayoutProps {
  readonly columns: number;
  readonly rows: number;
  /** 是否上色（组合根从 `NO_COLOR` / `TERM=dumb` 采一次） */
  readonly color: boolean;
  readonly version: string;
  /** 侧边栏宽度（状态层那个值 —— **几何层再夹一次**，故拖出界的中间值不会画歪） */
  // ⚠️ 它与 `Geometry.sidebarWidth` 同名同义，但那是**夹过之后**的数。
  readonly sidebarWidth: number;
  /** 左侧栏那几行会话（每项 `SESSION_ROWS` 行 + 项间那一行间隔；**没有标题行、顶部也没有留白**） */
  readonly sessions: readonly SessionRow[];
  /** 会话清单**滚到第几项**（**下标**；几何层再夹一次，见 `Geometry.sessionFirst`） */
  // ⚠️ 它是**状态**而不是坐标：几何层只夹它，「当前会话必须留在窗口里」那份判断住在
  // `@/AppState.js:revealSession`。⚠️ 本字段与 `sessions.length` 构成清单的**全部**输入。
  readonly sessionsTop: number;
  /** 当前是哪个会话 `id`（`null` = 一个都没有） */
  readonly selectedSessionId: string | null;
  /** 指针悬停着的会话 `id`（`null` = 指针不在侧边栏上） */
  readonly hoveredSessionId: string | null;
  /** 指针是不是**正落在那一项的「✕」上**（`false` = 只是悬在那一项上） */
  // ⚠️ 它**不是**「哪一个会话」的第二个答案（那一份是 `hoveredSessionId`）：命中测试**不看**悬停，
  // 而「要不要亮成『别按』那一档」只能由**上一次 move 事件**回答。
  readonly sessionCloseHot: boolean;
  /** 指针在不在拖宽手柄上（那一列给一层底色） */
  readonly handleHot: boolean;
  /** 台账里**每个**控制面的连接状态（**顺序 = 台账顺序**） */
  // ⚠️ 它是**全局**的一份（控制面是所有会话共享的），而「当前会话连的是哪一个」在侧边栏第二行。
  readonly managerStates: readonly ConnectionState[];
  readonly flat: FlatLog;
  /** 滚动位置（行号，**必须**已由上层用 `clampTop` 夹过） */
  readonly top: number;
  readonly input: string;
  /** 插入符的字符下标（**原串**的下标；`0` = 行首，`input.length` = 行末） */
  readonly cursor: number;
  /** 输入区那一段选区（⚠️ **`null` = 无选区**；⚠️ 它与「锚点正好在插入符上」是两件事，而两端已排好序） */
  // ⚠️ 判据是「有没有选中什么」而**不是**「有没有锚点」：落点与拖选由状态层收口，呈现层只画那一段。
  readonly inputSelection: InputSelection | null;
  /** 「提供商 · 推理强度」那一行上面写什么（⚠️ **那一行画不画读 `Geometry.modelStatus`**，两件事） */
  readonly modelStatus: ModelStatusView;
  /** 补全建议的**剩余部分**（`null` = 没有建议） */
  readonly ghost: string | null;
  /** 瞬时消息（写操作结果、错误摘要）；`null` = 没有 */
  readonly notice: string | null;
  /** 鼠标不可用时的提示；`null` = 不显示 */
  readonly mouseHint: string | null;
  /** 该不该显示 logo（= 当前会话还没有任何输出） */
  readonly showLogo: boolean;
  readonly palette: PaletteView | null;
  /** 环形缓冲丢掉过历史时的那一句（`null` = 没丢过） */
  readonly droppedHint: string | null;
  /** 模态此刻是什么（`null` = 没开；开了则整屏铺一层 `scrim`）—— ⚠️ **所有弹窗共用这一个入口** */
  // ⚠️ **一个 `view` 取代「两个窗口各一个字段」**：一个窗口一次只开一种内容，而那一屏上恒有唯一一种。
  // ⚠️ 判别字段与 `@/store` 的 `WindowState.kind` **逐字同名**（判别值是那一侧的超集，
  // 而多出来的那几档逐字列在 `ModalView` 那个声明的文件头上）—— 两处各起一个名就得有一张对照表。
  readonly view: ModalView | null;
  /** 改名框（`null` = 没开；⚠️ 它**只住在历史会话弹窗里**，而它在屏上的影响到处都要读，故住顶层） */
  readonly rename: RenameField | null;
  /** 会话菜单（`null` = 没开；⚠️ 它**不是模态**：点它外面就是关掉它，背后那一层照旧可点） */
  readonly menu: MenuView | null;
}

/** 每个组件拿到的 props：一屏状态 + **算好的**几何 + 一份主题（三样都必须齐） */
export type RegionProps = LayoutProps & {
  readonly g: Geometry;
  readonly theme: Theme;
};