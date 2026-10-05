/**
 * @fileoverview 「一个视图 ⇒ 一串槽位」：卡片内容区那一行行是怎么排出来的（零 React、零 Ink、零坐标）
 */

import type { WindowSlot } from "@/lib/index.js";
import type { ModalView, RenameField } from "../types.js";

/** 一格那种「判据是 `kind`、其余字段中性」的槽位（`note` / `row` / `group` / `check` / `input`） */
function slot(kind: WindowSlot["kind"]): WindowSlot {
  return { kind } as WindowSlot;
}

/** 说明那一行（`null` 时**不占**槽，于是长度少一格 —— 而这正是「不占」的实现方式） */
function noteOf(note: string | null): readonly WindowSlot[] {
  return note === null ? [] : [slot("note")];
}

/** 逐行「它是标题还是可选项」——⚠️ 两者**混在同一个数组**里，故判据只能是那一行的 `header` */
function headerSlots(rows: readonly { readonly header: string | null }[]): readonly WindowSlot[] {
  return rows.map((row) => slot(row.header === null ? "row" : "group"));
}

/**
 * 一个弹窗视图 ⇒ 内容区那一串槽位（**同序同长**：几何层按「第 i 槽」铺位置，呈现层按同一下标读）
 * @description 这是槽位序的**唯一出口**：外壳与五个内容渲染器都拿它算，而 `@/app.tsx` 拿它喂
 * `geometry()` —— 三处各算一次的话「画在第几行」与「点在第几行」会错开一格，而屏上完全看不出异常。
 */
// ⚠️ **改名框那一格不属于视图**：它住 `LayoutProps.rename`（焦点在框上这件事屏上到处都要读），
// 于是它作为**第二个入参**进来，而**只有历史会话那一档**把它排在最后。
export function slotsOf(view: ModalView | null, rename: RenameField | null): readonly WindowSlot[] {
  if (view === null) return [];
  switch (view.kind) {
    case "sessions":
      // ⚠️ 改名框**恒在最后**：排在说明或分组标题之前的话，校验失败一次整体下移一格 ⇒ 每按一次 `Enter` 字段跳一次。
      return [
        ...noteOf(view.note),
        ...headerSlots(view.rows),
        ...(rename === null ? [] : [slot("input")]),
      ];
    case "targets":
    case "users":
    case "providers":
      // ⚠️ 三档**同构**：行模型相同、差的只是动作，而槽位序也就没有分叉的理由
      return [...noteOf(view.note), ...view.rows.map(() => slot("row"))];
    case "provider-form":
      // ⚠️ **五个字段在说明之前**：说明一旦出现在字段**之前**，校验失败时那五行整体下移一格
      // ⇒ 每按一次 `Enter` 字段跳一次（而它每一次都在跳，因为校验不过就不关窗）。
      // ⚠️ 字段占 `input` 还是 `select` 那一槽**由状态层答**（`FieldCell.kind`），本层不自己判。
      return [...view.fields.map((field) => slot(field.kind)), ...noteOf(view.note)];
    case "provider-models":
      // ⚠️ 过滤框**恒占第 0 槽**（哪怕词是空串）：它恒在键盘焦点上，而它挪到说明之下的话
      // 「我正在往哪一行里打字」在屏上答不出来。
      return [slot("input"), ...noteOf(view.note), ...view.rows.map(() => slot("check"))];
    case "models":
      return [...noteOf(view.note), ...headerSlots(view.rows)];
  }
}