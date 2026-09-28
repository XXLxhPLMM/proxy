# tests/integration/

文件与路径说明（目录级说明见 `../AGENTS.md`）。

真 `HttpProxy` / HTTPS / SOCKS 挂空闲端口、真实收发字节的 `*.test.ts` 集合。

## 文件

- `acl-inert-warning.test.ts` — acl-inert 启动期告警条数与 CLI 落盘行的单测。
- `client-mode-acl.test.ts` — client 模式三组名单（含 upstream 路由名单）的单测。
- `custom-services-wiring.test.ts` — 自定义服务接线的单测。
- `forward-tunnel-guard.test.ts` — 隧道转发守卫的单测。
- `forwarder-connector-wiring.test.ts` — forward channel 与 connector 接线、上游凭证注入的单测。
- `forwarder-instance-reuse.test.ts` — 转发器实例复用的单测。
- `full-matrix.test.ts` — http / https / socks4 / socks5 × auth × node/curl 全矩阵单测。
- `http-acl-guard.test.ts` — HTTP 侧访问控制守卫的单测。
- `http-forward-contract.test.ts` — HTTP 转发合同五式（absolute-form / origin-form / SOCKS 隧道 / 上游凭证 / 失败分流）。
- `http-inbound-keepalive-decoupled.test.ts` — HTTP 入站 keepalive 与隧道生命周期解耦的单测。
- `http-proxy-auth.test.ts` — HTTP 代理认证（407）的单测。
- `http-proxy-chain.test.ts` — HTTP 代理串联上游的单测。
- `http-proxy-forward-socks.test.ts` — HTTP 代理经 SOCKS 上游转发的单测。
- `http-proxy-node.test.ts` — 经 node 客户端的 HTTP 代理单测。
- `http-proxy-request-line.test.ts` — HTTP 请求行形态的单测。
- `http-proxy-upstream-protocol.test.ts` — 上游协议取值下的 HTTP 代理行为单测。
- `http-proxy.test.ts` — HTTP 代理基础转发的单测。
- `inbound-admission-order.test.ts` — HTTP / SOCKS5 入站准入关卡顺序与事件的单测。
- `library-event-log-binding.test.ts` — 纯库路径事件日志绑定与 CLI 逐字段等价的单测。
- `lifecycle-log-binding.test.ts` — 生命周期日志绑定与 CLI/库逐字段等价的单测。
- `log-structured.test.ts` — 结构化日志字段的单测。
- `outbound-header-rewrite.test.ts` — 出站报文改写钩子（`OutboundHeaderRewriter`）的缺席/加头/改删/次序/抛错/上下文契约与库调用方注入路径。
- `request-scope-ids.test.ts` — 请求作用域 `requestId` / `connectionId` 的单测。
- `request-terminal-events.test.ts` — 请求终止事件的单测。
- `socks-acl.test.ts` — SOCKS 入站访问控制的单测。
- `socks-handshake.test.ts` — SOCKS 握手的单测。
- `socks-upstream-handshake.test.ts` — socks5 上游握手（分段交接与用户密码认证）的单测。
- `stop-drain-live-tunnel.test.ts` — 停机排空活跃隧道的单测。
- `tls-client-auth.test.ts` — TLS 客户端证书认证的单测。
- `traffic-ledger-runtime.test.ts` — runtime 落盘账本端到端重启恢复的单测。
- `traffic-quota.test.ts` — 每用户流量配额计量与耗尽的单测。
- `upstream-matrix.test.ts` — 入站 × 上游 × 证书组合矩阵的单测。
- `upstream-protocol-fail-closed.test.ts` — 非法 `upstreamProtocol` fail-closed 的单测。
- `user-acl-enforcement.test.ts` — 每用户名单在四条路径上生效的单测。
- `websocket-single-path.test.ts` — WebSocket 单路径 `route` 事件与自环判定的单测。

## 相关路径

- `../helpers/proxy.ts` — `withProxy` 起停整套代理的测试脚手架。
- `../helpers/net.ts` — `getFreePort()` 本机空闲端口。
- `../helpers/certs.ts` — 仓内测试 PKI。
- `../helpers/upstream-stub.ts` — 本地源站桩。
- `../helpers/access.ts` — 测试用 access / identity 替身。
- `../http-test-server.mjs` — 本地吞吐源站脚本。
- `../AGENTS.md`、`../unit/`、`../library/`。
