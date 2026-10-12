/**
 * @fileoverview `ScrollView` 的类型
 * @module ink-ui/components/scroll-view/type
 * @description
 * 纯类型，没有运行期值。
 */

import type { ReactNode } from "react";

export interface ScrollViewProps {
  /** 滚动区内容；不保证只渲染视口那几行，超出的部分靠视口裁掉 */
  children: ReactNode;
  /** 视口高度（行）；不给就靠父容器的 `flexGrow` 撑出来 */
  height?: number;
  /** 是否显示滚动条（默认 `false`：滚得动，但看不见） */
  showScrollbar?: boolean;
  /** 滚动条颜色（默认 `color.border`） */
  scrollbarColor?: string;
  /** 滚轮一格滚几行（默认 3） */
  wheelStep?: number;
}