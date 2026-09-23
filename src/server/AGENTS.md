# src/server — 服务端编排

`index.ts`（`ProxyServer`：进程与编排）+ `cluster.ts`（多进程）+ `log/`（结构化日志）。协议内部状态机归 `src/core/AGENTS.md` 的 `BaseProxy`，本层不管。

## ProxyServer（`index.ts`）

- `createProxy()`：读 store（`proxyProtocol/host/port/upstreamTimeout/tls/auth`）组 `baseOpts`，经 `core/server/factory.ts` 建 `ProxyCore`。
- `start()`：`setupProcessGuards()` → 非 worker 打掩码配置（`logConfig()`）→ 建代理 → 订 `stateChange` → `bindProxyEventLogs()` → 绑信号 → `proxy.start()`。
- `bindProxyEventLogs()`：core/server 只抛不记，落盘收拢于此。`forward`（按 kind 打行；debug 级 headers dump 经 `maskSensitiveHeaders` 把 `proxy-authorization`/`authorization`/`cookie`（大小写不敏感，含数组值）掩码为 `"***"`，其余头原样）/ `forwardError` / `serverError` / `clientError` / `auth`（allow→debug，deny→info 留审计）/ `pipe`（按 `type` 分发：`target-unresolved/loop-detected/upstream-refused/upstream-error/upstream-timeout/route（与 `[route]` info 行 1:1：字段 `target`/`route`/`reason`，core 在 server 模式短路不发）/ip-denied/target-denied/socks/debug`；**转发层 502 必须带成因**：`upstream-error` 含 `target` + `err.message` 落 warn，否则 TLS 失败/ECONNREFUSED 在 info/error 级无痕）。
- `stop(graceMs)`：优雅停机 + 超时兜底 `process.exit(1)`（timer `unref`）。信号与 master IPC 可能同时到达（同一次 Ctrl+C 的控制台广播 + IPC 扇出），重复触发幂等、不得打断排空；单进程下停机中再收信号才强退，worker 永不强退（兜底交 master 的 grace SIGKILL 与 `stop()` 自身超时）。
- `EADDRINUSE`：提示查占用 + `pnpm start -- --port <next>`（逻辑在 `src/cli.ts`）。

## Cluster（`cluster.ts`）

- `clusterWorkers>1` 才 fork。worker 快速退出（`<5s`）1s backoff 重启，连续 5 次快速退出 → master `exit(1)`；第二个信号强制 master 退出；全部 worker 退出后 master 以 0 退出。

## 本目录注意

- `server/log/`：`[event-code]` 结构化事件 + 启动期掩码配置快照。查日志用 `jq`（示例见 `src/utils/AGENTS.md`）。
