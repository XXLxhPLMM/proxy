import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/admin/` 主题片
 *
 * @description
 * 归**管 `tests/unit/admin/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * ⚠️ **原 reason 里的「本档」代词要逐条限定**：原文写的是「本档整份文件不 import 任何代理符号」——
 * 拆档之后那句话对每一档都成立，但**豁免的归属**必须逐条写清（否则一张表里三档共用一句「本档」，
 * 读者永远不知道是哪个文件在豁免）。纪律是**不许删原句**（它是「这条豁免为什么成立」的完整记录），
 * 而是在末尾**追加**一句归属限定。
 *
 * ⚠️ `ACCOUNT_WITH_EVERYTHING` 前导住在 `_admin-cli.ts` 而**不在** `tests/helpers/`：`helpers/` 不在
 * `SCAN_DIRS` 里，搬进去等于把这几个公网 host 字面量搬出普查范围，护栏对它彻底失效且一声不吭。
 * 它与 `tests/{unit,integration,library}/` 同在扫描面内 —— **可见的副本优于看不见的失效。**
 *
 * ⚠️ **三条纪律决定了条数**：零公网字面量的文件不建条目（建了会被判 stale），一条 entry 按**文件**
 * 聚合。所以本片的条数 = 这一组里**真的含公网 host 字面量**的文件数，不是文件数。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_ADMIN_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/admin/cli/_admin-cli.ts",
    hosts: ["evil.com", "example.com"],
    reason: "`ACCOUNT_WITH_EVERYTHING`（账号基准）里 `acl.target` 两张名单的条目字面量，本档整份文件不 import 任何代理符号、不起监听、不拨号 —— 它调的是 `runAdminCli`（一个纯命令层入口，只读写临时目录里的文件），这两个 host 只被 `parseHostRule` / `toEqual` 比较。归属限定：豁免只属于本模块内那份账号基准，_admin-cli.ts**不**带 `.test.ts` 而仍在 `SCAN_DIRS` 的扫描面内（`walk()` 收目录下全部 `.ts`）。",
  },
  {
    file: "tests/unit/admin/cli/acl.test.ts",
    hosts: ["1.2.3.4", "evil.com", "example.com", "never.com"],
    reason: "`proxy-cli acl add` 的**名单条目字面量**（`target` / `clientip` 两组各几个）与 `clientip` 组的 CIDR 负向输入 `1.2.3.4:8080`。它们只被 `parseHostRule` / `parseIpRule` 解析与 `toEqual` 比较；本档整份文件不 import 任何代理符号、不起监听、不拨号 —— 它调的是 `runAdminCli`（一个纯命令层入口，只读写临时目录里的文件）。归属限定：豁免只属于本档的名单读写与呈现三组用例。",
  },
  {
    file: "tests/unit/admin/cli/users.test.ts",
    hosts: ["a.com", "b.com", "evil.com"],
    reason: "`user set --target-whitelist` 的输入串（`a.com,b.com`）与「黑名单逐字保留」的对照项 `evil.com` —— 字段保全那一组要断言的正是「换掉白名单时黑名单一个字都不许动」。它们只被 `parseHostRule` 解析与 `toEqual` 比较；本档整份文件不 import 任何代理符号、不起监听、不拨号 —— 它调的是 `runAdminCli`（一个纯命令层入口，只读写临时目录里的文件）。归属限定：豁免只属于本档的账号写族与 `--expires` 判据那几组用例。",
  },
];