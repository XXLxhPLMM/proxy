import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/core/helpers/` 主题片
 *
 * @description
 * 归**管 `tests/unit/core/helpers/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 *
 * ⚠️ **按新档分组**（纪律③）：旧档那 2 条按各自 `it` 的新落点裂成 4 条，`bridge.test.ts` 与
 * `construction`/`credential-seam`/`own-credential`/`no-legacy-helper`/`snapshot-*` 那些档
 * 一个公网字面量都没有 ⇒ 按纪律②不建条目。
 */
export const UNIT_CORE_HELPERS_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/core/helpers/target.test.ts",
    hosts: ["a.com", "evil.com", "example.com", "mple.com"],
    reason: "转发辅助函数（目标解析 / 自环判定 / peerTarget / 桥接）的**入参字符串**；真连接一律打 127.0.0.1 的空闲端口。`mple.com` 同上，是**含空格的畸形 host 负向输入**（exa mple.com，必须被判非法）的尾巴。",
  },
  {
    file: "tests/unit/core/helpers/headers.test.ts",
    hosts: ["a.com"],
    reason: "转发辅助函数（目标解析 / 自环判定 / peerTarget / 桥接）的**入参字符串**；真连接一律打 127.0.0.1 的空闲端口。",
  },
  {
    file: "tests/unit/core/helpers/route.test.ts",
    hosts: ["a.example.com"],
    reason: "转发辅助函数（目标解析 / 自环判定 / peerTarget / 桥接）的**入参字符串**；真连接一律打 127.0.0.1 的空闲端口。",
  },
  {
    file: "tests/unit/core/helpers/self-loop.test.ts",
    hosts: ["example.com"],
    reason: "自环判定（通配监听 / localhost 等价 / v4-mapped）的 host 入参，纯字符串比较。",
  },
];