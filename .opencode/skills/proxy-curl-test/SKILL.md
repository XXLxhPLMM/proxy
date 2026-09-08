---
name: proxy-curl-test
description: Use when testing proxy via any method — integration (pnpm test/vitest), raw node (tests/manual/proxy-node-test-*.mjs), or curl (http/https/CONNECT/wss, 407, tunnel). Triggers on "测试代理", "代理测试", "curl", "pnpm test", "集成测试", "node 测试", "CONNECT", "407", "代理是否可用", "wss", "websocket".
---

# Proxy Test Skill (集成 / Node / Curl 全覆盖)

> 原锁定 `curl` 已扩展为 **三位一体**：`集成测试`（`pnpm test` / vitest）+ `裸 Node`（`tests/manual/*.mjs` 看日志）+ `Curl`（CLI 黑盒）。按需选型，禁止锁死单一方法。

## When to Use

- **集成测试**：用户说 "跑下集成测试" / "pnpm test" / "写个 vitest" / "CI 要绿" → 走 `pnpm test`
- **Node 裸测**：用户说 "看日志" / "裸 socket" / "双层 TLS" / "ws echo" → 走 `node tests/manual/proxy-node-test-*.mjs`
- **Curl 黑盒**：用户说 "用 curl 测一下" / "代理通不通" / "407" / "socks" → 走 `curl -v --proxy-insecure`
- Do NOT 锁死：优先按用户意图推荐，但三种方法均需掌握，切 env/探活/日志流程共用

## 选型指南

| 场景 | 推荐方法 | 优点 | 典型命令 |
|---|---|---|---|
| CI / 回归 / 快速验证 200/407/101 | **集成测试** | 自动起桩、零手动、断言强 | `pnpm test tests/integration/http-proxy-node.test.ts` |
| 看 `[forward]/[tunnel]/[upgrade]/[auth]` 日志 / 调 ws 帧 / 双层 TLS | **Node 裸测** | 直连真服务 `127.0.0.1:3000`，日志落 `log/` + 控制台 | `node tests/manual/proxy-node-test-http.mjs` / `-https.mjs` |
| 黑盒探活 / 浏览器行为 / 鉴权矩阵 / SOCKS / 链式 | **Curl** | 最贴近用户，无代码 | `curl -k --proxy-insecure --proxy-user test:456 -x https://127.0.0.1:3000 https://example.com/` |
| 复杂链式/超时 | 组合 | 先集成 PASS 再 Node 看日志 最后 curl 复核 | `pnpm test && node ... && curl` |

## Golden Rule: 先看 Env 再改 Env，最后才测

> **服务由用户手动启动，Agent 只改代码 + `pnpm build`。** 若服务未启动，提示用户执行 `pnpm dev` (或 `pnpm start -- --port <port>`)。Agent 绝不自行 `node dist/app.js` / `taskkill`.

## ⛔ 禁止 Agent 启动服务（强制）

> **Agent 绝对禁止自行启动/重启/杀掉服务。** 这是 `AGENTS.md: Service startup` 的硬规则，skill 必须遵守。

- **禁止执行**：`pnpm dev` / `pnpm start` / `pnpm start:dev` / `node dist/app.js` / `node --env-file-if-exists=... dist/app.js` / `taskkill` / `kill` / `npm run dev` 等任何拉起服务的命令
- **唯一允许**：检测到未启动时，`sleep 2` 重试一次后，输出提醒文案让 **用户手动** 执行：
  ```
  [proxy-test] 代理服务未启动（127.0.0.1:3000 连续2次连接失败）
  请先执行 pnpm dev (或 pnpm start -- --port <port>) 启动服务，启动后再通知本萝莉继续测试
  ```
- **禁止偷偷 `pnpm build` 后顺手 `pnpm dev`** — `build` 只产出 `dist/app.js`，不启动
- 若用户已用 `pnpm dev` 启动，env 变更由 `scripts/dev-server.mjs` 自动监听重启，Agent 只需等待日志 `[dev-server] restarting`，无需任何启动命令

### 标准流程（必须按序）

```
1. 查看 env 环境  →  2. 修改 env 环境（如需切换）  →  3. 等待服务自动重启  →  4. 存活检测(失败 sleep 2s 重试)  →  5. 选型测试 (集成/Node/Curl)  →  6. 读日志定位
```

