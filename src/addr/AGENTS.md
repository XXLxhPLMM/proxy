# src/addr/ — 文件与路径说明

## 层不变量

**本节只列不变式，理由留在各文件的头注释里**（理由会随代码一起改，搬进本文件就变成第二份要维护的真相）。

- **零配置依赖、零 IO、零日志**：不引 `@/config/index.js`、不读 store/env/文件。地址语法是纯数据层，判定归 `src/core/access-control.ts`。
- **服务的不止名单**：`ip.ts` / `host.ts` 的调用方横跨数据源（两处名单校验）、操作层、`core/` 的判定与转发、self-loop 与建链归一。**这一层是「地址文本的解析与匹配」共用的词汇**，不是某一处业务的私有实现——故它是顶层目录而不是某个业务目录的子目录（放 `core/` 会与 `datasource → core` 成环，放 `datasource/` 会让两个数据源与转发路径互相依赖）。
- **两个数据源共用同一批解析原语**：全局名单 `@/datasource/acl/validate.ts` 与 `users.json` 的账号级 `target` 组都走 `host.ts` 的**同一条** `parseHostRule`；名单与自环判定的 IP 归一也都收敛到 `ip.ts`（两份归一会漂）。
- **编译结果只读、可并发共享**：无每会话状态，`HostMatcher` / `IpRule[]` 可被多会话直接共用。
- **失败一律 undefined**：任一条目非法即整组返回 undefined，由调用方 fail-closed（本项目一律启动期 abort），绝不静默丢弃单条。

地址文本的解析、编译与匹配。全局名单、`users.json` 的账号级个人名单、self-loop 判定与建链归一共用这一份。

- `ip.ts` — IP/CIDR 条目的解析与编译（`parseIpRule` / `compileIpRules`）、字节匹配（`ipMatches`）与地址文本往返（`normalizeIp` / `ipToString` / `ipv6BytesToString`）。
- `host.ts` — 主机名与通配条目的解析与编译（`parseHostRule` / `compileHostRules`）、匹配（`hostMatches` / `normalizeHost`），IP/CIDR 分支复用 `ip.ts`。
- `index.ts` — 本层出口，`export *` 再导出 `ip.ts` 与 `host.ts`。

对外唯一出口：`@/addr/index.js`。

相关路径：`@/datasource/acl/validate.ts` 与 `@/datasource/users/validate.ts`（两处名单条目校验）、`src/ops/acl.ts`、`src/core/access-control.ts`（请求期名单判定）、`src/core/helpers/self-loop.ts`、`src/core/forward/upstream/connector/socks5.ts`、`src/core/forward/channel/socks.ts`、`src/manager/routes/input.ts`、`@/utils/host-text.ts`（字符级文本原子）、`@/utils/ip.ts`（入站地址取值，**明确不做**匹配）。

相关测试：`tests/unit/acl-rule-ip.test.ts`、`tests/unit/acl-rule-host.test.ts`、`tests/unit/auth-users.test.ts`、`tests/unit/manager-http.test.ts`。
