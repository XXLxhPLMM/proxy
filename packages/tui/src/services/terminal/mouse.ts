/**
 * @fileoverview 鼠标事件源：SGR 上报的开关与序列解析（零 Ink、零 React、零 `process.*`）；⚠️ Ink 没有鼠标而本模块在同一个 stdin 上自己挂 `data`，Ink 又把同一份报告当**文本**交给 `useInput`（`[<35;64;32M` 一串可打印字符）—— 故导出 `isMouseReport` 供输入行在**入状态之前**认领掉
 */

const ESC = "\u001B";

/** SGR 鼠标报告的固定前缀：`ESC [ <`（传统 X10 鼠标没有这个 `<`，故本模块不解析 X10 形态） */
const SGR_PREFIX = `${ESC}[<`;

/**
 * 残留缓冲的**上限**（字符数；一条 SGR 报告最长十几字符，64 是数量级的富余）
 * @description 上限是为内存：一条被截断/畸形的流若一直发 `ESC[<` 后面接数字而永不发终止字母，
 * 没有上限时残留缓冲**无界增长**。
 */
const MAX_PENDING = 64;

/** 低 2 位：0 左键 / 1 中键 / 2 右键 / 3 无按键 */
const BUTTON_MASK = 0b11;
/** 滚轮位：⚠️ 滚轮是**按下形态**上报的（`b = 64/65`），不是 release 形态 */
const WHEEL_BIT = 64;
/** 拖动位：本次报告里有一个按键正被拖着 */
const DRAG_BIT = 32;
const SHIFT_BIT = 4;
const ALT_BIT = 8;
const CTRL_BIT = 16;

/** 低 2 位 → 按键（3 = 没有按键，映射成 `null` 而不是猜一个） */
const BUTTONS = ["left", "middle", "right"] as const;

/** 一次鼠标动作的类别（**滚轮自成四档**，不塞进 `down`/`up`） */
export type MouseAction =
  "down" | "up" | "drag" | "move" | "wheelUp" | "wheelDown" | "wheelLeft" | "wheelRight";

/** 按键（`null` = 这次报告里没有按键参与：滚轮 / 无按键移动 / 无按键释放） */
export type MouseButton = (typeof BUTTONS)[number];

/** 一条鼠标事件（坐标已是 0-based 的**终端屏幕**坐标，见文件头） */
export interface MouseEvent {
  readonly action: MouseAction;
  /**
   * ⚠️ 滚轮事件恒为 `null`：`b = 64`（滚轮上）的低 2 位是 `0`，照抄会说出「左键」—— 那是用假事实换掉界面。
   */
  readonly button: MouseButton | null;
  readonly x: number;
  readonly y: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

/** {@link parseSgr} 的一次调用结果 */
export interface ParsedSgr {
  /** 这次调用凑齐的鼠标事件，**按到达顺序** */
  readonly events: readonly MouseEvent[];
  /** 本次调用里**能确定不属于我们**的字节，原样透传；⚠️ 它**不**回灌 stdin（Ink 已收到同一份字节，回灌是双发） */
  readonly rest: string;
  /** 跨调用残留：下一次调用必须把它作为 `pending` 传回来 */
  readonly pending: string;
}

/** 开启鼠标上报的序列（`h` = set；1000 按下/释放 / 1003 任意移动 / 1006 SGR 扩展坐标） */
// ⚠️ **1006 必开**：传统 X10 鼠标坐标在 223 列以上会 wrap —— 少了它，点右边三列会报出一个看似合法的错误坐标。
export const MOUSE_REPORTING_ON: readonly string[] = Object.freeze([
  `${ESC}[?1000h`,
  `${ESC}[?1003h`,
  `${ESC}[?1006h`,
]);

/** 关闭鼠标上报的序列（`l` = reset；**与 {@link MOUSE_REPORTING_ON} 一一对应且顺序相反**） */
// ⚠️ 这不是洁癖：退出那一刻终端可能还在发最后几条移动报告，顺序不撤会让「坐标格式已撤、事件还在发」这个
// 中间态把一条无格式的移动当按键吃掉。⚠️ 它**无条件**写（`?1000l` 对没开过的模式是幂等的 no-op）。
export const MOUSE_REPORTING_OFF: readonly string[] = Object.freeze([
  `${ESC}[?1006l`,
  `${ESC}[?1003l`,
  `${ESC}[?1000l`,
]);

/** 一次扫描的结论（内部） */
type SgrScan =
  /** 一条完整的报告：字节**消费掉**（`event` 为 `null` 表示认得但不该产出事件，见 `scanSgr`） */
  | { readonly kind: "report"; readonly event: MouseEvent | null; readonly next: number }
  /** 半条：整段留到下次（`rest` 里不含它） */
  | { readonly kind: "hold"; readonly pending: string }
  /** 不是（或还不确定是）我们的：调用方把 `ESC` 这一个字符塞进 `rest` 继续扫 */
  | { readonly kind: "foreign" };

/** 该字符是不是 SGR 报告的参数字节（十进制数字与分隔符 `;`） */
function isParamByte(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39) || code === 0x3b;
}

