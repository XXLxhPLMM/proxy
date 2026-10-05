import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/datasource/users/` 主题片
 *
 * @description
 * 归**管 `tests/unit/datasource/users/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * ⚠️ **搬迁时逐条重写 reason 里的「本档」代词**。
 *
 * ⚠️ **`hosts` 两处相同是可见的重复，不是漏检**：账号批 `ACCOUNTS` 的 `acl.target` 名单条目
 *    （含 `*.cdn.io` 通配形态）住在共用前导 `_account-store.ts` 里，而 `source.test.ts` 的
 *    `loadUserPolicy("carol", …)` 断言**逐字重写**了那一份期望值 —— 正向断言必须自己写出
 *    内容，不许改成引用 `ACCOUNTS`，否则「读到的是它」就退化成自证。
 *    ⚠️ 前导**留在测试侧**（不许上提 `tests/helpers/`）：`walk()` 收目录下**全部** `.ts`，
 *    搬进 `helpers/` 等于让这份覆盖从零外网扫描里静默消失。
 *    `store-equivalence.test.ts` 与 `driver-registry.test.ts` 零公网字面量 ⇒ **不建条目**。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_DATASOURCE_USERS_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/datasource/users/_account-store.ts",
    hosts: ["ads.io", "cdn.io", "example.com"],
    reason: "共用前导里那份代表性账号批（`ACCOUNTS`）的 `acl.target` 名单条目字面量（含 `*.cdn.io` 通配形态）—— 它们只被 `parseHostRule` 解析、被两后端 `toEqual` 比较；本模块不建链、不起监听。",
  },
  {
    file: "tests/unit/datasource/users/source.test.ts",
    hosts: ["ads.io", "cdn.io", "example.com"],
    reason: "`loadUserPolicy` 那条接线断言里**逐字写出的** carol 个人名单期望值（whitelist 白 / blacklist 黑）—— 它是「从库里那份快照取出来的名单」的判据，判据只能是内容本身，不许引用 `ACCOUNTS`（那会变成自证）；只被 `parseHostRule` 解析与 `toEqual` 比较，不建链、不拨号。",
  },
];
