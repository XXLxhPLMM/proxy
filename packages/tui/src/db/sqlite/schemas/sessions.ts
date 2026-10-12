import { index, integer, text } from "drizzle-orm/sqlite-core";
import { SESSION_STATUSES } from "../../dto/session.js";
import { table } from "./base/table.js";

export const sessions = table(
  "sessions",
  {
    /** 会话 id（主键） */
    id: text().primaryKey(),
    /** 显示标题 */
    title: text().notNull(),
    /** 会话选中的模型键（`provider/model`）；`null` = 还没选 */
    modelId: text(),
    /** 工作状态（`SESSION_STATUSES` 闭合集）；`null` = 无事（不另设 `"idle"` 值，见 DTO） */
    status: text({ enum: SESSION_STATUSES }),
    /** 是不是当前活动的那一个（sqlite 无布尔，存 `0` / `1`）；⚠️ `default` 是给老库补列时整表填的 */
    isActive: integer({ mode: "boolean" }).notNull().default(true),
    /** 创建时刻（epoch 毫秒） */
    createdAt: integer().notNull(),
    /** 最后更新时刻（epoch 毫秒） */
    updatedAt: integer().notNull(),
  },
  // 「查激活的那几个」与「清单定序」一条索引全包：等值列在前、排序列在后 ⇒ 正反扫都命中，不另排一次序
  (t) => [index("sessions_active_updated_at_idx").on(t.isActive, t.updatedAt)],
);

export type SessionRow = typeof sessions.$inferSelect;
