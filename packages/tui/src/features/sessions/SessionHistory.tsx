/**
 * @fileoverview 历史会话弹窗的**内容区**（逐槽画）；⚠️ 与控制面清单那一份互不认识
 */

import { Box, Text } from "ink";

import { WINDOW_INPUT_PROMPT_COLUMNS, ellipsis, widthOf } from "@/lib/index.js";
import {
  MARK_BLANK,
  MARK_SELECTED,
  SlotLine,
  WindowCard,
  historySlotsOf,
  tone,
  type RegionProps,
  type SessionHistoryRow,
} from "@/components/index.js";

/** 分组标题那一行的色档（⚠️ **它不吃高亮**：它是标题不是可选项，吃了就与「选中了哪一行」读起来一样） */
const HEADER_TONE = "muted" as const;

/** 「已经在侧边栏上」那一枚的记号与色档（⚠️ **与高亮记号不同形也不同色**） */
// ⚠️ 它答的是「已激活」，而高亮答的是「指针/键盘停在哪」—— 两个事实渲染成同一个东西就分不出
// 「它已经在侧边栏上」与「我现在正指着它」。
const PINNED_MARK = "◉";
const PINNED_TONE = "ok" as const;

/** 改名框的提示符（⚠️ **显示宽度必须等于** {@link WINDOW_INPUT_PROMPT_COLUMNS} —— 几何层不认识字形） */
const RENAME_PROMPT = "✎ ";

export function SessionHistory(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const view = props.history;
  if (view === null || g.windowBox === null) return <Box />;
  const box = g.windowBox;
  const sel = tone(theme, "selected");
  /** 可选行从第几槽起（说明那一行占了第 0 槽；`null` 时它根本不占槽） */
  const rowsAt = view.note === null ? 0 : 1;
  /** 逐行「它是第几个**可选**会话」（⚠️ `-1` = 那一行是分组标题，它不进那个计数） */
  const pick = pickOrder(view.rows);
  return (
    <WindowCard g={g} theme={theme} label={view.title}>
      {historySlotsOf(view).map((slot, i) => {
        // ⚠️ **逐槽按同一下标读**：几何层给的 `windowSlots` 与入参那串槽位**同序同长**，装不下的给
        // `null` 而长度不变 —— 少读一格、或把 `null` 当照画，下面那些行都会整体错位一格。
        const rect = g.windowSlots[i] ?? null;
        if (rect === null) return null;
        switch (slot.kind) {
          case "note": {
            // ⚠️ 说明**没有**「状态层已裁好」那份承诺（`label` 有），故这里由本层裁到那一槽的预算
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
          case "group": {
            const row = view.rows[i - rowsAt];
            if (row === undefined) return null;
            // ⚠️ **标题行没有记号、也不加粗**：它是「今天」/「3 天前」那一行，而记号与加粗是
            // 「可不可选」的两个通道 —— 标题吃了它们，屏上就分不出它是标题还是一条可选会话。
            return (
              <SlotLine
                key={i}
                box={box}
                slot={rect}
                fill={Math.max(0, rect.width - widthOf(row.label))}
              >
                <Text color={tone(theme, HEADER_TONE)}>{row.label}</Text>
              </SlotLine>
            );
          }
          case "row": {
            const row = view.rows[i - rowsAt];
            if (row === undefined) return null;
            const isAt = pick[i - rowsAt] === view.at;
            const mark = `${isAt ? MARK_SELECTED : MARK_BLANK} `;
            const pin = row.pinned ? ` ${PINNED_MARK}` : "";
            // ⚠️ `label` 是**状态层裁好的那一份**，本层一个字都不许自己裁（`WindowRow.name` 那条
            // 纪律）：记号与「已上侧边栏」那几列只参与**留白**，不参与裁剪。
            const used = widthOf(mark) + widthOf(row.label) + widthOf(pin);
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - used)}>
                <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
                  {mark}
                </Text>
                <Text color={isAt ? sel : tone(theme, "accent")} bold={isAt}>
                  {row.label}
                </Text>
                {row.pinned ? <Text color={tone(theme, PINNED_TONE)}>{pin}</Text> : null}
              </SlotLine>
            );
          }
          case "input": {
            const rename = view.rename;
            if (rename === null) return null;
            // ⚠️ `windowInput` **恒是一行**（那一格不会折行），故插入符就在 `cursor` 那一格而没有
            // 「落在第几行」的换算 —— 与 `Composer` 那一处是同一条纪律。
            const budget = Math.max(0, rect.width - WINDOW_INPUT_PROMPT_COLUMNS);
            const inside = rename.cursor >= 0 && rename.cursor <= rename.text.length;
            const at = Math.max(0, Math.min(rename.cursor, rename.text.length));
            const cell = inside ? (rename.text[at] ?? " ") : "";
            const cellWidth = widthOf(cell);
            // ⚠️ **插入符那一格先占住宽度再裁前半段**：反着算的话光标很深时前半段会顶到右缘，
            // 而多出来那一格让整行超宽 ⇒ Ink 静默软换行（卡片里多出一行而下面那些掉出去）。
            const head = ellipsis(rename.text.slice(0, at), Math.max(0, budget - cellWidth));
            const rest = inside ? rename.text.slice(at + 1) : rename.text;
            const tail = ellipsis(rest, Math.max(0, budget - widthOf(head) - cellWidth));
            const used = WINDOW_INPUT_PROMPT_COLUMNS + widthOf(head) + cellWidth + widthOf(tail);
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - used)}>
                <Text color={tone(theme, "accent")}>{RENAME_PROMPT}</Text>
                <Text>{head}</Text>
                {/* ⚠️ 插入符是**反底色**（颜色之外的形状通道），与 `Composer` 那一处同一条纪律 */}
                {cell === "" ? null : (
                  <Text color={sel} backgroundColor={sel}>
                    {cell}
                  </Text>
                )}
                <Text>{tail}</Text>
              </SlotLine>
            );
          }
          default:
            // ⚠️ `historySlotsOf` 只会给出那四档；这一支只是让 `kind` 多出一档时不至于静默画成空盒子。
            return null;
        }
      })}
    </WindowCard>
  );
}

/** 逐行「它是第几个**可选**会话」（`-1` = 那一行是分组标题；⚠️ `view.at` 数的是这个而不是数组下标） */
function pickOrder(rows: readonly SessionHistoryRow[]): readonly number[] {
  const out: number[] = [];
  let selectable = 0;
  for (const row of rows) {
    const isRow = row.header === null;
    out.push(isRow ? selectable : -1);
    if (isRow) selectable += 1;
  }
  return out;
}
