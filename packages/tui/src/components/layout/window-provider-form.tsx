/**
 * @fileoverview 新增 / 编辑提供商那张表单的内容区：五个字段按固定顺序各占一行 + **恒在最后**那一行说明；⚠️ 与其余四档互不认识
 */

import { Box, Text } from "ink";

import { WINDOW_INPUT_PROMPT_COLUMNS, ellipsis, padToWidth, widthOf } from "@/lib/index.js";
import { tone } from "../constants.js";
import type { ModalView, RegionProps } from "../types.js";
import { SlotLine, WindowCard } from "./window-card.js";
import { slotsOf } from "./window-slots.js";

/** 每一格左边的提示符（⚠️ **显示宽度必须等于** {@link WINDOW_INPUT_PROMPT_COLUMNS} —— 几何层不认识字形） */
// ⚠️ **五格用同一枚**：那一列恒是同样宽，于是五个值落在同一列上，而按格换字形会让值那一列在两帧之间跳。
const FIELD_PROMPT = "✎ ";

/** 校验没过去那一句的色档（⚠️ **它与另外几档的说明不是同一件事**：那几档是常态信息，这一档是「你填错了一格」） */
const INVALID_TONE = "warn" as const;

/** 收窄到表单那一档（`null` = 这一帧是别的那种内容） */
function formView(view: ModalView | null): Extract<ModalView, { readonly kind: "provider-form" }> | null {
  return view !== null && view.kind === "provider-form" ? view : null;
}

export function ProviderFormWindow(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const view = formView(props.view);
  if (view === null || g.windowBox === null) return <Box />;
  const box = g.windowBox;
  const sel = tone(theme, "selected");
  /** 字段名那一列的宽度（**五格取最宽的那个**：按各格自己那一份的话值那一列在两帧之间跳） */
  const labelWidth = view.fields.reduce((widest, field) => Math.max(widest, widthOf(field.label)), 0);
  return (
    <WindowCard g={g} theme={theme} label={view.title}>
      {slotsOf(view, null).map((slot, i) => {
        // ⚠️ **逐槽按同一下标读**：几何层给的 `windowSlots` 与入参那串槽位**同序同长**，装不下的给
        // `null` 而长度不变 —— 少读一格、或把 `null` 当照画，下面那些行都会整体错位一格。
        const rect = g.windowSlots[i] ?? null;
        if (rect === null) return null;
        switch (slot.kind) {
          case "input":
          case "select": {
            const field = view.fields[i];
            // ⚠️ **槽位与字段的下标是同一个数**（槽位序由 `FieldCell.kind` 现算），而两者对不上
            // 意味着状态层与几何层对「第 i 格」的理解已经分叉 —— 那时**如实不画**而不是画错一格。
            if (field === undefined || field.kind !== slot.kind) return null;
            const label = padToWidth(field.label, labelWidth, "left");
            // ⚠️ 逐段预算：**提示符那几列**与**字段名**先扣掉 —— 少扣的话值那一段顶到右缘 ⇒
            // **整行超宽** ⇒ Ink 静默软换行（卡片里多出一行而下面那些掉出去）。
            const room = Math.max(0, rect.width - WINDOW_INPUT_PROMPT_COLUMNS - widthOf(label));
            // ⚠️ **插入符只在 `input` 那一格、且焦点压在它上面时画**：下拉里没有一段用户敲出来的字，
            // 而留在屏上的反底色块等于说「这里能落字」；非焦点那一格画它等于说「焦点还在那儿」。
            const showCaret = field.focused && field.kind === "input";
            const at = Math.max(0, Math.min(field.cursor, field.value.length));
            const cell = showCaret ? (field.value[at] ?? " ") : "";
            const cellWidth = widthOf(cell);
            // ⚠️ **插入符那一格先占住宽度再裁前半段**（与改名框同一条纪律）：反着算的话光标很深时
            // 前半段会顶到右缘，而多出来那一格让整行超宽 ⇒ Ink 静默软换行。
            const head = ellipsis(field.value.slice(0, at), Math.max(0, room - cellWidth));
            const tail =
              cell === ""
                ? ""
                : ellipsis(field.value.slice(at + 1), Math.max(0, room - widthOf(head) - cellWidth));
            const value = cell === "" ? head : `${head}${cell}${tail}`;
            // ⚠️ **焦点是「最亮那一档 + 加粗」**：加粗是颜色之外的第二通道，无色终端里靠它认。
            // ⚠️ 下拉那一格**额外**把可选项列出来：只有当前值的话屏上答不出「`↑↓` 在这里换档」。
            const options =
              field.kind === "select" && field.options !== undefined && field.options.length > 0
                ? ellipsis(` · ${field.options.join(" / ")}`, Math.max(0, room - widthOf(value)))
                : "";
            const used = WINDOW_INPUT_PROMPT_COLUMNS + widthOf(label) + widthOf(value) + widthOf(options);
            const ink = field.focused ? sel : tone(theme, "idle");
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - used)}>
                <Text color={tone(theme, "accent")}>{FIELD_PROMPT}</Text>
                <Text color={tone(theme, "muted")}>{label}</Text>
                <Text color={ink} bold={field.focused}>
                  {head}
                </Text>
                {/* ⚠️ 插入符是**反底色**（颜色之外的形状通道），与 `Composer` / 改名框同一条纪律 */}
                {cell === "" ? null : (
                  <Text color={sel} backgroundColor={sel}>
                    {cell}
                  </Text>
                )}
                <Text color={ink} bold={field.focused}>
                  {tail}
                </Text>
                <Text color={tone(theme, "idle")}>{options}</Text>
              </SlotLine>
            );
          }
          case "note": {
            const text = ellipsis(view.note ?? "", rect.width);
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - widthOf(text))}>
                <Text color={tone(theme, INVALID_TONE)}>{text}</Text>
              </SlotLine>
            );
          }
          default:
            // ⚠️ 表单这一档只有「每一格一槽」与说明两档槽位；这一支让几何层多一档时落成空行而不是错位。
            return null;
        }
      })}
    </WindowCard>
  );
}