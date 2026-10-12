/**
 * @fileoverview 终端鼠标上报协议（xterm SGR 模式 1006）：事件类型 + 纯解码
 * @module ink-ui/hooks/mouse/protocol
 * @description
 * 终端把一次鼠标动作编成一条 CSI：`ESC [ < Cb ; Cx ; Cy M`（按下 / 拖拽 / 移动 / 滚轮），
 * 结尾小写 `m` 表示释放。`Cb` 是位域：低 2 位=按键号，`4`/`8`/`16`=Shift/Meta/Ctrl，
 * `32`=移动中，`64`=滚轮，`128`=扩展键（拇指键）。坐标终端给的是 1 基，事件里一律转成 0 基。
 *
 * ⚠️ **只认 SGR（1006），X10/1000 老编码故意不认**：老编码是 `ESC [ M` 后跟 3 个裸字节，
 * 而 ink 的 `input-parser` 会把 `ESC [ M` 当成一条完整 CSI 截断（`M` 本身就是 CSI 终止符），
 * 后面 3 个坐标字节被拆成独立事件，到我们手里已经对不上号。老终端不支持 1006 时宁可不捕获，
 * 也不去猜字节（开关码见同目录 `tracking.ts`）。
 *
 * ⚠️ **别的按键处理器必须用 `isMouseSequence` 先滤噪声**：ink 把每条输入广播给它的每个
 * `useInput` 订阅者，鼠标上报会漏进不认识鼠标的处理器（剥过 ESC 后形如 `[<0;12;34M`，符号位
 * 全 false，与「这一下什么都没有」同形）。
 *
 * 纯函数层：零 IO、零 React。开终端跟踪的开关码在同目录 `tracking.ts`，React 侧在同目录
 * `use-mouse.ts`（事件中枢在 `source.ts`）。
 */

/** 鼠标按键：`none` = 无按键（空按移动、释放全部键）；8/9 号键（后退 / 前进）之外的扩展键记 `other` */
export type MouseButton = "left" | "middle" | "right" | "back" | "forward" | "other" | "none";

/** 滚轮方向（横滚 = 左右两档） */
export type WheelDirection = "up" | "down" | "left" | "right";

/** 修饰键：终端把 Alt 报在 Meta 位上 */
export interface MouseModifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** 事件的判别式 `type` */
export type MouseEventType = "down" | "up" | "drag" | "move" | "wheel";

interface MouseEventBase {
  /** 触发该事件的按键；`move` 为 `none`，滚轮看 `direction`（滚轮本身无按键语义） */
  button: MouseButton;
  /** 0 基列号（对齐 ink 盒子的坐标系，做命中测试用这个） */
  x: number;
  /** 0 基行号 */
  y: number;
  modifiers: MouseModifiers;
}

/** 一次鼠标事件：按下 / 释放 / 拖拽（按键按住时的移动）/ 空按移动 / 滚轮 */
export type MouseEvent = MouseEventBase &
  (
    | { type: "down" }
    | { type: "up" }
    | { type: "drag" }
    | { type: "move" }
    | { type: "wheel"; direction: WheelDirection }
  );

/** 按键号（`Cb` 低 2 位）→ 按键；3 = 无按键 */
const BUTTONS: MouseButton[] = ["left", "middle", "right", "none"];

/** 扩展键（`Cb` 的 128 位，即 8–11 号键）→ 按键 */
const EXTENDED_BUTTONS: MouseButton[] = ["back", "forward", "other", "other"];

/** 滚轮键（`Cb` 的 64 位，即 4–7 号键）→ 方向；带 Shift/Alt/Ctrl 时低 2 位不变 */
const WHEEL_DIRECTIONS: WheelDirection[] = ["up", "down", "left", "right"];

/** 位掩码 */
const SHIFT = 4;
const ALT = 8;
const CTRL = 16;
const MOTION = 32;
const WHEEL = 64;
const EXTENDED = 128;

/**
 * ESC（0x1B）：上报里到处是它，开关码那边也要，故导出给同目录 `tracking.ts` 复用。
 *
 * ⚠️ 用码点造而不是写 `"\u001b"` 之类的字面量：正则**字面量**里放控制字符会被 eslint 的
 * `no-control-regex` 拦，而字符串里塞裸字节在源码里不可见、grep 也搜不到（改一处字节，
 * diff 里看不出差别）。
 */
export const ESC = String.fromCharCode(0x1b);

/**
 * 单条上报：可选前导 ESC（ink 的 `useInput` 会剥掉它）、`[<` 头、`M`/`m` 尾。
 *
 * ⚠️ **不许加 `g` 标志**：无 `g` 时 `test()` 与 `exec()` 各看各的，加了就会共享 `lastIndex`，
 * 于是「先 `isMouseSequence` 判一次、再 `parseMouseSequence` 解一次」的第二段会从上次的位置
 * 接着找而漏掉开头。
 */
const SEQUENCE_RE = new RegExp(
  `^(?:${ESC})?\\[<(\\d{1,3});(\\d{1,7});(\\d{1,7})([Mm])$`,
);

function decode(code: number, column: number, row: number, release: boolean): MouseEvent {
  const base: MouseEventBase = {
    button: "none",
    x: column - 1,
    y: row - 1,
    modifiers: {
      shift: (code & SHIFT) !== 0,
      alt: (code & ALT) !== 0,
      ctrl: (code & CTRL) !== 0,
    },
  };
  // 滚轮先判：64 位与 128 位互斥，判据不能混（带修饰键时高位照样是 64）
  if ((code & WHEEL) !== 0 && (code & EXTENDED) === 0) {
    return { ...base, type: "wheel", direction: WHEEL_DIRECTIONS[code & 3] };
  }
  const button =
    (code & EXTENDED) !== 0 ? EXTENDED_BUTTONS[code & 3] : BUTTONS[code & 3];
  if (release) return { ...base, button, type: "up" };
  // 无按键的移动（悬停）没有 `move` 与 `down` 的区别，终点端两种编码都见过
  if (button === "none") return { ...base, button, type: "move" };
  return { ...base, button, type: (code & MOTION) !== 0 ? "drag" : "down" };
}

/**
 * 这一下输入是不是一条鼠标上报：只判形状，不解码。
 *
 * 按键处理器滤噪声用（见文件头的 ⚠️）——`useMouse` 自己不需要它。
 *
 * @param input ink 交回的文本
 */
export function isMouseSequence(input: string): boolean {
  return SEQUENCE_RE.test(input);
}

/**
 * 解析单条上报。
 *
 * @param sequence 一条上报，容忍前导 ESC（`useInput` 传进来的就是被剥掉 ESC 的 `[<0;12;34M`）
 * @returns 事件；不是合法上报则 `null`（按键、粘贴、别的 CSI 都走这里返回 `null`）
 */
export function parseMouseSequence(sequence: string): MouseEvent | null {
  const matched = SEQUENCE_RE.exec(sequence);
  if (!matched) return null;
  const [, code, column, row, tail] = matched;
  return decode(Number(code), Number(column), Number(row), tail === "m");
}
