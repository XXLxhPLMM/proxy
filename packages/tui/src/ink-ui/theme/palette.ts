/**
 * @fileoverview 调色板：**原色**（灰阶 + 六色相）× **九档明度**，不含任何语义
 * @module ink-ui/theme/palette
 * @description
 * 名字两段：`<色相><档位>`（`gray9` 最亮，`blue4` 中偏深）。档位 1–9 是同一把尺子，越大越亮。
 *
 * 色值是 HEX —— ink 的 `colorize.js` 吃 HEX / `ansi256(n)` / `rgb()` / chalk 具名四种写法，选 HEX 是
 * 因为 chalk 会按终端能力自动降档（16 色 → 256 色 → truecolor），不必自己维护两套常量。
 *
 * 纯数据层：零 IO、零 React、零依赖。
 */

/** 灰阶（界面骨架：底色、文字、边框、分隔条） */
export const gray = {
  /** 纯黑：备用屏幕的底、需要「彻底压下去」的填充 */
  gray1: "#000000",
  /** 近黑：页面底色 */
  gray2: "#0d0d0d",
  /** 深灰：侧栏 / 面板底色 */
  gray3: "#1a1a1a",
  /** 稍亮的深灰：卡片、选中项的底 */
  gray4: "#262626",
  /** 中深灰：弱分隔线、禁用边框 */
  gray5: "#3d3d3d",
  /** 中灰：常态边框、分隔条 */
  gray6: "#5c5c5c",
  /** 中亮灰：次要文字、图标 */
  gray7: "#8c8c8c",
  /** 亮灰：主要文字的弱化档（暗色终端上做正文最舒服） */
  gray8: "#c0c0c0",
  /** 纯白：标题、强调文字 */
  gray9: "#ffffff",
} as const;

/** 蓝：主色（焦点、选中、链接、品牌色） */
export const blue = {
  blue1: "#001a33",
  blue2: "#003366",
  blue3: "#004c99",
  blue4: "#0066cc",
  blue5: "#0088ff",
  blue6: "#33a3ff",
  blue7: "#66bbff",
  blue8: "#99d4ff",
  blue9: "#cce9ff",
} as const;

/** 青：拖拽 / 拖动中的强调色（与蓝色的「选中」语义分开） */
export const cyan = {
  cyan1: "#002b2b",
  cyan2: "#004d4d",
  cyan3: "#007070",
  cyan4: "#009999",
  cyan5: "#00c2c2",
  cyan6: "#33d6d6",
  cyan7: "#66e0e0",
  cyan8: "#99ebeb",
  cyan9: "#ccf5f5",
} as const;

/** 绿：成功、在线、已完成 */
export const green = {
  green1: "#002b12",
  green2: "#004d20",
  green3: "#007030",
  green4: "#009940",
  green5: "#00c250",
  green6: "#33d673",
  green7: "#66e096",
  green8: "#99ebb9",
  green9: "#ccf5dc",
} as const;

/** 黄：警告、待处理、限流 */
export const yellow = {
  yellow1: "#332600",
  yellow2: "#4d3a00",
  yellow3: "#806000",
  yellow4: "#b38600",
  yellow5: "#e6ac00",
  yellow6: "#ffc233",
  yellow7: "#ffd166",
  yellow8: "#ffe099",
  yellow9: "#fff0cc",
} as const;

/** 橙：介于黄与红之间（重试、降级） */
export const orange = {
  orange1: "#331400",
  orange2: "#4d1f00",
  orange3: "#803300",
  orange4: "#b34700",
  orange5: "#e65c00",
  orange6: "#ff7a33",
  orange7: "#ff9c66",
  orange8: "#ffbd99",
  orange9: "#ffdecc",
} as const;

/** 红：错误、失败、危险操作 */
export const red = {
  red1: "#330b0b",
  red2: "#4d1111",
  red3: "#801c1c",
  red4: "#b32626",
  red5: "#e63030",
  red6: "#ff5c5c",
  red7: "#ff8585",
  red8: "#ffadad",
  red9: "#ffd6d6",
} as const;

/** 紫：特殊标记（缓存命中、实验特性） */
export const purple = {
  purple1: "#1f0b33",
  purple2: "#33114d",
  purple3: "#4c1a80",
  purple4: "#6626b3",
  purple5: "#8033e6",
  purple6: "#995cff",
  purple7: "#b385ff",
  purple8: "#ccadff",
  purple9: "#e6d6ff",
} as const;