/** 尾段整段留到下次；超过 {@link MAX_PENDING} 则判定为「不是我们的」（理由见那处注释） */
function holdTail(input: string, at: number): SgrScan {
  const pending = input.slice(at);
  return pending.length <= MAX_PENDING ? { kind: "hold", pending } : { kind: "foreign" };
}

/** 位域 → 动作类别（滚轮四档在**最前**：它不带终止字母语义，判据不同） */
function actionOf(button: number, release: boolean): MouseAction {
  if ((button & WHEEL_BIT) !== 0) {
    switch (button & BUTTON_MASK) {
      case 0:
        return "wheelUp";
      case 1:
        return "wheelDown";
      case 2:
        return "wheelLeft";
      default:
        return "wheelRight";
    }
  }
  if (release) return "up";
  const held = button & BUTTON_MASK;
  if ((button & DRAG_BIT) !== 0) return held === 3 ? "move" : "drag";
  return held === 3 ? "move" : "down";
}

/** 位域 + 坐标 → 一条事件 */
// ⚠️ 坐标在这一层已从 1-based 减到 0-based（减到 0-based 就与 `@/lib/geometry.js` 的矩形同一套坐标）。
function eventOf(button: number, x: number, y: number, release: boolean): MouseEvent {
  const held = button & BUTTON_MASK;
  const isWheel = (button & WHEEL_BIT) !== 0;
  return {
    action: actionOf(button, release),
    button: isWheel || held === 3 ? null : BUTTONS[held],
    x,
    y,
    shift: (button & SHIFT_BIT) !== 0,
    alt: (button & ALT_BIT) !== 0,
    ctrl: (button & CTRL_BIT) !== 0,
  };
}

/** 从 `input[at]`（必为 `ESC`）起判断这是不是一条 SGR 鼠标报告（零副作用） */
// ⚠️ 「是不是我们的」只用**结构**判（必须是 `ESC [ <` + 恰好三段十进制/分号 + 终止字母）：段数不是 3
// 判为「不是我们的」，字节原样透传 —— 判据宁可放过，不可把别人的序列吞掉。
function scanSgr(input: string, at: number): SgrScan {
  // ⚠️ 「后面没有了」先于「不是 `[`」判：一个孤零零落在 chunk 末尾的 `ESC` 可能是半条报告
  if (at + 1 >= input.length) return holdTail(input, at);
  if (input[at + 1] !== "[") return { kind: "foreign" };
  if (at + 2 >= input.length) return holdTail(input, at);
  if (!input.startsWith(SGR_PREFIX, at)) return { kind: "foreign" };
  let cursor = at + SGR_PREFIX.length;
  while (cursor < input.length && isParamByte(input[cursor])) cursor += 1;
  if (cursor === input.length) return holdTail(input, at);
  const final = input[cursor];
  if (final !== "M" && final !== "m") return { kind: "foreign" };
  const fields = input.slice(at + SGR_PREFIX.length, cursor).split(";");
  if (fields.length !== 3) return { kind: "foreign" };
  const button = Number(fields[0]);
  const column = Number(fields[1]);
  const row = Number(fields[2]);
  // ⚠️ 坐标另有一道闸：`Cx` / `Cy` 必须是**正整数**（有些终端拿不到位置时报 0）—— 这样的报告字节
  // 照常消费掉，但不产出事件。
  const event =
    column >= 1 && row >= 1 ? eventOf(button, column - 1, row - 1, final === "m") : null;
  return { kind: "report", event, next: cursor + 1 };
}

