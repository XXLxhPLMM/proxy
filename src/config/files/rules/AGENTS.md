# src/config/files/rules — 名单条目规则层

`acl.json` 与 `users.json` 里每一条名单条目的**语法**在这里定义：什么算合法条目、怎么编译成热路径可零分配匹配的结构。

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `ip.ts` | `normalizeIp` / `ipv6BytesToString` / `ipToString` / `parseIpRule` / `compileIpRules` / `ipMatches` | 服务 `clientIp` 组，以及另两组的 IP/CIDR 分支 |
| `host.ts` | `normalizeHost` / `parseHostRule` / `compileHostRules` / `hostMatches` | 服务 `target` / `upstream` 两组；IP/CIDR 分支**直接复用** `ip.ts` |
| `index.ts` | 本层出口（`export * from` 两个文件） | **唯一的跨目录第二出口** `@/config/files/rules/index.js` |

**不属于本层**：文件读取与顶层形状校验（`../acl.ts` / `../users.ts`）、请求期判定与「命中了怎么办」（`src/core/access-control.ts`）、字符级主机文本归一（`@/utils/host-text.ts`）。

## 硬约定

- **零配置依赖**（不引 `@/config/index.js`、不读 store/env/文件）、**零 IO、零日志、零模块级状态**。
- **层内相对引用**（`./ip.js`），**禁止自引 barrel**。跨目录引 `@/config/files/rules/index.js` 后**一律不许再往深引 `./ip.js`**——core 侧四个调用方（`access-control.ts`、`forward/upstream/dial.ts`、`forward/channel/socks.ts`、`helpers/self-loop.ts`）都只从这一个 barrel 取。
- **字符级归一统一委托叶子模块 `@/utils/host-text.js`**（`lowerTrim` / `stripIpBrackets` / `stripZone` / `stripTrailingDot`）。本层只保留各自**一条**语义差异（见决策 3）。
- 域名按**客户端请求的 host 字符串**匹配（小写、去尾点、剥方括号），**不做 DNS 解析**，条目**不支持端口**。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

**有断言锁住的裁决一律不写在这里**——它们的结论、否掉了什么、为什么、以及逐字锁点分布在：
`tests/unit/acl-rule-ip.test.ts`（`::ffff:a.b.c.d` / `::ffff:7f00:1` 一律还原为 IPv4；
`compileIpRules` 任一条非法即整体 `undefined`）、`tests/unit/acl-rule-host.test.ts`
（域名 ASCII 白名单**刻意拒绝 IDN 与下划线**；`*.a.com` 只匹配子域、**不含** apex；
`compileHostRules` 任一条非法即整体 `undefined`；请求 host 侧 `[v6]:port` 必须归一）、
`tests/unit/auth-users.test.ts`（条目侧**刻意不放松**：端口 / IDN / 下划线一律整组非法）。
要查「那条断言锁什么」，去那个文件的头注释。**下面五条全是「无牙齿」的**。

1. **住 `config/` 而不是 `@/utils/`** — 否掉「这是通用网络基础设施，搬去 utils」— 它不是通用基础设施：**通用工具目录不该知道「名单条目」这个业务概念**。搬过去 `@/utils` 就得知道 `acl.json` 的形状，而 utils 是依赖树最底层，那会让「工具层知道配置语义」变成既定事实。`@/utils` 侧只留零业务概念的 `host-text.ts` 文本原子。⚠️ **core 依赖 config 的规则层是既定方向**，别为了「utils 才是底层」把它搬回去。⚠️ **没有任何断言**：把整个 `rules/` 搬进 `@/utils/` 并同步改四个 import，全仓绿（`tests/unit/acl-rule-ip.test.ts` 那些用例的**判据形状**不变，只有 import 路径变）。
2. **地址一律以字节缓冲表示（v4 4 字节 / v6 16 字节），前缀按位掩码比较** — 否掉「存字符串前缀」— `10.0.0.5/24` 必须 ≡ `10.0.0.0/24`，字符串比较做不到；字节形式也让 v4/v6 共用同一套匹配路径。⚠️ **这条是本仓最彻底的一条「刻意无断言」**：`tests/unit/acl-rule-ip.test.ts` 的头注释**明写**「断言刻意不绑定内部数值形态（uint32 / BigInt / 字节缓冲），只校验地址族、前缀位数、条目文本与匹配行为——**实现换表示法也不应影响这些语义**」。把字节缓冲换成 `bigint` 或两个 `uint32`，**全仓一条都不会红**，而这是**有意为之**：表示法是实现取舍不是行为契约。别哪天「顺手补一条表示法断言」把这条纪律废掉。
3. **`normalizeIp` 只认「整体被方括号包裹」，`normalizeHost` 认 `[v6]:port` 并按 `]` 截断（且方括号形态不去尾点）** — 否掉「两边统一加 `]:port` 容错」— 请求 host 侧的带端口 authority 必须归一（客户端真的会发 `[::1]:443`），但**条目侧刻意不放松**：`[::1]:443` 写进任何 IP/CIDR 条目都判非法 → 整组失败 → 启动期 abort，运行期交给 core fail-closed，而不是悄悄按 `::1` 放行。⚠️ **别为了「容错」在 `normalizeIp` 里加 `]:port` 分支**。⚠️ **只锁了请求侧那一半**：`tests/unit/acl-rule-host.test.ts` 的 `expect(normalizeHost("[::1]:443")).toBe("::1")` 钉住请求侧；**条目侧那一半没有任何直接断言**——`parseIpRule("[::1]:443")` 至今没被任何用例调过（`tests/unit/auth-users.test.ts` 的样本表里虽有 `"[::1]:443"`，那一格是**两个判据互相校对**而不是断言它非法：两边同时放宽仍然全绿）。「方括号形态不去尾点」那一小截（`normalizeHost("[::1].")`）同样没被跑过。
4. **`ipToString`（字节 → 文本）在本层导出** — 否掉「放 utils」— 它的唯一用途是审计/诊断渲染 ACL 判定对象，而那个判定对象是名单条目；放 utils 就等于 utils 需要知道「IP 有两种字节宽度是名单语义」这件事。⚠️ **没有任何断言**：`ipToString` **全仓零测试引用**（`tests/unit/acl-rule-ip.test.ts` 的 import 列表里没有它），`@/utils` 侧也没有「不许导出它」的负向断言。搬到 utils 或删掉，全仓绿。
5. **宿主文本归一只走 `host-text.ts` 那四个原子** — 否掉「在两文件里各写一份 `toLowerCase().trim()`」— 名单判定与自环判定共用同一套归一，是「同一 host 在两侧归一结果逐字一致」那条不变量的前提；两份实现一旦漂移，症状是「名单时灵时不灵」。⚠️ **没有任何断言**：`lowerTrim` / `stripIpBrackets` / `stripZone` / `stripTrailingDot` 四个名字**在全仓测试里零出现**，`ip.ts` / `host.ts` 的 import 面也没有被扫过。在 `host.ts` 里内联一份 `toLowerCase().trim()`，全仓绿——`tests/unit/acl-rule-host.test.ts` 那些用例照过，因为判据是**归一结果**不是**归一来源**。