**为什么不能直接测？** `src/config/loader.ts:loadEnvFiles` 在启动时按优先级把 env 写入 `process.env`，且 `scripts/dev-server.mjs:99-120` 监听 `.env*` 文件变化后 **自动重启**。直接测可能测的是旧配置。

## Step 1 — 查看 Env 环境

```bash
# 1) 读当前生效文件（dev 模式下 dev-server 用 --env-file-if-exists=.env.development 启动）
cat .env.development
cat .env.production
cat .env.example  # 对照默认值

# 2) 若服务已启动，看启动日志里的 masked config 快照（src/server/index.ts:log masked config）
# 3) 配置优先级（src/config/loader.ts:initConfig）： CLI > env-file > 终端 env > src/config/store.ts:defaults
#    env-file 内部优先级低→高： .env.production → .env.development → .env.<NODE_ENV> (loader.ts:321)
#    注意：.env 和 .env.local 不被 loader 加载
```

关键字段对照 `src/config/store.ts:defaults` / `.env.example`:

| 字段 | 影响测试的点 |
|---|---|
| `PORT` / `HOST` | 所有方法里的 `127.0.0.1:3000` 地址 |
| `PROXY_PROTOCOL` | `http` → 明文/`curl -x http://`+`node net`；`https` → `curl -x https://`+`node tls` 需 `--proxy-insecure` |
| `TLS_KEY/CERT/CA` | `https` 必配 `keys/server.key|crt` (`src/utils/cert.ts:loadCerts`) |
| `AUTH_ENABLED` / `AUTH_TYPE` / `AUTH_USERNAME` / `AUTH_PASSWORD` | 集成里 `Auth` 构造、Node 里 `Proxy-Authorization: Basic`、Curl 里 `--proxy-user` |
| `PROXY_MODE` | `server` 直连目标，`client` 转发到 `UPSTREAM_*` / `UPSTREAM_URL` |
| `UPSTREAM_URL` / `UPSTREAM_HOST` / `UPSTREAM_PORT` | client 模式下所有方法的目标会被二次转发 |
| `LOG_FILE` / `LOG_LEVEL` | 日志落盘位置与等级，Node 法最直观 |

## Step 2 — 修改 Env 环境（按需切换）

> 直接改文件，**无需手动重启** — `scripts/dev-server.mjs:106-120` 监听 `.env*`，150ms 防抖后自动 `killTree` + `spawn`。

```bash
# 例：无鉴权 http
PORT=3000
PROXY_PROTOCOL=http
AUTH_ENABLED=false

# 例：Basic 鉴权 https
PROXY_PROTOCOL=https
TLS_KEY=keys/server.key
TLS_CERT=keys/server.crt
AUTH_ENABLED=true
AUTH_TYPE=basic
AUTH_USERNAME=test
AUTH_PASSWORD=456
```

**修改后必做：** 保存后等待 `[dev-server] .env.development changed, restarting...` + `[dev-server] server started`，再探活（见 Step 3.5）

## Step 3 — 等待服务自动重启

- `scripts/dev-server.mjs:88` 监听 `dist/*.js` + `.env*`，`restart` 防抖 150ms
- `killTree` 在 Windows 用 `taskkill /T /F` 杀进程树，Linux 用 `SIGTERM`，随后 300ms 拉起
- 判断完成：看日志 `server started: https://0.0.0.0:3000` / `http://...` 或探活返回 `200`/`407` 而非 `Connection refused`

## Step 3.5 — 服务未启动检测（每次测试前必跑）

```bash
# 探活：HOST/PORT 取自 env（默认 127.0.0.1:3000），https 代理需加 --proxy-insecure
curl -k --proxy-insecure -v --max-time 5 -x https://127.0.0.1:3000 http://example.com -I 2>&1 | head -n 20
# 或 http 代理： curl -v --max-time 5 -x http://127.0.0.1:3000 http://example.com -I
# 若含 "Connection refused"/"Failed to connect" → 视为未启动
```

