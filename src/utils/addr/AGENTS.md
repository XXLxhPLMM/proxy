# src/utils/addr/ — 文件与路径说明

地址文本的**字符级手术**与**名单条目语法**。全局名单、`users.json` 的账号级个人名单、
self-loop 判定、建链归一、manager 入参字符白名单共用这一份。

对外唯一出口：`@/utils/addr/index.js`。

## 文件

- `text.ts` — 字符级原子（无业务语义）：`stripIpBrackets` / `stripZone` / `stripTrailingDot` / `lowerTrim`。
- `ip.ts` — IP/CIDR 条目的解析与编译（`parseIpRule` / `compileIpRules`）、字节匹配（`ipMatches`）与地址文本往返（`normalizeIp` / `ipToString` / `ipv6BytesToString`）。
- `host.ts` — 主机名与通配条目的解析与编译（`parseHostRule` / `compileHostRules`）、匹配（`hostMatches` / `normalizeHost`），IP/CIDR 分支复用 `./ip.js`。
- `inbound.ts` — 入站请求 / 套接字 → 对端地址与 authority：`getClientAddress`（XFF > X-Real-IP > Forwarded > socket）、`getAuthority`、`getSocketAddress`。**每请求现算，不进任何缓存**。
- `index.ts` — 本层 barrel，`export *` 再导出上面四个。

## 层内分三档

| | `text.ts` | `ip.ts` / `host.ts` | `inbound.ts` |
| --- | --- | --- | --- |
| 何时跑 | 调用方组合时 | **启动期**编译一次，跨会话复用 | **每请求**现算 |
| 吃什么 | 裸字符串 | 名单 / CIDR 条目文本 | 入站 HTTP 请求与套接字 |
| 回答什么 | 「剥掉这层壳」 | 「这条条目合不合法」 | 「这次的对端是谁」 |
| 有无业务语义 | 无 | 有（名单条目怎么写） | 无（纯取值） |

`text.ts` 被 `config/schema/upstream-url.ts` 与 `core/helpers/target.ts` 直接用，规则层用不到它们；
`inbound.ts` 被 `core/server/*`、`core/guard.ts`、`core/identity/token.ts`、`runtime/bridge.ts` 用，
规则层也用不到。三档不是同一件事，只是同一个目录出口。

⚠️ **别把 `ip.ts` 与 `inbound.ts` 再合成一个文件**：两者都关于 IP，但一个在启动期被缓存复用、
一个在请求期现算；合成后每个判据都无法单独测、也无法单独缓存。同理**别让 `ip.ts` 回头 import
`inbound.ts`**（那是反向：条目编译不该知道 HTTP 请求长什么样）。

## 相关路径

- 条目校验 — `@/datasource/acl/validate.ts`、`@/datasource/users/validate.ts`、`src/ops/acl.ts`
- 请求期判定 — `src/core/access-control.ts`
- 归一的组合处 — `src/core/helpers/self-loop.ts`（转发策略）、`src/core/helpers/target.ts`（authority 拆分）、
  `src/config/schema/upstream-url.ts`
- `inbound.ts` 的调用方 — `src/core/server/{http,admission,socks-base}.ts`、`src/core/guard.ts`、
  `src/core/identity/token.ts`、`src/runtime/bridge.ts`
- 建链与转发 — `src/core/forward/upstream/connector/socks5.ts`、`src/core/forward/channel/socks.ts`
- 入参字符白名单 — `src/manager/routes/input.ts`

相关测试：`tests/unit/utils/addr/`、`tests/unit/config/auth-users/validate.test.ts`、`tests/unit/manager/http/acl-entry.test.ts`、`tests/unit/core/helpers/target.test.ts`。