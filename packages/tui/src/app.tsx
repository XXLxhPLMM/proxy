/**
 * @fileoverview 根组件：全屏 console 的应用状态层（台账 / 每个目标的输出桶 / 输入行 / 滚动）
 * @module app
 * @description
 * 本组件是**唯一**持有跨帧状态的地方，也是**唯一**把「一次动作」翻译成「若干次 `setState`」的地方。
 * 它不认识控制面数据的任何一个字段 —— 那在 `@/console/exec.js`。它也不画任何东西：那在
 * `@/console/layout.js`，而**坐标**在 `@/console/geometry.js`。
 *
 * ## 一屏的形状（全屏接管，不是「终端里的几个面板」）
 * @description
 * 屏顶零横向区域 → 左侧边栏（目标清单，可点）+ 右侧主区 → 主区上半是结果区（可滚）、下半是输入区。
 * 本组件**没有「页面」这个概念**：本工具的全部功能是**命令**（`@/cmd/index.js` 那张表），
 * 而结果区与输入区是**同一块主区**的上下两半。⚠️ 这条不是风格选择：一个页面就是一份
 * 「当前在哪 + 这一页的键位 + 这一页的数据」三件套，而本工具里「当前在哪」只有一个答案
 * （结果区里最近的那些行），键位只有一张全局表，数据一律由**命令**现拉。
 * 故 `1`-`6` 是**命令里的字符**，不是页签序号。
 *
 * ## 三条判据各自为什么落在这一层
 * @description
 * 1. **命令排队、一条一条跑**（{@link runQueue}）。执行层自己不碰状态，它只说「发生了什么」；
 *    而「什么时候把这一批结果贴进屏幕」是状态层的活。⚠️ **排队而不是并发**：`Effect` 里有
 *    `clear-log` 与 `ledger-changed` 两个会改动别的东西的动作，并发跑两次命令时，一个 `clear-log`
 *    会把另一条刚落地半秒的结果一起抹掉，而屏幕上没有任何东西解释它去哪了。串行化之后
 *    「按下回车的那一屏」与「结果贴上去的那一屏」永远同序。
 * 2. **每个目标一个输出桶**（{@link Bucket}）。⚠️ 不是「一份全局日志」：切目标之后回看上一个目标的
 *    输出是一件真实需求，而一个全局缓冲区只能靠 `clear` 把它弄掉（于是「看一眼上一个」与「清掉」
 *    变成了同一个动作）。桶的键是目标 `id`，外加一个**没选中目标时**的键
 *    （{@link NO_TARGET_BUCKET}）—— 那不是特例，是「`selected` 为 `null` 时这条命令的输出落在哪」
 *    这一个问题的答案，而 `target add` / `help` 的输出正落在那里。
 * 3. **探活只有一个来源**（{@link probes} 那一个 `Map`）。目标条上的连接字形**只有这一处**能算。
 *    ⚠️ 本仓曾经有过第二份（目标条一份、台账表格一份，逐字相同），分叉出来的不是「多一次请求」，
 *    而是**同一屏两句话**。现在没有表格了，但纪律不变：一个 id 一个值，侧边栏是它唯一的读者。
 *
 * ## ⚠️ 输入行里**永不出现控制字符，也永不出现协议报文**
 * @description
 * Ink 把粘贴的内容**逐字**交给 `useInput`，而一段从网页/编辑器复制来的 token 里常带着一个 `U+000D`
 * 或 `U+000A`。它会**静默**地进到输入行里、跟着 `target add` 一起发出去，而服务端的
 * `Authorization: Bearer` 用 `$` 锚定比对 —— 结果是恒 401，而屏幕上只有一句「未授权」，
 * 没有任何东西指向「你的 token 里有一个看不见的字符」。故 {@link printableOnly} 在**入状态之前**就把
 * C0 控制字符与 `DEL` 全部剔掉，而剔除**不产生任何提示**（那不是「用户打错」，那是被粘贴污染的）。
 *
 * ⚠️ **但 C0 那一道挡不住鼠标报告**：`useInput` 的字符串里那个唯一的 C0 字节（`ESC`）在进门之前
 * 就被 Ink 拿掉了，于是协议报文到这里**全是可打印字符**。故输入行有**两道闸**：先是
 * {@link isMouseReport}（认领协议，判据与 `@/ui/mouse.ts:parseSgr` 同源），再是
 * {@link printableOnly}（剔 C0）。⚠️ 写成一道都不行：只有 `isMouseReport` 时粘贴进来的换行会当命令发出去，
 * 只有 `printableOnly` 时移动一次鼠标就往输入行里糊几十行 `[<35;64;32M`。
 *
 * ## 键位（每一个都要有归属；没有「页面级键位」那一层）
 * @description
 * - 输入行编辑：`←` `→` `Home` `End` `Backspace` `Delete`
 * - 执行：`Enter`
 * - 补全：`Tab`
 * - 滚动结果区：`PageUp` `PageDown` `Ctrl+Home` `Ctrl+End` 与**滚轮**
 * - 切目标：`Ctrl+N` / `Ctrl+P`（下一台 / 上一台）、**鼠标点侧边栏那一行**、命令 `target switch <名字>`
 * - 退出：`Ctrl+C`（**Ink 自己处理**，见文件头）
 *
 * ## ⚠️ 本组件**没有**「退出」这个动作，也没有 `quit` 这个 prop
 * @description
 * `Ctrl+C` 由 Ink 的 `App` 组件在把输入交给任何监听器**之前**就处理掉了
 * （`ink/build/components/App.js:handleInput` 里 `return` 掉，`onExit` → `ink.js:handleAppExit`
 * → `unmount()` → 写 `?1049l` 与「显示光标」）。⚠️ 故本组件**收不到**那个键，也**不该**再实现一遍
 * —— 而**不该**的代价不是「重复退出」（`unmount()` 幂等），是「两处退出路径的收尾次序可能不一致」，
 * 那种不一致只在真终端里显形，且症状是「退出后屏幕停在全屏界面上」。
 *
 * ⚠️ **侧边栏没有光标行**：侧边栏上的高亮就是「当前选中的那一台」，而切换动作有三个入口
 * （点 / `Ctrl+N` / `target switch`）。⚠️ 曾经设计过一个独立的「光标行」——它带来的问题比它解决的
 * 多：光标行与选中行是两个概念，而**唯一**需要「移动光标再确认」的场景（点一下就选中）在鼠标上
 * 本来就是一步。
 *
 * ## logo 与输出的关系：没选中目标时先出 logo，出了输出就让位
 * @description
 * 用户要的原话是「logo 在没有选择链接的时候显示出来」。⚠️ 但台账为空时能敲的命令恰恰是
 * `target add` 与 `help` —— 它们的输出**必须**看得见，而 {@link Layout} 的 logo 与结果区是
 * **同一个位置**。故判据是「没选中目标**且**这个桶里还没有任何输出」：刚启动时是 logo（引导语），
 * 敲了 `help` 之后是帮助。⚠️ 若严格按「没选中就永远出 logo」，那么本工具唯一能教会用户怎么用的
 * 那条命令的输出**永远看不见**。
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
  caretFromColumn,
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
} from "@/console/index.js";
import {
  connectionStateOf,
  isMouseReport,
  maskToken,
  mouseUnsupportedHintOf,
  type MouseEvent,
  type MouseSource,
  type ProbeSlot,
} from "@/ui/index.js";

/* ── 常量 ────────────────────────────────────────────────────────────────── */

