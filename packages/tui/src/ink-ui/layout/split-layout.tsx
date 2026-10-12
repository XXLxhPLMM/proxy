/**
 * @fileoverview `SplitLayout`：左右两栏（左栏**定宽**）+ 鼠标拖中间分隔条调左栏列数
 * @module ink-ui/layout/split-layout
 * @description
 * 一行三格：左栏（定宽，单位是终端**列数**）+ 分隔条（1 列）+ 右栏（`flexGrow` 吃满剩余），
 * 三格加起来永远正好是整宽。列数分受控 / 非受控：给了 `leftWidth` 就是受控，拖动只回调
 * `onLeftWidthChange`、值由父组件写回；不给则拿 `defaultLeftWidth` 起手自己管。`showLeft={false}`
 * 或总宽不足 3 列时只渲染右栏。
 *
 * 左栏有**硬容量**：最多占整宽一半（`MAX_LEFT_RATIO`），且右栏至少留 1 列；两者取更紧的，压得过
 * 调用方给的 `minWidth` / `maxWidth` 与受控 `leftWidth`。
 *
 * 分隔条不画任何字符 / 边框，**只有底色**：静息态与左栏同色，指针悬停亮一档、拖动中再亮一档。
 * 三档色都来自 `ink-ui/theme`。
 *
 * 坐标：`measureElement` 量的是布局树坐标，鼠标上报是终端视口坐标，两者在备用屏幕（live region
 * 顶部 = 屏幕顶部）下相等。命中带横向按 `hitSlop` 放宽，按下即吸附到指针那一列。
 *
 * 纯数学只有下方的 `clamp`（无 React、无 IO）。
 */

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Box, measureElement, useWindowSize } from "ink";
import type { DOMElement } from "ink";
import { useMouse } from "@/ink-ui/hooks/mouse/index.js";
import { color } from "@/ink-ui/theme/index.js";

/** 分隔条固定占 1 列 */
const DIVIDER_WIDTH = 1;

/** 两栏各至少 1 列 + 1 列分隔条 ⇒ 窄于此就只画右栏 */
const MIN_SPLIT_WIDTH = DIVIDER_WIDTH + 2;

/** 默认左栏列数 */
const DEFAULT_LEFT_WIDTH = 29;

/** 默认下限：至少 1 列（上限默认不额外限制，只受「右栏留 1 列」与「整宽一半」约束） */
const DEFAULT_MIN_WIDTH = 1;

/** 左栏占整宽的比例上限（0.5 = 最多一半）；与「右栏留 1 列」取更紧的那个当硬容量 */
const MAX_LEFT_RATIO = 0.5;

/** 夹取；非有限值当 `min` 处理 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

export interface SplitLayoutProps {
  /** 左栏内容 */
  left: ReactNode;
  /** 右栏内容；`showLeft={false}` 时它吃满整宽 */
  right: ReactNode;
  /** 是否显示左栏（默认 `true`） */
  showLeft?: boolean;
  /** 受控左栏列数：给了它就是受控 */
  leftWidth?: number;
  /** 非受控初值（列数，默认 `DEFAULT_LEFT_WIDTH`） */
  defaultLeftWidth?: number;
  /** 列数变化回调；拖动时每换一列调一次，值已夹在 `[minWidth, maxWidth]`、「整宽一半」与「右栏留 1 列」之内 */
  onLeftWidthChange?: (width: number) => void;
  /** 左栏下限（列数，默认 1）；装不下时以硬容量为准 */
  minWidth?: number;
  /** 左栏上限（列数，默认不限；无论如何都会再夹到「整宽一半」与「右栏留 1 列」） */
  maxWidth?: number;
  /** 整块宽度（默认终端列数）——嵌在更窄的父容器里必须显式给 */
  width?: number;
  /** 整块高度（默认终端行数） */
  height?: number;
  /** 分隔条命中带（列，默认 0：只认恰好点在分隔条那一列上）；悬停判定同样按它放宽 */
  hitSlop?: number;
  /** 左栏底色，同时是分隔条静息色（默认 `color.surface`） */
  leftBackgroundColor?: string;
  /** 右栏底色（默认 `color.canvas`） */
  canvasColor?: string;
  /** 分隔条悬停色（默认 `color.dividerHover`） */
  dividerHoverColor?: string;
  /** 分隔条拖动中色（默认 `color.dividerActive`） */
  dividerActiveColor?: string;
}

/**
 * 左右分栏布局：左栏列数可控、可整体隐藏，中间分隔条可用鼠标拖动。
 *
 * ```tsx
 * <SplitLayout
 *   left={<Sessions />}
 *   right={<Messages />}
 *   showLeft={sidebarVisible}
 *   defaultLeftWidth={24}
 *   onLeftWidthChange={setSidebarWidth}
 * />
 * ```
 */
