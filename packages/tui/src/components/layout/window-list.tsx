/**
 * @fileoverview 清单弹窗（控制面 / 账号 / 提供商）的内容区；⚠️ 三档**共用**这一份而**其余四档互不认识**
 */

import { Box, Text } from "ink";

import { ellipsis, widthOf } from "@/lib/index.js";
import { connectionMark } from "@/theme/index.js";
import { MARK_BLANK, MARK_SELECTED, tone } from "../constants.js";
import type { ModalView, RegionProps } from "../types.js";
import { SlotLine, WindowCard } from "./window-card.js";
import { slotsOf } from "./window-slots.js";

/** 清单三档共用的那一个行视图（三档的行模型逐字相同，差的只是动作） */
type ListView = Extract<ModalView, { readonly kind: "targets" | "users" | "providers" }>;

/** 「这一行在等第二次 `Ctrl+D`」那一档（⚠️ 与悬停那枚「✕」同一档：屏上两处说的是同一句「别按」） */
const PENDING_TONE = "danger" as const;

/** 收窄到清单那一档（`null` = 这一帧是别的那种内容） */
function listView(view: ModalView | null): ListView | null {
  if (view === null) return null;
  if (view.kind === "targets" || view.kind === "users" || view.kind === "providers") return view;
  return null;
}

export function ListWindow(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const view = listView(props.view);
  if (view === null || g.windowBox === null) return <Box />;
  const box = g.windowBox;
  const sel = tone(theme, "selected");
  /** 可选行从第几槽起（说明那一行占了第 0 槽；`null` 时它根本不占槽） */
  const rowsAt = view.note === null ? 0 : 1;
  return (
    <WindowCard g={g} theme={theme} label={view.title}>
      {slotsOf(view, null).map((slot, i) => {
        // ⚠️ **逐槽按同一下标读**：几何层给的 `windowSlots` 与入参那串槽位**同序同长**，装不下的给
        // `null` 而长度不变 —— 少读一格、或把 `null` 当照画，下面那些行都会整体错位一格。
        const rect = g.windowSlots[i] ?? null;
        if (rect === null) return null;
        switch (slot.kind) {
          case "note": {
            // ⚠️ 说明**没有**「状态层已裁好」那份承诺，故裁剪归本层
            const text = ellipsis(view.note ?? "", rect.width);
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - widthOf(text))}>
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
            // ⚠️ **待确认删除整行换档**：它问的是「再按一次会删掉它」，而屏上必须读成「别按」——
            // 只给名字换档的话右边那一段说明仍是常态色，那一行看着与平常一样。
            const base = row.pending ? PENDING_TONE : "idle";
            return (
              <SlotLine key={i} box={box} slot={rect} fill={Math.max(0, rect.width - used)}>
                <Text color={isAt ? sel : tone(theme, base)} bold={isAt}>
                  {mark}
                </Text>
                <Text color={isAt ? sel : tone(theme, row.pending ? PENDING_TONE : "accent")} bold={isAt}>
                  {name}
                </Text>
                <Text color={isAt ? sel : tone(theme, row.pending ? PENDING_TONE : "muted")} bold={isAt}>
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
            // ⚠️ **清单三档只有说明与可选行两档槽位**；这一支让几何层多一档时落成空行而不是错位。
            return null;
        }
      })}
    </WindowCard>
  );
}