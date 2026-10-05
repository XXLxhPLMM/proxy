import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/integration/acl/` 主题片
 *
 * @description
 * 归**管 `tests/integration/acl/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const INTEGRATION_ACL_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/integration/acl/inert-warning.test.ts",
    hosts: ["203.0.113.9", "intranet.example.com"],
    reason: "写进临时 acl.json 的**名单条目**（`target` 与 `upstream` 两组），用来触发 `acl-inert` 告警。判定由注入的 `access` 替身或内置引擎的纯字符串比较完成；本档真发请求时目标一律是 `127.0.0.1:<getFreePort()>`，从不公网拨号。",
  },
  {
    file: "tests/integration/acl/inert-cli-row.test.ts",
    hosts: ["203.0.113.9"],
    reason: "写进临时 acl.json 的**名单条目**（`clientIp` 与 `target` 两组），用来触发 `acl-inert` 告警、让真 `ProxyServer` 落那一行 warn。判定由注入的 `access` 替身或内置引擎的纯字符串比较完成；本档真发请求时目标一律是 `127.0.0.1:<getFreePort()>`，从不公网拨号。",
  },
];