export function SplitLayout({
  left,
  right,
  showLeft = true,
  leftWidth,
  defaultLeftWidth = DEFAULT_LEFT_WIDTH,
  onLeftWidthChange,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = Number.POSITIVE_INFINITY,
  width,
  height,
  hitSlop = 0,
  leftBackgroundColor = color.surface,
  canvasColor = color.canvas,
  dividerHoverColor = color.dividerHover,
  dividerActiveColor = color.dividerActive,
}: SplitLayoutProps) {
  const { columns: terminalColumns, rows: terminalRows } = useWindowSize();
  const columns = width ?? terminalColumns;
  const rows = height ?? terminalRows;

  const [innerWidth, setInnerWidth] = useState(defaultLeftWidth);
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);
  /** 拖动标志走 ref：鼠标回调里要立刻读到，不等下一次渲染 */
  const draggingRef = useRef(false);
  /** 上一次回调出去的列数：指针停在同一列时不重复回调（受控父组件会被刷爆） */
  const emittedRef = useRef<number | null>(null);
  const rootRef = useRef<DOMElement | null>(null);

  // 上下限本身也要规整：写反了 / 越界了按夹取后的区间走。`fitMax` 是硬容量（右栏留 1 列、左栏最多
  // 占整宽一半，取两者更紧的），它压得过调用方给的下限与上限 —— 否则左栏会顶出容器 / 压掉右栏。
  const halfMax = Math.max(1, Math.floor(columns * MAX_LEFT_RATIO));
  const fitMax = Math.max(1, Math.min(columns - DIVIDER_WIDTH - 1, halfMax));
  const low = Math.min(Math.max(1, Math.min(minWidth, maxWidth)), fitMax);
  const high = Math.max(low, Math.min(Math.max(minWidth, maxWidth), fitMax));
  const leftColumns = clamp(leftWidth ?? innerWidth, low, high);

  /** 能不能分栏：左栏要显示，且宽度装得下两栏 + 分隔条 */
  const splittable = showLeft && columns >= MIN_SPLIT_WIDTH;

  /** 把「指针落在第几列」落成左栏列数：受控只回调，非受控自己存 */
  const commitWidth = (column: number) => {
    const next = clamp(column, low, high);
    if (next === emittedRef.current) return;
    emittedRef.current = next;
    if (leftWidth === undefined) setInnerWidth(next);
    onLeftWidthChange?.(next);
  };

  /** 本布局盒子的实际位置与高度（live region 坐标）；量不到就退回「按整屏算」 */
  const measureBox = () => {
    const node = rootRef.current;
    return node ? measureElement(node) : { x: 0, y: 0, width: columns, height: rows };
  };

  /** 某点是否落在分隔条命中带上（横向按 `hitSlop` 放宽，纵向限在本布局高度里） */
  const isOnDivider = (x: number, y: number) => {
    const box = measureBox();
    return (
      Math.abs(x - (box.x + leftColumns)) <= hitSlop &&
      y >= box.y &&
      y < box.y + box.height
    );
  };

  useMouse((event) => {
    // 左栏不显示时没有分隔条可拖
    if (!splittable) return;

    // 悬停要先于按键判据：空按移动上报的 `button` 是 `none`，按「只认左键」筛就收不到它
    if (event.type === "move") {
      if (!draggingRef.current) setHovering(isOnDivider(event.x, event.y));
      return;
    }

    if (event.button !== "left") return;

    if (event.type === "down") {
      const onDivider = isOnDivider(event.x, event.y);
      if (!draggingRef.current) setHovering(onDivider);
      if (!onDivider) return;
      draggingRef.current = true;
      emittedRef.current = null;
      setDragging(true);
      // 按下即吸附：`hitSlop` 放宽后指针常常落在分隔条旁边，就地跟手更自然
      commitWidth(event.x - measureBox().x);
      return;
    }

    if (!draggingRef.current) return;

    if (event.type === "drag") {
      // 拖动中不再判 y：指针可以拖出盒子（甚至拖到屏幕外），横向跟手才是预期
      commitWidth(event.x - measureBox().x);
      return;
    }

    if (event.type === "up") {
      draggingRef.current = false;
      emittedRef.current = null;
      setDragging(false);
      // 松手后指针多半还压在分隔条上：留悬停档，等下一次移动事件再判
      setHovering(isOnDivider(event.x, event.y));
    }
  });

  /** 分隔条底色：拖动中 > 悬停 > 与左栏同色（静息态看不出「有一条」） */
  const dividerTone = dragging
    ? dividerActiveColor
    : hovering
      ? dividerHoverColor
      : leftBackgroundColor;

  return (
    <Box ref={rootRef} width={columns} height={rows} flexDirection="row">
      {splittable ? (
        <>
          <Box width={leftColumns} flexShrink={0} backgroundColor={leftBackgroundColor}>
            {left}
          </Box>
          <Box width={DIVIDER_WIDTH} flexShrink={0} backgroundColor={dividerTone} />
          <Box flexGrow={1} flexBasis={0} minWidth={0} backgroundColor={canvasColor}>
            {right}
          </Box>
        </>
      ) : (
        <Box flexGrow={1} flexBasis={0} minWidth={0} backgroundColor={canvasColor}>
          {right}
        </Box>
      )}
    </Box>
  );
}
