/**
 * @fileoverview 鼠标事件源：SGR 上报的开关、序列解析、命中测试（零 Ink、零 React、零 `process.*`）
 * @module ui/mouse
 * @description
 * Ink **没有**鼠标。`ink/build/input-parser.js` 把每个未知 CSI 序列交给 `parseKeypress`，
 * `ESC[<b;x;yM` 在那里既不成一个键、也没有任何上交通道（`components/App.js` 内部没有自己的
 * `useInput`）—— 也就是说鼠标报告**不会被交给我们**。故本模块在**同一个 stdin 上
 * 自己挂一个 `data` 监听器**。Node 的流把同一份字节**广播**给所有监听器，Ink 与本模块都收得到；
 * 这也是 {@link ParsedSgr.rest} **绝不回灌 stdin** 的理由（回灌一遍就是双发，而双发的按键会被
 * 输入框收两次）。
 *
 * ## ⚠️ 广播的另一半：Ink 会把同一份鼠标报告**当成文本**交给 `useInput`
 * @description
 * 「Ink 收得到」不只是「多一份无害的副本」。`useInput` 把**未解析**的序列原样交给回调，而它
 * **顺手砍掉了那个 ESC**（`ink/build/hooks/use-input.js`），于是鼠标报告到达输入层时是
 * `[<35;64;32M` —— 一串**全是可打印字符**的协议报文，会被逐字插进输入行。故本模块同时导出
 * {@link isMouseReport}，由输入行在**入状态之前**用它认领掉。
 * ⚠️ 本模块曾经把这件事写成「既不会变成按键」，那句话是**错的**，而它错得贵：照着它实现，
 * 输入行就会把协议报文当内容，`?1003h` 开着时一次鼠标移动能糊进去几十行。**协议那一侧必须自己认领**，
 * 因为 Ink 的契约只是「尽力而为的文本」，它不负责认协议。
 *
 * ## 为什么 1006 必开
 * @description
 * 传统 X10 鼠标坐标在 223 列以上会 wrap（回绕到行首），而宽终端是常态。`?1006`（SGR 扩展坐标）把
 * 坐标写成无界的十进制数，故开启序列里**必须**有它；少了它，一个 240 列的终端上点右边三列会报出
 * 一个看似合法的错误坐标，而界面会据此选中**另一行** —— 那是一个不会报错的假事实。
 *
 * ## 关闭必须**无条件**执行
 * @description
 * 终端一旦被留在「鼠标上报开着」的状态，操作者退出后会得到一个**一直吞掉选中与粘贴**的终端：
 * 拖选变点击、`Ctrl+V` 失效，而且**屏幕上没有任何东西说明它发生了**。所以 {@link MouseSource.stop}
 * 内部不设任何可能被跳过的分支、且组合根那一侧必须走 `try/finally` 或 `process.once("exit")` 兜底。
 *
 * ## 坐标是 1-based 的终端**格子**
 * @description
 * 终端报的行列从 1 起，布局坐标从 0 起，故 {@link ParsedSgr} 里的事件坐标一律**已减一**。
 * ⚠️ **这里的坐标就是终端屏幕坐标，不需要任何平移。** 鼠标是一个物理设备指着一块物理屏幕，
 * SGR 协议给的 (x, y) 是那一格在**可见屏幕**上的位置（1-based），本模块减一到 0-based 之后，
 * 它与 `@/view/geometry.ts` 算出来的矩形**已经在同一套坐标里**，直接拿去命中测试即可。
 *
 * ⚠️ **别把 `measureElement` 的警告搬到这里。** Ink 那份文档说它给的是 layout-tree 坐标、
 * 与视口坐标之间还要用活动区域原点平移 —— 那是**它**的坐标需要平移，不是鼠标的。两者弄反的
 * 后果是给每一次点击加一个根本不存在的偏移，于是「点哪都不对」而每个部件单独看都合理。
 * 本包**刻意不用** `measureElement`：布局全部由 `@/view/geometry.ts` 算术得出（见那份文件头
 * 「为什么必须只有一份」），所以本包与「视口原点」这件事完全无关。
 *
 * ## 残留缓冲（分片到达）
 * @description
 * 一个 stdin chunk 完全可能只带半条序列 —— 慢速 SSH 上一个 40 字节的 chunk 只带半个坐标是常事。
 * 故 {@link parseSgr} 收一个**跨调用**的 `pending`，凑齐才吐事件，剩下的留到下次。⚠️ 这是本模块最容易
 * 漏的一处：漏掉它的后果不是「少一个事件」，而是**半条序列被当成普通按键**（`ESC[<0;1` 变成一次
 * Esc 加三个字符），界面会毫无征兆地跳页。
 *
 * ## 探活：「鼠标到底能不能用」的唯一诚实判据
 * @description
 * 判据是**终端有没有回我们的上报请求** —— SGR 模式下按下鼠标时终端才会回一条序列，所以
 * 「最近 {@link MOUSE_QUIET_MS} 毫秒内收到过任何一条报告」就是答案。
 * ⚠️ **绝不**去查环境变量或平台去猜：那类猜测与「终端实际上报不上」可以任意组合，猜错时同样是零信号。
 * ⚠️ 更重要的一条：**绝不许因为「没收到鼠标事件」就禁用键位**。`MOUSE_UNSUPPORTED_HINT` 是一句
 * 提示，键位表永远全部可用 —— 一次「鼠标坏了」只该降级一个**交互方式**，把唯一还能用的那个也关掉
 * 就不是降级了。
 *
 * @module
 */

