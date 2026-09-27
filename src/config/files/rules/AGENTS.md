# src/config/files/rules/ — 文件与路径说明

`acl.json` 与 `users.json` 名单条目的语法层：解析、编译与匹配。

- `ip.ts` — IP/CIDR 条目的解析与编译（`parseIpRule` / `compileIpRules`）、字节匹配（`ipMatches`）与地址文本往返（`normalizeIp` / `ipToString`）。
- `host.ts` — 主机名与通配条目的解析与编译（`parseHostRule` / `compileHostRules`）、匹配（`hostMatches` / `normalizeHost`），IP/CIDR 分支复用 `ip.ts`。
- `index.ts` — 本层出口，`export *` 再导出 `ip.ts` 与 `host.ts`。

对外唯一第二出口：`@/config/files/rules/index.js`。

相关路径：`../users.ts` 与 `../acl.ts`（文件读取与顶层形状校验）、`@/utils/host-text.ts`（字符级文本原子）、`src/core/access-control.ts`、`src/core/forward/upstream/dial.ts`、`src/core/forward/channel/socks.ts`、`src/core/helpers/self-loop.ts`（跨目录调用方）。

相关测试：`tests/unit/acl-rule-ip.test.ts`、`tests/unit/acl-rule-host.test.ts`、`tests/unit/auth-users.test.ts`。
