/**
 * @fileoverview 终端宽高：组合根那次快照是**初值**，此后跟 `resize`（本包唯一挂 `resize` 的文件）
 */

import { useEffect, useState } from "react";
import { useStdout } from "ink";

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

function usable(value: number | undefined): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

/** 终端当前的宽高（初值 = `initial`，此后跟 `resize`）；⚠️ 挂载时不自己再采一次；依赖取 `initial.columns`/`.rows` 两个数而不是 `initial` 那个对象 */
export function useTerminalSize(initial: TerminalSize): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(initial);

  useEffect(() => {
    const onResize = (): void => {
      setSize((before) => {
        const next: TerminalSize = {
          columns: usable(stdout.columns) ?? initial.columns,
          rows: usable(stdout.rows) ?? initial.rows,
        };
        // ⚠️ 原样返回 `before` = React bail-out：本包布局恒等于整屏，多一次重绘就是一次整屏重写
        if (next.columns === before.columns && next.rows === before.rows) return before;
        return next;
      });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, initial.columns, initial.rows]);

  return size;
}
