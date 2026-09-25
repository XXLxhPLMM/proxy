---
name: proxy-test
description: Use when testing proxy via any method — integration (pnpm test/vitest), raw node (tests/manual/proxy-node-test-*.mjs), curl (http/https/CONNECT/wss/socks, 407, tunnel), or local throughput origin (tests/http-test-server.mjs, ?size=, 4000). Triggers on "测试代理", "代理测试", "curl", "pnpm test", "集成测试", "node 测试", "CONNECT", "407", "代理是否可用", "socks", "wss", "websocket", "吞吐", "压测", "test:server", "test:pressure", "?size=".
---

# Proxy Test Skill（测试索引：说明 + 命令，细节见本目录分册）

> 四法按需选型，禁止锁死单一方法。本文件只留**说明和命令**，深水区去分册：
> `integration.md`（集成）/ `node.md`（裸 Node）/ `curl.md`（Curl 黑盒）/ `local-origin.md`（本地源站承压）。

## When to Use

- **集成测试**："跑下集成测试" / "CI 要绿" → `pnpm test`（详见同目录 `integration.md`）
- **Node 裸测**："看日志" / "双层 TLS" / "ws echo" → `node tests/manual/proxy-node-test-*.mjs`（详见同目录 `node.md`）
- **Curl 黑盒**："代理通不通" / "407" / "socks" → `curl -v --proxy-insecure`（详见同目录 `curl.md`）
- **并发承压**："能抗多少并发" / "压测" → 先读同目录 `local-origin.md` 再动手

## 选型指南

| 场景 | 推荐方法 | 分册 |
|---|---|---|
| CI / 回归 / 验证 200/407/101 | **集成测试** | `integration.md` |
| 看日志 / 调 ws 帧 / 双层 TLS | **Node 裸测** | `node.md` |
| 黑盒探活 / 鉴权矩阵 / SOCKS / 链式 | **Curl** | `curl.md` |
| 并发承压 | **本地源站** | `local-origin.md` |
| 复杂链式/超时 | 组合 | 先集成 PASS 再 Node 看日志 最后 curl 复核 |

## Golden Rule: 先看 Env 再改 Env，最后才测

> **服务由用户手动启动，Agent 只改代码才 `pnpm build`，单改 env 无需 build。** Agent 绝不自行 `node dist/app.js` / `pnpm dev` / `taskkill`。未启动：`sleep 2` 重试一次，仍失败则提示用户手动 `pnpm dev` (或 `pnpm start -- --port <port>`)，Agent 结束。

```
标准流程：1.查看 env → 2.修改 env（如需，dev-server 自动重启）→ 3.探活 → 4.选型测试 → 5.读日志
```

Env 要点：`cat .env.development` 对照；优先级 CLI > env-file > 终端 env > `defaults`；改 `.env*` 无需重启（150ms 防抖自动拉新），改 `src/` 才需 `pnpm build`。关键字段：`PORT/HOST` / `PROXY_PROTOCOL` / `TLS_*` / `AUTH_*` / `PROXY_MODE`（client 转 `UPSTREAM_*`）/ `LOG_LEVEL/LOG_FILE`。

## 四法速查（命令说明，细节见分册）

```bash
# 集成：零手动，适 CI（见 integration.md）
pnpm test; pnpm test tests/integration/http-proxy-node.test.ts

# Node 裸测：直连真服务，看帧看日志（见 node.md）
node tests/manual/proxy-node-test-http.mjs    # http
node tests/manual/proxy-node-test-https.mjs   # https 双层 TLS
node tests/manual/proxy-node-test-socks4.mjs  # socks4（目标走本地 :4000）

# Curl：用户视角（见 curl.md；https 自签加 -k --proxy-insecure）
curl -v --max-time 10 -x http://127.0.0.1:3000 http://example.com/                         # 200
curl -v --max-time 10 --proxy-user admin:secret -x http://127.0.0.1:3000 http://example.com/  # Basic 200（账号来自 cfg/users.json）
curl -v --max-time 10 -x http://127.0.0.1:3000 http://example.com/                         # 鉴权开时 → 407

# 承压：源站用户手动启动，Agent 禁拉（见 local-origin.md）
pnpm test:server -- --port 4000 --size 2KB
pnpm test:pressure -- --keepalive --requests 50 --concurrency 100 --size 200B
pnpm test:pressure:direct -- --keepalive --concurrency 50 --requests 100 --size 10B
```

## 日志与切换

- 日志：`src/utils/logger.ts` 唯一入口；`LOG_FILE=log` → `log/YYYY-MM-DD-HH.jsonl`（JSONL，每行一个 JSON 对象，为空不落盘）；`407→grep "\[auth\]"` / `502→grep upstream` / `101→grep upgrade`，或 `jq 'select(.user=="admin")' log/*.jsonl`
- 切环境：无鉴权 `AUTH_ENABLED=false`；Basic `AUTH_ENABLED=true` + `cfg/users.json` 账号（`AUTH_USERS_FILE`）；https 隧道 `PROXY_PROTOCOL=https+TLS_*`；SOCKS `socks5`；看日志 `LOG_LEVEL=debug`（集成保持 silent）

## 校验清单

- [ ] 已 `cat` env 且与命令一致；修改后已见 `restarting` + 探活成功
- [ ] 探活失败已提示 `请先执行 pnpm dev`，未自行启动
- [ ] 集成绿 / Node `PASS` / Curl `407/200/101` 符合预期；承压已读 `local-origin.md`

## Code References

- Env: `src/cli.ts` 显式快照并调用 `src/config/load.ts:loadConfig` / 重启 `scripts/dev-server.mjs` / 显式注入 `src/utils/logger.ts`
- 鉴权: `src/core/auth.ts` / 服务端: `src/core/server/http.ts` / `https.ts` / `src/server/index.ts`
- 测试: `tests/integration/` + `tests/manual/` + `tests/http-test-server.mjs` + `tests/perf/`
