# src/config/files/rules/ — 文件与路径说明

## 层不变量

**本节只列不变式，理由留在各文件的头注释里**（理由会随代码一起改，搬进本文件就变成第二份要维护的真相）。

- **零配置依赖、零 IO、零日志**：不引 `@/config/index.js`、不读 store/env/文件。名单条目语法是纯数据层，判定归 `src/core/access-control.ts`。
- **只服务 `acl.json`**：`ip.ts` 服务 `clientIp` 组（只收 IP/CIDR）与 `target` / `upstream` 的 IP/CIDR 分支；`host.ts` 服务 `target` / `upstream` 两组（`clientIp` 组不经过它）。`users.json` 的账号级 `target` 组复用 `host.ts` 的**同一条** `parseHostRule`。
- **编译结果只读、可并发共享**：无每会话状态，`HostMatcher` / `IpRule[]` 可被多会话直接共用。
- **失败一律 undefined**：任一条目非法即整组返回 undefined，由调用方 fail-closed（本项目一律启动期 abort），绝不静默丢弃单条。

`acl.json` 与 `users.json` 名单条目的语法层：解析、编译与匹配。

- `ip.ts` — IP/CIDR 条目的解析与编译（`parseIpRule` / `compileIpRules`）、字节匹配（`ipMatches`）与地址文本往返（`normalizeIp` / `ipToString`）。
- `host.ts` — 主机名与通配条目的解析与编译（`parseHostRule` / `compileHostRules`）、匹配（`hostMatches` / `normalizeHost`），IP/CIDR 分支复用 `ip.ts`。
- `index.ts` — 本层出口，`export *` 再导出 `ip.ts` 与 `host.ts`。

对外唯一第二出口：`@/config/files/rules/index.js`。

相关路径：`../users.ts` 与 `../acl.ts`（文件读取与顶层形状校验）、`@/utils/host-text.ts`（字符级文本原子）、`src/core/access-control.ts`、`src/core/forward/upstream/dial.ts`、`src/core/forward/channel/socks.ts`、`src/core/helpers/self-loop.ts`（跨目录调用方）。

相关测试：`tests/unit/acl-rule-ip.test.ts`、`tests/unit/acl-rule-host.test.ts`、`tests/unit/auth-users.test.ts`。
