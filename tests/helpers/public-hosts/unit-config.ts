import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/config/` 主题片
 *
 * @description
 * 归**管 `tests/unit/config/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * ⚠️ **搬迁时逐条重写 reason 里的「本档」代词**（`acl-configured` 那条不在本片，它归 `unit-datasource-acl.ts`）。
 *
 * ⚠️ `MIXED_ACCOUNTS` 前导**住在测试侧**（`config/auth-users/_auth-users.ts` 与
 * `_user-quota.ts`），理由同 `unit-admin.ts`：搬进 helpers = 护栏对 helper 静默失效。
 * ⚠️ 而 **`_*.ts` 前导自己也要建条目** —— 扫描器的 `walk()` 收全部 `.ts`（它只按目录
 * `SCAN_DIRS` 排除，不按文件名），所以前导仍在扫描范围内；这不是「零公网字面量的文件不建条目」
 * 那条纪律的例外，那条纪律排除的是**真的一行 host 都没有**的文件。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_CONFIG_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/config/auth-users/_auth-users.ts",
    hosts: ["ads.io", "corp.com"],
    reason: "带 acl 的账号表前导（`*.corp.com` 白名单 / `ads.io` 黑名单）：校验器只读文件做形状校验，不建链。⚠️ 这份前导刻意留在测试侧而不是 `tests/helpers/` —— 后者不在 `SCAN_DIRS` 里，搬进去等于让这道护栏对前导彻底失效且一声不吭。",
  },
  {
    file: "tests/unit/config/auth-users/_user-quota.ts",
    hosts: ["corp.com"],
    reason: "配额档的账号表前导（`*.corp.com` 白名单）：与 `_auth-users.ts` 同理，是被校验器读形状的名单条目，不触发任何连接。",
  },
  {
    file: "tests/unit/config/auth-users/validate.test.ts",
    hosts: ["1.2.3.4", "a.com", "ads.io", "b.com", "example.com", "mple.com"],
    reason: "账号级 acl 的形状校验用例：`example.com` / `*.a.com` / `ads.io` 是合法与非法名单条目，`1.2.3.4` 是 `clientIp` 组必须整组非法的那一格，`b.com` 是 `a_b.com` 的扫描残段。全部只喂 `validateAuthUsers`。`mple.com` 是**畸形 host 负向输入**的尾巴 —— 原文是含 IDN 字符的 exämple.com（必须被判非法），扫描器的 label 字符集不含非 ASCII，故只匹到 mple.com 这一段。",
  },
  {
    file: "tests/unit/config/auth-users/policy.test.ts",
    hosts: ["1.2.3.4", "ads.io", "corp.com", "evil.com"],
    reason: "用户策略读面：名单条目（`*.corp.com` / `ads.io`）与 `clientIp` 未知组（`1.2.3.4`）都只经 `loadUserPolicy` 读字符串；`evil.com` 是「深度冻结后 push 抛 TypeError」那一格里的**被拒写入值**，压根没进缓存。",
  },
  {
    file: "tests/unit/config/auth-users/quota-validate.test.ts",
    hosts: ["ads.io", "corp.com"],
    reason: "quota 形状校验用例：名单条目（`ads.io` 黑名单、`ads.io:80` 端口条目必须整组非法）与「凭证索引里不许含 `corp.com`」那一格，都是纯字符串比较与形状校验，不建链。",
  },
  {
    file: "tests/unit/config/auth-users/quota-window.test.ts",
    hosts: ["a.com", "corp.com"],
    reason: "`quota.window` 的合法/非法用例里的名单条目（`*.corp.com` 与 `a.com:80`）：判据是 `parseHostRule` 的结论，不是解析结果。",
  },
  {
    file: "tests/unit/config/auth-users/source-guards.test.ts",
    hosts: ["a.com", "corp.com"],
    reason: "启动期强校验那一格的非法名单条目（`a.com:80`）与「凭证索引里不许含 `*.corp.com`」那一格：前者喂 `readAuthUsersAsync` 的形状校验，后者是纯索引键断言。",
  },
  {
    file: "tests/unit/config/loader/sources.test.ts",
    hosts: ["proxy.example.com"],
    reason: "`UPSTREAM_URL` 的校验/拆项用例：只消费显式 env/argv 做字符串拆解，从不拨号。",
  },
  {
    file: "tests/unit/config/store/accessor.test.ts",
    hosts: ["1.2.3.4", "example.com"],
    reason: "configAccessorFromStore 的配置读取用例：目标 host 是 store 里的配置值（判定层入参字符串），不触发任何连接。`1.2.3.4` 是 `access.checkClient({ client })` 的纯函数入参。",
  },
];