**重试逻辑（严禁自行启动）：**
```bash
echo "[proxy-test] 服务未响应，sleep 2s 后重试..."; sleep 2; curl -k --proxy-insecure -v --max-time 5 -x https://127.0.0.1:3000 http://example.com -I 2>&1 | head -n 20
# 第二次仍失败 → 输出提醒：请先执行 pnpm dev，Agent 结束
```

## Step 4 — 三法测试

### 方法 A — 集成测试（pnpm test / vitest）

> **特点**：起本地桩 `httpTarget`/`wsTarget`，`set("logLevel","silent")` 静默，适 CI。参考 `tests/integration/http-proxy.test.ts:44` / `http-proxy-auth.test.ts:44`

```bash
# 全量
pnpm test  # 12 passed 68 tests

# 单文件
pnpm test tests/integration/http-proxy-node.test.ts  # 4 passed | 1 skipped

# 新增用例模板（tests/integration/http-proxy-node*.test.ts）
# - getFreePort() → http.createServer((req,res)=>res.end("hello-target")).listen(0)
# - set("port",proxyPort) + new HttpProxy() / HttpsProxy() + proxy.start()
# - afterAll 关闭桩 + 还原 set("port",origPort)
```

**覆盖**：`http 200` / `鉴权 407` / `https CONNECT 200` / `wss 101 echo`

### 方法 B — 裸 Node（看日志首选）

> **特点**：直连真服务 `127.0.0.1:3000`，日志实时落 `log/YYYY-MM-DD-HH.log` + 控制台，`src/utils/logger.ts:toHourlyFile`。已拆分为 `http` / `https` 专用：

```bash
# http 代理（PROXY_PROTOCOL=http）
node tests/manual/proxy-node-test-http.mjs
# 内部 net.createConnection → GET http://example.com/ / CONNECT example.com:443 → tls → GET / / CONNECT ws:443 → tls → Upgrade 101 → 发 masked hello-node → echo

# https 代理（PROXY_PROTOCOL=https，需 TLS 外层）
node tests/manual/proxy-node-test-https.mjs
# 外层 tls.connect({rejectUnauthorized:false}) → 内层同上双层 TLS
# 输出： [http via https-proxy] PASS / [https] PASS / [ws] PASS echo matched

# 失败定位
tail -n 50 log/2026-09-08-*.log
grep -n "\[auth\]\|\[forward\]\|\[tunnel\]\|\[upgrade\]" log/*.log
```

**何时用**：调 `wss` 帧、看 `[auth] deny`、验证 `HttpsProxy` 双层 TLS 时必用

### 方法 C — Curl（黑盒/用户视角）

> **特点**：最贴近用户，需注意 `https` 代理自签证书要加 `--proxy-insecure`

```bash
# === http 明文代理 PROXY_PROTOCOL=http ===
curl -v --max-time 10 -x http://127.0.0.1:3000 http://example.com/  # 无鉴权 200
curl -v --max-time 10 --proxy-user test:456 -x http://127.0.0.1:3000 http://example.com/  # Basic 200
curl -v --max-time 10 -x http://127.0.0.1:3000 http://example.com/  # 无鉴权但 AUTH_ENABLED=true → 407
curl -v --max-time 15 --proxy-user test:456 -x http://127.0.0.1:3000 https://example.com/  # https CONNECT

# === https 代理 PROXY_PROTOCOL=https 自签 ===
curl -k --proxy-insecure -v --max-time 10 --proxy-user test:456 -x https://127.0.0.1:3000 http://example.com/  # 200
curl -k --proxy-insecure -v --max-time 10 --proxy-user test:456 -x https://127.0.0.1:3000 https://example.com/  # 200 Connection Established → 200 OK
# 鉴权矩阵同上，无鉴权/错密码 → 407

# SOCKS
curl -v --max-time 10 --socks5 127.0.0.1:3000 http://example.com/
curl -v --max-time 10 --socks5 test:456@127.0.0.1:3000 http://example.com/

# WebSocket wss 经 https 代理
curl -k --proxy-insecure --proxy-user test:456 -x https://127.0.0.1:3000 -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" https://ws.postman-echo.com/raw
# → 200 Connection Established → 101 Switching Protocols
```

**`--proxy-insecure` 说明**：`https` 代理用 `keys/server.crt` 自签，`curl` 默认校验证书失败 `SEC_E_UNTRUSTED_ROOT`，需 `-k --proxy-insecure` 跳过代理层校验

