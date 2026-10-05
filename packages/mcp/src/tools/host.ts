/**
 * @fileoverview 「家目录在哪儿」的那**一个**口 —— 单测靠它把台账隔离到临时目录
 * @module tools/host
 */

import os from "node:os";

/**
 * 当前用户的家目录
 * @description
 * ⚠️ **每次调用现取，且包在一个可变引用后面**。工具表在进程启动时组装，而单测要能在同一个
 * 进程里让不同用例看到不同的家目录 —— 模块加载时取一次就固化了。
 * ⚠️ 本包**不读**任何环境变量决定这个位置（理由见 `@/utils/json-file.js` 的文件头）。
 */
let override: string | null = null;

/** 单测专用：把家目录指到别处（传 `null` 恢复真实值） */
export function setHomedirOverride(value: string | null): void {
  override = value;
}

export function homedir(): string {
  return override ?? os.homedir();
}