/**
 * 每个桶里保留多少条输出条目（**环形缓冲**，不是审计日志）
 * @description
 * 理由写在 `@/console/log.js:trim` 的文件头：结果区服务的是「刚才那条命令干了什么」，而 {@link flatten}
 * 在**每次渲染**都跑，于是条目数与屏上帧率成正比地吃 CPU。⚠️ 被丢掉多少要**说出口**
 * （{@link dropped} 那一行），否则操作者会以为历史是完整的。
 */
const LOG_KEEP = 2000;

/** 滚轮 / 翻页一次滚几行（三行 ≈ 一段话，且不至于一滚就穿过整个屏幕） */
const SCROLL_STEP = 3;

/**
 * 「还没选中任何目标」那个桶的键
 * @description ⚠️ 它就是 `selected === null` 时的**目标身份**，而 `selected` 为 `null` 是一种常态
 * （首次启动、`removeTarget` 掉了当前那个）。故这里给一个**不可能与任何 `id` 相等**的串：
 * `id` 恒为 `[a-z0-9-]+`（`@/ledger/edit.ts:slugify`），而 `!` 不在那个字符集里。
 * ⚠️ 选一个**打不出来的**哨兵是有意的：哨兵一旦与某个合法 `id` 撞上，两个目标会共享一个输出桶，
 * 而症状是「切到第二个却看到第一个的输出」—— 那种 bug 极难归因。
 */
const NO_TARGET_BUCKET = "!no-target";

/**
 * 输入区中间那一行给非补全消息停留多久（毫秒）
 * @description ⚠️ 那行**同时**是补全候选与「执行中」，所以它必须会自己消失：一条两分钟前的
 * 「没存进台账」挂在屏幕上，操作者会以为那是当前状态。它不是历史的唯一去处 —— 每一条消息
 * 同时也进结果区（{@link say}），滚回去还在。
 */
const MESSAGE_TTL_MS = 8000;

/** 兜底的终端行数（`process.stdout.rows` 拿不到时；`24` 是几乎所有终端都至少有的高度） */
export const FALLBACK_ROWS = 24;

/* ── 形状 ────────────────────────────────────────────────────────────────── */

/**
 * 一个输出桶：条目 + 滚动位置 + 「贴不贴底」
 * @description
 * ⚠️ **三个字段住在同一个对象里**，不是三个独立的 `useState`：贴底判定需要「追加前的高度」与
 * 「追加后的高度」两份数字，而它们必须与那一次追加**原子地**算出来。拆成三个状态就得到
 * 「判贴底用的是旧高度、贴底用的却是新 top」这种半拍延迟 —— 症状是新输出一闪而过然后停在半路。
 */
interface Bucket {
  readonly entries: readonly LogEntry[];
  /** 顶行号（行，0 起）。**读的时候还要再夹一次**（{@link clampTop}），改窗口高度会让它越界 */
  readonly top: number;
  /** 是否贴底。`false` = 操作者往上翻过，于是新输出**不**把他拽回去 */
  readonly follow: boolean;
}

/** 空的桶（**每个键一个**，不能共享同一个对象：`setState` 靠引用变化判断） */
function emptyBucket(): Bucket {
  return { entries: [], top: 0, follow: true };
}

/** 一条排队中的命令（**已经解析完**，故队列里不含任何需要 `try` 的东西） */
interface Job {
  readonly bucket: string;
  /** 用户敲的原文（回显用） */
  readonly line: string;
  readonly command: Command;
}

/* ── 纯工具（不入状态，可被单测逐字断言）──────────────────────────────────── */

/**
 * 是不是**控制字符**（C0 那一段 + `DEL`）
 * @description
 * ⚠️ **逐个 code point 判**而不是 `/[\u0000-\u001F\u007F]/` 那样的正则：那条正则会被本包的
 * `no-control-regex` 判死，而**加一条 `eslint-disable` 等于让这条纪律从此不再被看见** ——
 * 而它挡的是一类只在真终端里才显形、且症状是「一句没头没尾的 401」的 bug。
 * 判据一个字都没变：`code < 0x20`（C0，含 `U+000D` / `U+000A`）或 `code === 0x7F`（`DEL`）。
 */
function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/**
 * 只留下可打印的那部分
 * @description ⚠️ **剔掉而不是「替换成空格」**：一个被污染的 token 换成一个空格仍然是错的 token，
 * 而 `target add` 的 token 判据是「非空 + trim 端部」，中间多一个空格照样发出去、照样 401。
 * 剔掉之后操作者拿到的是一句诚实的 401（他多半会重敲一次 token），而不是一句「未授权」配上
 * 一个他自己看不见的差异。
 *
 * ⚠️ **它挡不住协议报文，只挡得住 C0**：`useInput` 的字符串里那个唯一的 C0 字节（`ESC`）
 * **在进门之前就被 Ink 拿掉了**（见 `useInput` 那道闸的注释），所以一条鼠标报告到这里是一串
 * 全可打印字符。⚠️ 别把它读成「进输入行的东西都干净」——「输入行只收可打印文本」这条不变式
 * 是**两道闸合起来**才成立的：`isMouseReport`（协议）+ 本函数（C0），少任何一道都不成立。
 */
export function printableOnly(text: string): string {
  let out = "";
  for (const ch of text) if (!isControlChar(ch)) out += ch;
  return out;
}

/**
 * 在 `text` 的第 `at` 个 **code unit** 处插入 `added`（返回新串与新光标）
 * @description ⚠️ **下标一律是 UTF-16 code unit**（`String.length` / `slice` / `[]` 的那套），
 * 因为它要与另外三处逐字一致：`@/console/geometry.ts:caretFromColumn` 返回的、`@/cmd/complete.ts`
 * 吃的、以及 `@/console/layout.tsx:CaretLine` 切的三者都是它。⚠️ 用 code point 计数当光标位置
 * 会让中文与 emoji 的插入点算错一格，而那种错**只在输入非 ASCII 时**出现。
 * ⚠️ 但**落点永远在 code point 边界上**：移动键按整段走，`caretFromColumn` 也只停在边界，
 * 所以 `slice` 不会切在一个代理对中间。
 */