/** ESC（CSI 序列的引入字节；本模块所有的判据都以它为锚） */
const ESC = "\u001B";

/** SGR 鼠标报告的固定前缀：`ESC [ <`（传统 X10 鼠标没有这个 `<`，故本模块不解析 X10 形态） */
const SGR_PREFIX = `${ESC}[<`;

/**
 * 残留缓冲的**上限**（字符数）
 * @description 一条 SGR 报告最长十几字符（`ESC[<` + 三段十进制 + 终止字母），64 是数量级的富余。
 * 上限存在的理由是内存：一条被截断/畸形的流若一直发 `ESC[<` 后面接数字而永不发终止字母，
 * 没有上限时残留缓冲**无界增长**，而一个长驻的控制台进程会被它慢慢吃干。
 */
const MAX_PENDING = 64;

/* ── SGR 报告的位域（ECMA-48 私有模式 1006 的按钮编码）────────────────────── */

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

/* ── 类型 ──────────────────────────────────────────────────────────────── */

/** 一次鼠标动作的类别（**滚轮自成四档**，不塞进 `down`/`up`） */
export type MouseAction =
  "down" | "up" | "drag" | "move" | "wheelUp" | "wheelDown" | "wheelLeft" | "wheelRight";

/** 按键（`null` = 这次报告里没有按键参与：滚轮 / 无按键移动 / 无按键释放） */
export type MouseButton = (typeof BUTTONS)[number];

/** 一条鼠标事件（坐标已是 0-based 的**终端屏幕**坐标，见文件头） */
export interface MouseEvent {
  readonly action: MouseAction;
  /**
   * ⚠️ 滚轮事件恒为 `null`：`b = 64`（滚轮上）的低 2 位是 `0`，照抄会说出「左键」—— 那是用假事实
   * 换掉界面。无按键移动（`b = 35`）与无按键释放（`b = 3`）同理。
   */
  readonly button: MouseButton | null;
  /** 0-based 列 */
  readonly x: number;
  /** 0-based 行 */
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
   * @description
   * ⚠️ 它**不**回灌 stdin：Ink 已经在同一个流上收到同一份字节。回灌是双发，而双发的按键会被输入框
   * 收两次（页面上表现为「敲一个字母进了两个」）。
   */
  readonly rest: string;
  /**
   * 跨调用残留：下一次调用必须把它作为 `pending` 传回来（`input === rest + pending` 是本模块的契约，
   * 调用方要自己往回灌时这就是那条顺序保证）
   */
  readonly pending: string;
}

/* ── 开关序列 ──────────────────────────────────────────────────────────── */

/**
 * 开启鼠标上报的序列（`h` = set）
 * @description
 * 1000 = 基本按下/释放；1003 = **任意**移动（比 1000 大一两个数量级的事件量，故节流是上层的事，
 * 而节流掉的事件必须是上层**自己说出口**的，不能在这里静默丢）；1006 = SGR 扩展坐标（见文件头）。
 * ⚠️ `set` 是**幂等**的：重复写一遍不会叠出第二份状态，所以「重复开启」无害（但仍不写成对称的重复动作）。
 */
export const MOUSE_REPORTING_ON: readonly string[] = Object.freeze([
  `${ESC}[?1000h`,
  `${ESC}[?1003h`,
  `${ESC}[?1006h`,
]);

/**
 * 关闭鼠标上报的序列（`l` = reset）
 * @description
 * **与 {@link MOUSE_REPORTING_ON} 一一对应且顺序相反**（先撤 1006 这个坐标格式，再撤 1003 这个事件
 * 量，最后撤 1000 这个总开关）。⚠️ 这不是洁癖：退出那一刻终端可能还在发最后几条移动报告，
 * 顺序不撤会让「坐标格式已撤、事件还在发」这个中间态把一条无格式的移动当按键吃掉。
 */
export const MOUSE_REPORTING_OFF: readonly string[] = Object.freeze([
  `${ESC}[?1006l`,
  `${ESC}[?1003l`,
  `${ESC}[?1000l`,
]);

/* ── 纯函数那一半：解析 ────────────────────────────────────────────────── */

