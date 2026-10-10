/**
 * @fileoverview 历史会话弹窗的内容区：分组标题 + 可选会话 + **恒在最后**那个改名框；⚠️ 与其余四档互不认识
 * （flex 布局：逐行 `<Box>` + `<Text wrap="truncate">`，不再读几何层的槽位矩形）
 */

import { Box, Text } from "ink";

import { MARK_BLANK, MARK_SELECTED, tone } from "../constants.js";
import type { ModalView, RegionProps, SessionListRow } from "../types.js";
import { SlotLine, WindowCard } from "./window-card.js";

/** 分组标题那一行的色档（⚠️ **它不吃高亮**：它是标题不是可选项，吃了就与「选中了哪一行」读起来一样） */
const HEADER_TONE = "muted" as const;

/** 「已经在侧边栏上」那一枚的记号与色档（⚠️ **与高亮记号不同形也不同色**） */
// ⚠️ 它答的是「已激活」，而高亮答的是「指针/键盘停在哪」—— 两个事实渲染成同一个东西就分不出
// 「它已经在侧边栏上」与「我现在正指着它」。
const PINNED_MARK = "◉";
const PINNED_TONE = "ok" as const;

/** 「这一行在等第二次 `Ctrl+D`」那一档（⚠️ `danger` 那一档：屏上读作「别按」） */
const PENDING_TONE = "danger" as const;

/** 改名框的提示符 */
const RENAME_PROMPT = "✎ ";

/** 收窄到历史会话那一档（`null` = 这一帧是别的那种内容） */
function sessionsView(view: ModalView | null): Extract<ModalView, { readonly kind: "sessions" }> | null {
  return view !== null && view.kind === "sessions" ? view : null;
}

export function SessionsWindow(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  const view = sessionsView(props.view);
  if (view === null) return <Box />;
  const sel = tone(theme, "selected");
  /** 逐行「它是第几个**可选**会话」（⚠️ `-1` = 那一行是分组标题，它不进那个计数） */
  const pick = pickOrder(view.rows);
  const rename = props.rename;
  // ⚠️ 改名框**恒在最后**：排在说明或分组标题之前的话，校验失败一次整体下移一格 ⇒ 每按一次 `Enter` 字段跳一次。
  // ⚠️ 键位与插入符走 `useHotkeys` 管的那一串字（`LayoutProps.rename`），本层只画、不自挂 `useInput`。
  const showRename = rename !== null;
  const renameAt = rename === null ? 0 : Math.max(0, Math.min(rename.cursor, rename.text.length));
  const renameInside = rename !== null && rename.cursor >= 0 && rename.cursor <= rename.text.length;
  const renameHead = rename === null ? "" : rename.text.slice(0, renameAt);
  const renameCell = rename === null || !renameInside ? "" : (rename.text[renameAt] ?? " ");
  const renameTail = rename === null || !renameInside ? "" : rename.text.slice(renameAt + 1);
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
          // ⚠️ **标题行没有记号、也不加粗**：它是「今天」/「3 天前」那一行，而记号与加粗是
          // 「可不可选」的两个通道 —— 标题吃了它们，屏上就分不出它是标题还是一条可选会话。
          // ⚠️ 标题那一行的字就是 `label` 本身。
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
        const pin = row.pinned ? ` ${PINNED_MARK}` : "";
        // ⚠️ **待确认删除换档**：两段 `Ctrl+D` 里已经按过第一次 ⇒ 那一行在等第二次，
        // 而「在等」与「已经是那一行」是两件事，故记号与色档各自读自己那一份。
        return (
          <SlotLine key={row.id}>
            {/* ⚠️ 整行包在一个 `truncate` 里：超宽截断整行，本层不再按列宽手算 `ellipsis` */}
            <Text wrap="truncate">
              <Text color={isAt ? sel : tone(theme, row.pending ? PENDING_TONE : "idle")} bold={isAt} wrap="truncate">
                {mark}
              </Text>
              <Text color={isAt ? sel : tone(theme, row.pending ? PENDING_TONE : "accent")} bold={isAt} wrap="truncate">
                {row.label}
              </Text>
              {row.pinned ? (
                <Text color={tone(theme, PINNED_TONE)} wrap="truncate">
                  {pin}
                </Text>
              ) : null}
            </Text>
          </SlotLine>
        );
      })}
      {showRename ? (
        <SlotLine>
          {/* ⚠️ 那个输入框**恒是一行**：插入符就在 `cursor` 那一格而没有「落在第几行」的换算 ——
              与 `Composer` 那一处是同一条纪律。插入符是**反底色**（颜色之外的形状通道）。 */}
          <Text wrap="truncate">
            <Text color={tone(theme, "accent")} wrap="truncate">
              {RENAME_PROMPT}
            </Text>
            <Text wrap="truncate">{renameHead}</Text>
            {renameCell === "" ? null : (
              <Text color={sel} backgroundColor={sel} wrap="truncate">
                {renameCell}
              </Text>
            )}
            <Text wrap="truncate">{renameTail}</Text>
          </Text>
        </SlotLine>
      ) : null}
    </WindowCard>
  );
}

/** 逐行「它是第几个**可选**会话」（`-1` = 那一行是分组标题；⚠️ `view.at` 数的是这个而不是数组下标） */
function pickOrder(rows: readonly SessionListRow[]): readonly number[] {
  const out: number[] = [];
  let selectable = 0;
  for (const row of rows) {
    const isRow = row.header === null;
    out.push(isRow ? selectable : -1);
    if (isRow) selectable += 1;
  }
  return out;
}
