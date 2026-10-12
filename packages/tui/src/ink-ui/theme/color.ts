/**
 * @fileoverview 语义色：把 `palette.ts` 的原色钉到**角色**上
 * @module ink-ui/theme/color
 * @description
 * 名字答「用在哪」：`surface`（侧栏底）、`dividerHover`（分隔条悬停）、`textDim`（次要文字）。
 * 换主题 / 明暗对调只动本文件，界面代码一行不改。
 *
 * 同族档位有序：`divider` → `dividerHover` → `dividerActive` 逐档变亮，`text` 一系由强到弱。
 *
 * 纯数据层：零 IO、零 React、零依赖。
 */

import { blue, gray, green, orange, purple, red, yellow } from "./palette.js";

/** 侧栏 / 面板底色。分隔条静息态与它**同色**，故抽出来共用一份引用 */
const surface = gray.gray3;

/** 语义色：按角色取，界面只引这一份 */
export const color = {
  // ── 底与面 ────────────────────────────────────────────────────────────────
  /** 终端 / 备用屏幕的底 */
  background: gray.gray1,
  /** 主工作区（右栏）的底 */
  canvas: gray.gray1,
  /** 侧栏 / 面板的底（左栏用它） */
  surface,
  /** 浮在面上的元素：下拉、弹窗、选中项 */
  surfaceRaised: gray.gray4,
  /** 压得更深的区（代码块、日志窗） */
  surfaceDeep: gray.gray2,

  // ── 线与框 ────────────────────────────────────────────────────────────────
  /** 常态边框 */
  border: gray.gray5,
  /** 淡边框：有框但不抢戏的分组 */
  borderMuted: gray.gray4,
  /** 分隔条静息色：与 `surface` 同色，静息态看不出「有一条」 */
  divider: surface,
  /** 分隔条悬停色：亮一档 */
  dividerHover: gray.gray4,
  /** 分隔条拖动中色：再亮一档 */
  dividerActive: gray.gray5,

  // ── 文字（由强到弱） ──────────────────────────────────────────────────────
  /** 正文与主要信息 */
  text: gray.gray8,
  /** 标题、强调数值 */
  textStrong: gray.gray9,
  /** 次要文字：标签、单位、时间戳 */
  textDim: gray.gray7,
  /** 更弱的说明文字 */
  textFaint: gray.gray6,
  /** 占位符 / 禁用文字：不可承载信息 */
  textGhost: gray.gray5,
  /** 实心底上的反白文字 */
  textInverse: gray.gray1,

  // ── 主色与状态 ────────────────────────────────────────────────────────────
  /** 主色：焦点、选中、可点 */
  accent: blue.blue5,
  /** 主色弱化档：选中行的底、悬停底 */
  accentMuted: blue.blue3,
  /** 主色上的文字 */
  accentText: blue.blue8,
  /** 成功 / 在线 / 已完成 */
  success: green.green5,
  /** 警告 / 待处理 */
  warning: yellow.yellow5,
  /** 介于警告与错误之间：重试、降级 */
  caution: orange.orange5,
  /** 错误 / 失败 / 危险 */
  danger: red.red5,
  /** 中性提示 */
  info: blue.blue5,
  /** 特殊标记（缓存命中、实验特性） */
  special: purple.purple6,
} as const;

/** 语义色的取值类型 */
export type ColorToken = (typeof color)[keyof typeof color];