/** 解析一个 stdin chunk 里的 SGR 鼠标报告（**纯函数**，零副作用、零 I/O） */
// ⚠️ 一个 chunk 完全可能只带半条序列（慢速 SSH 上常事），故 `pending` 是**必带**的跨调用残留；返回值恒满足
// `input === rest + pending`，而本函数**不**在结尾把 `rest` 重发（`usePaste` 与 Ink 自己要用的是同一个流）。
export function parseSgr(chunk: string, pending = ""): ParsedSgr {
  const input = pending + chunk;
  const events: MouseEvent[] = [];
  let rest = "";
  let held = "";
  let index = 0;
  while (index < input.length) {
    const escapeAt = input.indexOf(ESC, index);
    if (escapeAt === -1) {
      rest += input.slice(index);
      break;
    }
    rest += input.slice(index, escapeAt);
    const scan = scanSgr(input, escapeAt);
    if (scan.kind === "hold") {
      held = scan.pending;
      break;
    }
    if (scan.kind === "report") {
      if (scan.event !== null) events.push(scan.event);
      index = scan.next;
      continue;
    }
    // 「不是我们的」：只把 ESC 这一个字符并进 rest，后面的字节按原序接着扫（逐个字符累加与整段拷贝逐字相同）
    rest += ESC;
    index = escapeAt + 1;
  }
  return { events, rest, pending: held };
}

/** `input` **整段**是不是一条（或半条）SGR 鼠标报告（内部；判据只有一个实现处 = {@link scanSgr}） */
// ⚠️ 「整段」是硬要求（**没有剩下任何不属于报告的字节**）：少了它，一段粘贴（`[<35;64;32Mx`）会被当成
// 报告吞掉，而那是操作者自己敲的字。⚠️ 长度必须**超过** {@link SGR_PREFIX} 本身 —— `[` 是用户随时可能敲出来
// 的字符，把「只有前缀」也算成报告，输入行里就再也打不出 `[` 了。
function isWholeSgr(input: string): boolean {
  if (!input.startsWith(SGR_PREFIX) || input.length === SGR_PREFIX.length) return false;
  const scan = scanSgr(input, 0);
  if (scan.kind === "foreign") return false;
  return scan.kind === "hold" || scan.next === input.length;
}

/** Ink 交给 `useInput` 的这一串是不是一条鼠标报告（是则原样丢掉）；⚠️ ESC 被砍掉后它与 `[abc` 再也分不开 */
export function isMouseReport(text: string): boolean {
  if (text === "") return false;
  return isWholeSgr(text) || isWholeSgr(`${ESC}${text}`);
}

/** 「鼠标到底能不能用」的三个事实（**全部由实测得出**，没有一个来自环境变量或平台） */
export interface MouseLiveness {
  /** 上报是否已开启（本模块已写出 {@link MOUSE_REPORTING_ON}） */
  readonly reporting: boolean;
  /** 开启后是否收到过**任何**一条鼠标报告 */
  readonly seenAny: boolean;
  /** 最近一条报告的时刻（`now()` 的口径）；从未收到过为 `null` */
  readonly lastEventAt: number | null;
}

/**
 * 探活结论四档
 * @description `unknown` = 还没开上报（没开就没资格下结论，**不许**显示任何关于鼠标的提示）；`reported`
 * = 最近 {@link MOUSE_QUIET_MS} 毫秒内收到过报告；`idle` = 收到过但最近没有（用户没动鼠标或被别的 TUI
 * 抢了，**不知道**，不提示）；`silent` = 开着上报且**从未**收到过 —— 唯一能说「似乎不支持」的档。
 */
export type MouseSupport = "unknown" | "reported" | "idle" | "silent";

/**
 * 「最近收到过」的窗口（毫秒）
 * @description 量的是「操作者还在用鼠标吗」，不是「终端还活着吗」—— 后者要靠别的信号。
 */
export const MOUSE_QUIET_MS = 2000;

/** 「本终端似乎不支持鼠标」那一档的提示文案（⚠️ 后半段「全部键位仍可用」**不许**被删） */
export const MOUSE_UNSUPPORTED_HINT = "本终端似乎不支持鼠标；全部键位仍可用";

/** 探活事实 → 结论档（**纯函数**；`now` 与 `quietMs` 都是入参） */
// ⚠️ **绝不**查环境变量或平台去猜「鼠标能不能用」（猜错时同样是零信号）；⚠️ **绝不许**因为「没收到鼠标
// 事件」就禁用键位 —— 一句提示不是能力降级。
export function mouseSupportOf(
  liveness: MouseLiveness,
  now: number,
  quietMs: number = MOUSE_QUIET_MS,
): MouseSupport {
  if (!liveness.reporting) return "unknown";
  const lastEventAt = liveness.lastEventAt;
  if (lastEventAt === null) return "silent";
  return now - lastEventAt < quietMs ? "reported" : "idle";
}

