import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/core/identity/` 主题片
 *
 * @description
 * 归**管 `tests/unit/core/identity/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 *
 * ⚠️ **这一片是 2 条而不是「identity 族那 6 档各一条」**：旧档的 `example.com` 只有**一处**
 * 字面量（`ctxWith` 的 `authority` 缺省），搬进共用模块 `_identity.ts` 后，六档里只有
 * `token-parsing.test.ts` 自己还留着两处显式的 `example.com:*`。其余五档一个公网字面量都没有，
 * 按纪律②「零公网字面量的文件不建条目」**不许**给它们建 —— 建了会被判 stale。
 * 换个方向也不成立：把 `ctxWith` 复制回六档各一份去凑条目，等于为了凑一张申报表而在
 * 同一个目录里放六份一模一样的 20 行构造器。
 */
export const UNIT_CORE_IDENTITY_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/core/identity/_identity.ts",
    hosts: ["example.com"],
    reason: "鉴权失败日志与事件载荷里的目标 host 占位符，纯字符串。",
  },
  {
    file: "tests/unit/core/identity/token-parsing.test.ts",
    hosts: ["example.com"],
    reason: "鉴权失败日志与事件载荷里的目标 host 占位符，纯字符串。",
  },
];