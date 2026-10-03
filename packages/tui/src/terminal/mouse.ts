/**
 * @fileoverview 鼠标事件源：SGR 上报的开关与序列解析（零 Ink、零 React、零 `process.*`）
 * @module terminal/mouse
 * @description
 * Ink **没有**鼠标：`ink/build/input-parser.js` 把 `ESC[<b;x;yM` 交给 `parseKeypress`，那里既不成一个键也没有
 * 任何上交通道，故本模块在**同一个 stdin 上自己挂一个 `data` 监听器**（Node 的流把同一份字节**广播**给所有
 * 监听器）。⚠️ 广播的另一半：Ink 把同一份报告**当成文本**交给 `useInput` —— `use-input.js` 顺手砍掉那个 ESC，
 * 于是到达输入层时它是 `[<35;64;32M`：**一串全是可打印字符的协议报文**，会被逐字插进输入行。故本模块同时导出
 * {@link isMouseReport} 供输入行在**入状态之前**认领掉 —— Ink 的契约只是「尽力而为的文本」，它不负责认协议。
 *
 * ⚠️ **关闭必须无条件执行**：终端一旦被留在「上报开着」的状态，操作者退出后会得到一个**一直吞掉选中与粘贴**的
 * 终端且屏幕上没有任何东西说明它发生了。故 {@link MouseSource.stop} 不设任何可能被跳过的分支。
 *
 * ⚠️ **坐标是 1-based 的终端格子，已在这里减一，且不需要任何平移**：减到 0-based 之后它与 `@/view/geometry.ts`
 * 的矩形**已经在同一套坐标里**。⚠️ **别把 `measureElement` 的警告搬过来** —— 那说的是**它**的 layout-tree 坐标
 * 要平移，不是鼠标的；弄反的后果是给每一次点击加一个不存在的偏移。命中测试也在那份文件里。
 *
 * ⚠️ 探活判据是**终端有没有回我们的上报请求**，故「最近 {@link MOUSE_QUIET_MS} 毫秒内收到过任何一条报告」就是
 * 答案。⚠️ **绝不**查环境变量或平台去猜，猜错时同样是零信号。⚠️ 更重要：**绝不许因为「没收到鼠标事件」就禁用
 * 键位** —— 一句提示不是能力降级，把唯一还能用的操作通路也关掉才是。
 *
 * @module
 */

/** ESC（CSI 序列的引入字节；本模块所有的判据都以它为锚） */
const ESC = "\u001B";

/** SGR 鼠标报告的固定前缀：`ESC [ <`（传统 X10 鼠标没有这个 `<`，故本模块不解析 X10 形态） */
const SGR_PREFIX = `${ESC}[<`;

/**
 * 残留缓冲的**上限**（字符数）
 * @description 一条 SGR 报告最长十几字符，64 是数量级的富余。上限是为内存：一条被截断/畸形的流若一直发
 * `ESC[<` 后面接数字而永不发终止字母，没有上限时残留缓冲**无界增长**。
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
   * ⚠️ 滚轮事件恒为 `null`：`b = 64`（滚轮上）的低 2 位是 `0`，照抄会说出「左键」—— 那是用假事实换掉
   * 界面。无按键移动（`b = 35`）与无按键释放（`b = 3`）同理。
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
  /**
   * 本次调用里**能确定不属于我们**的字节，原样透传（一个字节都不改、也不重排）
   * @description ⚠️ 它**不**回灌 stdin：Ink 已经在同一个流上收到同一份字节。回灌是双发，而双发的按键会被
   * 输入框收两次。
   */
  readonly rest: string;
  /** 跨调用残留：下一次调用必须把它作为 `pending` 传回来 */
  readonly pending: string;
}

/**
 * 开启鼠标上报的序列（`h` = set）
 * @description 1000 = 基本按下/释放；1003 = **任意**移动（比 1000 大一两个数量级的事件量，故节流是上层的
 * 事，而节流掉的事件必须由上层**自己说出口**，不能在这里静默丢）；1006 = SGR 扩展坐标。
 *
 * ⚠️ **1006 必开**：传统 X10 鼠标坐标在 223 列以上会 wrap，而宽终端是常态。少了它，点右边三列会报出一个看
 * 似合法的错误坐标，界面据此选中**另一行** —— 一个不会报错的假事实。⚠️ `set` 是**幂等**的。
 */
export const MOUSE_REPORTING_ON: readonly string[] = Object.freeze([
  `${ESC}[?1000h`,
  `${ESC}[?1003h`,
  `${ESC}[?1006h`,
]);

/**
 * 关闭鼠标上报的序列（`l` = reset）
 * @description **与 {@link MOUSE_REPORTING_ON} 一一对应且顺序相反**。⚠️ 这不是洁癖：退出那一刻终端可能还在
 * 发最后几条移动报告，顺序不撤会让「坐标格式已撤、事件还在发」这个中间态把一条无格式的移动当按键吃掉。
 */
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

/** 位域 + 坐标 → 一条事件（坐标在这一层已从 1-based 减到 0-based） */
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

