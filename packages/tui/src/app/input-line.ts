/** @fileoverview 输入行的纯函数：串的增删与插入符移动（零 React、零终端；下标一律 UTF-16 code unit） */

/** C0 那一段 + `DEL`；逐个 code point 判而不用正则（`no-control-regex` 会把它判死） */
export function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** 剔掉而不是「替换成空格」：被污染的 token 换成一个空格仍然是错的 token */
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
  // ⚠️ 退一整个 code point：只退一半会在代理对中间切开
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
