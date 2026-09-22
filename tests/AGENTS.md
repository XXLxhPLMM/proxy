# tests — 测试

`unit/` + `integration/`（真 `HttpProxy` 挂空闲端口；先在 store 置 `host`/`port`/`proxyMode` 再 `new HttpProxy()`），外加回归护栏：`forward-tunnel-guard` / `http-proxy-forward-socks` / `socks-handshake` / `socks-upstream-handshake`（隧道超时、SOCKS 上游路由、分段/流水线握手、上游应答分段 + 余量交接）、`client-mode-acl`（client 名单语义：名单只判客户端请求目标，上游 `UPSTREAM_*` 不受约束）、`upstream-matrix`（入站 × 上游 × 证书四态串联矩阵，全本地桩；**新增串联组合或证书语义时必须在此补一档**）。

## 脚手架

- `helpers/`：`net.ts`（`getFreePort`/`sleep`/`listen`）、`config.ts`（`silenceLogs`/`snapshotConfig`/`restoreConfig`）、`certs.ts`（`TEST_TLS_PATHS`/`TEST_TLS_CERTS` + readers）、`proxy.ts`（`withProxy`）、`socks-client.ts`（collector/connect/builders）—— vitest 不采集（`include: tests/**/*.test.ts`），但 `tsconfig.json` 参与 `tsc --noEmit`。
- `setup-env.ts`（`vitest.config.ts:setupFiles` 接线）：清掉终端残留的配置 env（如 `AUTH_TYPE=pwd`、`PORT=444`），键列表与 `FIELDS` 保持同步。
- `manual/proxy-node-test-*.mjs`（裸 socket 客户端）+ `http-test-server.mjs`（`:4000` 本地吞吐源，`pnpm test:server`）+ `perf/socks4-pressure.mjs`（`pnpm test:pressure`）+ `perf/http-pressure.mjs`（`pnpm test:pressure:direct`，直连压测、免构建）。`vitest.config.ts`（`@`→`src`，`pool:forks`）。

## 测试不落盘

- `setup-env.ts` 把 `LOG_FILE` 钉成空串 —— 默认值与 `.env.development` 都指向仓库 `log/`，用例一旦走到 warn 路径（坏配置、ACL 拒绝、上游失败…）就会把用例日志写进真实运行日志，而 `log/` 被 `.gitignore` 忽略、混进去几乎无法察觉。刻意触发 warn 的用例自己拦截：`vi.spyOn(Logger.prototype, "warn")`（顺带断言去重与恢复，见 `tests/unit/json-file.test.ts`）或 `silenceLogs()`；要断言落盘行为就自己 `set("logFile", <temp dir>)`（见 `log-structured` / `logger` 测试）。
