/**
 * @fileoverview 编辑某个提供商的模型清单：最上面那个过滤框 + 一行说明 + 若干勾选行；⚠️ 与其余四档互不认识
 * （flex 布局：逐行 `<Box>` + `<Text wrap="truncate">`，不再读几何层的槽位矩形）
 */

import { Box, Text } from "ink";

import { MARK_BLANK, MARK_SELECTED, tone } from "../constants.js";
import type { ModalView, RegionProps } from "../types.js";
import { SlotLine, WindowCard } from "./window-card.js";

/** 过滤框的提示符（⚠️ 与改名框**不共用一个字形**：那一个是「给这条会话改名」，这一个是「筛出要的那几行」，两件事各有各的入口） */
const FILTER_PROMPT = "▸ ";

/** 勾选位：**纯 ASCII** —— 它要在无色终端里读得出来 */
// ⚠️ 刻意不用 `☑` / `☐`：两者的 East Asian Width 是 **Ambiguous**（按 CJK 宽度渲染的终端里是四列），
// 而字形列数一旦算错，那一行的列位在两帧之间跳。
const CHECKED = "[x]";
const UNCHECKED = "[ ]";

/** 全局置顶那一枚（⚠️ 它答的是「置顶」，与勾选、与高亮是三件事） */
const PIN_MARK = "★";

/** 「这一行在等第二次 `Ctrl+D`」那一档（⚠️ `danger` 那一档：屏上读作「别按」） */
const PENDING_TONE = "danger" as const;

/** 收窄到模型清单那一档（`null` = 这一帧是别的那种内容） */
function modelsView(
  view: ModalView | null,
): Extract<ModalView, { readonly kind: "provider-models" }> | null {
  return view !== null && view.kind === "provider-models" ? view : null;
}

export function ProviderModelsWindow(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  const view = modelsView(props.view);
  if (view === null) return <Box />;
  const sel = tone(theme, "selected");
  // ⚠️ **过滤框恒有焦点**：它是这一屏唯一收键的地方（键位走 `useHotkeys`，本层不自挂 `useInput`）。
  const filter = view.filter;
  const filterAt = Math.max(0, Math.min(filter.cursor, filter.value.length));
  const filterHead = filter.value.slice(0, filterAt);
  const filterCell = filter.focused ? (filter.value[filterAt] ?? " ") : "";
  const filterTail = filter.focused ? filter.value.slice(filterAt + 1) : filter.value.slice(filterAt);
  return (
    <WindowCard
      theme={theme}
      columns={props.columns}
      label={view.title}
      closeHint={view.closeHint}
    >
      <SlotLine>
        {/* ⚠️ **恒有焦点 ⇒ 恒最亮 + 加粗**：这一格是这一屏唯一在收键的地方，
            而「那一格有底色」这个通道在无色终端里压根不存在。插入符是反底色块（与 `Composer` 同一套画法）。 */}
        <Text wrap="truncate">
          <Text color={tone(theme, "accent")} wrap="truncate">
            {FILTER_PROMPT}
          </Text>
          <Text color={sel} bold wrap="truncate">
            {filterHead}
          </Text>
          {filterCell === "" ? null : (
            <Text color={sel} backgroundColor={sel} wrap="truncate">
              {filterCell}
            </Text>
          )}
          <Text color={sel} bold wrap="truncate">
            {filterTail}
          </Text>
        </Text>
      </SlotLine>
      {view.note === null ? null : (
        <SlotLine>
          <Text color={tone(theme, "muted")} wrap="truncate">
            {view.note}
          </Text>
        </SlotLine>
      )}
      {view.rows.map((row, index) => {
        const isAt = index === view.at;
        const mark = `${isAt ? MARK_SELECTED : MARK_BLANK} `;
        const tick = row.checked ? CHECKED : UNCHECKED;
        const pin = row.pinned ? `${PIN_MARK} ` : "";
        return (
          <SlotLine key={row.id}>
            {/* ⚠️ 整行包在一个 `truncate` 里：超宽截断整行，本层不再按列宽手算 `ellipsis` */}
            <Text wrap="truncate">
              <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt} wrap="truncate">
                {mark}
              </Text>
              {/* ⚠️ 勾选位**不吃高亮**：勾与高亮是「它是不是这一份清单里的」与「我现在指着哪一行」，
                  合成一格的话按 `Space` 与按 `↑↓` 在屏上分不出分别改了哪一件事。 */}
              <Text
                color={isAt ? sel : tone(theme, row.pending ? PENDING_TONE : "ok")}
                bold={isAt}
                wrap="truncate"
              >
                {`${tick} `}
              </Text>
              {row.pinned ? (
                <Text color={tone(theme, "warn")} wrap="truncate">
                  {pin}
                </Text>
              ) : null}
              <Text
                color={isAt ? sel : tone(theme, row.pending ? PENDING_TONE : "accent")}
                bold={isAt}
                wrap="truncate"
              >
                {row.label}
              </Text>
            </Text>
          </SlotLine>
        );
      })}
    </WindowCard>
  );
}
