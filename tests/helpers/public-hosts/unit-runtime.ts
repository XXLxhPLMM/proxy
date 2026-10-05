import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/runtime/` 主题片
 *
 * @description
 * 归**管 `tests/unit/runtime/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_RUNTIME_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/runtime/bridge/deny-events.test.ts",
    hosts: ["1.2.3.4", "example.com"],
    reason: "事件载荷的 client/target host 占位符；只断言载荷字段值。",
  },
  {
    file: "tests/unit/runtime/bridge/forward-events.test.ts",
    hosts: ["203.0.113.7", "example.com"],
    reason: "事件载荷的 client/target host 占位符（203.0.113.7 是 RFC 5737 文档用 IP）；只断言载荷字段值。",
  },
  {
    file: "tests/unit/runtime/bridge/lifecycle.test.ts",
    hosts: ["example.com"],
    reason: "事件载荷的 client/target host 占位符；只断言载荷字段值。",
  },
  {
    file: "tests/unit/runtime/upstream-url.test.ts",
    hosts: ["context.store"],
    reason: "**非 host 文本**：字符串内容是断言用的属性路径文本 `context.store`，因 TLD 表收录 `store` 被命中。",
  },
];