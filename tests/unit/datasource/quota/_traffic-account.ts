/**
 * 判定层两档（`mirror-allow` / `consume-sync`）共用的 `QuotaResolver` 替身
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`；这里只放两档真用到的那一个工厂。
 *
 * ⚠️ **刻意只有一张「用户 → 配额」表**：恒 allow 的四种情形必须是**显式分支**，不是「默认上限 0
 * 恰好放行」的蒙混，所以「未配」与「配了但 `bytes` 为 0」必须由用例自己写出来 —— 替身若偷偷
 * 补一个默认值，那正是 `mirror-allow.test.ts` 要否掉的那种蒙混。
 */

import {
  createUsageMirror,
  type UsageAccount,
  type UsageQuota,
} from "@/datasource/quota/index.js";

/** 用一张表当 `QuotaResolver` 替身：查不到即 undefined（= 不限流） */
export function accountWith(quotas: Record<string, UsageQuota>): UsageAccount {
  return createUsageMirror((user) => quotas[user]);
}
