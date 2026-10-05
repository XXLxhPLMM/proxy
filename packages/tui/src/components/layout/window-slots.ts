/**
 * @fileoverview 「一个视图 ⇒ 一串槽位」：卡片内容区那一行行是怎么排出来的（零 React、零 Ink、零坐标）
 */

import type { WindowSlot } from "@/lib/index.js";
import type { SessionHistoryView, WindowView } from "../types.js";

/** 控制面清单那一份的槽位序：说明在前（`null` 时**不占**那一行），然后逐个可选行 */
export function managerSlotsOf(view: WindowView): readonly WindowSlot[] {
  return [
    ...(view.note === null ? [] : [{ kind: "note" as const }]),
    ...view.rows.map(() => ({ kind: "row" as const })),
  ];
}

/** 历史会话那一份的槽位序：说明 → 逐行（标题与可选**混在同一个数组**里）→ 改名框 */
// ⚠️ 分组标题占一个 `group` 槽而**不是**一个 `row` 槽：可不可选由 `kind` 答，命中测试读的是 `windowRows`。
export function historySlotsOf(view: SessionHistoryView): readonly WindowSlot[] {
  return [
    ...(view.note === null ? [] : [{ kind: "note" as const }]),
    ...view.rows.map((row) => ({
      kind: row.header === null ? ("row" as const) : ("group" as const),
    })),
    ...(view.rename === null ? [] : [{ kind: "input" as const }]),
  ];
}
