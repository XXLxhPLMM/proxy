## 回归护栏补充

- `unit/scope-ids.test.ts` + `integration/request-scope-ids.test.ts`：`requestId` / `connectionId` 契约——终态事件必带 id、同请求事件共享同一 requestId、跨请求 id 互异、SOCKS 与 HTTP 一致。**改动请求入口（`handleForward` / `socks-base:onConn`）或事件载荷字段时必须在此复核。**
- `unit/config-loader-import.test.ts`：**唯一加载器 import 边界**——先放入非法宿主 `PORT`/`AUTH_ENABLED`/`UPSTREAM_URL`，动态 import `config/load.ts`；import 与显式 `loadConfig({ env:{}, envFiles:[], argv:[], store, skipFileValidation:true })` 都不得读取/污染 `process.env`，也不得在调用前改 store。改动 `loadConfig`、包入口或配置 IO 边界时必须复核。
- `unit/config-access.test.ts`：core 配置端口**无全局状态**——两个 `configAccessorFromStore()` 实例互不串号且现读各自 store；`ProxyOptions.config`、auth 与 `resolveRoute` 都必须显式绑定 accessor。不得恢复可选参数默认或 `globalConfigAccessor`。
- `unit/config-instance.test.ts` / `unit/config-loader.test.ts`：锁定 `createConfigContext({ ... })` 对象工厂、必填 `configDir`、startup 集合固定来自完整 FIELDS 表且不可由调用方删减；`loadConfig` 与纯内存 runtime 共用 `UPSTREAM_URL` 校验/拆项，URL 与六个 endpoint 拆项是 startup，覆盖拆项 warning 保留。`config-loader.test.ts` 的 argv 用例**一律经 `loadConfig({ argv })`** 断言（三种写法、`=` 保留、非法/越界 fail-fast），不再直接调已删除的 `parseStartupArgs`；该文件的 `parseUpstreamUrl` / `applyUpstreamUrl` 从 `@/config/schema/upstream-url.js` 直引（原 `@/utils/upstream-url.js`），`describe` 名相应改为 `config/schema/upstream-url`。
- `unit/acl.test.ts`：**跨层回归护栏**——`validateAcl` / `readAcl` / `loadAcl` 从 `@/config/index.js` 取（数据层），条目原语 `parseIpRule` / `parseHostRule` / `compileIpRules` / `compileHostRules` / `ipMatches` / `hostMatches` 从 **`@/config/files/rules/index.js`** 取（规则/数据层，`acl.json` 条目语法的唯一定义处），`checkClientIp` / `checkTargetHost` / `checkUpstreamRoute` 从 `@/core/access-control.js` 取（策略层）。改 ACL 语义或搬迁判定层/规则层时必须在此复核两侧 import 方向没有回退。
- `unit/acl-rule-ip.test.ts` / `unit/acl-rule-host.test.ts`（原 `unit/ip-list.test.ts` / `unit/host-list.test.ts`）：锁定 acl.json **条目语法**与 fail-closed 行为——含 `[::1]:443` 判非法（`normalizeIp` 只认整体被方括号包裹，条目侧刻意不放松）、`::ffff:` v4-mapped 归一、CIDR 前缀掩码、`*.域名` 不含裸域、IDN/下划线拒绝。**这两个文件的断言未改动，只改了 import 路径（指向 `@/config/files/rules/index.js`）与 `describe` 名（`config/files/rules/ip|host ...`）**，源文件也从 `src/utils/{ip,host}-list.ts` 搬到了 `src/config/files/rules/{ip,host}.ts`。
- `unit/self-loop.test.ts`（原 `unit/ip.test.ts` 里 `isSelfLoopAddr` 那两个 describe 拆出）：自环判定 11 例，覆盖通配监听（`0.0.0.0`/`::`/展开形态）、端口不同放行、localhost 等价、v4-mapped 归一、通配目标 × loopback 监听的反向判定、尾点与方括号形态，另加 `%zone` 归一后与裸地址等价、空串双方按不相等处理。`unit/ip.test.ts` 只保留地址提取（`getClientAddress` / `getAuthority` / `getSocketAddress`，从 `@/utils/ip.js` 取）。改动 `core/helpers/self-loop.ts` 或 `rules/` 的归一链时两处都要复核。
- `unit/proxy-runtime.test.ts`：锁定 context 模式与传入 context 共享 live store、runtime 相位热读、startup accessor/options 冻结、`UPSTREAM_URL` 改动要求重建、configDir 路径在 `process.chdir()` 后不漂移、`config.loaded` 的 `sourceName` 顺序，以及 stop/restart 保留外部 EventHub 的宿主订阅；还要覆盖 `start→stop→start` 与 `stop-before-start` 后重新建立 bridge/store/ACL 文件订阅；config/preset 模式则使用独立私有 store。
- `integration/tls-client-auth.test.ts`：mTLS 行为之外还锁定实例 logger DI——测试显式创建 silent `LoggerImpl` 并注入 HTTPS/SOCKS core，mTLS 拒绝只能写入该实例，TLS/SOCKS 路径不得回退 `getLogger()`/默认 logger。
- `unit/logger.test.ts`：**logger 导出面护栏**——所有实例化都写 `new LoggerImpl({...})`，并断言 `@/utils/logger/index.js` **不再导出 `Logger` 值**（`expect("Logger" in mod).toBe(false)`）。历史类构造别名 `export const Logger = LoggerImpl` 已删除（破坏性变更，不留兼容层）：**值位置用 `LoggerImpl`，类型位置仍用 `Logger` 接口**（`import type { Logger }` 依旧合法，见 `unit/logger-port.test.ts`）。别把别名加回来。
- **纯搬迁（断言未改、只改 import 路径）的三个文件**，搬迁后复核断言是否仍然指向同一实现即可：`unit/tls.test.ts`（原 `unit/cert.test.ts`：`@/utils/cert.js` → `@/utils/tls/index.js`，`describe` 已改名 `utils/tls:*`）、`unit/log-events.test.ts`（`@/server/log/events-log.js` → `@/core/log-events.js`，`describe` 已改名 `core/log-events`）、`unit/error-boundary.test.ts` 等引常量用例（→ `@/utils/constants/index.js`）。

