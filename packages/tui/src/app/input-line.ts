/**
 * @fileoverview 输入行的**纯函数**：串的增删与插入符移动（零 React、零终端）
 * @module app/input-line
 * @description
 * ## ⚠️ 输入行有**两道闸**，少任何一道都不成立
 * @description
 * Ink 把粘贴的内容**逐字**交给 `useInput`，而网页复制来的 token 常带一个 `U+000D`：它会**静默**
 * 进输入行、跟着 `target add` 发出去，而 `Authorization: Bearer` 用 `$` 锚定比对 —— 恒 401。故
 * {@link printableOnly} 在**入状态之前**剔掉 C0 与 `DEL`。⚠️ **但 C0 挡不住鼠标报告**：`useInput`
 * 那个字符串里唯一的 C0 字节（`ESC`）在进门之前就被 Ink 拿掉了，于是报文到这里**全是可打印
 * 字符** —— 故还需要另一道 `isMouseReport`（认领协议，在 `./use-keyboard.js` 的最前面）。
 *
 * ⚠️ **下标一律是 UTF-16 code unit**，因为它要与另外三处逐字一致：
 * `@/view/geometry.ts:caretFromWrappedPoint` 返回的、`@/cmd/complete.ts` 吃的、
 * `@/view/layout.tsx` 的 `CaretRow` 切的三者。
 */

/**
 * 是不是**控制字符**（C0 那一段 + `DEL`）
 * @description 逐个 code point 判而不是一条正则：那条正则会被本包的 `no-control-regex` 判死，而
 * 加一条 `eslint-disable` 等于让这条纪律从此不再被看见。
 */
export function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/**
 * 只留下可打印的那部分
 * @description **剔掉**而不是「替换成空格」：一个被污染的 token 换成一个空格仍然是错的 token。
 */
export function printableOnly(text: string): string {
  let out = "";
  for (const ch of text) if (!isControlChar(ch)) out += ch;
  return out;
}

/** 在 `text` 的第 `at` 个 code unit 处插入 `added`（返回新串与新光标） */
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
