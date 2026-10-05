import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/core/` 根 主题片
 *
 * @description
 * 归**管 `tests/unit/core/` 根层各档的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_CORE_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/core/error-boundary.test.ts",
    hosts: ["example.com"],
    reason: "错误路径用例构造的 host 占位符。它只进两处纯文本：`DialTimeoutError` 的消息串与 `rejectRequest` 附带的 context 载荷，判据是 `toMatchObject` / `toEqual` 的字段比对 —— 全档不起监听、不拨号。",
  },
  {
    file: "tests/unit/core/events/hub.test.ts",
    hosts: ["example.com"],
    reason: "事件 context 的 target host 占位符。它只是 `context` 上的一个**字段值**，参与快照分发与相等比较（`toBe` / `toEqual`），本档 `import` 面只有 `@/core/events` —— 不经任何建链原语。",
  },
  {
    file: "tests/unit/core/log-events.test.ts",
    hosts: ["1.2.3.4", "evil.com", "example.com"],
    reason: "结构化日志行的 host/IP 占位符（[ip-denied] / [target-denied] 等文本断言）。logger 是收集行与字段的替身，这些 host 只被拼进 `[event-code]` 文本与 `extra` 字段，判据是 `toContain` / `toBe` 的字符串比对 —— 全档零 IO。",
  },
  {
    file: "tests/unit/core/events/pipe-contract.test.ts",
    hosts: ["example.com"],
    reason: "PipeEvent 类型级契约用例里的 target host 占位符。它是 14 个变体样本中 `route` 那一条的一个**字面量字段值**，判据是 `toHaveLength` 与 `Set` 去重计数 —— 这些样本从不被 publish、从不进转发器。",
  },
];
