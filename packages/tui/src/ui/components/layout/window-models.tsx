/**
 * @fileoverview 选模型那张弹窗的内容区：按提供商**分组**渲染，置顶的带 `★`；⚠️ 与其余四档互不认识
 */

import { Box, Text } from "ink";

import { ellipsis, widthOf } from "@/lib/index.js";
import { MARK_BLANK, MARK_SELECTED, tone } from "../constants.js";
import type { ModalView, RegionProps } from "../types.js";
import { SlotLine, WindowCard } from "./window-card.js";
import { slotsOf } from "./window-slots.js";

/** 分组标题那一行的色档（⚠️ **它不吃高亮**：它是标题不是可选项，吃了就与「选中了哪一行」读起来一样） */
const HEADER_TONE = "muted" as const;

/** 全局置顶那一枚（⚠️ 它答的是「这一行排在最前」，与勾选、与高亮是三件事） */
const PIN_MARK = "★";

/** 收窄到选模型那一档（`null` = 这一帧是别的那种内容） */
function pickerView(view: ModalView | null): Extract<ModalView, { readonly kind: "models" }> | null {
  return view !== null && view.kind === "models" ? view : null;
}

export function ModelsWindow(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const view = pickerView(props.view);
  if (view === null || g.windowBox === null) return <Box />;
  const box = g.windowBox;
  const sel = tone(theme, "selected");
  /** 可选行从第几槽起（说明那一行占了第 0 槽；`null` 时它根本不占槽） */
  const rowsAt = view.note === null ? 0 : 1;
  /** 逐行「它是第几个**可选**模型」（⚠️ `-1` = 那一行是分组标题，它不进那个计数） */
  const pick = pickOrder(view.rows);
  return (
    <WindowCard g={g} theme={theme} label={view.title}>
      {slotsOf(view, null).map((slot, i) => {
        // ⚠️ **逐槽按同一下标读**：几何层给的 `windowSlots` 与入参那串槽位**同序同长**，装不下的给
        // `null` 而长度不变 —— 少读一格、或把 `null` 当照画，下面那些行都会整体错位一格。
        const rect = g.windowSlots[i] ?? null;
        if (rect === null) return null;
        switch (slot.kind) {
          case "note": {
            const text = ellipsis(view.note ?? "", rect.width);
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - widthOf(text))}>
                <Text color={tone(theme, "muted")}>{text}</Text>
              </SlotLine>
            );
          }
          case "group": {
            const row = view.rows[i - rowsAt];
            if (row === undefined) return null;
            // ⚠️ **标题行没有记号、也不加粗**：它是「按提供商分组」那一行，而记号与加粗是
            // 「可不可选」的两个通道 —— 标题吃了它们，屏上就分不出它是标题还是一条可选模型。
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - widthOf(row.label))}>
                <Text color={tone(theme, HEADER_TONE)}>{row.label}</Text>
              </SlotLine>
            );
          }
          case "row": {
            const row = view.rows[i - rowsAt];
            if (row === undefined) return null;
            const isAt = pick[i - rowsAt] === view.at;
            const mark = `${isAt ? MARK_SELECTED : MARK_BLANK} `;
            const pin = row.pinned ? `${PIN_MARK} ` : "";
            // ⚠️ `label` 是**状态层裁好的那一份**，本层一个字都不许自己裁：记号与 `★` 只参与留白。
            const room = Math.max(0, rect.width - widthOf(mark) - widthOf(pin));
            const label = ellipsis(row.label, room);
            const used = widthOf(mark) + widthOf(pin) + widthOf(label);
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - used)}>
                <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
                  {mark}
                </Text>
                {row.pinned ? <Text color={tone(theme, "warn")}>{pin}</Text> : null}
                <Text color={isAt ? sel : tone(theme, "accent")} bold={isAt}>
                  {label}
                </Text>
              </SlotLine>
            );
          }
          default:
            // ⚠️ 选模型这一档只有那三档槽位；这一支让几何层多一档时落成空行而不是错位。
            return null;
        }
      })}
    </WindowCard>
  );
}

/** 逐行「它是第几个**可选**模型」（`-1` = 那一行是分组标题；⚠️ `view.at` 数的是这个而不是数组下标） */
function pickOrder(rows: readonly { readonly header: string | null }[]): readonly number[] {
  const out: number[] = [];
  let selectable = 0;
  for (const row of rows) {
    const isRow = row.header === null;
    out.push(isRow ? selectable : -1);
    if (isRow) selectable += 1;
  }
  return out;
}