# 方法 B — 裸 Node（`tests/manual/*.mjs`，看日志首选）

> **特点**：裸 `net`/`tls` 直连真服务 `127.0.0.1:3000`，绕过 curl 的黑盒，直看协议帧 + 代理日志。服务由用户手动启动（`pnpm dev`），脚本只对外建连。

## 三脚本

```bash
node tests/manual/proxy-node-test-http.mjs    # PROXY_PROTOCOL=http
node tests/manual/proxy-node-test-https.mjs   # PROXY_PROTOCOL=https（外层 tls.connect({rejectUnauthorized:false})）
node tests/manual/proxy-node-test-socks4.mjs  # PROXY_PROTOCOL=socks4 + uid 鉴权（目标走本地 :4000，不走公网）
```

## 各自在验什么

- **http**：`GET http://example.com/` 明文转发 → `CONNECT example.com:443` 建隧道 → 内层 `tls` 发 `GET /` → `CONNECT ws:443` → `Upgrade 101` → 发 masked `hello-node` → echo 比对
- **https**：同上全套，外层再包一层 `tls`（双层 TLS），验 `HttpsProxy` 拆/封
- **socks4**：裸 `net` 发 `0x04/0x01 + 端口 + IP + USERID` → `0x5A` 放行 → 隧道里 `GET /?size=200B` + `/?size=400KB` 精确字节 → 错用户 `0x5B` 拒绝
- 输出：`[http via https-proxy] PASS` / `[https] PASS` / `[ws] PASS echo matched` / `handshake/http 200B/http 400KB/auth deny` 四项 `ALL PASS`

## 配日志看（本方法精髓）

```bash
tail -n 50 log/2026-09-08-*.log
grep -n "\[auth\]\|\[forward\]\|\[tunnel\]\|\[upgrade\]" log/*.log
```

- 调 `wss` 帧：看 `[upgrade]` + Node 帧 `810a...`
- 看 `[auth] deny`：核对 `AUTH_USERNAME/PASSWORD` + `Proxy-Authorization` 拼写
- `LOG_LEVEL=debug` 开控制台细粒度、`LOG_FILE_LEVEL=debug` 单独开文件细粒度（两级独立）；文件按 `LOG_FILE=log` 落 `log/YYYY-MM-DD-HH.log`（为空不落盘）

## 何时用

调 `wss` 帧、看 `[auth] deny`、验证双层 TLS、curl 复现不了的玄学问题时必用。
