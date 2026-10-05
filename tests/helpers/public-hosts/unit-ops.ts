import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/ops/` 主题片
 *
 * @description
 * 归**管 `tests/unit/ops/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * ⚠️ **搬迁时逐条重写 reason 里的「本档」代词**。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 *
 * ⚠️ **账号夹具那条住在 `_ops.ts` 而不是某一档里**：那一对「磁盘形态 ↔ 归一形态」夹具由
 * `read` / `write` 两档共用，故它的公网 host 字面量也归 `_ops.ts` 这一条。
 * `source-guards.test.ts` **零公网字面量 ⇒ 不建条目**（建了会被判 stale）。
 */
export const UNIT_OPS_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/ops/_ops.ts",
    hosts: ["evil.com", "example.com"],
    reason: "**共用账号夹具里的个人名单字面量**（`ACCOUNT_DOC` / `ACCOUNT` 那一对「磁盘形态 ↔ 归一形态」夹具，`read` 与 `write` 两档都用它）。它们只被 `parseHostRule` 解析、被 `toEqual` 比较、或写进临时目录里的 `acl.json`；本目录不 import 任何代理符号、不起监听、不拨号。",
  },
  {
    file: "tests/unit/ops/read.test.ts",
    hosts: ["evil.com", "example.com"],
    reason: "`readAcl` 缺省补齐断言里写进临时 `acl.json` 的名单条目（`target.blacklist`），以及 `addAclEntry` 的「条目语法不成立」那一条实参。它们只被 `parseHostRule` 解析、被 `toEqual` 比较；本档不 import 任何代理符号、不起监听、不拨号。",
  },
  {
    file: "tests/unit/ops/write.test.ts",
    hosts: ["evil.com", "never.example.com"],
    reason: "`ops 名单写：幂等 no-op` 那个**记账数替身**的基线名单（`target.blacklist`）与「移出本来就没有的」那条的条目实参。替身的 `locator` / `read` 指向 `/nowhere/acl.json` 这个**不存在的路径**、写面只在内存里计数；本档不 import 任何代理符号、不起监听、不拨号。",
  },
];