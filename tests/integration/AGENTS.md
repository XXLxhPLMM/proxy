# tests/integration/ — 真起端口、真收发字节那一半

判据目录（目录级说明见 `../AGENTS.md`）：挂真 server 类（`http` / `https` / `socks4` / `socks5` /
`sockss4` / `sockss5`）、走真装配、收发真实字节。逐档清单不住在本文件 —— 它住在**该档所在主题目录**的
`AGENTS.md` 里。

## 主题目录

| 目录 | 它答什么 | 判据在 `src/` 哪个文件 |
|---|---|---|
| `acl/` | 名单（`acl.json` 三组 + `users.json` 的个人名单）在真装配里怎么生效、失效时怎么报警（inert 告警 + CLI 落盘行） | `src/core/access-control.ts` + `src/datasource/acl/` |
| `forward/` | `src/core/forward/` 的四条通道（`http` / `tunnel` / `upgrade` / `socks`）加上 `src/core/forward/upstream/connector/` 这一层：出站那几个字节与守卫事件长什么样 | `src/core/forward/` |
| `inbound/` | 入站那一侧：准入关卡顺序、握手字节、mTLS 准入、keep-alive 与上游生命周期解耦 | `src/core/server/` |
| `upstream/` | **入站协议 × 上游协议 × 证书有无** 这一圈里哪几处不许漂 | `src/core/forward/upstream/` |
| `quota/` | 每用户流量配额：从「建链后流动的真实字节」到「落盘账本跨进程存活」这条链路 | `src/datasource/quota/` + `src/core/quota-meter.ts` |
| `logging/` | `bindProxyEventLogs` / `bindLifecycleLog` 两族的逐字段绑定 | `src/runtime/event-log.ts` |
| `runtime/` | 真 runtime 那一圈：三个注入位 + 请求作用域标识 + 请求终态 + 停机排空 | `src/runtime/` |

⚠️ **`forward/` 下面还有一层**：`forward/outbound-header-rewrite/` 有自己的 `AGENTS.md`（出站净化
只能剥不能改那个端口的判据）。其余主题目录下没有再分带独立不变量的一层。

## 集成档的纪律

⚠️ **端口一律 `getFreePort()` 取，禁止硬编码**：它是 `listen(0)` 再 `close()`，**存在 TOCTOU 窗口**
（关掉到真 `listen` 之间那个号可能被抢），所以它只降低撞车概率、不消除。而**硬编码端口在并行 fork /
同机多跑时必撞，且撞了的表现是「某个无关的档红」** —— 报错的距离离真因很远。第二次绑同一个**固定**
端口要真撞时（`../unit/manager/control-plane.test.ts` 那种 `EADDRINUSE` 判据）是刻意的，其余不是。

⚠️ **真端口 ⇒ 真生命周期**：起停、排空、断言一律 `await`；`afterEach` 里必须把 server 关掉。
漏关的后遗症有两份 —— 下一档撞端口，以及 `pool: "forks"` 下进程迟迟不退出（表现为「跑着跑着卡住」，
不是报错）。

⚠️ **fixture 归该主题目录，不许外提到 `../helpers/`**：判据是「它答的是哪个主题的问题」，不是
「有几档在用」。`acl/inert-fixture.ts` 只对名单那块有意义、`upstream/matrix-fixture.ts` 只对上游矩阵
有意义 —— 搬进 `../helpers/` 会让「这段不变量属于哪个主题」在目录结构上消失。命名两种：跨档的
`_*` 前导模块（**不带 `.test.ts`，故不被 `vitest.config.ts` 的 `tests/**/*.test.ts` 收集**）
与 `*fixture.ts`。

⚠️ **账号表 / 名单 / 账本目录一律写进 `mkdtemp` 出来的临时目录**：`../setup-env.ts` 那层钉值**只覆盖
走 `loadConfig` 的用例**，而库模式内联 config 的用例压根不经 `loadConfig` —— 它自己 `new ConfigStore(内联)`
补缺省，于是 `quotaUsageDir` 回落到 `<configDir>/cfg/usage`（`configDir` 缺省 = 仓库根），
而 `open()` 在 `start()` 里就跑（配额为零也照建）。故**内联 config 的每一处都必须自己钉
`quotaUsageDir`**（或给仓库外的 `configDir`）。

## 相关路径

- `../helpers/proxy.ts` — `withProxy` 起停整套代理的测试脚手架。
- `../helpers/net.ts` — `getFreePort()` / `listen()`。
- `../helpers/upstream-stub.ts` — 本地源站桩（`127.0.0.1:<getFreePort()>`）。
- `../helpers/certs.ts` — 仓内测试 PKI（`TEST_TLS_CERTS` / `TEST_CA_PATH`）。
- `../helpers/access.ts` — 测试用 access / identity 替身。
- `../helpers/socks-client.ts` — 裸 SOCKS4/5 客户端。
- `../helpers/child-proxy.ts` — spawn 真 `dist/app.js` 子进程那一套。
- `../http-test-server.mjs` — 本地吞吐源站脚本。
- `../setup-env.ts`、`../AGENTS.md`、`../unit/`、`../library/`。