# tests — 测试

`library/`（**库消费方视角的公开 API 契约测试**）+ `unit/` + `integration/`（真 `HttpProxy`/HTTPS/SOCKS 挂空闲端口；每个 core 显式传 `config: testConfig`，需要鉴权时显式传 disabled 或测试 auth provider），另加回归护栏。

## 库契约（`library/`）

- `entry.test.ts`：验证包边界的硬承诺——① `require("@b-hole/proxy")` 解析到打包的 `lib/index.js` 且深路径被 `exports` 阻断；② 公开值/类型导出面齐全，并明确断言没有 `get/getAll/set/globalConfigAccessor`；③ `createProxyRuntime` 能启停并真转发 HTTP，不只是端口 listening；④ 双 runtime 的 runtimeId/EventHub/context store/端口互不串号，B 的事件归属 B 且 A 的监听数不变；⑤ `await loadConfig({ env, envFiles, argv, cwd })` 只消费显式来源，返回 context/store/accessor/warnings 且不污染宿主 `process.env`。
- runtime 的直接配置面只断言/使用 `runtime.context`；context 模式可由调用方显式传入，纯内存 config/preset 模式由 runtime 建私有 store。`runtime.options.config` 仅作为已归一化 core 选项的 accessor 视图断言；测试不得寻找已删除的独立 `runtime.config` 或 `runtime.configAccessor` 字段。
- 未跑 `build:lib` 时 `lib/` 缺失/过期 → 打包相关断言 `it.skipIf` 跳过，回退到 `@/index.js` 源入口，不让 CI 因未构建而红。
- **`pnpm pack` 烟测不在这里**：仓内测试只覆盖仓内入口。发布前须 `pnpm pack` + 在外部临时项目装 tarball，实测 `files`/`exports`/`engines`、公开导出面与“无 root postinstall”。`forward-tunnel-guard` / `http-proxy-forward-socks` / `socks-handshake` / `socks-upstream-handshake`（隧道超时、SOCKS 上游路由、分段/流水线握手、上游应答分段与余量交接）、`client-mode-acl`（client 名单语义：target 只判客户端请求目标，上游 `UPSTREAM_*` 不受约束；`upstream` 第三组路由语义与 `[route]` 事件）、`upstream-matrix`（入站×上游×证书四态本地矩阵）仍需随行为扩展维护。

