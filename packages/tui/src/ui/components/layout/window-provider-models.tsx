/**
 * @fileoverview 编辑某个提供商的模型清单：最上面那个**恒占第 0 槽**的过滤框 + 一行说明 + 若干勾选行；⚠️ 与其余四档互不认识
 */

import { Box, Text } from "ink";

import { WINDOW_INPUT_PROMPT_COLUMNS, ellipsis, widthOf } from "@/lib/index.js";
import { MARK_BLANK, MARK_SELECTED, tone } from "../constants.js";
import type { ModalView, RegionProps } from "../types.js";
import { SlotLine, WindowCard } from "./window-card.js";
import { slotsOf } from "./window-slots.js";

/** 过滤框的提示符（⚠️ **显示宽度必须等于** {@link WINDOW_INPUT_PROMPT_COLUMNS} —— 几何层不认识字形） */
// ⚠️ 与改名框**不共用一个字形**：那一个是「给这条会话改名」，这一个是「筛出要的那几行」，两件事各有各的入口。
const FILTER_PROMPT = "▸ ";

/** 勾选位：**纯 ASCII** —— 它要在无色终端里读得出来，而框里那几列正是命中测试按它算的 */
// ⚠️ 刻意不用 `☑` / `☐`：两者的 East Asian Width 是 **Ambiguous**（按 CJK 宽度渲染的终端里是四列），
// 而 `string-width` 按六列算 —— 少算的话那一行的列位在两帧之间跳，点它落错行。
const CHECKED = "[x]";
const UNCHECKED = "[ ]";

/** 全局置顶那一枚（⚠️ 它答的是「置顶」，与勾选、与高亮是三件事） */
const PIN_MARK = "★";

/** 「这一行在等第二次 `Ctrl+D`」那一档（⚠️ 与悬停那枚「✕」同一档：屏上两处说的是同一句「别按」） */
const PENDING_TONE = "danger" as const;

/** 收窄到模型清单那一档（`null` = 这一帧是别的那种内容） */
function modelsView(
  view: ModalView | null,
): Extract<ModalView, { readonly kind: "provider-models" }> | null {
  return view !== null && view.kind === "provider-models" ? view : null;
}

export function ProviderModelsWindow(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const view = modelsView(props.view);
  if (view === null || g.windowBox === null) return <Box />;
  const box = g.windowBox;
  const sel = tone(theme, "selected");
  const slots = slotsOf(view, null);
  /** 勾选行从第几槽起（过滤框恒占第 0 槽，说明占中间那一格） */
  const rowsAt = view.note === null ? 1 : 2;
  return (
    <WindowCard g={g} theme={theme} label={view.title}>
      {slots.map((slot, i) => {
        // ⚠️ **逐槽按同一下标读**：几何层给的 `windowSlots` 与入参那串槽位**同序同长**，装不下的给
        // `null` 而长度不变 —— 少读一格、或把 `null` 当照画，下面那些行都会整体错位一格。
        const rect = g.windowSlots[i] ?? null;
        if (rect === null) return null;
        switch (slot.kind) {
          case "input": {
            // ⚠️ **过滤框恒是第 0 槽**，而那一格恒有焦点 ⇒ 它是这一屏唯一收键的地方。
            const text = g.windowInputTexts[i] ?? null;
            if (text === null) return null;
            const budget = Math.max(0, text.width);
            // ⚠️ **插入符与改名框、`Composer` 同一套画法**：焦点在那一格就画出「光标在第几个字」，
            // 而这一格恒有焦点 ⇒ 那个块恒在（**留空 = 不改**那一格时它落在第 0 格，是「等你敲」）。
            const showCaret = view.filter.focused;
            const at = Math.max(0, Math.min(view.filter.cursor, view.filter.value.length));
            const cell = showCaret ? (view.filter.value[at] ?? " ") : "";
            const cellWidth = widthOf(cell);
            const head = ellipsis(view.filter.value.slice(0, at), Math.max(0, budget - cellWidth));
            const tail =
              cell === ""
                ? ""
                : ellipsis(view.filter.value.slice(at + 1), Math.max(0, budget - widthOf(head) - cellWidth));
            const value = cell === "" ? head : `${head}${cell}${tail}`;
            const used = WINDOW_INPUT_PROMPT_COLUMNS + widthOf(value);
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - used)}>
                <Text color={tone(theme, "accent")}>{FILTER_PROMPT}</Text>
                {/* ⚠️ **恒有焦点 ⇒ 恒最亮 + 加粗**：这一格是这一屏唯一在收键的地方，
                    而「那一格有底色」这个通道在无色终端里压根不存在。 */}
                <Text color={sel} bold>
                  {head}
                </Text>
                {cell === "" ? null : (
                  <Text color={sel} backgroundColor={sel}>
                    {cell}
                  </Text>
                )}
                <Text color={sel} bold>
                  {tail}
                </Text>
              </SlotLine>
            );
          }
          case "note": {
            const text = ellipsis(view.note ?? "", rect.width);
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - widthOf(text))}>
                <Text color={tone(theme, "muted")}>{text}</Text>
              </SlotLine>
            );
          }
          case "check": {
            const row = view.rows[i - rowsAt];
            if (row === undefined) return null;
            const isAt = i - rowsAt === view.at;
            const mark = `${isAt ? MARK_SELECTED : MARK_BLANK} `;
            const tick = row.checked ? CHECKED : UNCHECKED;
            const pin = row.pinned ? `${PIN_MARK} ` : "";
            const room = Math.max(0, rect.width - widthOf(mark) - widthOf(tick) - widthOf(pin) - 1);
            const label = ellipsis(row.label, room);
            const used = widthOf(mark) + widthOf(tick) + 1 + widthOf(pin) + widthOf(label);
            // ⚠️ 勾选位**不吃高亮**：勾与高亮是「它是不是这一份清单里的」与「我现在指着哪一行」，
            // 合成一格的话按 `Space` 与按 `↑↓` 在屏上分不出分别改了哪一件事。
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - used)}>
                <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
                  {mark}
                </Text>
                <Text
                  color={isAt ? sel : tone(theme, row.pending ? PENDING_TONE : "ok")}
                  bold={isAt}
                >
                  {`${tick} `}
                </Text>
                {row.pinned ? <Text color={tone(theme, "warn")}>{pin}</Text> : null}
                <Text color={isAt ? sel : tone(theme, row.pending ? PENDING_TONE : "accent")} bold={isAt}>
                  {label}
                </Text>
              </SlotLine>
            );
          }
          default:
            // ⚠️ 模型清单这一档只有那三档槽位；这一支让几何层多一档时落成空行而不是错位。
            return null;
        }
      })}
    </WindowCard>
  );
}