export function insertAt(text: string, at: number, added: string): { text: string; cursor: number } {
  const clamped = Math.min(Math.max(at, 0), text.length);
  return { text: text.slice(0, clamped) + added + text.slice(clamped), cursor: clamped + added.length };
}

/** 删掉 `at` 之前那一个 code point（`Backspace`）；行首是 no-op */
export function deleteBefore(text: string, at: number): { text: string; cursor: number } {
  const clamped = Math.min(Math.max(at, 0), text.length);
  if (clamped === 0) return { text, cursor: 0 };
  // ⚠️ **退一整个 code point**，不是退一个 code unit：只退一半会在代理对中间切开，
  // 而那个半个字符既显示成一个豆腐块、又在下一次插入时被顶到别处。
  const before = text.slice(0, clamped);
  const head = before.slice(0, [...before].length - 1);
  return { text: head + text.slice(clamped), cursor: head.length };
}

/** 删掉 `at` 处那一个 code point（`Delete`）；行末是 no-op */
export function deleteAt(text: string, at: number): { text: string; cursor: number } {
  const clamped = Math.min(Math.max(at, 0), text.length);
  if (clamped >= text.length) return { text, cursor: clamped };
  const whole = [...text];
  // 找到 `at` 所在的第几个 code point
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
  const before = text.slice(0, clamped);
  const chars = [...before];
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
 * ⚠️ 与 `@/console/exec.ts` 那两份是**同物种的重复**（本机文件形状不对 vs 对面没答上，
 * 排查方向完全相反），但那份在纯函数层、它不 import React，而本组件没法被纯函数层 import ——
 * 反向依赖会把执行层拖上 React。故各有一份，且两处都**不许**转述非这两类的异常。
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
 * @description ⚠️ 名字**可以重复**（`@/ledger/edit.ts:idFor` 对撞名加 `-2`，而 `name` 保持不变），
 * 故这里取**第一个**匹配并把这一个选择**说出口**：静默取第一个是对的（那是唯一有定义的答案），
 * 而**不说**就会让操作者以为「我切到了第二个」。
 * @throws {LedgerError} 台账里没有这个名字 —— 失败由执行层翻成一句判据（`@/console/exec.ts:ledgerFailure`）
 */
function idOfName(ledger: Ledger | null, name: string): string {
  const found = ledger?.targets.find((one) => one.name === name);
  if (found === undefined) throw new LedgerError("invalid-target", "台账里没有这个名字的控制面");
  return found.id;
}

/** 输入区下方那一小行：当前目标的地址、端口、超时与打码后的 token */
function hintOf(target: Target | null, color: boolean): string | null {
  // ⚠️ **台账为空时这一半整个不显示**，而不是像以前那样写「用 target add … 加一个」：
  // 「有哪些命令能敲」现在由**命令面板**回答（按 `/` 就浮出来），而底部状态行再挂一句
  // 「你应该敲这个」就是同一件事在一屏里出现两次，且两份必然漂（面板从命令表算出，
  // 这一句是手写的）。引导落在**引导屏**上（{@link Layout} 的 `showLogo` 那一支），
  // 而那一块是操作者第一次打开本工具时唯一会读的地方。
  if (target === null) return null;
  const token = target.token === "" ? "（token 为空）" : maskToken(target.token);
  void color;
  return `${target.baseUrl} · 超时 ${String(target.timeoutMs)}ms · token ${token}`;
}

/* ── 组件 ────────────────────────────────────────────────────────────────── */

export interface AppProps {
  /** 台账文件路径（`@/ledger/path.ts:targetsPath` 的产物，由组合根算好） */
  readonly ledgerFile: string;
  /** 终端总列数（组合根采集的快照 —— **本层零 `process.*`**） */
  readonly columns: number;
  /** 终端总行数（同上；⚠️ 缺了它就画不出上下分栏，而 `Layout` 会在缺省时按 0 行渲染） */
  readonly rows: number;
  /** 要不要上色（`NO_COLOR` / `TERM=dumb` / `CI` 由组合根判好） */
  readonly color: boolean;
  /** 版本号（组合根从构建期注入的 `APP_VERSION` 取；空串 = 不知道，状态行右半**整个**不显示它） */
  readonly version: string;
  /** 鼠标事件源（生命周期归组合根；本组件只订阅） */
  readonly mouse: MouseSource;
}

export function App({ ledgerFile, columns, rows, color, version, mouse }: AppProps) {
  /* ── 状态 ────────────────────────────────────────────────────────────── */

  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [ledgerError, setLedgerError] = useState<LedgerError | null>(null);
  /** 改台账后触发重读盘（`target add` / `target del` 之后） */
  const [ledgerTick, setLedgerTick] = useState(0);
  /** 每个目标（外加 {@link NO_TARGET_BUCKET}）一个输出桶 */
  const [buckets, setBuckets] = useState<ReadonlyMap<string, Bucket>>(
    () => new Map<string, Bucket>(),
  );
  /** 每个目标最近一次探活持有的那个值（`undefined` = 还没探过） */
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeSlot>>(
    () => new Map<string, ProbeSlot>(),
  );
  const [input, setInput] = useState("");
  /** 插入符位置（**UTF-16 code unit 下标**，见 {@link insertAt}） */
  const [cursor, setCursor] = useState(0);
  /** 输入区中间那一行（执行中 / 一条瞬时消息） */
  const [message, setMessage] = useState<string | null>(null);
  /** 正在跑的那条命令的原文（`null` = 队列空着） */
  const [running, setRunning] = useState<string | null>(null);

  /* ── ref：回调要在「下一次渲染的视角」里读到最新的东西 ───────────────── */

  /**
   * 内存里那份台账
   * @description 与 `ledger` **同一个写入口**（{@link holdLedger}），因为探活要能探**任意** id
   * （点侧边栏只探当前那个，但 `reprobe` 本身是按 id 找记录的），而「ref 与 state 什么时候一致」
   * 一旦成为一条要靠时序推理的隐含约定，那个时序错的表现就是「点了没反应」。
   */
  const ledgerRef = useRef<Ledger | null>(null);
  /**
   * 每个 id 的探活序号：{@link reprobe} 每调一次 +1，回来时**序号仍匹配**的那次才写回
   * @description ⚠️ 这道守卫替代不了 `useEffect` 清理函数里的 `alive` 标志 —— 后者只在 **effect 重跑**
   * 时翻转，而 {@link reprobe} 是普通回调（按键与副作用都调它，**没有清理时机**）。不换守卫的后果
   * 是「切得快一点」时旧结果盖掉新结果，而屏幕上**看不出任何异常**（三处仍然自洽，
   * 只是那个自洽的结论是过期的）。
   */
  const probeSeq = useRef(new Map<string, number>());
  /** 排队中还没跑的命令（**只进不出**，故不需要 state） */
  const queueRef = useRef<Job[]>([]);
  /** 此刻是不是正在跑一条（`true` 时 {@link pump} 拒绝启动下一条） */
  const busyRef = useRef(false);
  /** {@link pump} 自己（串行化要它回调自己，而 `useCallback` 的空依赖版本看不到自己） */
  const pumpRef = useRef<() => void>(() => {});
  /** 视口（结果区内容宽度与视口行数）；异步回调里要用**当下**的那一份 */
  const viewportRef = useRef({ width: 0, rows: 0 });

  /* ── 台账 ────────────────────────────────────────────────────────────── */

  /**
   * 内存里那份台账的**唯一**写入口（`state` 与 {@link ledgerRef} 在这里一起落）
   * @description ⚠️ 写路径只有一处，故两处不可能只写一半。
   */
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
      // 而里面存的是控制面管理员凭据（`@/ledger/store.ts` 文件头的完整推导）。
      // ⚠️ 也**不清掉**上一份好的：它是操作者此刻唯一还能看见的那份端点清单。
      setLedgerError(err instanceof LedgerError ? err : new LedgerError("unreadable", "台账读不出来"));
    }
  }, [ledgerFile, ledgerTick, holdLedger]);

  const targets: readonly Target[] = useMemo(() => ledger?.targets ?? [], [ledger]);
  const current = useMemo(() => (ledger === null ? null : selectedTarget(ledger)), [ledger]);
  /**
   * 当前桶的键
   * @description ⚠️ 用 **`id`** 而不是显示名：`id` 是台账内的引用键且**唯一**，而两个目标**可以同名**
   * （`@/ledger/edit.ts:idFor` 对撞名加 `-2`，而 `name` 保持不变）。用名字当键会让两个同名目标
   * 共享一个输出桶，于是「点第二个」看到的是第一个的输出。
   */
  const bucketKey = current?.id ?? NO_TARGET_BUCKET;

  /* ── 输出桶 ──────────────────────────────────────────────────────────── */

  /** 取一个桶（**没有就现造一个**，但**不**写进 state —— 读路径不许有副作用） */
  const bucketOf = useCallback(
    (key: string): Bucket => buckets.get(key) ?? { entries: [], top: 0, follow: true },
    [buckets],
  );

  /**
   * 往一个桶追加若干行
   * @description 追加之后**重算 `top`**：贴底时跳到最底下，不贴底时保持原位并夹一次。
   * ⚠️ 环形缓冲丢掉了前面的条目时行号会整体前移，而「不贴底」的那个人下一次滚动就会看到
   * 稍微不同的内容 —— 那是环形缓冲的**固有**代价，写在这里是为了让下一个想「修」它的人知道
   * 这不是 bug 而是一条权衡。
   */
  const push = useCallback(
    (key: string, rows: readonly LogRow[], at: number): void => {
      if (rows.length === 0) return;
      const viewport = viewportRef.current;
      setBuckets((prev) => {
        const before = prev.get(key) ?? emptyBucket();
        const entries = trim(append(before.entries, rows, at), LOG_KEEP);
        const height = flatten(entries, viewport.width).height;
        const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
        const top = before.follow ? bottom : clampTop(height, viewport.rows, before.top);
        return new Map(prev).set(key, { entries, top, follow: before.follow });
      });
    },
    [],
  );

  /**
   * 一条命令的结果之外的那句话（瞬时消息）
   * @description ⚠️ 它**同时**进 {@link NO_TARGET_BUCKET} 那个桶：中间那一行会自己消失
   * （{@link MESSAGE_TTL_MS}），而「刚才那次切换没存进台账」这种事实不该跟着 TTL 一起消失。
   * ⚠️ 落在**那个**桶而不是当前目标的桶：它说的是**台账**的事，而台账是全局的 ——
   * 把它塞进「当前选中那个目标」的输出里，操作者切走再切回来就看不到了。
   */
  const say = useCallback(
    (text: string): void => {
      setMessage(text);
      push(NO_TARGET_BUCKET, [{ kind: "note", text }], Date.now());
    },
    [push],
  );

  // ⚠️ 瞬时消息自己会消失，且**计时器跟着消息走**（依赖是 `message` 本身）：
  // 依赖写成 `[message !== null]` 会让「换一条消息」不重启计时器，于是第二条只显示第一段剩余时间。
  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_TTL_MS);
    return () => clearTimeout(timer);
  }, [message]);

  /** 滚一段（`delta` 为正是往下） */
  const scrollBy = useCallback(
    (delta: number): void => {
      const viewport = viewportRef.current;
      setBuckets((prev) => {
        const before = prev.get(bucketKey) ?? emptyBucket();
        const height = flatten(before.entries, viewport.width).height;
        const top = clampTop(height, viewport.rows, before.top + delta);
        const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
        // ⚠️ 滚回最底下时**重新贴底**：否则新输出在「我明明已经看到最新了」的屏幕上静默地不出现。
        return new Map(prev).set(bucketKey, { ...before, top, follow: top >= bottom });
      });
    },
    [bucketKey],
  );

  /** 直接定位到顶 / 底 */
  const scrollTo = useCallback(
    (where: "top" | "bottom"): void => {
      const viewport = viewportRef.current;
      setBuckets((prev) => {
        const before = prev.get(bucketKey) ?? emptyBucket();
        const height = flatten(before.entries, viewport.width).height;
        const top =
          where === "top" ? 0 : clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
        return new Map(prev).set(bucketKey, { ...before, top, follow: where === "bottom" });
      });
    },
    [bucketKey],
  );

  /* ── 探活（全包唯一的一次）───────────────────────────────────────────── */

  /**
   * 探**任意一个**目标一次
   * @description 两个触发点、一个实现：挂载与切目标（那个 effect）与 `r` 命令。⚠️ 依赖数组里
   * **不许**出现本函数：它读的是 {@link ledgerRef}（身份恒定），而若它随台账重读换身份，挂进依赖
   * 就等于「每次动作多打一次 `GET /api/status`」——请求放大器。
   *
   * ⚠️ **在飞要写进去**：发请求**之前**先把这个 id 那一格换成 `{ pending: true }`，于是侧边栏读作
   * 「连接中」，而「还没探过」的 `undefined` 那一格读作「未知」—— 操作者据此分得出「还没开始」
   * 与「卡住了」。⚠️ 它与结果**同容器**（{@link probes} 那一个 map），所以覆盖掉上一次那个
   * **真实**结果是刻意的：本次探活必然在 `timeoutMs` 内回来，落地后立刻换成一个有事实依据的结论。
   */
  const reprobe = useCallback((id: string): void => {
    // ⚠️ 认的是**这一份**台账：侧边栏的字形与探活结果必须指向同一条记录
    const target = ledgerRef.current?.targets.find((one) => one.id === id);
    if (target === undefined) return;
    const seq = (probeSeq.current.get(id) ?? 0) + 1;
    probeSeq.current.set(id, seq);
    const fresh = (): boolean => probeSeq.current.get(id) === seq;
    // ⚠️ 「在飞」**先**落地，于是它在屏上可见；这是「在飞」在全包**唯一**的来源
    setProbes((prev) => new Map(prev).set(id, { pending: true }));
    // ⚠️ **不靠 `AbortController`**：探活在渲染之外，abort 传不进去；作废只能落在调用点上
    void probeTarget(clientFor(target))
      .then((result) => {
        if (!fresh()) return;
        setProbes((prev) => new Map(prev).set(id, result));
      })
      // `probeTarget` 只对 `TuiError` 兜底；能到这里的是本包自己有 bug。
      // ⚠️ **什么也不写**：`ProbeResult` 表达不了「本包有 bug」，编一个 `TuiError` 会在界面上造出
      // 一条从未发生的失败（对面可能明明连着）。⚠️ 但也不能把 `{ pending: true }` 留在那儿：那是
      // 一句永远兑现不了的话，而屏上此刻**没有任何事实** —— 故这一格**整格删掉**，回到「还没探过」。
      .catch(() => {
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
    // ⚠️ 依赖只有这两项：挂载与切目标。按 `r` 那一次**不走这里**（它直接调 `reprobe`），
    // 故不需要第三个计数 —— 有了它就多一条「靠改状态让 effect 重跑」的暗道，而那条暗道迟早会长出
    // 「按 r 探的是不是当前那个目标」这种说不清的分支。
  }, [current?.id, reprobe]);

  /* ── 切目标 ──────────────────────────────────────────────────────────── */

  /**
   * 切到某一个目标（**现读现写**）
   * @description 「下次打开重连到同一个」的实现就在这里：`selected` 变了必须落盘，否则它只活在
   * 内存里。⚠️ **现读**（`readLedger` 每次现读）是因为 {@link push} 之后内存里那份可能比磁盘旧，
   * 而 `readLedger` / `writeLedger` 都是同步的，读-改-写之间没有 `await`，故不存在被别人插进来的窗口。
   * ⚠️ **写失败不回滚**：回滚会让「刚才那次切换」看起来没发生，而它确实发生了、只是没存下来。
   */
  const switchTo = useCallback(
    (id: string): void => {
      let next: Ledger;
      try {
        const fresh = readLedger(ledgerFile);
        next = setSelected(fresh, id);
      } catch (err) {
        say(`切目标失败：${describe(err)}`);
        return;
      }
      let failure: string | null = null;
      try {
        writeLedger(ledgerFile, next);
      } catch (err) {
        failure = describe(err);
      }
      holdLedger(next);
      if (failure !== null) {
        say(`这次切换没存进台账（${failure}）—— 界面上已经切过去了，关掉就没了`);
      }
    },
    [ledgerFile, holdLedger, say],
  );

  /** 下一个 / 上一个目标（`Ctrl+N` / `Ctrl+P`；**没有就什么都不做**） */
  const stepTarget = useCallback(
    (step: 1 | -1): void => {
      if (targets.length < 2) {
        // 只有一个：说清为什么不动，而不是让人以为按键没生效；一个都没有：屏上正在写着「还没有控制面」
        if (targets.length === 1) say("台账里只有 1 个控制面，没有下一个");
        return;
      }
      const at = current === null ? -1 : targets.findIndex((one) => one.id === current.id);
      const to = (Math.max(0, at) + step + targets.length) % targets.length;
      const picked = targets[to];
      if (picked === undefined) return;
      switchTo(picked.id);
    },
    [targets, current, switchTo, say],
  );

  /* ── 执行 ────────────────────────────────────────────────────────────── */

  /** 执行层要用的依赖（**现造**，故它读到的是调用那一刻的最新状态） */
  const depsFor = useCallback(
    (job: Job): ExecDeps => ({
      client: current === null ? null : clientFor(current),
      width: viewportRef.current.width,
      line: job.line,
      // ⚠️ **台账的写一律经这三个回调**：内存里那份是本层的状态，直接 `writeLedger` 会造出
      // 「内存与磁盘漂移」（`@/console/exec.ts` 文件头那条不变量）。
      // ⚠️ **现读现写**：每一次写都重新 `readLedger`，而 `readLedger` / `writeLedger` 都是同步的，
      // 读-改-写之间没有 `await`，故不存在「被别人插进来的窗口」。少了「现读」这一步，
      // 刚在界面上加的那个目标会被内存里那份旧副本覆盖掉。
      onTargetAdd: (request): void => {
        // ⚠️ 缺省超时在这里补，且**只**在这里补：`@/console/exec.ts` 刻意不补（补了就成了
        // 第二处默认值），而 `@/ledger` 的 `TargetInput.timeoutMs` 是**必填**的 `number`
        // （`null` 不是一个能落盘的形状）。真值只有 `@/ledger:DEFAULT_TIMEOUT_MS` 一处。
        const next = upsertTarget(readLedger(ledgerFile), {
          name: request.name,
          baseUrl: request.baseUrl,
          token: request.token,
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
        switchTo(idOfName(ledgerRef.current, name));
      },
    }),
    [current, ledgerFile, holdLedger, switchTo],
  );

  /**
   * 一条命令的**副作用**
   * @description ⚠️ **穷举**而不是「取第一条」：多一个 `Effect` 种类时这一支会编译期红，
   * 而漏掉一个种类的后果是「服务端已经改了、界面没跟上」。
   */
  const applyEffect = useCallback(
    (key: string, effect: Effect): void => {
      switch (effect.kind) {
        case "clear-log":
          setBuckets((prev) => new Map(prev).set(key, emptyBucket()));
          break;
        case "reprobe":
          if (current !== null) reprobe(current.id);
          break;
        case "ledger-changed":
          setLedgerTick((tick) => tick + 1);
          break;
        case "target-switched":
          // ⚠️ **刻意什么都不做**：`onTargetSwitch` 那一刻已经把内存里那份换掉并落盘了
          // （「下次打开重连到同一个」就在那一步）。这个副作用是为了让执行层**说**出
          // 「当前目标换了」，而本层的读取端已经从 `current` 读到了。
          break;
        default:
          throw new Error(`应用层不认识这个副作用：${JSON.stringify(effect)}`);
      }
    },
    [current, reprobe],
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
        push(job.bucket, result.rows, Date.now());
        for (const effect of result.effects) applyEffect(job.bucket, effect);
      })
      // ⚠️ 不让 rejection 冒出去：`exec` 自己已经把每一种失败收敛成一行，而漏到这里的
      // 只有「本层自己的 bug」—— 那时让它把进程带走比静默继续好，但**必须**先让下一条跑起来，
      // 否则队列就死了（界面停在「执行中」而永远不恢复）。
      .catch(() => {
        push(job.bucket, [{ kind: "err", text: "本包在执行这条命令时崩了（不是控制面的回答）" }], Date.now());
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
   * ## ⚠️ 本函数**不回显**，回显是 {@link exec} 那**一个**来源（`echoOf`，凭据已掩码）
   * @description
   * 曾经这里是第二个回显点，而它 echo 的是**用户敲的原文** —— 于是
   * `/target add live http://x T0KEN` 在结果区里留下了一行**明文 token**，且与 `exec`
   * 那一行掩码版**并存**（每条命令显示两遍）。⚠️ 凭据在输入行里**不可避免**（用户正在敲它），
   * 而它在桶里是**永久**的：桶会落进终端回滚缓冲，而输入行只活到下一次编辑。
   * 故回显只留一个出口，而那一个必须认识「哪几位是凭据」（判据在 `@/console/exec.ts:echoOf`）。
   *
   * ## ⚠️ **解析失败也清输入行**（面板随之关，判据看得见）
   * @description
   * 不回显（回显原文就是把凭据抄进可滚动的结果区，与 `@/cmd/parse.ts` 文件头那条
   * 「失败分支一个字的用户输入都不许进去」同源），也不留行 —— **留着的那一帧里命令面板正盖在
   * 结果区上面**，于是操作者刚敲出来的那句判据一个字都看不见，而重敲整条命令（含一个 token）
   * 是这个工具能造成的最贵的手滑。
   * ⚠️ 而「敲错了怎么重来」由**命令面板**回答：清掉之后再敲一个 `/`，19 行命令就在那儿，
   * `↓`/`↑` 走、`Tab` 接受 —— 比重敲一遍整行更短。
   */
  const submit = useCallback(
    (raw: string): void => {
      const line = raw.trim();
      // ⚠️ 三档都清输入行，且**在**任何 `push` 之前：否则那一帧输入行还在、面板还开着，
      // 而下面刚贴上去的判据被面板整个盖住。
      setInput("");
      setCursor(0);
      if (line === "") return;
      const parsed = parseLine(line);
      if (parsed.kind === "empty") return;
      if (parsed.kind === "ok") {
        queueRef.current.push({ bucket: bucketKey, line, command: parsed.command });
        pumpRef.current();
        return;
      }
      push(bucketKey, rowsOfFailure(parsed), Date.now());
    },
    [bucketKey, push],
  );

  /* ── 台账的两个本地命令（`ExecDeps` 那三个回调之外，本层自己用得着的）── */

  /** 当前的 `id` 序列（供补全取名字用；⚠️ 名字可以重复，见 {@link bucketKey} 那条注释） */
  const targetNames = useMemo(() => targets.map((one) => one.name), [targets]);

  /* ── 命令面板 ──────────────────────────────────────────────────────────── */

  /**
   * 面板此刻的样子（**高亮是输入行的纯函数**，界面上没有「高亮在第几行」这个状态）
   * @description ⚠️ 所以 `↑`/`↓` 走完之后必须**把那一行写进输入行** —— 下一帧的高亮由那行字
   * 自己算出来，于是「输入行上敲的是 A、面板高亮的是 B」这件事在**类型上**不可能发生。
   * 少做「写进行内」那一步的后果不是高亮错，而是**回车跑的不是你以为的那一条**。
   */
  const palette = useMemo(() => paletteOf(input), [input]);

  /**
   * `↑`/`↓`（以及滚轮、鼠标点行）在面板上走一步，并**把落点写进输入行**
   * @description ⚠️ 面板没开时 `steps` 返回 `-1`，而 `rows[-1]` 是 `undefined` ⇒ 这一支直接
   * 返回，于是调用点不必再判「面板开着吗」—— 同一个判据只写在**一处**。
   * ⚠️ 高亮**不动**时（已经到头）也直接返回：那一帧若仍然重写输入行，`paletteFill` 会把
   * 光标往后挪一格（多段命令名那条带空格），于是「按 `↓` 没反应」变成「光标自己跑了」。
   */
  const movePalette = useCallback(
    (step: 1 | -1): void => {
      const to = paletteStep(palette.at, step, palette.rows.length);
      const row = palette.rows[to];
      if (row === undefined || to === palette.at) return;
      const filled = paletteFill(input, cursor, row);
      setInput(filled.line);
      setCursor(filled.cursor);
    },
    [palette, input, cursor],
  );

  /**
   * `Tab` / 鼠标点行要接受的那一行补进输入行（`null` = 「这一刻没有可接受的那一行」）
   * @description ⚠️ **没有高亮就是 `null`**（`at === -1`，敲的东西表里没有）：那时按 Tab 什么也不
   * 做，而不是悄悄接受第一行 —— 悄悄接受会让 `/zzz` + Tab 变成一条他没敲过的命令。
   */
  const acceptPalette = useCallback((): { line: string; cursor: number } | null => {
    const row = palette.rows[palette.at];
    return row === undefined ? null : paletteFill(input, cursor, row);
  }, [palette, input, cursor]);

  /* ── 键位 ────────────────────────────────────────────────────────────── */

  useInput((pressed, key) => {
    // ⚠️ **第一道闸，也是唯一能挡住鼠标报告的那一道**：Ink 的 `useInput` 会把**未解析**的转义序列
    // 原样交给本回调，而它**顺手砍掉了那个 ESC**（`ink/build/hooks/use-input.js` 里
    // `if (input.startsWith("\u001B")) input = input.slice(1)`），于是鼠标报告到这里已经是
    // `[<35;64;32M` —— **一串全是可打印字符的协议报文**。
    // ⚠️ 它必须在**最前面**：`?1003h` 开着时每帧都可能有报告，而它们一个 `key.*` 标志都不带，
    // 落到最后一档就会被 `printableOnly` 原样放行（那个函数的 C0 判据在这里**已经失效** ——
    // 唯一的 C0 字节 ESC 在进门之前就被 Ink 拿掉了）。
    // 判据本身在 `@/ui/mouse.ts`（`isMouseReport`），与 `parseSgr` **同一个扫描器**，不是第二份形状。
    // 丢掉是**静默**的：同一份字节已经由 `createMouseSource` 交给鼠标分派了，
    // 而「你动了一下鼠标」不是一次需要解释的输入。
    if (isMouseReport(pressed)) return;
    // ⚠️ `Ctrl+C` **到不了这里**：Ink 的 `App` 组件在把输入交给监听器**之前**就自己处理了它
    // （`ink/build/components/App.js:handleInput` 里 `return` 掉了），所以本组件不必也不该重复实现。
    if (key.ctrl || key.meta) {
      const lower = pressed.toLowerCase();
      if (lower === "n") {
        stepTarget(1);
        return;
      }
      if (lower === "p") {
        stepTarget(-1);
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
      // ⚠️ 其余 Ctrl 组合**什么都不做**：让它们什么也不发生，比让它们变成一条没写进键位表的命令诚实。
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
    if (key.upArrow) {
      if (palette.open) {
        movePalette(-1);
        return;
      }
      stepTarget(-1);
      return;
    }
    if (key.downArrow) {
      if (palette.open) {
        movePalette(1);
        return;
      }
      stepTarget(1);
      return;
    }
    if (key.leftArrow) {
      setCursor((at) => caretLeft(input, at));
      return;
    }
    if (key.rightArrow) {
      setCursor((at) => caretRight(input, at));
      return;
    }
    if (key.home) {
      setCursor(0);
      return;
    }
    if (key.end) {
      setCursor(input.length);
      return;
    }
    if (key.backspace || key.delete) {
      // ⚠️ 一次性改两个状态：分开写会产生一帧「串变了、光标还在老位置」的中间态，
      // 而那一帧里再按一次退格就落在错的地方（Ink 是逐帧 diff 的，中间态**看得见**）。
      setInput((before) => {
        const after = key.delete ? deleteAt(before, cursor) : deleteBefore(before, cursor);
        setCursor(after.cursor);
        return after.text;
      });
      return;
    }
    if (key.tab) {
      // ⚠️ **面板开着时 Tab 补的是高亮那一行**，而不是 `@/cmd:complete` 挑的「字典序第一个」：
      // 两条规则给同一次按键两个答案时，「Tab 填进去的」与「面板高亮的」会差一行，
      // 而那正是这块面板要回答的问题。
      const accept = acceptPalette();
      if (accept !== null) {
        setInput(accept.line);
        setCursor(accept.cursor);
        return;
      }
      const suggestion = complete({ line: input, cursor, targetNames });
      if (suggestion.candidates.length === 0) return;
      setInput(suggestion.line);
      setCursor(suggestion.cursor);
      return;
    }
    if (key.return || key.escape) {
      if (key.escape) {
        setInput("");
        setCursor(0);
        return;
      }
      // ⚠️ **Enter 不接受面板的高亮**：它提交的是输入行**逐字**。
      // 「我敲的就是我要的」这条不变式比「三个键跑一条命令」值钱 —— 而高亮为什么没被接受，
      // 面板那一行的反底色已经说清楚了（高亮与输入行不一致时看得见）。
      submit(input);
      return;
    }
    // ⚠️ 最后一档：**可打印的文本**。控制字符在这里被剔掉（见 {@link printableOnly}），
    // 所以粘贴进来的 `U+000D` 不会变成 token 里的一个字节。
    const typed = printableOnly(pressed);
    if (typed === "") return;
    setInput((before) => {
      const after = insertAt(before, cursor, typed);
      setCursor(after.cursor);
      return after.text;
    });
  });

  /* ── 鼠标 ────────────────────────────────────────────────────────────── */

  const items = useMemo(
    () =>
      targets.map((target) => ({
        name: target.name,
        // ⚠️ 与探活那**一份**结果走**同一个**换算（`@/ui/theme.ts:connectionStateOf`）：
        // 侧边栏是它唯一的读者，而「同一个目标在两处说两个词」是本包真的发生过一次的退化。
        state: connectionStateOf(probes.get(target.id)),
      })),
    [targets, probes],
  );

  /**
   * 几何（**本层与 {@link Layout} 调的是同一个纯函数、喂的是同一组参数**，故两份结果逐字相同）
   * @description 命中测试要用 `sidebarRows` 与 `inputText`，而它们是布局的判据 —— 在这里重算一遍
   * 就是「两份判据」，而两份会漂（症状是「点 A 行切到 B 机」）。
   */
  const g = useMemo(
    () => geometry(columns, rows, items.length, palette.rows.length),
    [columns, rows, items.length, palette.rows.length],
  );

  /**
   * 面板滚动窗口的第一行号（**绘制与命中测试共用它**）
   * @description ⚠️ 屏上第 `pick` 行是 `palette.rows[windowStart + pick]` —— 命中测试回查候选时
   * **必须**经过同一个 `windowStart`，否则「点第 2 行」会填出第 3 条命令，而那两行在屏上长得一样。
   * 视口几行由几何层给（{@link Geometry.paletteViewportRows}），故它与「画几行」是同一份数。
   */
  const windowStart = paletteWindow(palette.at, g.paletteViewportRows, palette.rows.length);

  useEffect(() => {
    viewportRef.current = { width: g.outputWidth, rows: g.outputRows };
  }, [g.outputWidth, g.outputRows]);

  useEffect(() => {
    return mouse.onMouse((event: MouseEvent) => {
      switch (event.action) {
        case "wheelUp":
          // ⚠️ 面板开着时滚轮**走面板**（移动高亮那一行），面板关着时才滚结果区：
          // 与 `↑`/`↓` 同一个判据、同一份实现，于是「滚轮和方向键为什么不一样」不存在。
          if (palette.open) movePalette(-1);
          else scrollBy(-SCROLL_STEP);
          return;
        case "wheelDown":
          if (palette.open) movePalette(1);
          else scrollBy(SCROLL_STEP);
          return;
        case "down": {
          // ⚠️ **只认左键**：中键与右键各有各的含义（粘贴 / 菜单），而本工具没有那两种操作，
          // 把它们当成「切目标」会让一次右键粘贴的附带操作变成一次切换。
          if (event.button !== "left") return;
          const row = hitTest(event.x, event.y, g.sidebarRows);
          if (row >= 0) {
            const picked = targets[row];
            // ⚠️ 点的**就是当前那个**时什么都不做：那一次点击不该产生任何后果，
            // 而「重新探一次活」是一次真实的网络往返。
            if (picked !== undefined && picked.id !== current?.id) switchTo(picked.id);
            return;
          }
          // ⚠️ 面板的候选行**在侧边栏右侧**（几何层算的，与画的逐字同源）：点中哪一行就把它补进
          // 输入行，**不执行** —— 点一下是「我挑这一条」，跑不跑由回车决定。
          const pick = hitTest(event.x, event.y, g.paletteRows);
          if (pick >= 0 && palette.open) {
            const chosen = palette.rows[windowStart + pick];
            if (chosen !== undefined) {
              const filled = paletteFill(input, cursor, chosen);
              setInput(filled.line);
              setCursor(filled.cursor);
            }
            return;
          }
          if (g.inputText !== null && hitTest(event.x, event.y, [g.inputText]) >= 0) {
            setCursor(caretFromColumn(event.x, g.inputText, input));
            return;
          }
          // ⚠️ 点结果区**什么都不做**：不选中、不跳转。一个「点了会做点什么」的结果区需要用户
          // 先理解一份交互契约，而那不是本工具的职责。
          return;
        }
        default:
          // move / drag / up / wheelLeft / wheelRight：鼠标的**拖动选择**必须留给终端，
          // 所以本工具一个都不接（接了就会破坏操作者的拖选与粘贴选择）。
          return;
      }
    });
  }, [
    mouse,
    g.sidebarRows,
    g.paletteRows,
    g.inputText,
    targets,
    current,
    switchTo,
    scrollBy,
    movePalette,
    palette,
    windowStart,
    input,
    cursor,
  ]);

  /* ── 呈现 ────────────────────────────────────────────────────────────── */

  const bucket = bucketOf(bucketKey);
  const flat: FlatLog = useMemo(
    () => flatten(bucket.entries, g.outputWidth),
    [bucket.entries, g.outputWidth],
  );
  // ⚠️ **读的时候再夹一次**：改窗口高度会让 `top` 越界，而一个越界的 `top` 让
  // `visibleLines` 返回空数组 —— 界面上是「结果区空了」，而下面其实有内容。
  const top = clampTop(flat.height, g.outputRows, bucket.top);

  const suggestion = complete({ line: input, cursor, targetNames });
  // ⚠️ 幽灵文本 = **「按 Tab 会插进来什么」**，两条来源合成**一个**出口：
  // 面板开着时是面板那一行（`Tab` 走的也是同一个 `acceptPalette`），否则是形参值的候选。
  // ⚠️ 分成两处各算一次的话，幽灵与 Tab 会给出两个答案 —— 而它们本来是同一个动作。
  const fillable = palette.open ? acceptPalette() : null;
  const ghost =
    fillable !== null && fillable.cursor > cursor
      ? fillable.line.slice(cursor, fillable.cursor)
      : suggestion.cursor > cursor && suggestion.candidates.length > 0
        ? suggestion.line.slice(cursor)
        : null;

  /**
   * 输入区中间那一行：**两档，优先级从上到下**
   * @description ⚠️ 「补全候选」那一档**被删掉了**，而它曾经是「有哪些命令能敲」的答案 ——
   * 现在那块答案是**命令面板**（按 `/` 就浮出来）。⚠️ 留着它就是同一件事在一屏里出现两次：
   * 一处列的是**全部**命令（面板），一处列的是**光标位置的候选**（那一行），而 `/` 时两者
   * 内容重叠、长度不同，操作者会去比它们 —— 而它们的排序规则本来就不同（见
   * `@/cmd/complete.ts` 与 `@/cmd/palette.ts` 各自那一条）。
   * 剩下两档的顺序仍有理由，每一档都比下一档更「此刻」：
   * 1. **执行中** —— 有命令在跑，而它几秒后就结束；
   * 2. **一条瞬时消息** —— 刚刚发生了什么；
   * 3. **台账读不出来** —— ⚠️ **最低**不是因为它不重要，而是它**不消失**：一个会自己消失的
   *    提示才能让上面两档轮流出现，而「台账读不出来」必须一直在（它是**持续**状态）。
   *    反过来把它排在最前的话，一次切换就会把它顶掉 8 秒 —— 而那 8 秒里操作者会以为台账好着呢。
   */
  const notice =
    running !== null
      ? `执行中：${running}`
      : message ?? (ledgerError === null ? null : `台账读不出来：${ledgerError.message}`);

  /**
   * 命令面板（`null` = 没开）
   * @description ⚠️ `rows` 给的是**行号序**（已经滚过窗），而 `at` 也换算成**行号** ——
   * 呈现层因此完全不需要知道「首行号是多少」，而那正是「画的」与「点的」会漂的那一位。
   * ⚠️ `total` 与 `rows.length` **不是一回事**：前者喂给几何层（它要靠它决定留不留「装不下」
   * 那一行），后者是这一屏真的画了几行。
   */
  const paletteView: PaletteView | null = palette.open
    ? {
        total: palette.rows.length,
        rows: palette.rows
          .slice(windowStart, windowStart + g.paletteViewportRows)
          .map((row) => ({ text: row.path, summary: row.summary })),
        at: palette.at - windowStart,
        // ⚠️ **装不下必须说一声**（与侧边栏「…还有 N 个」、结果区「下面还有 N 行」同一条纪律）：
        // 静默少画几行的话，操作者会以为命令表就这十几条。
        footer:
          palette.rows.length > g.paletteViewportRows
            ? `第 ${String(windowStart + 1)}–${String(
                windowStart + Math.min(g.paletteViewportRows, palette.rows.length - windowStart),
              )} 条 · 共 ${String(palette.rows.length)} 条 · ↑↓ 选 · Tab 接受`
            : null,
      }
    : null;

  return (
    <Layout
      columns={columns}
      rows={rows}
      color={color}
      version={version}
      items={items}
      selected={current?.name ?? null}
      flat={flat}
      top={top}
      input={input}
      cursor={cursor}
      ghost={ghost}
      hint={hintOf(current, color)}
      notice={notice}
      palette={paletteView}
      mouseHint={mouseUnsupportedHintOf(mouse.liveness(), Date.now())}
      // ⚠️ logo 只在「没选中目标**且**这个桶还什么都没有」时占位：台账为空时唯一能敲的两条命令
      // （`/target add` 与 `/help`）的输出正落在那个桶里，见文件头那一节。
      showLogo={current === null && !flat.any}
      droppedHint={droppedHint(bucket)}
    />
  );
}

/* ── 解析失败的若干行（从 {@link exec} 的排版纪律里借来的形状）─────────────── */

/**
 * 解析失败 → 若干行
 * @description ⚠️ **文案里没有用户输入**：`@/cmd/parse.ts` 的纪律在这里继续生效 ——
 * 凭据敲错一个字符时，「你输入错了：x#k2」会把凭据抄进可滚动、可复制的结果区。
 */
function rowsOfFailure(failed: Exclude<ParseResult, { kind: "ok" }>): LogRow[] {
  switch (failed.kind) {
    // ⚠️ **空输入不是错误**：`parseLine` 把「全是空白」单独给一档，而本函数只在真的解析失败时被调，
    // 走到这一支说明调用点漏了那个判断 —— 返回空数组（不显示任何东西）是**最不坏**的形态，
    // 而编一句「你什么都没输」会是一次凭空捏造的失败。
    case "empty":
      return [];
    // ⚠️ `missing-prefix` 与 `unknown-command` **同一副形状**（一句判据 + 「是不是想写 …」）：
    // 两件事的修法都是「把那几行改成能跑的样子」，给它们排不同的版式只会在同一屏上让操作者
    // 以为那是两种不同严重程度的问题 —— 而命令面板（按 `/` 就出来）已经把那条修法摆在眼前了。
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