/**
 * 从 `input[at]`（必为 `ESC`）起判断这是不是一条 SGR 鼠标报告（零副作用）
 * @description 「是不是我们的」只用**结构**判：必须是 `ESC [ <` + 恰好三段十进制/分号 + 终止字母 `M` / `m`。
 * 段数不是 3 判为「不是我们的」，字节原样透传给 Ink —— 判据宁可放过，不可把别人的序列吞掉。⚠️ 坐标另有一
 * 道闸：`Cx` / `Cy` 必须是**正整数**（有些终端在拿不到位置时报 0，而 `0` 不是一格终端，硬减一成 0 就是拿一个
 * 假位置去喂命中测试）。这样的报告字节照常消费掉，但不产出事件。
 */
function scanSgr(input: string, at: number): SgrScan {
  // ⚠️ 「后面没有了」先于「不是 `[`」判：一个孤零零落在 chunk 末尾的 `ESC` 可能是半条报告（`ESC` /
  // `ESC [` / `ESC [<0;1` 三种都真实存在），判成「不是我们的」就会把半条序列交给输入框当按键
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
  const event =
    column >= 1 && row >= 1 ? eventOf(button, column - 1, row - 1, final === "m") : null;
  return { kind: "report", event, next: cursor + 1 };
}

/**
 * 解析一个 stdin chunk 里的 SGR 鼠标报告（**纯函数**，零副作用、零 I/O）
 * @description ⚠️ 一个 chunk 完全可能只带半条序列（慢速 SSH 上常事），故 `pending` 是**必带**的跨调用残留 ——
 * 漏传它等于宣布「输入流分片不可能发生」。返回值恒满足 `input === rest + pending`，所以调用方若要把非鼠标字
 * 节回灌给别的消费者，顺序是可还原的（⚠️ 本函数**不**在结尾把 `rest` 重发：`usePaste` 与 Ink 自己要用的是同
 * 一个流）。
 */
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

/**
 * `input` **整段**是不是一条（或半条）SGR 鼠标报告（内部；判据只有一个实现处 = {@link scanSgr}）
 * @description ⚠️ 「整段」是硬要求：`scan.next === input.length` 判的是**这一串被消费干净了**，`scan.kind
 * === "hold"` 判的是「本模块认得、且它是全部」—— 共同点是**没有剩下任何不属于报告的字节**。少了它，一段
 * 粘贴（`[<35;64;32Mx`）会被当成报告吞掉，而那是操作者自己敲的字。⚠️ 长度必须**超过** {@link SGR_PREFIX}
 * 本身：`scanSgr` 对孤零零落在末尾的 `ESC` / `ESC[` / `ESC[<` 都会说 `hold`，而 `[` 是用户随时可能敲出来的
 * 字符 —— 把「只有前缀」也算成报告，输入行里就再也打不出 `[` 了。
 */
function isWholeSgr(input: string): boolean {
  if (!input.startsWith(SGR_PREFIX) || input.length === SGR_PREFIX.length) return false;
  const scan = scanSgr(input, 0);
  if (scan.kind === "foreign") return false;
  return scan.kind === "hold" || scan.next === input.length;
}

/**
 * Ink 交给 `useInput` 的这一串是不是一条鼠标报告（**纯函数**；是则调用方必须原样丢掉）
 * @description 带 ESC 与不带 ESC 两种形态都收。⚠️ **判据能力上的边界**：ESC 被砍掉之后，「未解析的 CSI 序列」
 * 与「用户敲的 `[abc`」在字符串上**再也分不开**，故只能认**结构上就是报告**的那些，宁可放过不可错杀。
 *
 * @param text `useInput` 交出来的那一串（**一个**键或一段粘贴；Ink 已按转义序列切分过了）
 * @returns 是鼠标报告（含分片未到齐的半条）时为 true —— 那时它一个字都不许进输入行
 */
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

/**
 * 「本终端似乎不支持鼠标」那一档的提示文案
 * @description ⚠️ 后半段（「全部键位仍可用」）与前半段同等重要且**不许**被删：键位是**唯一**的操作通路，把它
 * 读成「鼠标不可用」就会有人接着去关键位。
 */
export const MOUSE_UNSUPPORTED_HINT = "本终端似乎不支持鼠标；全部键位仍可用";

/** 探活事实 → 结论档（**纯函数**；`now` 与 `quietMs` 都是入参，判据自身零副作用、可单测） */
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

/**
 * 该不该说「本终端似乎不支持鼠标」（**纯函数**；不是那一档时给 `null`）
 * @description ⚠️ 返回 `null` **只意味着不说这句话**，不意味着任何能力被关掉。
 */
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

/**
 * 造一个鼠标事件源（薄壳：挂监听 + 开关上报 + 记探活）
 * @description ⚠️ **回调里的异常不上报也不吞**：它沿 stdin 的 `emit` 冒出去把进程带崩。这不是疏忽 —— Ink 调
 * `useInput` 回调时是同一个暴露面（它也没有守卫），而在这里加一层守卫就等于给鼠标这条路单独造一套「吞掉
 * UI 异常」的语义。
 *
 * @param options 宿主来源由组合根采集后传进来（`stdin` / `out` / `now`）；本模块**不**自己摸 `process.*`
 */
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