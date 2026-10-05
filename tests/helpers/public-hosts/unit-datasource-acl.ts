import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/datasource/acl/` 主题片
 *
 * @description
 * 归**管 `tests/unit/datasource/acl/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * ⚠️ **搬迁时逐条重写 reason 里的「本档」代词**。
 *
 * ⚠️ **一个 `file:` 条目只归一片，而同名主题的两半住在两个目录**：`datasource/acl/validate.test.ts`
 *    那一半是结构校验（条目在本片），`core/access-control/decision.test.ts` 那一半是判定语义（条目
 *    归 `unit-core-access-control.ts`）。判据是**哪一半住在哪个目录**，不是「哪两个档讲同一件事」
 *    —— 故这两条永不合并成一条，改判据归属时两个片都要动。
 *
 * ⚠️ **条目只给「真的扫得到公网 host 字面量」的文件建**：`driver-registry.test.ts` 一个公网
 *    字面量都没有（它的名单字面量住在 `_acl-driver.ts` 里），建条目会被判 stale。
 *    而 `_acl-driver.ts` 带 `.ts` 后缀之外的**全部 `.ts` 都在扫描范围内**（`walk()` 不看前缀），
 *    所以它自己也要一条 —— 前导**留在测试侧**正是这个原因，理由同 `unit-admin.ts`。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_DATASOURCE_ACL_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/datasource/acl/_acl-driver.ts",
    hosts: ["banned-by-custom.example.com"],
    reason: "共用前导里那份写死的假名单（`CUSTOM_ACL`）的 target 黑名单条目 —— 它是喂给 `parseHostRule` 与判定层的待解析**字符串**，用来让「自定义档拒 / json 档放行」这组对照有同一个目标主机；本模块不建链、不起监听、不拨号。",
  },
  {
    file: "tests/unit/datasource/acl/driver-wiring.test.ts",
    hosts: ["198.51.100.7", "direct.example.com", "example.com", "other.example.com"],
    reason: "`ACL_DRIVER` 两个装配点那组的名单条目与目标主机字面量（RFC 5737 文档用 IP `198.51.100.7`；`other.example.com` 是「json 档必然放行」那份对照文件里唯一的黑名单项，`example.com:8080` 用来断言条目不支持端口）。判据是 `parseHostRule` / `hostMatches` 的归一与比较加 `toEqual`，本档不建链、不拨号。",
  },
  {
    file: "tests/unit/datasource/acl/validate.test.ts",
    hosts: ["1.2.3.4", "a.com", "ads.example.net", "example.com"],
    reason: "`validateAcl` 结构校验真值表里的 acl.json 名单条目字面量（`clientIp` 收 IP/CIDR 而拒域名、`target` 与 `upstream` 收 host 与通配域名的同形对照）—— 全是喂给规则层 `parseHostRule` / `parseIpRule` 的待解析字符串，判据全程是形状比较与位运算，**从不拨号**；私网与回环字面量（`10.0.0.0/8` / `::1` / `192.168.*.*`）按扫描口径不算公网。",
  },
  {
    file: "tests/unit/datasource/acl/configured.test.ts",
    hosts: ["203.0.113.9", "example.com", "intranet.example.com"],
    reason: "`hasConfiguredAcl` 真值表里的 **acl.json 名单条目字面量**（target / upstream 组）—— 它们是喂给 `validateAcl` + 规则层 `parseHostRule` 的待解析字符串与判定入参，判据全程是字符串比较，**从不拨号**。`203.0.113.9` 是 RFC 5737 文档用 IP；`example.com` 是 `*.example.com` 通配条目被剥掉前缀后的形态（扫描器按 label 提取），`intranet.example.com` 是 RFC 2606 保留名。",
  },
];