/** 一次扫描的结论（内部） */
type SgrScan =
  /** 一条完整的 SGR 报告：字节**消费掉**（`event` 为 `null` 表示认得但不该产出事件，见 `scanSgr`） */
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
 * @description
 * 「是不是我们的」只用**结构**判：必须是 `ESC [ <` + 恰好三段十进制/分号 + 终止字母 `M` / `m`。
 * 段数不是 3（例如某些私有扩展塞了第四段）判为「不是我们的」，字节原样透传给 Ink —— 判据宁可放过，
 * 不可把别人的序列吞掉。
 * ⚠️ 坐标另有一道闸：`Cx` / `Cy` 必须是**正整数**。有些终端在拿不到位置时报 0，而 `0` 不是一格终端，
 * 硬把它减一成 0 就是拿一个假位置去喂命中测试，而命中的下标会被当成「用户点了那一行」。
 * 这样的报告字节照常消费掉（它确实是我们的），但不产出事件。
 */
function scanSgr(input: string, at: number): SgrScan {
  // ⚠️ 「后面没有了」先于「不是 `[`」判：一个孤零零落在 chunk 末尾的 `ESC` 可能是半条报告
  // （`ESC` / `ESC [` / `ESC [<0;1` 三种都真实存在），判成「不是我们的」就会把半条序列交给
  // 输入框当按键 —— 界面会毫无征兆地跳页。
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
 * @description
 * ⚠️ `pending` 是**必带**的跨调用残留：漏传它等于宣布「输入流分片不可能发生」，而慢速 SSH 上分片
 * 发生得很频繁。返回值恒满足 `input === rest + pending`（`input` 是 `pending + chunk`），所以调用方
 * 若要把非鼠标字节回灌给别的消费者，顺序是可还原的。
 * ⚠️ 本函数**不**在结尾把 `rest` 交出去重发：`usePaste` 与 Ink 自己要用的是同一个流（见 {@link ParsedSgr.rest}）。
 *
 * @param chunk 本次到达的字节（stdin 的一次 `data`）
 * @param pending 上一次调用留下的残留（首次传空串）
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
    // 「不是我们的」：只把 ESC 这一个字符并进 rest，后面的字节按原序接着扫 ——
    // 逐个字符累加的结果与整段拷贝逐字相同，故这里不需要另开一条「整段透传」的路径。
    rest += ESC;
    index = escapeAt + 1;
  }
  return { events, rest, pending: held };
}

/**
 * `input` **整段**是不是一条（或半条）SGR 鼠标报告（内部；判据只有一个实现处 = {@link scanSgr}）
 * @description
 * ⚠️ 「整段」是硬要求：`scan.next === input.length` 判的是**这一串被消费干净了**，而
 * `scan.kind === "hold"` 判的是「本模块认得、且它是全部」—— 两者的共同点是**没有剩下任何
 * 不属于报告的字节**。少了它，一段粘贴（`[<35;64;32Mx`）会被当成报告吞掉，而那是操作者自己敲的字。
 *
 * ⚠️ 长度必须**超过** {@link SGR_PREFIX} 本身：`scanSgr` 对孤零零落在末尾的 `ESC` / `ESC[` /
 * `ESC[<` 都会说 `hold`（那是分片到达的正常形态），而 `[` 是一个用户随时可能敲出来的字符 ——
 * 把「只有前缀」也算成报告，输入行里就再也打不出 `[` 了。
 */
function isWholeSgr(input: string): boolean {
  if (!input.startsWith(SGR_PREFIX) || input.length === SGR_PREFIX.length) return false;
  const scan = scanSgr(input, 0);
  if (scan.kind === "foreign") return false;
  return scan.kind === "hold" || scan.next === input.length;
}

/**
 * Ink 交给 `useInput` 的这一串是不是一条鼠标报告（**纯函数**；是则调用方必须原样丢掉）
 * @description
 * ## 存在的理由：Ink 把**未解析**的转义序列连同那个 ESC 一起交给 `useInput`，却**顺手把 ESC 砍掉**
 * @description
 * `ink/build/hooks/use-input.js` 里 `parseKeypress("ESC[<35;64;32M")` 解析不出任何键名，于是
 * `input = keypress.sequence`（整串原样），紧接着
 * `if (input.startsWith("\u001B")) input = input.slice(1)` —— 到达 `useInput` 回调时它已经是
 * `[<35;64;32M`：**一串全是可打印字符的协议报文**。
 * ⚠️ 那不是 Ink 的缺陷而是它的契约（「我给你的是尽力而为的文本」），所以**协议这一侧必须自己认领**：
 * 不认领的后果是输入行里逐字长出 `[<35;64;32M`，而 `?1003h` 开着时移动一次鼠标就是几十行那种垃圾。
 * ⚠️ 由此还得到一条**判据能力上的边界**：ESC 被砍掉之后，「未解析的 CSI 序列」与「用户敲的 `[abc`」
 * 在字符串上**再也分不开**，故本函数只能认**结构上就是报告**的那些，宁可放过不可错杀。
 *
 * ## 两种形态都收
 * @description
 * 带 ESC（`parseSgr` / 单元测试里的原样）与不带 ESC（Ink 交给 `useInput` 的形态）都判为 true。
 *
 * @param text `useInput` 交出来的那一串（**一个**键或一段粘贴；Ink 已按转义序列切分过了）
 * @returns 是鼠标报告（含分片未到齐的半条）时为 true —— 那时它一个字都不许进输入行
 */
