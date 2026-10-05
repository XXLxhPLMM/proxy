# tests/integration/acl/

本目录只答一件事：**名单（`acl.json` 三组 + `users.json` 的个人名单）在真装配里怎么生效、又怎么在失效时报警**。
共享的被测装配是 `services.access` + `createFileAccessControl` + `readAcl` / `readAuthUsers` 热加载
（层不变量归 `src/runtime/AGENTS.md` 与 `src/core/access-control` 那几处）。

判据层（3×3 优先级真值表、闭合 `reason`、热加载、零分配）在 `tests/unit/core/access-control/`，
`hasConfiguredAcl` 的三组非空判定在 `tests/unit/datasource/acl/configured.test.ts` —— **本目录不重复那两层**。

## 三族启动期告警的共用形状

`acl-inert` / `account-table-inert`（与 `quota-inert` 同族）都是同一句话：**配置有洞、服务照跑、零信号**。

⚠️ `account-table-inert` 那族的推导（这一族的机制、两个字段为什么共用一个 code、以及判据为什
刻意不含哪些项）见 `inert-account-table.test.ts` 的 describe 上方 —— 它只服务那一档。

- ⚠️ **「只报一次」**：告警是启动期一次性事实，不许每请求报。故一律断言**恰好**条数（不是 `>= 1`）。
- **判据是两个都必须成立的 AND**，少任一条都变成噪音（缺前者 = 没配也在报，缺后者 = 没配的部署狂报）。
  于是每族都必须钉「正反四格」：**正向**（配了 + 触发条件成立 → 恰好一条）+ **至少两条负向**（各零条）。
  负向那两格是防「告警变噪音」与「误报」的唯一护栏 —— 而**一条会误报的告警在第一次误报之后就再也不会被看**，
  那等于把它永久关掉。
- ⚠️ **文案必须回答「怎么办」**：`acl-inert` 那条逐字点名三组名单各自的后果，是因为判据只能答「有没有配」
  （布尔）、**答不出是哪一组**；`account-table-inert` 必须点名 `exp` / `basic` / `uid` / `disabled`。
- ⚠️ **`hasConfiguredAcl` 的「读失败 → false」是刻意取舍**：读不到名单时**不告警** —— 那是「压根不知道配没配」
  而不是「配了却没生效」，报出来是**误报**。真正读不到文件时另有可见信号（`readJsonCached` 经 `onEvent`
  报 `error` → `config.file-error` → CLI 落日志）—— 那**两半**（判据 `false` **且**恰好一条 `error` 事件）
  在 `tests/unit/datasource/acl/configured.test.ts` 里一起断言，本目录的负向 B 是它的**告警侧投影**。
- **`isAccessOverridden` 取实例身份而不是 `instanceof`**（实现是模块级 `WeakSet<AccessControl>`）：
  后者跨模块副本 / 打包产物 / 测试替身全部失配，症状是「明明注入了替身、告警却没响」。
  ⚠️ **只判 `access` 不判其余三项** —— `identity` / `traffic` / `usageSource` 注入替身后配置文件照样生效，
  只有 `access` 注入会让 `acl.json` 整份失效。
- **`onWarning` 只接白名单三条**（`quota-inert` / `acl-inert` / `account-table-inert`）、**不整体转发**：
  全量转发会把「必须知道」与「重复一遍」（`config-normalized`、`start-failed`）混在同一等级，
  **warn 一多就等于没有 warn**。⚠️ **白名单到第三条时的重新裁决（尚未执行）**：正确形态是让 `RuntimeWarning`
  自带 `level` 并整体转发，而不是继续加 `if` 分支；所以 `disabled` 的失效告警是**并进第三条**
  （成因逐字相同：jwt 模式不查账号表），而不是新开第四条。
- ⚠️ **`account-table-inert` 的判据刻意不含「是否已过期」**：一个早就过期、早就该被拒的账号不该
  每次启动都报一遍「配了不生效」——那是启动期事实（有没有人配过），不是请求期事实（现在有没有人过期）。
- ⚠️ **负向两格只写「零条」会恒绿**：每格都要配一条**正向证据**（默认实现对着同一份文件确实会拒 /
  `readAcl` 真的读到了），否则它只是「什么都没发生」。

## 文件驱动的访问控制：直构 core 必须显式注入

`ProxyOptions.access` 是**必填**的（`access: AccessControl`，无 `?`）：全仓不存在那个「显式放行」缺省档，
**缺席即全放行**，必须编译期拦。直构 core 的档因此必须显式注入 `createFileAccessControl(ctx.config)`，
否则目标名单与 upstream 路由名单两条被测行为**整条消失**（表现为「命中黑名单仍 200」与「本该回落直连的请求走上游」）。

⚠️ 本应把这件事写在 `tests/helpers/proxy.ts` 紧邻 `withProxy`（那里是所有直构 core 的汇聚点）；
它就地定义而没有放进 `tests/helpers/**`（登记在 `tests/AGENTS.md`，待收口）。

`withProxy` 那一侧唯一有缺省档的注入位就是 `access`，且那个缺省**不是**放行桩而是生产那一份 ——
牙齿在 `inert-cli-row.test.ts` 那一档（行为面 + 源码级两面）。

## client 模式下的目标名单语义（两档共用）

- 判定对象**永远是「客户端请求的目标」**：absolute-form 的 authority，缺失时回退 Host（**不做 DNS**）。
- 上游的协议 / 地址 / 端口只来自 `UPSTREAM_*`，**不受名单约束**：上游属基础设施，不是「目标网站」。
  旧实现把上游当目标送进判定，后果是双向的 —— 黑名单写上上游会拦掉自己的串联，
  而客户端真正要访问的站点反而无人检查。