/** 该不该说「本终端似乎不支持鼠标」（⚠️ 返回 `null` **只意味着不说这句话**，不意味着任何能力被关掉） */
export function mouseUnsupportedHintOf(
  liveness: MouseLiveness,
  now: number,
  quietMs?: number,
): string | null {
  return mouseSupportOf(liveness, now, quietMs) === "silent" ? MOUSE_UNSUPPORTED_HINT : null;
}

/** 一个能写字符串的终端输出（`NodeJS.WriteStream` 结构上满足它） */
export interface TerminalOut {
  write(chunk: string): unknown;
}

/** 本模块需要的 stdin 面（只有 `on` / `off`；`NodeJS.ReadStream` 结构上满足它） */
export interface MouseStdin {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

/** 开启鼠标上报（薄壳：真发字节的那一半） */
export function enableMouseReporting(out: TerminalOut): void {
  out.write(MOUSE_REPORTING_ON.join(""));
}

/** 关闭鼠标上报（薄壳；漏掉它的代价见文件头「关闭必须无条件执行」） */
export function disableMouseReporting(out: TerminalOut): void {
  out.write(MOUSE_REPORTING_OFF.join(""));
}

export interface MouseSourceOptions {
  readonly stdin: MouseStdin;
  readonly out: TerminalOut;
  /** 时刻来源（缺省 `Date.now`）；只服务于「最近 N 毫秒」那个探活窗口，判据自身仍是纯函数 */
  readonly now?: () => number;
}

/** 一个挂好了的鼠标事件源（`start` / `stop` 各自幂等） */
export interface MouseSource {
  /** 挂 `data` 监听 + 开启上报；重复调用是 no-op */
  start(): void;
  /** 摘监听 + 关闭上报；重复调用是 no-op（幂等守卫见 `attached`） */
  stop(): void;
  /** 订阅；返回退订函数。⚠️ 不补发历史事件（补发会让一次「点了一下」在挂上订阅者后重放一遍） */
  onMouse(handler: (event: MouseEvent) => void): () => void;
  /** 探活快照（三个事实，全部由实测得出） */
  liveness(): MouseLiveness;
}

/** 造一个鼠标事件源（薄壳：挂监听 + 开关上报 + 记探活）；⚠️ **回调里的异常不上报也不吞**（沿 `emit` 冒出去） */
export function createMouseSource(options: MouseSourceOptions): MouseSource {
  const { stdin, out } = options;
  const now = options.now ?? Date.now;
  const handlers = new Set<(event: MouseEvent) => void>();
  let pending = "";
  let attached = false;
  let reporting = false;
  let seenAny = false;
  let lastEventAt: number | null = null;

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parsed = parseSgr(text, pending);
    pending = parsed.pending;
    // `parsed.rest` 不回灌（见 ParsedSgr.rest）
    if (parsed.events.length === 0) return;
    seenAny = true;
    lastEventAt = now();
    for (const event of parsed.events) {
      // 复制一份再遍历：回调里退订 / 新订阅不许改到正在遍历的那一份
      for (const handler of [...handlers]) handler(event);
    }
  };

  return {
    start(): void {
      if (attached) return;
      stdin.on("data", onData);
      // ⚠️ 先置位再写序列：写序列抛了（流已销毁）时监听器已经挂上，`stop()` 必须仍认得出「要收尾」
      attached = true;
      enableMouseReporting(out);
      reporting = true;
    },
    stop(): void {
      if (!attached) return;
      // ⚠️ 幂等守卫**先**置位：重复调用不许写第二遍字节 —— 收尾期间没有第二次机会，写失败时重试也写不进去
      attached = false;
      stdin.off("data", onData);
      pending = "";
      seenAny = false;
      lastEventAt = null;
      reporting = false;
      // ⚠️ 关闭序列**无条件**写，即便开启那一半抛过：`?1000l` 对没开过的模式是幂等的 no-op，而「万一开成功过
      // 而我们不知道」是把操作者的终端永久留在吞选中与粘贴的状态。故**不**加「开成功过才关」的第二道闸
      disableMouseReporting(out);
    },
    onMouse(handler: (event: MouseEvent) => void): () => void {
      handlers.add(handler);
      return (): void => {
        handlers.delete(handler);
      };
    },
    liveness(): MouseLiveness {
      return { reporting, seenAny, lastEventAt };
    },
  };
}