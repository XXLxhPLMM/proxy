## 回归护栏补充

- `unit/scope-ids.test.ts` + `integration/request-scope-ids.test.ts`：`requestId` / `connectionId` 契约——终态事件必带 id、同请求事件共享同一 requestId、跨请求 id 互异、SOCKS 与 HTTP 一致。**改动请求入口（`handleForward` / `socks-base:onConn`）或事件载荷字段时必须在此复核。**
- `unit/config-loader-import.test.ts`：配置 import 零副作用契约——在非法 `PORT` / `AUTH_ENABLED` / `UPSTREAM_URL` 下 import `cli.ts` 与 `loader.ts` 必须成功，且 `process.env` / 全局 store 原样不变。**改动 loader、CLI 入口或配置初始化位置时必须复核。**

# tests — 测试

`library/`（**库消费方视角的公开 API 契约测试**）+ `unit/` + `integration/`（真 `HttpProxy` 挂空闲端口；先在 store 置 `host`/`port`/`proxyMode` 再 `new HttpProxy()`），外加回归护栏：

## 库契约（`library/`）

- `entry.test.ts`：验证「别人把仓库当库调用能轻松搭代理」的四条硬承诺——① `require("@b-hole/proxy")` 解析到打包的 `lib/index.js` 且**深路径被 `exports` 阻断**；② 公开值/类型导出面齐全；③ `createProxyRuntime` 能起**真能转发**的代理（`starts and stops` + `forwards a real request`）而不只是「端口在监听」；④ **双 runtime 实例隔离**（runtimeId/事件总线/配置/端口互不串号，B 的事件 context 归属 B 且 A 的总线监听数不变）；⑤ `loadConfig` 显式加载**不污染宿主 `process.env` 与全局单例**。
- 未跑 `build:lib` 时 `lib/` 缺失/过期 → 打包相关断言 `it.skipIf` 跳过，回退到 `@/index.js` 源入口，**不让 CI 因未构建而红**。
- **`npm pack` 烟测不在这里**：仓内测试只覆盖仓内入口。发布前须 `npm pack` + 在**外部临时项目**装 tarball 实测（验证 `files`/`exports`/`engines` 与「无 root postinstall」），手工执行一次即可。`forward-tunnel-guard` / `http-proxy-forward-socks` / `socks-handshake` / `socks-upstream-handshake`（隧道超时、SOCKS 上游路由、分段/流水线握手、上游应答分段 + 余量交接）、`client-mode-acl`（client 名单语义：target 名单只判客户端请求目标，上游 `UPSTREAM_*` 不受约束；`upstream` 第三组路由语义——黑名单命中/白名单未命中回落直连、真值表与 server 模式短路 + `[route]` 路由事件恰一条/拒绝与 server 模式零条（监听 pipe 事件断言；`[route]` info 落盘全链路在 `log-structured`））、`upstream-matrix`（入站 × 上游 × 证书四态串联矩阵，全本地桩；**新增串联组合或证书语义时必须在此补一档**）。

## 脚手架

- `helpers/`：`net.ts`（`getFreePort`/`sleep`/`listen`）、`config.ts`（`silenceLogs`/`snapshotConfig`/`restoreConfig`）、`certs.ts`（`TEST_TLS_PATHS`/`TEST_TLS_CERTS` + readers）、`proxy.ts`（`withProxy`）、`socks-client.ts`（collector/connect/builders）—— vitest 不采集（`include: tests/**/*.test.ts`），但 `tsconfig.json` 参与 `tsc --noEmit`。
- `setup-env.ts`（`vitest.config.ts:setupFiles` 接线）：清掉终端残留的配置 env，键列表与 `FIELDS` 保持同步；并把 `logFile`/`aclFile`/`authUsersFile` **同时**钉进 env 与 store（core/库测试不会自动执行 CLI 初始化，只钉 env 无法改变全局 `get()`）——`logFile=""` 防落盘、后两者指向不存在的绝对路径（缺失=空配置），使用例不受开发者本地 `cfg/*.json` 影响。
- `manual/proxy-node-test-*.mjs`（裸 socket 客户端）+ `http-test-server.mjs`（`:4000` 本地吞吐源，`pnpm test:server`）+ `perf/socks4-pressure.mjs`（`pnpm test:pressure`）+ `perf/http-pressure.mjs`（`pnpm test:pressure:direct`，直连压测、免构建）。`vitest.config.ts`（`@`→`src`，`pool:forks`）。

## 测试不落盘

- `setup-env.ts` 把 `LOG_FILE` 钉成空串（**同时 `set("logFile", "")`**：CLI 初始化不再由 import 触发，仅钉 env 时 `get("logFile")` 仍是 `"log"`）—— 默认值与 `.env.development` 都指向仓库 `log/`，用例一旦走到 warn 路径（坏配置、ACL 拒绝、上游失败…）就会把用例日志写进真实运行日志，而 `log/` 被 `.gitignore` 忽略、混进去几乎无法察觉。刻意触发 warn 的用例自己拦截：`vi.spyOn(Logger.prototype, "notice")`（`utils/json-file` 只抛 `onEvent` 事件、不记日志；config 层经 `src/config/json-file-log.ts` 落 notice，顺带断言去重/恢复/热加载——json-file 单测直接断言事件回调，见 `tests/unit/json-file.test.ts`；事件→日志的 pid/版本字段断言见 `tests/unit/json-file-log.test.ts`）或 `silenceLogs()`（`logLevel=silent` 对 notice 同样是硬关闭）；要断言落盘行为就自己 `set("logFile", <temp dir>)`（见 `log-structured` / `logger` 测试）。
- 同理，`aclFile` / `authUsersFile` 也钉成不存在的路径：两者默认指向仓库 `cfg/`（`.gitignore` 忽略、属开发者本地配置），不钉住则本地名单/账号会混进测试——实测本地 `cfg/acl.json` 带 target 白名单会让整批集成用例假失败（403）。需要名单/账号的用例自行 `set(...)` 或给子进程传 CLI（CLI 优先于 env）。
