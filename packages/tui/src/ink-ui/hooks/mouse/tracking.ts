/**
 * @fileoverview 终端鼠标跟踪的开关码（xterm DECSET / DECRST）：纯字符串拼装
 * @module ink-ui/hooks/mouse/tracking
 * @description
 * 只拼字符串，不写 stdout；谁来开、谁来关见同目录 `source.ts` 的 `startMouse` / `stopMouse`
 * （应用级的一对开关，档次不共用）。四个模式各管一段：
 *
 * | 模式 | 含义 | 本包怎么用 |
 * |---|---|---|
 * | `1000` | 按下 / 释放 | 无条件开，是捕获的前提 |
 * | `1002` | 拖拽（按键按住时的移动） | `drag` 档 |
 * | `1003` | 任何移动（含悬停空按） | `motion` 档 |
 * | `1006` | SGR 扩展坐标 | 无条件开，唯一能穿过 ink 输入解析器的编码 |
 *
 * ⚠️ **关闭必须按开启的逆序**（1006 → 1003 → 1002 → 1000）：SGR 是 1000–1003 的坐标表示层，
 * 先关它再关底层模式才是 xterm 的规定顺序；反过来偶发残留 1000。
 */

import { ESC } from "./protocol.js";

/** 要跟踪的鼠标动作档次：拖拽 = 按键按住时的移动（1002），空按移动 = 悬停也报（1003） */
export interface MouseTracking {
  drag: boolean;
  motion: boolean;
}

const DRAG_ON = `${ESC}[?1002h`;
const DRAG_OFF = `${ESC}[?1002l`;
const MOTION_ON = `${ESC}[?1003h`;
const MOTION_OFF = `${ESC}[?1003l`;
const BASIC_ON = `${ESC}[?1000h`;
const BASIC_OFF = `${ESC}[?1000l`;
const SGR_ON = `${ESC}[?1006h`;
const SGR_OFF = `${ESC}[?1006l`;

/** 开跟踪；`1000`（按下 / 释放）与 `1006`（SGR 坐标）无条件带上 */
export function enableMouseTracking({ drag, motion }: MouseTracking): string {
  return BASIC_ON + (drag ? DRAG_ON : "") + (motion ? MOTION_ON : "") + SGR_ON;
}

/** 关跟踪：按开启的逆序写回，全部关掉（见文件头的逆序要求） */
export function disableMouseTracking(): string {
  return SGR_OFF + MOTION_OFF + DRAG_OFF + BASIC_OFF;
}