/**
 * @fileoverview 控制面清单那张模态卡片的**内容区**（逐槽画）；⚠️ 与历史会话那一份互不认识
 */

import { Box, Text } from "ink";

import { ellipsis, widthOf } from "@/lib/index.js";
import { connectionMark } from "@/theme/index.js";
import { MARK_BLANK, MARK_SELECTED, tone } from "../constants.js";
import type { RegionProps } from "../types.js";
import { SlotLine, WindowCard } from "./window-card.js";
import { managerSlotsOf } from "./window-slots.js";

export function Window(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const view = props.window;
  if (view === null || g.windowBox === null) return <Box />;
  const box = g.windowBox;
  const sel = tone(theme, "selected");
  /** 可选行从第几槽起（说明那一行占了第 0 槽；`null` 时它根本不占槽） */
  const rowsAt = view.note === null ? 0 : 1;
  return (
    <WindowCard g={g} theme={theme} label={view.title}>
      {managerSlotsOf(view).map((slot, i) => {
        // ⚠️ **逐槽按同一下标读**：几何层给的 `windowSlots` 与入参那串槽位**同序同长**，装不下的给
        // `null` 而长度不变 —— 少读一格、或把 `null` 当照画，下面那些行都会整体错位一格。
        const rect = g.windowSlots[i] ?? null;
        if (rect === null) return null;
        switch (slot.kind) {
          case "note": {
            const text = ellipsis(view.note ?? "", rect.width);
            return (
              <SlotLine
                key={i}
                box={box}
                slot={rect}
                fill={Math.max(0, rect.width - widthOf(text))}
              >
                <Text color={tone(theme, "muted")}>{text}</Text>
              </SlotLine>
            );
          }
          case "row": {
            const row = view.rows[i - rowsAt];
            if (row === undefined) return null;
            const isAt = i - rowsAt === view.at;
            const mark = `${isAt ? MARK_SELECTED : MARK_BLANK} `;
            const tail = row.current ? " ←当前" : "";
            // ⚠️ 逐段预算：**记号那两列**与**「当前」那个记号**先扣掉 —— 少扣的话右边被吃掉一格，
            // 而一段超宽会让整行超宽（Ink 静默软换行 ⇒ 卡片里多出一行而下面那些行被挤出卡片）。
            const room = Math.max(0, rect.width - widthOf(mark) - widthOf(tail));
            const nameWidth = Math.min(widthOf(row.name), Math.floor(room / 2));
            const glyph = row.state === null ? "" : connectionMark(row.state).glyph;
            const name = ellipsis(row.name, nameWidth);
            const detail = ellipsis(` ${glyph} ${row.detail}`, Math.max(0, room - nameWidth));
            const used = widthOf(mark) + widthOf(name) + widthOf(detail) + widthOf(tail);
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - used)}>
                <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
                  {mark}
                </Text>
                <Text color={isAt ? sel : tone(theme, "accent")} bold={isAt}>
                  {name}
                </Text>
                <Text color={isAt ? sel : tone(theme, "muted")} bold={isAt}>
                  {detail}
                </Text>
                {/* ⚠️ 右侧那个记号回答「**当前会话连的就是它吗**」—— 与高亮是两件事：高亮是
                    「指针/键盘停在哪」，它是「已生效的是哪一台」。 */}
                {row.current ? (
                  <Text color={sel} bold>
                    {tail}
                  </Text>
                ) : null}
              </SlotLine>
            );
          }
          default:
            // ⚠️ **`WindowView` 里既没有分组标题也没有改名框**，故那两档在本组件里**不可能**出现；
            // 这一支只是让 `kind` 多出一档时不至于静默画出一行空盒子。
            return null;
        }
      })}
    </WindowCard>
  );
}