## Step 5 — 日志在哪里读

> `src/utils/logger.ts` 唯一入口，控制台始终输出，文件额外落盘。

- **控制台**：`pnpm dev` 直接彩色输出 `[proxy] [auth/tunnel/forward/upgrade]`
- **文件**：`LOG_FILE=log` → `log/YYYY-MM-DD-HH.log` 按小时轮转（`src/utils/logger.ts:43 toHourlyFile`），`LOG_FILE` 为空则不落盘
```bash
ls log/; tail -n 100 log/2026-09-08-10.log; tail -f log/2026-09-08-10.log
grep -n "\[auth\]" log/*.log; grep -n "407\|502\|504" log/*.log
```
- **等级**：`debug < info < warn < error < silent`，`LOG_LEVEL=debug` 可看更细

| 现象 | 看哪里 |
|---|---|
| `Connection refused` | 终端 `server started`，`log/*.log tail` 看崩溃 |
| `407` | `grep "\[auth\]"` 核对 `AUTH_USERNAME/PASSWORD` |
| `502/504` | `grep upstream` 核对 `UPSTREAM_*` |
| `101` 失败 | `grep upgrade` + Node 帧 `810a...` |

## 切换环境快速模板

| 想测什么 | 改什么 | 三法怎么变 |
|---|---|---|
| 无鉴权 http | `AUTH_ENABLED=false` | 集成 `new Auth({enabled:false})` / Node 去掉 `Proxy-Authorization` / Curl 去掉 `--proxy-user` |
| Basic 鉴权 | `AUTH_ENABLED=true` + `test:456` | 集成 `new Auth({enabled:true,...})` / Node `Basic dGVzdDo0NTY=` / Curl `--proxy-user` |
| https 隧道 | `PROXY_PROTOCOL=https` + `TLS_*` | 集成 `HttpsProxy` / Node 切 `proxy-node-test-https.mjs` / Curl `-x https://` + `--proxy-insecure` |
| SOCKS | `PROXY_PROTOCOL=socks5` | 集成 `SocksProxy` / Curl `--socks5` |
| 看日志 | `LOG_LEVEL=debug` | Node 最直观，集成保持 silent |

## 校验清单

- [ ] 已 `cat` env，`PORT/PROXY_PROTOCOL/AUTH_*` 与测试命令一致
- [ ] 修改后已见 `[dev-server] restarting`，探活成功才测（失败 sleep 2 重试）
- [ ] 探活两次失败已提醒 `请先执行 pnpm dev`，未自行启动
- [ ] 集成 `pnpm test` 绿，Node `PASS` + `echo`，Curl `407/200/101` 符合预期
- [ ] 已按需 `tail log/*.log`，`LOG_LEVEL=debug` 时看 `[auth]` 审计

## 常见坑

- **Connection refused** → sleep 2 重试，再提示 `pnpm dev`；看 `PORT` 是否一致
- **407 但密码对** → 核对 `AUTH_TYPE=basic` / `AUTH_ENABLED=true` / `Proxy-Authorization` 拼写
- **curl 自签报错** → `https` 代理必加 `-k --proxy-insecure`
- **改 env 不生效** → `pnpm start` 不监听，需手动重启；`pnpm dev` 才自动
- **日志找不到** → `LOG_FILE` 为空则无文件，`ls log/` 确认

## Code References

- Env 加载: `src/config/loader.ts:initConfig` / `FIELDS` / `loader.ts:321`
- 默认值: `src/config/store.ts:defaults`
- 自动重启: `scripts/dev-server.mjs:watch` + `restart`
- 日志: `src/utils/logger.ts:Logger` / `toHourlyFile`
- 鉴权: `src/core/auth.ts:Auth` + `src/core/token-extractors.ts:HeaderTokenExtractor`
- HTTP 常量: `src/utils/constants.ts:HTTP_407_PROXY_AUTH_REQUIRED`
- 服务端: `src/core/server/http.ts:HttpProxy` / `src/core/server/https.ts:HttpsProxy` / `src/server/index.ts:ProxyServer`
- 测试: `tests/integration/http-proxy-node.test.ts` / `tests/manual/proxy-node-test-http.mjs` / `tests/manual/proxy-node-test-https.mjs`
