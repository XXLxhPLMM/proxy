/**
 * 配额那 3 档共用的三个前导（读面接线 + 两条样本常量）
 *
 * @description
 * 共享的判据（禁限速 / 禁并发 / 禁滚动窗 / 禁跨 worker 共享账本、缺省 `month` 归一在消费侧、
 * `quota` 与 `acl` 各自独立决定整份文件是否作废）在 `./AGENTS.md`，不复制进本文件。
 *
 * ⚠️ **必须留在本目录**：`SCAN_DIRS` 排除 `tests/helpers/` 且 `walk()` 收目录下全部 `.ts`，
 * 而 `MIXED` 带公网 host 字面量（`*.corp.com` / `ads.io`）—— 搬进 `helpers/` 等于那部分覆盖
 * 从零外网扫描里静默消失，而下界断言照样绿。**可见的重复优于看不见的失效。**
 *
 * @module tests/unit/config/auth-users
 */

import { accountLocatorFor } from "@/config/index.js";
import { testConfig } from "../../../helpers/config.js";

/**
 * 账号表接线（读面收的是平值，不收 `ConfigAccessor`）
 * @description 恒返回**同一个**对象（`accountLocatorFor` 按 accessor 记忆），故下游
 * 实现器记忆跨调用命中——这正是「热路径零分配」的前提。
 */
export const acc = (): ReturnType<typeof accountLocatorFor> => accountLocatorFor(testConfig);

/** bytes 为 0 = 不限流（与「没配」语义相同，故不计入「真配了配额」） */
export const UNLIMITED = { bytes: 0 };

/**
 * 形状面与读取面共用的样本账号表
 * @description `acl` 刻意写成**已归一**形态（whitelist / blacklist 都在）：多处拿它同时当
 * 「输入」与「期望产物」用，产物侧必定补出空名单。
 */
export const MIXED = [
  { username: "alice", password: "pw1" },
  {
    username: "bob",
    password: "pw2",
    acl: { target: { whitelist: ["*.corp.com"], blacklist: [] } },
  },
  { username: "carol", password: "pw3", quota: { bytes: 1024 } },
];
