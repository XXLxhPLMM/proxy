/**
 * @fileoverview 根组件：全屏 console 的应用状态层（会话 / 控制面台账 / 输入行 / 滚动 / 模态窗口）
 * @module app
 * @description
 * 本组件是**唯一**持有跨帧状态的地方，也是**唯一**把「一次动作」翻译成「若干次 `setState`」的地方。
 * 它不认识控制面数据的任何一个字段 —— 那在 `@/console/exec.js`。它也不画任何东西：那在
 * `@/console/layout.js`，而**坐标**在 `@/console/geometry.js`。
 *
 * ## 一屏的形状
 * @description
 * 屏顶零横向区域 → 左侧栏（**会话**清单，每项两行）隔一列 → 右侧主区 → 主区自上而下是
 * 结果区（可滚）、命令面板（开着时）、输入区（**带框，高度随输入折行数变化**），而**状态行
 * 在框外**、贴着屏底。
 * ⚠️ **控制面不在侧边栏里**（它在 `/managers` 那个模态窗口里）：控制面是**配置**、会话是
 * **上下文**，而配置摆在一列常驻清单里等于逼着操作者每秒读一遍「我现在连的是哪台」。
 * ⚠️ 那条信息因此落到**每个会话的第二行**（它连的是哪个控制面），而状态行按约定**不显示链接**。
 *
 * ## 四条判据各自为什么落在这一层
 * @description
 * 1. **命令排队、一条一条跑**（{@link pump}）。执行层自己不碰状态，它只说「发生了什么」。
 *    ⚠️ **排队而不是并发**：`Effect` 里有 `clear-log` / `session-new` 两个会改动别的东西的动作，
 *    并发跑两次命令时一个 `clear-log` 会把另一条刚落地半秒的结果一起抹掉。
 * 2. **每个会话一份自己的上下文**（{@link Session}）：输出桶 + 输入行 + **连的是哪个控制面**。
 *    ⚠️ 不是「一份全局日志 + 一个全局当前目标」：那样「切会话」就只等于换个名字，而
 *    「这个会话刚才那条命令跑在哪台机器上」答不出来 —— 切回去看到的是别的机器的结果。
 *    ⚠️ 而**控制面（台账）是所有会话共享的**（{@link ledgerRef} 只读它、{@link useTarget} 落盘它），
 *    「所有会话共享」就是这一条，不在会话里存第二份。
 * 3. **探活只有一个来源**（{@link probes} 那一个 `Map`）。台数按状态分组上色（状态行左半）
 *    与窗口里每一行的连接字形都走**同一个**换算（`@/ui/theme.ts:connectionStateOf`），
 *    而「探活的唯一发起方」也只有 {@link reprobe}。
 * 4. **侧边栏宽度是状态**，而**合法区间是几何层算的**（`sidebarWidthBounds`）：拖动的中间值
 *    允许越界（越界那一帧由几何层夹住），而**命中测试与绘制读的是同一个夹过的值**。
 *
 * ## ⚠️ 输入行里**永不出现控制字符，也永不出现协议报文**
 * @description
 * Ink 把粘贴的内容**逐字**交给 `useInput`，而一段从网页/编辑器复制来的 token 里常带着一个 `U+000D`
 * 或 `U+000A`。它会**静默**地进到输入行里、跟着 `target add` 一起发出去，而服务端的
 * `Authorization: Bearer` 用 `$` 锚定比对 —— 结果是恒 401。故 {@link printableOnly} 在**入状态
 * 之前**就把 C0 控制字符与 `DEL` 全部剔掉。⚠️ **但 C0 挡不住鼠标报告**：`useInput` 的字符串里
 * 那个唯一的 C0 字节（`ESC`）在进门之前就被 Ink 拿掉了，于是报文到这里**全是可打印字符**。
 * 故输入行有**两道闸**：{@link isMouseReport}（认领协议，判据与 `@/ui/mouse.ts:parseSgr` 同源）、
 * {@link printableOnly}（剔 C0）。写成一道都不行。
 *
 * ## 键位（每一个都要有归属；没有「页面级键位」那一层）
 * @description
 * - 输入行编辑：`←` `→` `Home` `End` `Backspace` `Delete`（输入**折行**时 `↑`/`↓` 仍是切会话 ——
 *   见下面「折行没有第二套移动键」那条）
 * - 执行：`Enter`；补全：`Tab`；清空输入行：`Esc`
 * - 滚动结果区：`PageUp` `PageDown` `Ctrl+Home` `Ctrl+End` 与**滚轮**
 * - 切会话：`Ctrl+N` / `Ctrl+P`（下一个 / 上一个）、`↑` / `↓`、**鼠标点侧边栏那一项**
 * - 拖宽侧边栏：**按在侧边栏最右那一列上左右拖**
 * - 模态窗口（`/managers`）：`↑` `↓` `Tab` 选行、`Enter` 确认、`Esc` 关窗、**点右上角那枚 `esc`** 关窗
 * - 切控制面：`target switch <名字>`、或 `/managers` 窗口里 `Enter`
 * - 退出：`Ctrl+C`（**Ink 自己处理**，见文件头）
 *
 * ## ⚠️ 「折行」没有第二套移动键
 * @description
 * 输入串折成几行之后，`↑` / `↓` **仍然**是切会话，而不是「在折出来的行之间移动光标」。
 * ⚠️ 这是刻意的：给折行再加一套上下移动键，就得回答「光标在第一行时按 ↑ 是移到上一行还是切会话」
 * —— 而那会让同一个键在两种屏上有两种意思（面板开着时 `↑`/`↓` 已经归面板了，同一条纪律）。
 * 命令行里**没有必要**在多行之间移动光标：`←` 能走到头，走到头再换行（Insert 在多数终端里发不出来）。
 *
 * ## ⚠️ 本组件**没有**「退出」这个动作，也没有 `quit` 这个 prop
 * @description
 * `Ctrl+C` 由 Ink 的 `App` 组件在把输入交给任何监听器**之前**就处理掉了。
 * ⚠️ 故本组件**收不到**那个键，也**不该**再实现一遍 —— 而**不该**的代价不是「重复退出」
 * （`unmount()` 幂等），是「两处退出路径的收尾次序可能不一致」。
 *
 * @module
 */

import { useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  complete,
  paletteFill,
  paletteOf,
  paletteStep,
  paletteWindow,
  parseLine,
  type Command,
  type ParseResult,
} from "@/cmd/index.js";
import {
  DEFAULT_TIMEOUT_MS,
  LedgerError,
  clientFor,
  probeTarget,
  readLedger,
  removeTarget,
  selectedTarget,
  setSelected,
  upsertTarget,
  writeLedger,
  type Ledger,
  type Target,
} from "@/ledger/index.js";
import {
  Layout,
  append,
  caretFromWrappedPoint,
  clampTop,
  dropped,
  exec,
  flatten,
  geometry,
  hitTest,
  trim,
  type Effect,
  type ExecDeps,
  type FlatLog,
  type LogEntry,
  type LogRow,
  type PaletteView,
  type SessionRow,
  type WindowRow,
  type WindowView,
} from "@/console/index.js";
import {
  connectionStateOf,
  isMouseReport,
  mouseUnsupportedHintOf,
  type MouseEvent,
  type MouseSource,
  type ProbeSlot,
} from "@/ui/index.js";
import { SIDEBAR_WIDTH } from "@/console/index.js";

