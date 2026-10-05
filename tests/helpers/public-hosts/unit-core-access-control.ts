import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/core/access-control/` 主题片
 *
 * @description
 * 归**管 `tests/unit/core/access-control/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * ⚠️ **搬迁时逐条重写 reason 里的「本档」代词**。
 *
 * ⚠️ **`acl.test.ts` 那条与 `unit-datasource-acl.ts` 共享**：拆分 `acl.test.ts` 时它会裂成
 * `datasource/acl/validate.test.ts`（结构校验那 4 个 host）与 `core/access-control/decision.test.ts`
 * （判定语义那 12 个 host —— 两个半边各有 `1.2.3.4` 与 `example.com`，故 4 + 12 > 14）。**两个片都要改**，
 * 别只改一个。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_CORE_ACCESS_CONTROL_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/core/access-control/file-engine.test.ts",
    hosts: ["1.2.3.4", "8.8.8.8", "9.9.9.9", "a.com", "evil.com", "good.com", "other.com", "secret.a.com", "sub.a.com", "x.evil.com"],
    reason: "`AccessControl` 端口的**纯函数入参**（`checkClient({ client })` / `checkTarget({ host })` / `checkRoute({ host })` 的字符串）+ acl.json 名单条目。本档真转发那两例的目标一律是 `127.0.0.1:<getFreePort()>` 与本地 `http.Server`，从不公网拨号。",
  },
  {
    file: "tests/unit/core/access-control/required-port.test.ts",
    hosts: ["203.0.113.9"],
    reason: "**显式放行档**（`openAccessControl()`）的 `checkClient({ client })` 纯函数入参：它证明「不判名单」那份实现在任意地址上恒放行，判据是返回对象逐字相等，从不拨号。`203.0.113.9` 是 RFC 5737 文档用 IP。",
  },
  {
    file: "tests/unit/core/access-control/decision.test.ts",
    hosts: ["1.2.3.4", "8.8.8.8", "9.9.9.9", "a.com", "b.com", "c.com", "evil.com", "example.com", "good.com", "other.com", "secret.a.com", "sub.a.com", "x.evil.com"],
    reason: "全局名单条目 + access.checkTarget/checkRoute 的**纯函数入参**（8.8.8.8 只是喂给名单判定的字符串）；判定是字符串比较，不拨号。",
  },
  {
    file: "tests/unit/core/access-control/user-merge-runtime.test.ts",
    hosts: ["198.51.100.5", "203.0.113.9", "ads.io"],
    reason: "users.json 个人名单条目（ads.io）与 IP 条目（198.51.100.5 / 203.0.113.9 是 RFC 5737 文档 IP）；合流判定是纯函数。",
  },
];