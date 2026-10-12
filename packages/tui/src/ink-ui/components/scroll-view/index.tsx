/**
 * @fileoverview `ScrollView`：纵向滚动容器（内容整体下移 + 溢出裁掉）
 * @module ink-ui/components/scroll-view
 * @description
 * ink 没有滚动容器，本组件拿两格盒子凑出来：
 * - **视口** `<Box overflow="hidden">`：ink 渲染到它时对输出 `clip`，溢出的行直接不画。
 * - **内容盒** `marginTop={offset}`：把内容整体往下顶，顶掉的那几行正好被裁掉 ⇒ 滚了几行就露出第几行。
 *   ⚠️ 内容盒必须 `flexShrink={0}`（ink 默认 1）：否则 yoga 把它压扁到视口高度，`marginTop` 只剩空白。
 *
 * 滚动上限 = 内容高度 − 视口高度，两者都是 `useBoxMetrics` 量出来的**布局值**（裁剪只影响画到屏上的
 * 那一层，不改被裁节点自己的高度）。内容变短时把越界的滚动位置拉回上限，否则下一次上滚会卡住不回弹。
 *
 * 滚动条只画拇指，不画轨道：`color.divider` 的静息色与底色同色，轨道画出来也看不见。拇指长度按
 * `视口² / 内容` 比例取，最少 1 行，位置按 `滚动量 / 上限` 分。
 * ⚠️ **默认不显示滚动条**（`showScrollbar` 默认 `false`）：滚得动，但看不见；内容装得下时什么都不画。
 *
 * 滚轮走本包的 `useMouse`：`wheel` 逐条派发（`move` / `drag` 才按帧合并），所以一格滚一格，不合并。
 * ⚠️ 命中测试量的是**布局树坐标**，只在 live region 顶部 = 屏幕顶部时与鼠标的终端视口坐标相等
 * （与 `layout/split-layout.tsx` 同一个前提）。
 */

import { useEffect, useRef, useState } from "react";
import { Box, measureElement, useBoxMetrics } from "ink";
import type { DOMElement } from "ink";
import { useMouse } from "@/ink-ui/hooks/mouse/index.js";
import { color } from "@/ink-ui/theme/index.js";
import type { ScrollViewProps } from "./type.js";

export type { ScrollViewProps } from "./type.js";

/** 滚轮一格滚几行的默认行数 */
const DEFAULT_WHEEL_STEP = 3;

/** 滚动条固定占 1 列 */
const BAR_WIDTH = 1;

/** 夹取；`low > high` 时以 `low` 为准 */
function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}

/**
 * 纵向滚动容器：内容超出的部分被视口裁掉，滚轮在指针落在本容器内时上下滚。
 *
 * ```tsx
 * <ScrollView showScrollbar>
 *   <Messages />
 * </ScrollView>
 * ```
 */
export function ScrollView({
  children,
  height,
  showScrollbar = false,
  scrollbarColor = color.border,
  wheelStep = DEFAULT_WHEEL_STEP,
}: ScrollViewProps) {
  /** 整块（视口 + 滚动条）：滚轮命中测试量它 */
  const rootRef = useRef<DOMElement | null>(null);
  /** 内容盒：量它得出内容有多高 */
  const contentRef = useRef<DOMElement | null>(null);

  const { height: measuredRows } = useBoxMetrics(rootRef);
  const { height: contentRows } = useBoxMetrics(contentRef);

  const [offset, setOffset] = useState(0);

  /** 给了 `height` 就以它为准（首帧量出来的 0 会让滚动条闪一帧），没给才用量到的视口高度 */
  const rows = height ?? measuredRows;
  /** 滚得动的最大行数：内容装得下就是 0 */
  const maxOffset = Math.max(0, contentRows - rows);

  /** 上限走 ref：滚轮回调里要立刻读到，不等下一次渲染 */
  const maxOffsetRef = useRef(maxOffset);
  useEffect(() => {
    maxOffsetRef.current = maxOffset;
  }, [maxOffset]);

  /** 越界的位置（内容变矮了）只夹在渲染值上看着对，状态本身要拉回来，否则下一次上滚会卡住 */
  const shown = clamp(offset, 0, maxOffset);
  useEffect(() => {
    if (offset !== shown) setOffset(shown);
  }, [offset, shown]);

  useMouse((event) => {
    if (event.type !== "wheel") return;
    // 只接纵向滚轮：横滚（left / right）不归本容器管
    if (event.direction !== "up" && event.direction !== "down") return;
    const node = rootRef.current;
    if (!node) return;
    const box = measureElement(node);
    const inside =
      event.x >= box.x &&
      event.x < box.x + box.width &&
      event.y >= box.y &&
      event.y < box.y + box.height;
    if (!inside) return;
    const step = event.direction === "down" ? wheelStep : -wheelStep;
    setOffset((previous) => clamp(previous + step, 0, maxOffsetRef.current));
  });

  const scrollable = maxOffset > 0;
  /** 拇指：按 `视口² / 内容` 的比例取，至少 1 行、不超过视口 */
  const thumbRows = scrollable
    ? clamp(Math.round((rows * rows) / contentRows), 1, rows)
    : 0;
  /** 拇指顶端那一段空白 */
  const thumbTop = scrollable
    ? Math.round(((rows - thumbRows) * shown) / maxOffset)
    : 0;

  return (
    <Box
      ref={rootRef}
      flexDirection="row"
      height={height}
      // 没给 `height` 就吃掉父容器剩下的竖向空间；给了就别再 `flexGrow`，否则两处都在抢高度
      flexGrow={height === undefined ? 1 : 0}
      minHeight={0}
    >
      <Box
        flexDirection="column"
        flexGrow={1}
        flexBasis={0}
        minWidth={0}
        minHeight={0}
        overflow="hidden"
      >
        <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={shown}>
          {children}
        </Box>
      </Box>
      {showScrollbar && scrollable ? (
        <Box width={BAR_WIDTH} flexShrink={0} flexDirection="column">
          <Box height={thumbTop} />
          <Box height={thumbRows} backgroundColor={scrollbarColor} />
          <Box flexGrow={1} />
        </Box>
      ) : null}
    </Box>
  );
}