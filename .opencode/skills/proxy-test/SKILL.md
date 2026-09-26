---
name: proxy-test
description: Use when black-box testing a running proxy with curl over HTTP, HTTPS CONNECT, WebSocket, SOCKS, authentication, and ACL behavior, or when using the retained local HTTP test origin. Triggers on "测试代理", "代理测试", "curl", "CONNECT", "407", "socks", "wss", "websocket", "代理是否可用", "test:server".
---

# Proxy Test Skill（黑盒验证）

本目录只保留两种手工验证资料：`curl.md`（Curl 黑盒）和 `local-origin.md`（本地 HTTP 测试源站）。不再提供 Vitest、裸 Node 代理客户端或压测器。

## When to Use

- 用户要求验证运行中的代理协议、鉴权、ACL、CONNECT、WebSocket 或 SOCKS 行为。
- 用户需要启动本地测试源站作为可达目标。

## Golden Rule

服务由用户手动启动。Agent 只改代码并执行构建/静态检查，不自行执行 `pnpm dev`、`pnpm start` 或 `pnpm test:server` 拉起常驻进程。未启动时提示用户：

```text
请先执行 pnpm dev (或 pnpm start -- --port <port>) 启动
```

## 工具入口

```bash
# Curl 黑盒：按用户实际协议、账号和目标执行
# 详细示例见 curl.md
curl -v --max-time 10 -x http://127.0.0.1:3000 http://example.com/

# 本地 HTTP 源站：用户手动启动
pnpm test:server -- --port 4000 --size 2KB
```

## 日志

- 日志入口：`src/utils/log/logger.ts`。
- `LOG_FILE` 落盘为按小时切分的 JSONL；可用 `jq` 查询 `[auth]`、`[forward]`、`[route]` 等事件。
- Curl 只用于协议和策略黑盒验证，不用于得出代理吞吐量上限。

## 校验清单

- [ ] 已确认当前 `.env.*`、协议、端口和账号与命令一致。
- [ ] 服务由用户启动，探活失败时没有自行启动或杀死进程。
- [ ] HTTP/CONNECT/WebSocket/SOCKS 的状态码或握手结果符合预期。
- [ ] 鉴权、ACL 和路由结果与当前配置一致。

## Code References

- 配置加载：`src/config/load.ts:initConfig`
- 服务生命周期：`src/server/index.ts`
- 日志：`src/utils/log/logger.ts`
- 本地源站：`tests/http-test-server.mjs`