/* 状态层的常量与形状 */

/**
 * 每个会话里保留多少条输出条目（**环形缓冲**，不是审计日志）
 * @description 理由写在 `@/console/log.js:trim` 的文件头。⚠️ 被丢掉多少要**说出口**
 * （{@link dropped} 那一行），否则操作者会以为历史是完整的。
 */
const LOG_KEEP = 2000;

/** 滚轮 / 翻页一次滚几行（三行 ≈ 一段话，且不至于一滚就穿过整个屏幕） */
const SCROLL_STEP = 3;

/**
 * 输入区中间那一行给非补全消息停留多久（毫秒）
 * @description ⚠️ 那行**同时**是补全候选与「执行中」，所以它必须会自己消失。
 * 它不是历史的唯一去处 —— 每一条消息同时也进结果区（{@link say}），滚回去还在。
 */
const MESSAGE_TTL_MS = 8000;

/** 兜底的终端行数（`process.stdout.rows` 拿不到时；`24` 是几乎所有终端都至少有的高度） */
export const FALLBACK_ROWS = 24;

/**
 * 一个输出桶：条目 + 滚动位置 + 「贴不贴底」
 * @description
 * ⚠️ **三个字段住在同一个对象里**，不是三个独立的 `useState`：贴底判定需要「追加前的高度」与
 * 「追加后的高度」两份数字，而它们必须与那一次追加**原子地**算出来。
 */
interface Bucket {
  readonly entries: readonly LogEntry[];
  /** 顶行号（行，0 起）。**读的时候还要再夹一次**（{@link clampTop}），改窗口高度会让它越界 */
  readonly top: number;
  /** 是否贴底。`false` = 操作者往上翻过，于是新输出**不**把他拽回去 */
  readonly follow: boolean;
}

/** 空的桶（**每个会话一个**，不能共享同一个对象：`setState` 靠引用变化判断） */
function emptyBucket(): Bucket {
  return { entries: [], top: 0, follow: true };
}

/**
 * 一个会话（本包**唯一的**「上下文」单元）
 * @description
 * ⚠️ 它持**三样**东西，而这三样必须**同生共死**：输出桶（这个会话说过什么）、输入行
 * （这个会话正在敲什么）、`targetId`（这个会话打给哪台机器）。
 * ⚠️ 反过来（把当前控制面做成全局状态、只按会话切输出桶）会造出一个**说谎的组合**：
 * 「切到会话 2，看到的是会话 1 那台机器的结果」—— 而结果区里那些行**不显示**打给谁。
 * ⚠️ 而**控制面本身不在会话里**（{@link ledgerRef} / `readLedger`）：台账是所有会话共享的
 * 「一份链接清单」，在会话里存第二份就是「两个会话各自有一份台账」这个整类 bug 的产地。
 */
interface Session {
  readonly id: string;
  readonly name: string;
  /** 这个会话连的是哪个控制面（`null` = 还没选；⚠️ **不认台账的 `selected`**，那是「上次用的」） */
  readonly targetId: string | null;
  readonly bucket: Bucket;
  readonly input: string;
  /** 插入符位置（**UTF-16 code unit 下标**，与 {@link insertAt} 同一套） */
  readonly cursor: number;
}

/** 造一个新会话（⚠️ 每个键一个全新的对象：`setState` 靠引用变化判断） */
function newSession(id: string, name: string): Session {
  return { id, name, targetId: null, bucket: emptyBucket(), input: "", cursor: 0 };
}

/** 一条排队中的命令（**已经解析完**，故队列里不含任何需要 `try` 的东西） */
interface Job {
  /** 这一条属于哪个会话（⚠️ 落盘与渲染都按它，故它必须在**排队那一刻**定下来） */
  readonly sessionId: string;
  /** 用户敲的原文（回显用） */
  readonly line: string;
  readonly command: Command;
}

/**
 * 是不是**控制字符**（C0 那一段 + `DEL`）
 * @description
 * ⚠️ **逐个 code point 判**而不是一条正则：那条正则会被本包的 `no-control-regex` 判死，而
 * **加一条 `eslint-disable` 等于让这条纪律从此不再被看见**。
 */
function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/**
 * 只留下可打印的那部分（**剔掉**而不是「替换成空格」：一个被污染的 token 换成一个空格仍然是错的 token）
 */
export function printableOnly(text: string): string {
  let out = "";
  for (const ch of text) if (!isControlChar(ch)) out += ch;
  return out;
}

/**
 * 在 `text` 的第 `at` 个 **code unit** 处插入 `added`（返回新串与新光标）
 * @description ⚠️ **下标一律是 UTF-16 code unit**，因为它要与另外三处逐字一致：
 * `geometry.ts:caretFromWrappedPoint` 返回的、`complete.ts` 吃的、`layout.tsx:CaretRow` 切的三者。
 */
export function insertAt(text: string, at: number, added: string): { text: string; cursor: number } {
  const clamped = Math.min(Math.max(at, 0), text.length);
  return { text: text.slice(0, clamped) + added + text.slice(clamped), cursor: clamped + added.length };
}

/** 删掉 `at` 之前那一个 code point（`Backspace`）；行首是 no-op */
export function deleteBefore(text: string, at: number): { text: string; cursor: number } {
  const clamped = Math.min(Math.max(at, 0), text.length);
  if (clamped === 0) return { text, cursor: 0 };
  // ⚠️ **退一整个 code point**：只退一半会在代理对中间切开，而那个半个字符既显示成豆腐块、
  // 又在下一次插入时被顶到别处。
  const before = text.slice(0, clamped);
  const head = before.slice(0, [...before].length - 1);
  return { text: head + text.slice(clamped), cursor: head.length };
}

/** 删掉 `at` 处那一个 code point（`Delete`）；行末是 no-op */
export function deleteAt(text: string, at: number): { text: string; cursor: number } {
  const clamped = Math.min(Math.max(at, 0), text.length);
  if (clamped >= text.length) return { text, cursor: clamped };
  const whole = [...text];
  let index = 0;
  let units = 0;
  while (index < whole.length && units < clamped) {
    units += (whole[index] as string).length;
    index += 1;
  }
  const removed = whole.slice(index, index + 1).join("");
  return { text: text.slice(0, clamped) + text.slice(clamped + removed.length), cursor: clamped };
}

/** 光标向左移一个 code point（行首停住） */
export function caretLeft(text: string, at: number): number {
  const clamped = Math.min(Math.max(at, 0), text.length);
  if (clamped === 0) return 0;
  const chars = [...text.slice(0, clamped)];
  chars.pop();
  return chars.join("").length;
}

/** 光标向右移一个 code point（行末停住） */
export function caretRight(text: string, at: number): number {
  const clamped = Math.min(Math.max(at, 0), text.length);
  if (clamped >= text.length) return clamped;
  const rest = [...text.slice(clamped)];
  rest.shift();
  return text.length - rest.join("").length;
}