- ⚠️ 判别「走上游」与「直连」靠**双源站**（本地 target 桩回 `target-ok:` / 外层 upstream 桩回 `upstream-ok:`）：
  两个应答体互斥，实际拨到谁一目了然；`upstream` 桩还要分别记 CONNECT 的 request-target 与 Upgrade 的握手 Host，
  那是「误用 connectorFor」的硬证据。
- 路由名单（第三组）**只有布尔答案**：命中动作 = 直连，不交上游；server 模式短路不查该组（连 `[route]` 事件都不发）。

## 每用户名单那条链与它三条容易悄悄坏掉的不变式

身份只有一条链：`RequestScope.user` → `ForwarderBase.preDial` → `guardPreDial` → `AccessControl.checkTarget`。

- **事件恰好一条**：`http.ts` 在 client 模式下会走**两次** `preDial`（① 判有效拨号地址、③ 判传输对端），
  两次都判同一个 `dest`。拒绝时恰好一条事件且**上游零建链**；放行时**零条**事件且上游真建链一次。
- **全局优先**：全局与个人都拒时报 `source:"global"` 那一档（运维先看自己的全局配置）。
- **不重启即生效**：改 `users.json` + 越过 1s 节流后，同一条请求从 403 变 200。

## 防假绿的位置

- **公共事件面用真 `CoreEventBridge` 验证**：它转发 `reason` 原值，而 `reason` 若被改成 `"user:blacklist"`
  之类，落进公共面的就是 0 条 —— 断言只数「有没有发」会看不出这条。
- **`onWarning` 白名单逐条点名**（`toContain('w.code === "…"')`）而不是数出现次数：数次数的话新增一条白名单时
  该断言会**静默通过**，而漏接（新增告警却不落盘）才是真正要防的失效。
- **`hasAccountDisabled` 判 `=== true`** 而不是「键存在」：判成「键存在」的话，一个把账号全显式写成 `false`
  的部署每次启动都收一条「配了不生效」—— 告警一旦误报就永久失信。
- **被拒的路径要断言「对端零字节 / 零命中」**：只断言 403 的话，一次「先拒再照发」的接线照样全绿。
- ⚠️ **fixture 一律留在本目录，不许进 `tests/helpers/`**：`external-network-scan.ts` 的 `SCAN_DIRS`
  排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` —— 把含建链位或公网 host 字面量的东西搬进 `helpers/`
  等于让那部分覆盖从零外网扫描里**静默消失**，而 `no-external-network.test.ts` 的两条下界断言照样绿。
- 所有源站 / 上游桩一律 `127.0.0.1:<getFreePort()>`；`acl.json` / `users.json` 一律写进 `mkdtemp` 出来的临时目录。

## 文件

- `guard-http.test.ts` — HTTP 侧访问控制守卫（真代理 + 真名单）。
- `guard-socks.test.ts` — SOCKS 入站访问控制（真握手）。
- `inert-warning.test.ts` — `acl-inert` 的**正反四格真值表**（三条 describe）。
- `inert-cli-row.test.ts` — `acl-inert` 的**落盘行**（真 `ProxyServer` + 文案逐字）+ `onWarning` 白名单的源码级牙齿 + 脚手架 `withProxy` 的 `access` 缺省档不是放行桩。
- `inert-account-table.test.ts` — `account-table-inert` 的判据三格 + 共用码两侧 + CLI 落盘行。
- `user-paths.test.ts` — 每用户名单在**四条转发路径**上各一条 + bob 对照组 + client 模式两次 `preDial`。
- `user-events-and-reload.test.ts` — `[target-denied]` 落盘行带 `source=` / 全局优先 / 改 `users.json` 不重启即生效。
- `client-mode-target.test.ts` — client 模式的**目标名单语义**（第二组）：absolute-form 与 Host 两种形态、白名单只写站点、Upgrade 握手 Host 按目标回写。
- `client-mode-upstream-route.test.ts` — client 模式的**上游路由名单**（第三组）：真值表 + 三种通道形态 + server 模式短路 + `[route]` 事件。
- `inert-fixture.ts` — 前三档共用的装配面：临时 `acl.json`、注入替身、真 runtime / `ProxyServer` 起停（`live` 是跨用例存活的状态句柄）。
- `user-acl-fixture.ts` — `user-*` 两档共用的装配面：自建事件总线、临时 `users.json` / `acl.json`、三个目标桩与四组 hook。
- `client-mode-fixture.ts` — `client-mode-*` 两档共用的装配面：配置快照、上游桩、client / server 两种起法。
- `AGENTS.md` — 本文件。

## 相关路径

- `../../../src/core/access-control.ts` — 被测的名单判定默认实现（`createFileAccessControl`）。
- `../../../src/runtime/index.ts` — `createProxyRuntime` 与 `RuntimeWarning` / `onWarning` 白名单。
- `../../../src/server/index.ts` — 告警落盘那行 `[acl-inert]` / `[account-table-inert]` / `[target-denied]` 的 switch 在这里。
- `../../helpers/proxy.ts` — `withProxy` 脚手架（`access` 缺省档不是放行桩的那条裁决住在这里）。
- `../../../tests/unit/core/access-control/` / `../../../tests/unit/datasource/acl/configured.test.ts` — 判定层与 `hasConfiguredAcl` 那两半。
- `../../../tests/helpers/public-hosts/integration-acl.ts` — 本目录的零外网白名单片（**只有两档有公网字面量**）。
- `../AGENTS.md`、`../../AGENTS.md`、`../../../AGENTS.md`。