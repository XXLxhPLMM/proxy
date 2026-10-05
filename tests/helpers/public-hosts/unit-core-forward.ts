import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/core/forward/` 主题片
 *
 * @description
 * 归**管 `tests/unit/core/forward/**` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_CORE_FORWARD_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/core/forward/upstream/connector/open-dial-failure.test.ts",
    hosts: ["c.name"],
    reason: "**非 host 文本**：字符串内容是形如 `c.name` 的方法名，出现在源码级断言的被查文本里。因 TLD 表收录 `name` 而被命中 —— 这是口径的已知误报类，显式豁免而不是把 `name` 从 TLD 表删掉（那会给真实公网 TLD 开后门）。",
  },
  {
    file: "tests/unit/core/forward/upstream/dial-boundary.test.ts",
    hosts: ["sub.name"],
    reason: "**非 host 文本**：源码里 `${sub.name}` 是模板串**断言消息**里的类名插值（`sub` 遍历 `Socks4Connector` / `Socks5Connector` 两个子类），扫描器把它读成 `label.TLD` 形态 ⇒ 因 TLD 表收录 `name` 被命中，与同片 `connector/open-dial-failure.test.ts` 那条同类。本档只读源码文本与原型成员名单，不起监听、不拨号。",
  },
];
