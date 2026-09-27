# src/utils/tls/ — 文件与路径说明

证书材料与 TLS 选项。

对外唯一出口：`@/utils/tls/index.js`。

## 文件

- `certs.ts` — `TlsKeyCert` / `TlsInput` / `LoadedTlsCerts` 类型与 `loadCerts` 证书读取。
- `server-options.ts` — 入站建服选项：`requiresClientCert` / `tlsServerOptions`。
- `upstream.ts` — 出站建链选项：`readUpstreamCa` / `upstreamTlsOptions`。
- `index.ts` — 目录 barrel。

入站在 `certs.ts` + `server-options.ts`，出站在 `upstream.ts`。

## 相关路径

- 证书路径绝对化的权威 — `src/config/normalize/paths.ts` 的 `resolveConfigPaths`，字段标记在 `src/config/schema/` 的 `FIELDS`
- 握手失败告警 — `@/core/server/tls-alarm.js`，事件文本 `@/core/log-events.js`
- 接线方 — `src/core/server/https.ts` 的 `doStart`、`src/core/server/socks-base.ts` 的 `onListenerReady`

## 相关测试

- `tests/unit/tls.test.ts`
- `tests/integration/tls-client-auth.test.ts`