/**
 * 一次失败 → 一句话（**绝不引用 token 的内容**）
 * @description `LedgerError` / `TuiError` 的文案里本来就没有凭据，这里也不许拼进去。
 */
function describe(err: unknown): string {
  if (err instanceof LedgerError) return `台账 ${err.code}：${err.message}`;
  return "本包遇到一个未预期的错误（不是控制面的回答，请查本包的问题）";
}

/** 结果区底部那一行：被环形缓冲丢掉的最早一条是第几条（`0` = 没丢过） */
function droppedHint(bucket: Bucket): string | null {
  const first = dropped(bucket.entries, LOG_KEEP);
  return first === 0 ? null : `（更早的 ${first - 1} 条已被丢弃）`;
}

/**
 * 按**显示名**找目标 `id`（`target switch <名字>` / `target del <名字>` 的落点）
 * @description ⚠️ 名字**可以重复**，故这里取**第一个**匹配并把这一个选择**说出口**：
 * 静默取第一个是对的，而**不说**就会让操作者以为「我切到了第二个」。
 * @throws {LedgerError} 台账里没有这个名字
 */
function idOfName(ledger: Ledger | null, name: string): string {
  const found = ledger?.targets.find((one) => one.name === name);
  if (found === undefined) throw new LedgerError("invalid-target", "台账里没有这个名字的控制面");
  return found.id;
}

/** 模态窗口当前是哪一个（`null` = 没开）。⚠️ 只有一个窗口而它是**联合**，不是 `boolean` */
type WindowKind = "managers" | null;

/* 组件本体（下面几段各答一件事：台账 / 输出桶 / 探活 / 执行 / 键位 / 鼠标 / 呈现） */

export interface AppProps {
  /** 台账文件路径（`@/ledger/path.ts:targetsPath` 的产物，由组合根算好） */
  readonly ledgerFile: string;
  /** 终端总列数（组合根采集的快照 —— **本层零 `process.*`**） */
  readonly columns: number;
  /** 终端总行数（同上；⚠️ 缺了它就画不出上下分栏） */
  readonly rows: number;
  /** 要不要上色（`NO_COLOR` / `TERM=dumb` / `CI` 由组合根判好） */
  readonly color: boolean;
  /** 版本号（组合根从构建期注入的 `APP_VERSION` 取；空串 = 不知道，状态行右半**整个**不显示它） */
  readonly version: string;
  /** 鼠标事件源（生命周期归组合根；本组件只订阅） */
  readonly mouse: MouseSource;
}

