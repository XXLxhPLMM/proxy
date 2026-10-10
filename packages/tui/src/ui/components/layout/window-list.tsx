/**
 * @fileoverview 清单弹窗（控制面 / 账号 / 提供商）的内容区；⚠️ 三档**共用**这一份而**其余四档互不认识**
 * （flex 布局：逐行 `<Box>` + `<Text wrap="truncate">`，不再读几何层的槽位矩形）
 */

import { Box, Text } from "ink";

import { connectionMark } from "@/ui/theme/index.js";
import { MARK_BLANK, MARK_SELECTED, tone } from "../constants.js";
import type { ModalView, RegionProps } from "../types.js";
import { SlotLine, WindowCard } from "./window-card.js";

/** 清单三档共用的那一个行视图（三档的行模型逐字相同，差的只是动作） */
type ListView = Extract<ModalView, { readonly kind: "targets" | "users" | "providers" }>;

/** 「这一行在等第二次 `Ctrl+D`」那一档（⚠️ `danger` 那一档：屏上读作「别按」） */
const PENDING_TONE = "danger" as const;

/** 收窄到清单那一档（`null` = 这一帧是别的那种内容） */
function listView(view: ModalView | null): ListView | null {
  if (view === null) return null;
  if (view.kind === "targets" || view.kind === "users" || view.kind === "providers") return view;
  return null;
}

export function ListWindow(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  const view = listView(props.view);
  if (view === null) return <Box />;
  const sel = tone(theme, "selected");
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
        const isAt = index === view.at;
        const mark = `${isAt ? MARK_SELECTED : MARK_BLANK} `;
        const tail = row.current ? " ←当前" : "";
        const glyph = row.state === null ? "" : connectionMark(row.state).glyph;
        // ⚠️ **待确认删除整行换档**：它问的是「再按一次会删掉它」，而屏上必须读成「别按」——
        // 只给名字换档的话右边那一段说明仍是常态色，那一行看着与平常一样。
        const base = row.pending ? PENDING_TONE : "idle";
        return (
          <SlotLine key={row.id}>
            {/* ⚠️ 整行包在一个 `truncate` 里：超宽截断整行，本层不再按列宽手算 `ellipsis` */}
            <Text wrap="truncate">
              <Text color={isAt ? sel : tone(theme, base)} bold={isAt} wrap="truncate">
                {mark}
              </Text>
              <Text
                color={isAt ? sel : tone(theme, row.pending ? PENDING_TONE : "accent")}
                bold={isAt}
                wrap="truncate"
              >
                {row.name}
              </Text>
              <Text
                color={isAt ? sel : tone(theme, row.pending ? PENDING_TONE : "muted")}
                bold={isAt}
                wrap="truncate"
              >
                {` ${glyph} ${row.detail}`}
              </Text>
              {/* ⚠️ 右侧那个记号回答「**当前会话连的就是它吗**」—— 与高亮是两件事：高亮是
                  「指针/键盘停在哪」，它是「已生效的是哪一台」。 */}
              {row.current ? (
                <Text color={sel} bold wrap="truncate">
                  {tail}
                </Text>
              ) : null}
            </Text>
          </SlotLine>
        );
      })}
    </WindowCard>
  );
}
