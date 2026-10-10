/**
 * @fileoverview 选模型那张弹窗的内容区：按提供商**分组**渲染，置顶的带 `★`；⚠️ 与其余四档互不认识
 * （flex 布局：逐行 `<Box>` + `<Text wrap="truncate">`，不再读几何层的槽位矩形）
 */

import { Box, Text } from "ink";

import { MARK_BLANK, MARK_SELECTED, tone } from "../constants.js";
import type { ModalView, RegionProps } from "../types.js";
import { SlotLine, WindowCard } from "./window-card.js";

/** 分组标题那一行的色档（⚠️ **它不吃高亮**：它是标题不是可选项，吃了就与「选中了哪一行」读起来一样） */
const HEADER_TONE = "muted" as const;

/** 全局置顶那一枚（⚠️ 它答的是「这一行排在最前」，与勾选、与高亮是三件事） */
const PIN_MARK = "★";

/** 收窄到选模型那一档（`null` = 这一帧是别的那种内容） */
function pickerView(view: ModalView | null): Extract<ModalView, { readonly kind: "models" }> | null {
  return view !== null && view.kind === "models" ? view : null;
}

export function ModelsWindow(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  const view = pickerView(props.view);
  if (view === null) return <Box />;
  const sel = tone(theme, "selected");
  /** 逐行「它是第几个**可选**模型」（⚠️ `-1` = 那一行是分组标题，它不进那个计数） */
  const pick = pickOrder(view.rows);
  return (
    <WindowCard
      theme={theme}
      columns={props.columns}
      label={view.title}
      closeHint={view.closeHint}
    >
      {view.note === null ? null : (
        <SlotLine>
          <Text color={tone(theme, "muted")} wrap="truncate">
            {view.note}
          </Text>
        </SlotLine>
      )}
      {view.rows.map((row, index) => {
        if (row.header !== null) {
          // ⚠️ **标题行没有记号、也不加粗**：它是「按提供商分组」那一行，而记号与加粗是
          // 「可不可选」的两个通道 —— 标题吃了它们，屏上就分不出它是标题还是一条可选模型。
          // ⚠️ 标题那一行的字就是 `label` 本身（与历史会话那一档同一份约定）。
          return (
            <SlotLine key={`group-${String(index)}`}>
              <Text color={tone(theme, HEADER_TONE)} wrap="truncate">
                {row.label}
              </Text>
            </SlotLine>
          );
        }
        const isAt = pick[index] === view.at;
        const mark = `${isAt ? MARK_SELECTED : MARK_BLANK} `;
        const pin = row.pinned ? `${PIN_MARK} ` : "";
        return (
          <SlotLine key={row.id}>
            {/* ⚠️ 整行包在一个 `truncate` 里：超宽截断整行，本层不再按列宽手算 `ellipsis` */}
            <Text wrap="truncate">
              <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt} wrap="truncate">
                {mark}
              </Text>
              {row.pinned ? (
                <Text color={tone(theme, "warn")} wrap="truncate">
                  {pin}
                </Text>
              ) : null}
              <Text color={isAt ? sel : tone(theme, "accent")} bold={isAt} wrap="truncate">
                {row.label}
              </Text>
            </Text>
          </SlotLine>
        );
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
