# tests/unit/utils/addr/

本目录只答一件事：**地址文本的语法层** —— 一条名单条目、或一个请求里的 host 与对端地址，归一之后是什么、按什么匹配。
三档分工：`host-rule` 管域名侧（IP/CIDR 条目转交 `ip.ts`）、`ip-rule` 管地址侧、`inbound` 管入站请求侧的取值。

⚠️ **这一族是 `src/utils/` 里唯一的「带业务词」例外**，而它待得住的理由是**依赖方向**
（零 IO、零配置、零日志、不回指 `@/core/*`）：调用方横跨 datasource / ops / core / manager 四层，
是全仓共用的词汇而不属于任何一层。判据是依赖方向而不是「有没有业务词」—— 按后者判，
这个共用词汇就得在某个业务目录下复制，或升级成顶层目录。

## 锁什么（每条括号里是牙齿所在的档）

① ⚠️ **`compileIpRules` / `compileHostRules` 任一条非法即整体 `undefined`**，交给调用方 fail-closed
   ——绝不静默丢弃那一条：丢弃会让一份「运维以为配了」的名单**部分生效**，症状是「名单时灵时不灵」，
   而日志上没有任何线索。牙齿：`compileIpRules(["1.2.3.4", "bad"])` 与
   `compileHostRules(["example.com", "bad_host"])`（`ip-rule` / `host-rule` 各一条）。
   正向两格钉住另两个形状：空数组 / 空名单编译成**空规则集**（不是 `undefined`，也不是抛错），
   以及**顺序也是契约**（诊断要按序报第一条错）。
② ⚠️ **请求侧必须归一、条目侧刻意不放松**：`[::1]:443` / `[2001:db8::1]:5678` / `fe80::1%eth0`
   这三种形态客户端真的会发，不归一则 IPv6 名单永不命中（牙齿三档各一份：`host-rule` 的 `normalizeHost`、
   `ip-rule` 的 `normalizeIp`、`inbound` 的 `Forwarded` 解析）。
   而**条目侧不接受 `]:port`**（`normalizeIp` 不认它）——那半边**本目录没有断言**，
   由数据层那一侧的「条目不支持端口」间接兑现，见 ④。
③ **`::ffff:a.b.c.d` 与 `::ffff:7f00:1` 一律还原为 IPv4**：双栈 / Windows 下对端地址常是这个形态，
   不还原则**所有 IPv4 名单规则永不命中**（`ip-rule` 归一与匹配两侧各一份；
   `host-rule` 的 `hostMatches` 对 IP 字面量请求走的是同一条 `ipMatches`）。
④ ⚠️ **这一族的另一半牙齿在数据层，不在本目录**：账号级 `acl` 走同一条判据，
   「两处对同一批条目结论必须一致」的逐条比对、以及 `exämple.com` / `a_b.com` / `example.com:8080`
   这三批条目在**条目侧**被拒，在 `tests/unit/config/auth-users/` 那一档。
   刻意**不在本目录复刻**它：复刻一份就多一个会各自漂的判据，而那份漂了没人看得见。
⑤ **断言只绑行为，不绑内部表示法**（uint32 / BigInt / 字节缓冲 / 位掩码）：实现换表示法不该影响
   地址族、前缀位数、条目文本与匹配结果。反过来说「字节缓冲 + 位掩码比较」这条**刻意没有断言**
   ——那是实现取舍而不是行为契约，它靠每一条行为断言间接兜住。

## 防假绿的位置

- ⚠️ **负向断言要成对看**：只钉「非法条目返回 `undefined`」的话，把 `compileXxx` 改成
  「跳过非法那条」照样全绿 —— 而那正是 ① 要防的实现。故 ① 的正向格（空名单 / 顺序）与负向格同档。
- **族不交叉那几条是真值表不是抽样**：`ip-rule` 的「族不交叉」与「v4-mapped 命中」各钉了两个方向，
  只钉单向的话「实现把两个族并成一个」会静默通过。
- **`ipv6BytesToString` 那一档往返判据钉的是「normalizeIp 可再解析」**而不是某段十六进制文本：
  压缩规则改判（并列零段取末段、单零组也压缩）时，两头一起变而这一条仍然咬得住。
- **`inbound` 的 `getAuthority` 依赖最小请求形状**（`{ headers, url, method }`），所以直接构造对象
  而不起真 server —— 起真 socket 只会多验 HTTP 自己的解析，多余。

## 文件

- `host-rule.test.ts` — 域名侧三条独有否决：ASCII 正则拒 IDN 与下划线、`*` 通配不含 apex、精确与通配职责分离。
- `ip-rule.test.ts` — 地址侧：`normalizeIp` / `parseIpRule` / `ipMatches` / `compileIpRules` + `ipv6BytesToString` 渲染真值表。
- `inbound.test.ts` — 入站请求侧：`getClientAddress` 的头优先级与 `Forwarded` 各种形态 + `getAuthority` 的取值优先级。
- `AGENTS.md` — 本文件。

## 相关路径

- `../../../../src/utils/addr/` — 被测模块（`ip.ts` / `host.ts` / `inbound.ts` / `text.ts`）。
- `../../../../src/utils/AGENTS.md` — 「叶子层」与「地址文本是唯一例外」那条裁决。
- `../../config/auth-users/` — ④ 那半边的牙齿（跨层一致性逐条比对）。
- `../../../helpers/public-hosts/unit-utils.ts` — 本目录的零外网白名单片（`host-rule` / `ip-rule` / `inbound` 各一条）。
- `../../../helpers/source-scan.ts` — `REPO_ROOT` / `TESTS_DIR` / `SRC_DIR` 三个路径常量。
- `../../AGENTS.md`、`../../../AGENTS.md`、`../../../../AGENTS.md`。