export function isMouseReport(text: string): boolean {
  if (text === "") return false;
  return isWholeSgr(text) || isWholeSgr(`${ESC}${text}`);
}

/* ── 纯函数那一半：命中测试 ────────────────────────────────────────────── */

/* ── 探活 ──────────────────────────────────────────────────────────────── */

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
 * @description
 * - `unknown` —— 还没开上报。没开就没资格下结论，**不许**显示任何关于鼠标的提示。
 * - `reported` —— 最近 {@link MOUSE_QUIET_MS} 毫秒内收到过报告：终端确实在回。
 * - `idle` —— 收到过，但最近这段时间没有（用户没动鼠标，或被别的 TUI 抢了）：**不知道**，不提示。
 * - `silent` —— 开着上报且**从未**收到过：这是唯一能说「似乎不支持」的档。
 */
export type MouseSupport = "unknown" | "reported" | "idle" | "silent";

/**
 * 「最近收到过」的窗口（毫秒）
 * @description SGR 模式下终端只在有动作时才回报告，所以这个窗口量的是「操作者还在用鼠标吗」，
 * 不是「终端还活着吗」—— 后者要靠别的信号。
 */
export const MOUSE_QUIET_MS = 2000;

/**
 * 「本终端似乎不支持鼠标」那一档的提示文案
 * @description
 * ⚠️ 这句话的后半段（「全部键位仍可用」）与前半段同等重要，且**不许**被删：没收到鼠标事件是一个
 * **能力**判据，而键位是**唯一**的操作通路；把它读成「鼠标不可用」就会有人接着去关键位。
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
 * 该不该说「本终端似乎不支持鼠标」（**纯函数**；不是那一档时给 `null`，界面就不显示它）
 * @description ⚠️ 返回 `null` **只意味着不说这句话**，不意味着任何能力被关掉。
 */
export function mouseUnsupportedHintOf(
  liveness: MouseLiveness,
  now: number,
  quietMs?: number,
): string | null {
  return mouseSupportOf(liveness, now, quietMs) === "silent" ? MOUSE_UNSUPPORTED_HINT : null;
}

/* ── 薄壳那一半：开关与监听 ────────────────────────────────────────────── */

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

/**
 * 关闭鼠标上报（薄壳）
 * @description ⚠️ 漏掉这一句的代价是操作者的终端**一直吞掉选中与粘贴**，且**看不出来**（见文件头）。
 * 故调用点必须处在 `try/finally` 或 `process.once("exit")` 上。
 */
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
 * @description
 * ⚠️ **回调里的异常不上报也不吞**：它沿 stdin 的 `emit` 冒出去把进程带崩。这不是疏忽 ——
 * Ink 调 `useInput` 回调时是同一个暴露面（它也没有守卫），而在这里加一层守卫就等于给鼠标这条路
 * 单独造一套「吞掉 UI 异常」的语义，与界面其余部分不是同一套做法。
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
      // ⚠️ 先置位再写序列：写序列抛了（流已销毁）时监听器已经挂上，`stop()` 必须仍认得出「要收尾」，
      // 否则那一个监听器会活到进程结束。
      attached = true;
      enableMouseReporting(out);
      reporting = true;
    },
    stop(): void {
      if (!attached) return;
      // ⚠️ 幂等守卫**先**置位：重复调用不许写第二遍字节。理由是收尾期间没有第二次机会 ——
      // 写失败（EPIPE / 流已销毁）时重试也写不进去，而「多写一遍」与终端正在恢复的中间态相撞更糟。
      attached = false;
      stdin.off("data", onData);
      pending = "";
      seenAny = false;
      lastEventAt = null;
      reporting = false;
      // ⚠️ 关闭序列**无条件**写，即便开启那一半抛过（流已销毁、根本没开成功）：`?1000l` 对一个
      // 没开过的模式是幂等的 no-op，而「万一开成功过而我们不知道」是把操作者的终端永久留在
      // 吞选中与粘贴的状态。故这里**不**加「开成功过才关」的第二道闸 —— 那道闸只会在最需要它的
      // 时候（开启抛了）把唯一的那次补救挡掉。
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