export function App({ ledgerFile, columns, rows, color, version, mouse }: AppProps) {
  /* 跨帧状态 */

  /** 会话清单（⚠️ **至少一个**：没有会话就没有输入行，而没有输入行就没有任何命令） */
  const [sessions, setSessions] = useState<readonly Session[]>(() => [newSession("s1", "会话 1")]);
  /** 当前是哪个会话（⚠️ 它是 `id` 不是下标：`/new` 之后下标全变，而 `hoveredId` 那种按下标存的
   *  东西会在重排那一刻指着另一个） */
  const [activeId, setActiveId] = useState("s1");
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [ledgerError, setLedgerError] = useState<LedgerError | null>(null);
  /** 改台账后触发重读盘（`target add` / `target del` 之后） */
  const [ledgerTick, setLedgerTick] = useState(0);
  /** 每个控制面最近一次探活持有的那个值（`undefined` = 还没探过） */
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeSlot>>(
    () => new Map<string, ProbeSlot>(),
  );
  /** 输入区中间那一行（执行中 / 一条瞬时消息） */
  const [message, setMessage] = useState<string | null>(null);
  /** 正在跑的那条命令的原文（`null` = 队列空着） */
  const [running, setRunning] = useState<string | null>(null);
  /** 模态窗口开着没有（⚠️ 一个联合而不是 `boolean`：下一个窗口（改密码）会加一档） */
  const [windowKind, setWindowKind] = useState<WindowKind>(null);
  /** 窗口里高亮第几行（**下标**，不是 `id` —— 窗口是公共组件，它不认识控制面） */
  const [windowAt, setWindowAt] = useState(0);
  /** 侧边栏宽度（**用户拖出来的那个值**，允许越界；合法区间由几何层算，见 `sidebarWidthBounds`） */
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH);

  /* 这些 ref 的唯一理由：异步回调要读到「下一次渲染的视角」 */

  /** 内存里那份台账（与 `ledger` **同一个写入口**） */
  const ledgerRef = useRef<Ledger | null>(null);
  /** 每个 id 的探活序号：{@link reprobe} 每调一次 +1，回来时**序号仍匹配**的那次才写回 */
  const probeSeq = useRef(new Map<string, number>());
  /** 排队中还没跑的命令（**只进不出**，故不需要 state） */
  const queueRef = useRef<Job[]>([]);
  /** 此刻是不是正在跑一条（`true` 时 {@link pump} 拒绝启动下一条） */
  const busyRef = useRef(false);
  /** {@link pump} 自己（串行化要它回调自己，而 `useCallback` 的空依赖版本看不到自己） */
  const pumpRef = useRef<() => void>(() => {});
  /** 视口（结果区内容宽度与视口行数）；异步回调里要用**当下**的那一份 */
  const viewportRef = useRef({ width: 0, rows: 0 });
  /** 会话序号（造新会话 id 的唯一发号处） */
  const sessionSeq = useRef(1);
  /** 台账读出来之后**只**给第一个会话播种一次（⚠️ 见那一处的注释：种子不是「当前目标」） */
  const seededRef = useRef(false);
  /** 正在拖宽侧边栏吗（`null` = 没拖）。⚠️ **存起点而不存当前宽度**：拖动的映射必须是
   *  `起点宽度 + (现在列 − 起点列)`，即每一次拖动报告都从**同一个**起点算 ——
   *  改成「累加位移」的话一个像素的报告会被累加成几十像素（终端一秒几百条报告） */
  const resizingRef = useRef<{ readonly x: number; readonly width: number } | null>(null);

    /** 内存里那份台账的**唯一**写入口（`state` 与 {@link ledgerRef} 在这里一起落） */
  const holdLedger = useCallback((next: Ledger | null): void => {
    ledgerRef.current = next;
    setLedger(next);
  }, []);

  useEffect(() => {
    try {
      holdLedger(readLedger(ledgerFile));
      setLedgerError(null);
    } catch (err) {
      // ⚠️ **不碰内存里那份**：把「读不出来」当成空台账，下一次写就会拿那份空台账覆盖掉好的，
      // 而里面存的是控制面管理员凭据。⚠️ 也**不清掉**上一份好的。
      setLedgerError(err instanceof LedgerError ? err : new LedgerError("unreadable", "台账读不出来"));
    }
  }, [ledgerFile, ledgerTick, holdLedger]);

  const targets: readonly Target[] = useMemo(() => ledger?.targets ?? [], [ledger]);

  /**
   * 当前会话（**永远有一个**：清单空了就不是「没有当前会话」而是 bug，故这里夹成第一个）
   * @description ⚠️ 夹住而不是 `undefined`：渲染路径上一次 `undefined` 会让**每一处**读会话的
   * 地方都要判空，而漏一处就是一个「点侧边栏没反应」。
   */
  const active: Session = useMemo(() => {
    const found = sessions.find((one) => one.id === activeId);
    return found ?? sessions[0] ?? newSession("s1", "会话 1");
  }, [sessions, activeId]);

  /**
   * 当前会话连的是哪个控制面（`null` = 还没选）
   * @description ⚠️ **认 `id` 不认名字**（名字可以重复，见 {@link idOfName} 那条注释）。
   * ⚠️ 而**它与台账的 `selected` 是两件事**：`selected` 是「上次用的那台」（落盘，为了下次启动
   * 接着连），会话的 `targetId` 是「这一局打给谁」（只在内存里）。⚠️ 混起来就会出现
   * 「切会话把另一个会话的目标也改了」—— 而两个会话各自的目标正是这一层存在的理由。
   */
  const current: Target | null = useMemo(
    () => targets.find((one) => one.id === active.targetId) ?? null,
    [targets, active.targetId],
  );

  /**
   * 台账读出来之后给**第一个**会话播种一次
   * @description ⚠️ 播种的是「上次用的那台」而不是「当前目标」：会话 #1 接着上次连的那台，
   * 而**后来 `/new` 出来的会话不播种**（它从 `null` 开始，让操作者自己挑）。
   * ⚠️ 只播种**一次**（`seededRef`）：台账每重读一次就是一个新对象，而每次都播种会让
   * 「`/target switch` 切过去的那个目标」立刻被台账的旧值盖回去（`ledgerTick` 一动就读回真值），
   * 症状是「切了目标，下一次任何写台账的动作之后它自己跳回去」。
   */
  useEffect(() => {
    if (seededRef.current || ledger === null) return;
    seededRef.current = true;
    const seed = selectedTarget(ledger);
    if (seed === null) return;
    setSessions((prev) =>
      prev.map((one, i) => (i === 0 && one.targetId === null ? { ...one, targetId: seed.id } : one)),
    );
  }, [ledger]);

    /**
   * 往某一个会话的桶追加若干行（**原子**地重算 `top`）
   * @description ⚠️ 按**会话 id** 而不是「当前会话」：一条命令的结果必须落在**它排队那一刻**的
   * 那个会话里 —— 而在那条命令跑的几秒里操作者很可能已经切走了。
   */
  const push = useCallback((sessionId: string, rows: readonly LogRow[], at: number): void => {
    if (rows.length === 0) return;
    const viewport = viewportRef.current;
    setSessions((prev) =>
      prev.map((one) => {
        if (one.id !== sessionId) return one;
        const before = one.bucket;
        const entries = trim(append(before.entries, rows, at), LOG_KEEP);
        const height = flatten(entries, viewport.width).height;
        const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
        const top = before.follow ? bottom : clampTop(height, viewport.rows, before.top);
        return { ...one, bucket: { entries, top, follow: before.follow } };
      }),
    );
  }, []);

  /**
   * 一条命令的结果之外的那句话（瞬时消息）
   * @description ⚠️ 它落在**当前会话**的桶里：它是这一局的操作者此刻要知道的事，而会话就是
   * 「一份自己的上下文」。⚠️ 中间那一行会自己消失（{@link MESSAGE_TTL_MS}），所以它同时进桶 ——
   * 「刚才那次切换没存进台账」不该跟着 TTL 一起消失。
   */
  const say = useCallback(
    (text: string): void => {
      setMessage(text);
      push(activeId, [{ kind: "note", text }], Date.now());
    },
    [push, activeId],
  );

  // ⚠️ 瞬时消息自己会消失，且**计时器跟着消息走**（依赖是 `message` 本身）：
  // 依赖写成 `[message !== null]` 会让「换一条消息」不重启计时器，于是第二条只显示第一段剩余时间。
  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_TTL_MS);
    return () => clearTimeout(timer);
  }, [message]);

  /** 滚一段（`delta` 为正是往下）—— **只作用于当前会话** */
  const scrollBy = useCallback(
    (delta: number): void => {
      const viewport = viewportRef.current;
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const height = flatten(one.bucket.entries, viewport.width).height;
          const top = clampTop(height, viewport.rows, one.bucket.top + delta);
          const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          // ⚠️ 滚回最底下时**重新贴底**：否则新输出在「我明明已经看到最新了」的屏幕上静默地不出现。
          return { ...one, bucket: { ...one.bucket, top, follow: top >= bottom } };
        }),
      );
    },
    [activeId],
  );

  /** 直接定位到顶 / 底 */
  const scrollTo = useCallback(
    (where: "top" | "bottom"): void => {
      const viewport = viewportRef.current;
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const height = flatten(one.bucket.entries, viewport.width).height;
          const top =
            where === "top" ? 0 : clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          return { ...one, bucket: { ...one.bucket, top, follow: where === "bottom" } };
        }),
      );
    },
    [activeId],
  );

    /**
   * 探**任意一个**控制面一次
   * @description ⚠️ 依赖数组里**不许**出现本函数：它读的是 {@link ledgerRef}（身份恒定）。
   * ⚠️ **在飞要写进去**：发请求**之前**先把这个 id 那一格换成 `{ pending: true }`，于是状态行与
   * 窗口里读作「连接中」，而「还没探过」的 `undefined` 读作「未知」—— 分得出「还没开始」与「卡住了」。
   */
  const reprobe = useCallback((id: string): void => {
    const target = ledgerRef.current?.targets.find((one) => one.id === id);
    if (target === undefined) return;
    const seq = (probeSeq.current.get(id) ?? 0) + 1;
    probeSeq.current.set(id, seq);
    const fresh = (): boolean => probeSeq.current.get(id) === seq;
    setProbes((prev) => new Map(prev).set(id, { pending: true }));
    // ⚠️ **不靠 `AbortController`**：探活在渲染之外，abort 传不进去；作废只能落在调用点上
    void probeTarget(clientFor(target))
      .then((result) => {
        if (!fresh()) return;
        setProbes((prev) => new Map(prev).set(id, result));
      })
      .catch(() => {
        // ⚠️ 什么也不写：`ProbeResult` 表达不了「本包有 bug」，编一个 `TuiError` 会造出
        // 一条从未发生的失败。⚠️ 但也不能把 `{ pending: true }` 留在那儿 —— 故整格删掉。
        if (!fresh()) return;
        setProbes((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      });
  }, []);

  useEffect(() => {
    if (current === null) return;
    reprobe(current.id);
    // ⚠️ 依赖只有这两项：挂载与**切换会话连的那台**。按 `r` 那一次**不走这里**。
  }, [current?.id, reprobe]);

    /** 切到某一个会话（⚠️ **什么都不落盘**：会话只在内存里，见 {@link Session}） */
  const switchSession = useCallback((id: string): void => {
    setActiveId((before) => (before === id ? before : id));
  }, []);

  /** 下一个 / 上一个会话（`Ctrl+N` / `Ctrl+P` / `↑` `↓`；**没有就什么都不做**） */
  const stepSession = useCallback(
    (step: 1 | -1): void => {
      if (sessions.length < 2) {
        if (sessions.length === 1) say("只有 1 个会话，按 /new 可以再开一个");
        return;
      }
      const at = sessions.findIndex((one) => one.id === active.id);
      const to = (Math.max(0, at) + step + sessions.length) % sessions.length;
      const picked = sessions[to];
      if (picked === undefined) return;
      switchSession(picked.id);
    },
    [sessions, active.id, switchSession, say],
  );

    /**
   * 让某一个会话连上某一个控制面（**现读现写**）
   * @description 「下次打开接着连同一个」的实现就在这里：台账的 `selected` 变了必须落盘，否则它只活
   * 在内存里。⚠️ **现读**（`readLedger` 每次现读）是因为 {@link push} 之后内存里那份可能比磁盘旧，
   * 而 `readLedger` / `writeLedger` 都是同步的，读-改-写之间没有 `await`。
   * ⚠️ **写失败不回滚**：回滚会让「刚才那次切换」看起来没发生，而它确实发生了、只是没存下来。
   * ⚠️ 只改**这一个**会话的 `targetId`（`setSessions` 逐个比 `id`）：台账的 `selected` 是
   * 「上次用的那台」，而每个会话的目标是它自己的 —— 这两件事不许互相覆盖。
   */
  const useTarget = useCallback(
    (sessionId: string, targetId: string): void => {
      setSessions((prev) =>
        prev.map((one) => (one.id === sessionId ? { ...one, targetId } : one)),
      );
      let failure: string | null = null;
      try {
        writeLedger(ledgerFile, setSelected(readLedger(ledgerFile), targetId));
      } catch (err) {
        failure = describe(err);
      }
      holdLedger(readLedgerSafe(ledgerFile) ?? ledgerRef.current);
      setLedgerTick((tick) => tick + 1);
      if (failure !== null) {
        say(`这次切换没存进台账（${failure}）—— 界面上已经切过去了，关掉就没了`);
      }
    },
    [ledgerFile, holdLedger, say],
  );

    /** 执行层要用的依赖（**现造**，故它读到的是调用那一刻的最新状态） */
  const depsFor = useCallback(
    (job: Job): ExecDeps => ({
      client: current === null ? null : clientFor(current),
      width: viewportRef.current.width,
      line: job.line,
      // ⚠️ **台账的写一律经这三个回调**：内存里那份是本层的状态，直接 `writeLedger` 会造出
      // 「内存与磁盘漂移」。
      onTargetAdd: (request): void => {
        const next = upsertTarget(readLedger(ledgerFile), {
          name: request.name,
          baseUrl: request.baseUrl,
          token: request.token,
          // ⚠️ 缺省超时在这里补，且**只**在这里补（真值只有 `@/ledger:DEFAULT_TIMEOUT_MS` 一处）
          timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        holdLedger(next);
        writeLedger(ledgerFile, next);
        setLedgerTick((tick) => tick + 1);
      },
      onTargetDel: (name): void => {
        const next = removeTarget(readLedger(ledgerFile), idOfName(ledgerRef.current, name));
        holdLedger(next);
        writeLedger(ledgerFile, next);
        setLedgerTick((tick) => tick + 1);
      },
      onTargetSwitch: (name): void => {
        const id = idOfName(ledgerRef.current, name);
        useTarget(job.sessionId, id);
      },
    }),
    [current, ledgerFile, holdLedger, useTarget],
  );

  /**
   * 一条命令的**副作用**
   * @description ⚠️ **穷举**而不是「取第一条」：多一个 `Effect` 种类时这一支会编译期红。
   */
  const applyEffect = useCallback(
    (sessionId: string, effect: Effect): void => {
      switch (effect.kind) {
        case "clear-log":
          setSessions((prev) =>
            prev.map((one) => (one.id === sessionId ? { ...one, bucket: emptyBucket() } : one)),
          );
          break;
        case "reprobe":
          if (current !== null) reprobe(current.id);
          break;
        case "ledger-changed":
          setLedgerTick((tick) => tick + 1);
          break;
        case "target-switched":
          // ⚠️ **刻意什么都不做**：`onTargetSwitch` 那一刻已经把那个会话的 `targetId` 换掉并落盘了
          break;
        case "session-new": {
          // ⚠️ 发号在**这里**（不放在 `/new` 的解析或执行层）：执行层不认识会话，
          // 而「第几个会话」是本层的状态。⚠️ 新会话**从 `null` 开始连**，不继承当前那个 ——
          // 继承的话「`/new` 之后我还是在操作同一台机器」这件事在屏上没有任何区别，
          // 而「新会话是干净的」正是它的用途。
          sessionSeq.current += 1;
          const id = `s${String(sessionSeq.current)}`;
          const created = newSession(id, `会话 ${String(sessionSeq.current)}`);
          setSessions((prev) => [...prev, created]);
          setActiveId(id);
          break;
        }
        case "show-managers":
          // ⚠️ 高亮**默认落在当前会话连的那一台**上：窗口一打开就该能直接 `Enter` 确认它，
          // 而落在第 0 行的话「打开窗口就回车」会静默切到另一台机器。
          setWindowAt(Math.max(0, targets.findIndex((one) => one.id === active.targetId)));
          setWindowKind("managers");
          break;
        default:
          throw new Error(`应用层不认识这个副作用：${JSON.stringify(effect)}`);
      }
    },
    [current, reprobe, targets, active.targetId],
  );

  /**
   * 启动队列里的下一条（**串行化的全部实现**）
   * @description ⚠️ `finally` 里那一行 `pumpRef.current()` 是串行化的关键：前一条**跑完**（无论成功
   * 还是失败）才启动下一条，于是两个 `Effect` 永远不交错。
   */
  const pump = useCallback((): void => {
    if (busyRef.current) return;
    const job = queueRef.current.shift();
    if (job === undefined) return;
    busyRef.current = true;
    setRunning(job.line);
    void exec(job.command, depsFor(job))
      .then((result) => {
        push(job.sessionId, result.rows, Date.now());
        for (const effect of result.effects) applyEffect(job.sessionId, effect);
      })
      .catch(() => {
        push(
          job.sessionId,
          [{ kind: "err", text: "本包在执行这条命令时崩了（不是控制面的回答）" }],
          Date.now(),
        );
      })
      .finally(() => {
        busyRef.current = false;
        setRunning(null);
        pumpRef.current();
      });
  }, [depsFor, push, applyEffect]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  /**
   * 提交一行：解析 → 清空输入行 → 排队 / 贴判据
   * @description
   * ## ⚠️ 本函数**不回显**，回显是 {@link exec} 那**一个**来源（凭据已掩码）
   * @description 曾经这里是第二个回显点，而它 echo 的是**用户敲的原文** —— 于是
   * `target add live http://x T0KEN` 在结果区里留下了一行**明文 token**。
   *
   * ## ⚠️ **解析失败也清输入行**（面板随之关，判据看得见）
   * @description 不回显（回显原文就是把凭据抄进可滚动的结果区），也不留行 ——
   * **留着的那一帧里命令面板正盖在结果区上面**，操作者刚敲出来的那句判据一个字都看不见。
   */
  const submit = useCallback(
    (raw: string): void => {
      const line = raw.trim();
      // ⚠️ 三档都清输入行，且**在**任何 `push` 之前
      setSessions((prev) =>
        prev.map((one) => (one.id === activeId ? { ...one, input: "", cursor: 0 } : one)),
      );
      if (line === "") return;
      const parsed = parseLine(line);
      if (parsed.kind === "empty") return;
      if (parsed.kind === "ok") {
        queueRef.current.push({ sessionId: activeId, line, command: parsed.command });
        pumpRef.current();
        return;
      }
      push(activeId, rowsOfFailure(parsed), Date.now());
    },
    [activeId, push],
  );

    /**
   * 面板此刻的样子（**高亮是输入行的纯函数**，界面上没有「高亮在第几行」这个状态）
   * @description ⚠️ 所以 `↑`/`↓` 走完之后必须**把那一行写进输入行** —— 下一帧的高亮由那行字
   * 自己算出来，于是「输入行上敲的是 A、面板高亮的是 B」这件事在**类型上**不可能发生。
   */
  const palette = useMemo(() => paletteOf(active.input), [active.input]);

  const movePalette = useCallback(
    (step: 1 | -1): void => {
      const to = paletteStep(palette.at, step, palette.rows.length);
      const row = palette.rows[to];
      if (row === undefined || to === palette.at) return;
      const filled = paletteFill(active.input, active.cursor, row);
      setSessions((prev) =>
        prev.map((one) =>
          one.id === activeId ? { ...one, input: filled.line, cursor: filled.cursor } : one,
        ),
      );
    },
    [palette, active.input, active.cursor, activeId],
  );

  /** `Tab` / 鼠标点行要接受的那一行补进输入行（`null` = 「这一刻没有可接受的那一行」） */
  const acceptPalette = useCallback((): { line: string; cursor: number } | null => {
    const row = palette.rows[palette.at];
    return row === undefined ? null : paletteFill(active.input, active.cursor, row);
  }, [palette, active.input, active.cursor]);

    const closeWindow = useCallback((): void => setWindowKind(null), []);

  /** 窗口里 `↑`/`↓`/`Tab` 走一行（⚠️ 走到底就停住，不循环 —— 循环的话按着 `↓` 会一路滑回第一行） */
  const moveWindow = useCallback(
    (step: 1 | -1): void => {
      setWindowAt((before) => {
        const last = Math.max(0, targets.length - 1);
        return Math.max(0, Math.min(last, before + step));
      });
    },
    [targets.length],
  );

  /** `Enter`：把高亮那一台接到**当前会话**上，然后关窗 */
  const pickWindow = useCallback((): void => {
    const picked = targets[windowAt];
    if (picked !== undefined) useTarget(activeId, picked.id);
    closeWindow();
  }, [targets, windowAt, useTarget, activeId, closeWindow]);

    useInput((pressed, key) => {
    // ⚠️ **第一道闸，也是唯一能挡住鼠标报告的那一道**：Ink 的 `useInput` 会把**未解析**的转义序列
    // 原样交给本回调，而它**顺手砍掉了那个 ESC**，于是鼠标报告到这里已经是 `[<35;64;32M` ——
    // **一串全是可打印字符的协议报文**。⚠️ 它必须在**最前面**。
    if (isMouseReport(pressed)) return;
    // ⚠️ `Ctrl+C` **到不了这里**：Ink 的 `App` 组件在把输入交给监听器**之前**就自己处理了它。
    // ⚠️ **窗口开着 ⇒ 它是模态**：除 Esc / ↑↓ / Tab / Enter 之外**全部被吃掉**（含可打印文本）——
    // 「开着窗口还照常敲命令」会让操作者在看不见输入结果的情况下敲出一串命令，而回车会把它们
    // 全部执行。那不是「窗口不挡键盘」，那是「一个能偷偷执行的遮罩」。
    if (windowKind !== null) {
      if (key.escape) {
        closeWindow();
        return;
      }
      if (key.upArrow) {
        moveWindow(-1);
        return;
      }
      if (key.downArrow || key.tab) {
        moveWindow(1);
        return;
      }
      if (key.return) {
        pickWindow();
        return;
      }
      return;
    }
    if (key.ctrl || key.meta) {
      const lower = pressed.toLowerCase();
      if (lower === "n") {
        stepSession(1);
        return;
      }
      if (lower === "p") {
        stepSession(-1);
        return;
      }
      if (key.home) {
        scrollTo("top");
        return;
      }
      if (key.end) {
        scrollTo("bottom");
        return;
      }
      if (key.pageUp) {
        scrollBy(-SCROLL_STEP);
        return;
      }
      if (key.pageDown) {
        scrollBy(SCROLL_STEP);
        return;
      }
      // ⚠️ 其余 Ctrl 组合**什么都不做**
      return;
    }
    if (key.pageUp) {
      scrollBy(-SCROLL_STEP);
      return;
    }
    if (key.pageDown) {
      scrollBy(SCROLL_STEP);
      return;
    }
    // ⚠️ `↑`/`↓` **不移动光标**（输入折行了也不移）—— 见文件头「折行没有第二套移动键」。
    if (key.upArrow) {
      if (palette.open) {
        movePalette(-1);
        return;
      }
      stepSession(-1);
      return;
    }
    if (key.downArrow) {
      if (palette.open) {
        movePalette(1);
        return;
      }
      stepSession(1);
      return;
    }
    const edit = (change: (text: string, cursor: number) => { text: string; cursor: number }): void => {
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const after = change(one.input, one.cursor);
          return { ...one, input: after.text, cursor: after.cursor };
        }),
      );
    };
    const setCaret = (pick: (text: string, cursor: number) => number): void => {
      setSessions((prev) =>
        prev.map((one) =>
          one.id === activeId ? { ...one, cursor: pick(one.input, one.cursor) } : one,
        ),
      );
    };
    if (key.leftArrow) {
      setCaret(caretLeft);
      return;
    }
    if (key.rightArrow) {
      setCaret(caretRight);
      return;
    }
    if (key.home) {
      setCaret(() => 0);
      return;
    }
    if (key.end) {
      setCaret((text) => text.length);
      return;
    }
    if (key.backspace || key.delete) {
      // ⚠️ 一次性改两个字段：分开写会产生一帧「串变了、光标还在老位置」的中间态，
      // 而那一帧里再按一次退格就落在错的地方（Ink 是逐帧 diff 的，中间态**看得见**）。
      edit((text, cursor) =>
        key.delete ? deleteAt(text, cursor) : deleteBefore(text, cursor),
      );
      return;
    }
    if (key.tab) {
      // ⚠️ **面板开着时 Tab 补的是高亮那一行**，而不是 `complete` 挑的「字典序第一个」：
      // 两条规则给同一次按键两个答案时，「Tab 填进去的」与「面板高亮的」会差一行。
      const accept = acceptPalette();
      if (accept !== null) {
        setSessions((prev) =>
          prev.map((one) =>
            one.id === activeId
              ? { ...one, input: accept.line, cursor: accept.cursor }
              : one,
          ),
        );
        return;
      }
      const suggestion = complete({
        line: active.input,
        cursor: active.cursor,
        targetNames: targets.map((one) => one.name),
      });
      if (suggestion.candidates.length === 0) return;
      setSessions((prev) =>
        prev.map((one) =>
          one.id === activeId
            ? { ...one, input: suggestion.line, cursor: suggestion.cursor }
            : one,
        ),
      );
      return;
    }
    if (key.return) {
      // ⚠️ **Enter 不接受面板的高亮**：它提交的是输入行**逐字**。
      submit(active.input);
      return;
    }
    if (key.escape) {
      setSessions((prev) =>
        prev.map((one) => (one.id === activeId ? { ...one, input: "", cursor: 0 } : one)),
      );
      return;
    }
    // ⚠️ 最后一档：**可打印的文本**（C0 在这里被剔掉，见 {@link printableOnly}）
    const typed = printableOnly(pressed);
    if (typed === "") return;
    edit((text, cursor) => insertAt(text, cursor, typed));
  });

    /**
   * 侧边栏那几行（**每项两行**：名字 + 它连的控制面）
   * @description ⚠️ 认 `id` 不认下标（`/new` 之后数组整个变了，而按下标存的 hover 会指着别的会话）。
   * ⚠️ 第二行答「打给谁」，而控制面 `null` 说成「未选控制面」——空串与「名字是空的控制面」同形。
   */
  const sessionRows: readonly SessionRow[] = useMemo(
    () =>
      sessions.map((one) => ({
        id: one.id,
        name: one.name,
        manager: targets.find((t) => t.id === one.targetId)?.name ?? null,
      })),
    [sessions, targets],
  );

  /** 台账里每个控制面的连接状态（状态行按它数台数；窗口里每一行的字形也走它） */
  const managerStates = useMemo(
    () => targets.map((one) => connectionStateOf(probes.get(one.id))),
    [targets, probes],
  );

  /** 指针当前悬停在哪个会话上（`null` = 不在侧边栏上） */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /** 指针在不在拖宽手柄上（那一列给一层底色，于是「能拖」看得见） */
  const [handleHot, setHandleHot] = useState(false);
  /** 指针在不在右上角那枚 `esc` 上 */
  const [closeHot, setCloseHot] = useState(false);

  /**
   * 几何（**本层与 {@link Layout} 调的是同一个纯函数、喂的是同一组字段**，故两份结果逐字相同）
   * @description ⚠️ `input` 喂的是**当前会话的输入原文**（不是行数）：折行由几何层算 ——
   * 两处各折一次就是两份判据，而症状是「点输入行落点落在错一个字上」。
   */
  const g = useMemo(
    () =>
      geometry({
        columns,
        rows,
        sidebarWidth,
        input: active.input,
        paletteCount: palette.rows.length,
        window: windowKind !== null,
        windowRows: targets.length,
        windowFooter: windowKind !== null,
      }),
    [columns, rows, sidebarWidth, active.input, palette.rows.length, windowKind, targets.length],
  );

  /** 面板滚动窗口的第一行号（**绘制与命中测试共用它**） */
  const windowStart = paletteWindow(palette.at, g.paletteViewportRows, palette.rows.length);

  useEffect(() => {
    viewportRef.current = { width: g.outputWidth, rows: g.outputRows };
  }, [g.outputWidth, g.outputRows]);

  useEffect(() => {
    return mouse.onMouse((event: MouseEvent) => {
      // ⚠️ **拖宽优先于其余一切**：`drag` 报告在拖宽期间是**本包的语义**，
      // 而其余时候它必须留给终端（拖选文本 / 框选粘贴）。判据是 `resizingRef` 那一个 ref：
      // 「按着最右那一列」是**起手**决定的（`down`），故拖到哪儿都不需要再判一次位置。
      if (event.action === "drag" && resizingRef.current !== null) {
        const start = resizingRef.current;
        setSidebarWidth(start.width + (event.x - start.x));
        return;
      }
      switch (event.action) {
        case "move": {
          // ⚠️ **只有 `move` 认 hover**：`drag` 是「按着挪」，让拖宽时也换底色的话，
          // 那一项会亮着而屏上没有任何东西解释它为什么亮着。
          setHoveredId((before) => {
            // ⚠️ **同一个值就原样返回**：React 跳过重渲染，于是「手在侧边栏里划一下」
            // 一个字节都不写（`?1003h` 开着时那是一秒几百条报告）。
            const now =
              resizingRef.current === null ? (hitTest(event.x, event.y, g.sidebarRows) < 0 ? null : (sessionRows[hitTest(event.x, event.y, g.sidebarRows)]?.id ?? null)) : null;
            return before === now ? before : now;
          });
          setHandleHot(resizingRef.current === null && hitTest(event.x, event.y, [g.sidebarHandle].filter((r) => r !== null)) >= 0);
          setCloseHot(
            windowKind !== null && hitTest(event.x, event.y, [g.windowClose].filter((r) => r !== null)) >= 0,
          );
          return;
        }
        case "up":
          // ⚠️ 抬手之后**底色留着**（指针确实还在那一项上）；而 `drag` / `wheelLeft` /
          // `wheelRight` 一个都不接（除非正在拖宽，那一支在上面）—— 拖动选择必须留给终端。
          resizingRef.current = null;
          return;
        case "wheelUp":
          // ⚠️ 面板开着时滚轮**走面板**（移动高亮那一行），面板关着时才滚结果区：
          // 与 `↑`/`↓` 同一个判据、同一份实现。
          if (palette.open) movePalette(-1);
          else scrollBy(-SCROLL_STEP);
          return;
        case "wheelDown":
          if (palette.open) movePalette(1);
          else scrollBy(SCROLL_STEP);
          return;
        case "down": {
          // ⚠️ **只认左键**：中键与右键各有各的含义（粘贴 / 菜单），本工具没有那两种操作。
          if (event.button !== "left") return;
          // ⚠️ **窗口是模态**：它开着时只认它自己的两处（右上角那枚 esc、它自己那几行），
          // 背后的一切点击**什么都不做** —— 包括侧边栏与输入行。
          if (windowKind !== null) {
            if (hitTest(event.x, event.y, [g.windowClose].filter((r) => r !== null)) >= 0) {
              closeWindow();
              return;
            }
            const picked = hitTest(event.x, event.y, g.windowRows);
            if (picked >= 0) setWindowAt(picked);
            return;
          }
          // ⚠️ **手柄先判**：它与那些会话项**重叠**（就是侧边栏最右那一列），
          // 反过来（先判会话）的话「按着最右那列拖宽」会在起手那一瞬把会话切掉。
          if (hitTest(event.x, event.y, [g.sidebarHandle].filter((r) => r !== null)) >= 0) {
            resizingRef.current = { x: event.x, width: sidebarWidth };
            return;
          }
          const row = hitTest(event.x, event.y, g.sidebarRows);
          if (row >= 0) {
            const pickedSession = sessionRows[row];
            // ⚠️ 点的**就是当前那个**时什么都不做：那一次点击不该产生任何后果。
            if (pickedSession !== undefined && pickedSession.id !== activeId) {
              switchSession(pickedSession.id);
            }
            return;
          }
          // ⚠️ 面板的候选行**在侧边栏右侧**：点中哪一行就把它补进输入行，**不执行**。
          const pick = hitTest(event.x, event.y, g.paletteRows);
          if (pick >= 0 && palette.open) {
            const chosen = palette.rows[windowStart + pick];
            if (chosen !== undefined) {
              const filled = paletteFill(active.input, active.cursor, chosen);
              setSessions((prev) =>
                prev.map((one) =>
                  one.id === activeId
                    ? { ...one, input: filled.line, cursor: filled.cursor }
                    : one,
                ),
              );
            }
            return;
          }
          if (g.inputTextRows.length > 0) {
            const at = caretFromWrappedPoint(
              event.x,
              event.y,
              g.inputTextRows,
              g.inputWrapped,
            );
            if (at !== null) {
              setSessions((prev) =>
                prev.map((one) => (one.id === activeId ? { ...one, cursor: at } : one)),
              );
              return;
            }
          }
          // ⚠️ 点结果区**什么都不做**
          return;
        }
        default:
          return;
      }
    });
  }, [
    mouse,
    g,
    sessionRows,
    activeId,
    active.input,
    active.cursor,
    palette,
    windowStart,
    windowKind,
    sidebarWidth,
    switchSession,
    scrollBy,
    movePalette,
    closeWindow,
  ]);

    const bucket = active.bucket;
  const flat: FlatLog = useMemo(
    () => flatten(bucket.entries, g.outputWidth),
    [bucket.entries, g.outputWidth],
  );
  // ⚠️ **读的时候再夹一次**：改窗口高度会让 `top` 越界，而一个越界的 `top` 让
  // `visibleLines` 返回空数组 —— 界面上是「结果区空了」，而下面其实有内容。
  const top = clampTop(flat.height, g.outputRows, bucket.top);

  const suggestion = complete({
    line: active.input,
    cursor: active.cursor,
    targetNames: targets.map((one) => one.name),
  });
  // ⚠️ 幽灵文本 = **「按 Tab 会插进来什么」**，两条来源合成**一个**出口。
  const fillable = palette.open ? acceptPalette() : null;
  const ghost =
    fillable !== null && fillable.cursor > active.cursor
      ? fillable.line.slice(active.cursor, fillable.cursor)
      : suggestion.cursor > active.cursor && suggestion.candidates.length > 0
        ? suggestion.line.slice(active.cursor)
        : null;

  /**
   * 输入区中间那一行：**两档，优先级从上到下**（执行中 / 一条瞬时消息 / 台账读不出来）
   * @description ⚠️ 「补全候选」那一档**不存在**：那块答案是**命令面板**。
   * ⚠️ 「台账读不出来」**最低**不是因为它不重要，而是它**不消失**。
   */
  const notice =
    running !== null
      ? `执行中：${running}`
      : message ?? (ledgerError === null ? null : `台账读不出来：${ledgerError.message}`);

  /**
   * 命令面板（`null` = 没开）
   * @description ⚠️ `rows` 给的是**行号序**（已经滚过窗），而 `at` 也换算成**行号** ——
   * 呈现层因此完全不需要知道「首行号是多少」。
   * ⚠️ **装不装得下读几何层**（`paletteFooterRow !== null`），本层**不自己比**一次。
   */
  const paletteView: PaletteView | null = palette.open
    ? {
        total: palette.rows.length,
        rows: palette.rows
          .slice(windowStart, windowStart + g.paletteViewportRows)
          .map((row) => ({ text: row.path, summary: row.summary })),
        at: palette.at - windowStart,
        footer:
          g.paletteFooterRow === null
            ? null
            : `第 ${String(windowStart + 1)}–${String(
                windowStart + Math.min(g.paletteViewportRows, palette.rows.length - windowStart),
              )} 条 · 共 ${String(palette.rows.length)} 条 · ↑↓ 选 · Tab 接受`,
      }
    : null;

  /**
   * 模态窗口的内容（`null` = 没开）
   * @description ⚠️ **链接在这一行**而不在状态行：状态行是恒定的一行（各状态台数 + 版本号），
   * 链接会随会话连的那台变 —— 摆在恒定位置上只会闪。⚠️ 而「**管理**」指的是「选一台给当前会话」，
   * 删除仍然走命令（`target del <名字>`）：一个「点一下就删掉」的按钮没有任何确认步骤，
   * 而删除的是**控制面管理员凭据**。
   */
  const windowRows: readonly WindowRow[] = useMemo(
    () =>
      targets.map((one) => ({
        id: one.id,
        name: one.name,
        detail: `${one.baseUrl} · 超时 ${String(one.timeoutMs)}ms`,
        state: connectionStateOf(probes.get(one.id)),
        current: one.id === current?.id,
      })),
    [targets, probes, current?.id],
  );

  const windowView: WindowView | null =
    windowKind === null
      ? null
      : {
          title: `控制面（${targets.length}）`,
          rows: windowRows,
          at: windowAt,
          footer:
            targets.length === 0
              ? "台账里还没有控制面 · 用 /target add <名字> <地址> <token> 加一个"
              : "↑↓ 选 · Enter 接到当前会话 · Esc 或点右上角关窗 · 删除用 /target del <名字>",
        };

  return (
    <Layout
      columns={columns}
      rows={rows}
      color={color}
      version={version}
      sidebarWidth={sidebarWidth}
      sessions={sessionRows}
      selectedSessionId={activeId}
      hoveredSessionId={hoveredId}
      handleHot={handleHot}
      managerStates={managerStates}
      flat={flat}
      top={top}
      input={active.input}
      cursor={active.cursor}
      ghost={ghost}
      notice={notice}
      palette={paletteView}
      mouseHint={mouseUnsupportedHintOf(mouse.liveness(), Date.now())}
      // ⚠️ logo 只在「当前会话**还没有任何输出**」时占位：台账为空时唯一能敲的两条命令
      // （`target add` 与 `help`）的输出正落在那个桶里。
      showLogo={!flat.any}
      droppedHint={droppedHint(bucket)}
      window={windowView}
      closeHot={closeHot}
    />
  );
}

/** 台账读不出来时给 `null`（**不抛**）：写完盘紧接着刷新内存那一份，读失败就留着旧的那份 */
function readLedgerSafe(file: string): Ledger | null {
  try {
    return readLedger(file);
  } catch {
    return null;
  }
}

/* 解析失败 → 若干行（形状借自 {@link exec} 的排版纪律） */

/**
 * 解析失败 → 若干行
 * @description ⚠️ **文案里没有用户输入**：凭据敲错一个字符时，「你输入错了：x#k2」会把凭据
 * 抄进可滚动、可复制的结果区。
 */
function rowsOfFailure(failed: Exclude<ParseResult, { kind: "ok" }>): LogRow[] {
  switch (failed.kind) {
    // ⚠️ **空输入不是错误**：本函数只在真的解析失败时被调，返回空数组（不显示任何东西）
    // 是**最不坏**的形态。
    case "empty":
      return [];
    case "missing-prefix":
    case "unknown-command":
      return [
        { kind: "err", text: failed.message },
        ...(failed.suggestions.length > 0
          ? [{ kind: "note" as const, text: `是不是想写 ${failed.suggestions.join(" / ")}？` }]
          : []),
      ];
    case "bad-args":
    case "bad-value": {
      const rows: LogRow[] = [{ kind: "err", text: failed.message }];
      if (failed.usage !== null) rows.push({ kind: "note", text: `用法：${failed.usage}` });
      return rows;
    }
  }
}