## 脚手架

- `helpers/config.ts` 是测试配置唯一便利入口：每个 Vitest fork 显式创建 `testConfigStore = new ConfigStore()`，再派生 `testConfig: ConfigAccessor`。`get/set/getAll/silenceLogs/snapshotConfig/restoreConfig` 只是该测试实例的兼容包装，**不是生产全局 store**。
- `helpers/proxy.ts:withProxy()` 合并 `{ config: testConfig }` 后再构造 core；`helpers/` 另有 `net.ts`（`getFreePort`/`sleep`/`listen`）、`certs.ts`（测试 PKI readers：`TEST_CA_PATH`/`TEST_TLS_PATHS`，被 `unit/tls.test.ts` 经 `@/utils/tls/index.js` 的 `loadCerts`/`readUpstreamCa` 消费）、`socks-client.ts`（collector/connect/builders）。vitest 不采集 helpers，但 `tsconfig.json` 会参与 `tsc --noEmit`。
- `setup-env.ts`（`vitest.config.ts:setupFiles`）清理终端/CI 残留配置 env，键列表与 `FIELDS` 同步；为显式启动 CLI 的子进程钉住 `AUTH_ENABLED=false`、空 `LOG_FILE` 和不存在的 ACL/users 绝对路径。同时把同样三项写入显式 `testConfigStore`，因为 core/库测试直接注入 `testConfig`，不会替它们执行 CLI `loadConfig`。
- `manual/proxy-node-test-*.mjs`（裸 socket 客户端）+ `http-test-server.mjs`（`:4000` 本地吞吐源，`pnpm test:server`）+ `perf/socks4-pressure.mjs`（`pnpm test:pressure`）+ `perf/http-pressure.mjs`（`pnpm test:pressure:direct`）。`vitest.config.ts`：`@`→`src`，`pool:forks`。

## 测试不落盘

- 默认测试 logger 为 noop，或通过 `silenceLogs()` 把显式 `testConfigStore` 的 console/file 等级与路径静音。需要断言日志的用例必须注入自己的 `LoggerImpl`/config-bound logger 并把 `logFile` 指向临时目录；禁止依赖默认 logger 从生产 store 读取策略。
- `setup-env.ts` 同时钉 `process.env.LOG_FILE=""` 与 `set("logFile", "")`：前者约束显式启动 CLI 的组合根，后者约束直接注入 `testConfig` 的 core/runtime。两条路径都不写仓库真实 `log/`。
- JSON 文件单测直接断言 `onEvent`：`unit/json-file.test.ts` 覆盖 label+path 缓存隔离、多个回调各自收到 error/recovered、同回调去重和 missing/reloaded，并锁定仅 `ENOENT`/`ENOTDIR`/非普通文件算 missing、`EACCES` 等 stat 错误保留旧值（无历史时 fallback）并发 error、相对路径先绝对化；`unit/json-file-log.test.ts` 用显式 `{ info, warn }` logger 替身断言 pid/mtimeMs/size。runtime 集成路径则把实例 logger 显式注入 handler。
- `integration/tls-client-auth.test.ts` 显式注入 `new LoggerImpl({ level: "silent" })` 并 spy 该实例的 `warn`，确保 `[tls-client-error]` 断言不依赖任何全局 logger；注入实例的类名是 `LoggerImpl`——历史别名 `Logger` 已从 barrel 删除（`type Logger` 接口仍在，类型位置照旧用）。`integration/log-structured.test.ts` 用 `testConfigStore` 创建 `ConfigContext`、配置临时 `logFile`，经 `ProxyServer({ context })` 验证 JSONL。
- 同理，`aclFile` / `authUsersFile` 钉成不存在的绝对路径，避免开发者本地 `cfg/*.json` 混进测试。需要名单/账号的用例自行 `set(...)` 或创建显式 context；给子进程传 CLI 时仍按 argv > 显式 env > env 文件 > defaults。
