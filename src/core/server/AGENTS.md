# src/core/server/

文件与路径说明。

## 文件

- `src/core/server/base.ts` — `BaseProxy` 生命周期状态机、`ConnRegistry`、`closeServer`、`authorize`、`listenAsync` 与 `ListenableServer`。
- `src/core/server/admission.ts` — 入站两阶段准入 `InboundAdmission`（`admitClientIp` / `authenticate` / `scopeFor`）。
- `src/core/server/http.ts` — `HttpProxy` 骨架、三个 `server.on` 回调、入站派发表 `buildInboundChannels` / `channelFor`、`handleForward`、`writeRejected`、`maskSensitiveHeaders`。
- `src/core/server/https.ts` — `HttpsProxy`，TLS 建服的 `doStart`。
- `src/core/server/factory.ts` — 按 `ProxyProtocol` 建实例。
- `src/core/server/socks-base.ts` — `SocksProxyBase` 与 `PlainSocksProxy` / `TlsSocksProxy`，`createListener` 差异点。
- `src/core/server/socks-session.ts` — `runSocks4Session` / `runSocks5Session` 握手状态机，经 `SocksSessionHost` 注入。
- `src/core/server/socks4.ts` / `src/core/server/socks5.ts` / `src/core/server/sockss4.ts` / `src/core/server/sockss5.ts` — 四个协议薄壳。
- `src/core/server/tls-alarm.ts` — `bindTlsClientError` 握手告警绑定。

## 路径指引

- 相关：`src/core/forward/`（转发与上游）、`src/core/request-scope.ts`（`createRequestScope` 的调用点在 `admission.ts`）、`src/core/log-events.ts`（握手 / 接入期告警词汇）、`src/runtime/event-log.ts`（事件落盘）、`src/server/process.ts`（进程策略端口）。
- 相关测试：`tests/unit/core/server/inbound-dispatch.test.ts`、`tests/unit/core/server/base-lifecycle.test.ts`、`tests/unit/runtime/bridge/`、`tests/integration/inbound/admission-order-http.test.ts` + `admission-order-socks5.test.ts`、`tests/integration/runtime/stop-drain.test.ts`、`tests/integration/inbound/tls-client-auth.test.ts`。
