/**
 * @fileoverview 文本的字符判据 —— 控制字符那一处**共用**的判据
 * @module utils/text
 * @description
 * 为什么单独一个文件：地址、显示名、环境名三处都要判「有没有控制字符」，而三处各写一份
 * 就会有第三份 —— 控制字符的危害恰恰是**跨层**的（header 注入、日志断行，以及「看到的」
 * 与「实际发出去的」分叉）。
 *
 * ## ⚠️ 判据用 charCode 循环，**不用**正则
 * @description 写成 `/[\u0000-\u001f\u007f]/` 在源码里是更短的一行，但那串转义会被本仓的
 * 工具链（write/edit）**还原成真控制字节** —— 于是文件变成二进制，`git diff` 与编辑器都读不出
 * 那一行改了什么，而它偏偏是安全判据。`codePointAt` 的数值比较没有这个传输问题，
 * 且「C0 + DEL」在代码里是自解释的。
 */

/** C0 的上界（含）—— ⚠️ 0x1f，不是 0x20：0x20 是空格，那不是控制字符 */
const C0_MAX = 0x1f;

/** DEL */
const DEL = 0x7f;

/** 有没有控制字符（C0 或 DEL） */
export function hasControlChars(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code <= C0_MAX || code === DEL) {
      return true;
    }
  }
  return false;
}

/**
 * 拒掉含控制字符的字符串
 * @param what 人读的定位串（只进错误文案，⚠️ **绝不转述被判的那个值** ——
 * 那正是控制字符会弄断日志与终端的地方）
 */
export function assertNoControlChars(value: string, what: string): void {
  if (hasControlChars(value)) {
    throw new Error(`${what}里有控制字符`);
  }
}
