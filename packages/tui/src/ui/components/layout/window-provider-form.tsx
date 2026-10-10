/**
 * @fileoverview 新增 / 编辑提供商那张表单的内容区：字段各占一行 + **恒在最后**那一行说明；⚠️ 与其余四档互不认识
 * （flex 布局：逐行 `<Box>` + `<Text wrap="truncate">`，不再读几何层的槽位矩形）
 */

import { Box, Text } from "ink";

import { tone } from "../constants.js";
import type { ModalView, RegionProps } from "../types.js";
import { SlotLine, WindowCard } from "./window-card.js";

/** 每一格左边的提示符 */
// ⚠️ **五格用同一枚**：那一列恒是同样宽，于是五个值落在同一列上，而按格换字形会让值那一列在两帧之间跳。
const FIELD_PROMPT = "✎ ";

/** 校验没过去那一句的色档（⚠️ **它与另外几档的说明不是同一件事**：那几档是常态信息，这一档是「你填错了一格」） */
const INVALID_TONE = "warn" as const;

/** 收窄到表单那一档（`null` = 这一帧是别的那种内容） */
function formView(view: ModalView | null): Extract<ModalView, { readonly kind: "provider-form" }> | null {
  return view !== null && view.kind === "provider-form" ? view : null;
}

export function ProviderFormWindow(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  const view = formView(props.view);
  if (view === null) return <Box />;
  const sel = tone(theme, "selected");
  return (
    <WindowCard
      theme={theme}
      columns={props.columns}
      label={view.title}
      closeHint={view.closeHint}
    >
      {view.fields.map((field, index) => {
        const ink = field.focused ? sel : tone(theme, "idle");
        // ⚠️ **插入符只在 `input` 那一格、且焦点压在它上面时画**：下拉里没有一段用户敲出来的字，
        // 而留在屏上的反底色块等于说「这里能落字」；非焦点那一格画它等于说「焦点还在那儿」。
        // ⚠️ 键位走 `useHotkeys`，本层不自挂 `useInput`。
        const showCaret = field.focused && field.kind === "input";
        const at = Math.max(0, Math.min(field.cursor, field.value.length));
        const head = showCaret ? field.value.slice(0, at) : field.value;
        const cell = showCaret ? (field.value[at] ?? " ") : "";
        const tail = showCaret ? field.value.slice(at + 1) : "";
        // ⚠️ **焦点是「最亮那一档 + 加粗」**：加粗是颜色之外的第二通道，无色终端里靠它认。
        // ⚠️ 下拉那一格**额外**把可选项列出来：只有当前值的话屏上答不出「`↑↓` 在这里换档」。
        const options =
          field.kind === "select" && field.options !== undefined && field.options.length > 0
            ? ` · ${field.options.join(" / ")}`
            : "";
        return (
          <SlotLine key={`field-${String(index)}`}>
            <Text wrap="truncate">
              <Text color={tone(theme, "accent")} wrap="truncate">
                {FIELD_PROMPT}
              </Text>
              <Text color={tone(theme, "muted")} wrap="truncate">
                {`${field.label} `}
              </Text>
              <Text color={ink} bold={field.focused} wrap="truncate">
                {head}
              </Text>
              {/* ⚠️ 插入符是**反底色**（颜色之外的形状通道），与 `Composer` 同一条纪律 */}
              {cell === "" ? null : (
                <Text color={sel} backgroundColor={sel} wrap="truncate">
                  {cell}
                </Text>
              )}
              <Text color={ink} bold={field.focused} wrap="truncate">
                {tail}
              </Text>
              <Text color={tone(theme, "idle")} wrap="truncate">
                {options}
              </Text>
            </Text>
          </SlotLine>
        );
      })}
      {view.note === null ? null : (
        <SlotLine>
          <Text color={tone(theme, INVALID_TONE)} wrap="truncate">
            {view.note}
          </Text>
        </SlotLine>
      )}
    </WindowCard>
  );
}
