/**
 * 账号表那 8 档共用的两个前导（读面接线 + 一份带 `acl` 的样本账号表）
 *
 * @description
 * 共享的判据（八个已否决方向、两条「对凭证索引不可见」、读面零直接读取器、零外网白名单纪律）
 * 在 `./AGENTS.md`，不复制进本文件。
 *
 * ⚠️ **必须留在本目录**：`SCAN_DIRS` 排除 `tests/helpers/` 且 `walk()` 收目录下全部 `.ts`，
 * 而 `MIXED_ACCOUNTS` 带公网 host 字面量 —— 搬进 `helpers/` 等于那部分覆盖从零外网扫描里
 * 静默消失，而下界断言照样绿。**可见的重复优于看不见的失效。**
 *
 * @module tests/unit/config/auth-users
 */

import { accountLocatorFor } from "@/config/index.js";
import { testConfig } from "../../../helpers/config.js";

/**
 * 账号表接线（读面收的是平值，不收 `ConfigAccessor`）
 * @description 每次取到的都是**同一个**对象（`accountLocatorFor` 按 accessor 记忆），
 * 故下游实现器记忆跨调用命中——这正是热路径零分配的前提。
 */
export const acc = (): ReturnType<typeof accountLocatorFor> => accountLocatorFor(testConfig);

/** 一份带 `acl` 的账号表：旧的 `{username,password}` 与新的混排也合法 */
export const MIXED_ACCOUNTS = [
  { username: "alice", password: "pw1" },
  {
    username: "bob",
    password: "pw2",
    acl: { target: { whitelist: ["*.corp.com"], blacklist: ["ads.io"] } },
  },
];
