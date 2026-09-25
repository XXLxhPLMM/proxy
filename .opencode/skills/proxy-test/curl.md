# Curl 黑盒验证

> **特点**：最贴近用户，无代码。注意两条铁律：`https` 自签代理必加 `-k --proxy-insecure`；经 socks4 代理**禁止**加 `--noproxy`（否则直连绕过代理），直连源站**必须**加 `--noproxy "*"`（否则被终端 `HTTP_PROXY` 污染）。

> 账号来自 `cfg/users.json`（`AUTH_USERS_FILE`，见仓库 `cfg/users.json.example`）；下面示例用 `admin` / `admin:secret`，请按你的账号表替换。plaintext 密码只作示例。

```bash
curl -v --max-time 10 -x http://127.0.0.1:3000 http://example.com/                        # 无鉴权 200
curl -v --max-time 10 --proxy-user admin:secret -x http://127.0.0.1:3000 http://example.com/ # Basic 200
curl -v --max-time 10 -x http://127.0.0.1:3000 http://example.com/                        # 鉴权开着没带证 → 407
curl -v --max-time 15 --proxy-user admin:secret -x http://127.0.0.1:3000 https://example.com/ # https CONNECT 建隧道
```

## https 代理（`PROXY_PROTOCOL=https`，自签 `keys/server.crt`）

```bash
curl -k --proxy-insecure -v --max-time 10 --proxy-user admin:secret -x https://127.0.0.1:3000 http://example.com/  # 200
curl -k --proxy-insecure -v --max-time 10 --proxy-user admin:secret -x https://127.0.0.1:3000 https://example.com/ # 200 Connection Established → 200 OK
# 鉴权矩阵同上：无鉴权/错密码 → 407
```

**`--proxy-insecure` 说明**：自签证书默认校验失败 `SEC_E_UNTRUSTED_ROOT`，`-k --proxy-insecure` 跳过的是**代理层**校验。

## SOCKS

```bash
curl -v --max-time 10 --socks5 127.0.0.1:3000 http://example.com/
curl -v --max-time 10 --socks5 admin:secret@127.0.0.1:3000 http://example.com/
```

## WebSocket（wss 经 https 代理）

```bash
curl -k --proxy-insecure --proxy-user admin:secret -x https://127.0.0.1:3000 -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://ws.postman-echo.com/raw
# → 200 Connection Established → 101 Switching Protocols
```

## socks4 鉴权矩阵（`uid` 只看冒号前，目标走本地 `:4000`）

```bash
curl -s --max-time 8 --socks4 127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "%{http_code}\n" || echo "CURL_EXIT:$?"        # 无鉴权 → exit 97
curl -s --max-time 8 --socks4 nobody@127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "%{http_code}\n" || echo "CURL_EXIT:$?"  # 错用户 → exit 97
curl -s --max-time 8 --socks4 admin:secret@127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "%{http_code}\n"                        # 200（冒号后被忽略）
```

## 5 并发模板（加压起步）

```bash
for i in 1 2 3 4 5; do curl -s --max-time 15 --socks4 admin@127.0.0.1:3000 "http://127.0.0.1:4000/?size=256KB" -o NUL -w "job$i CODE:%{http_code} %{time_total}s %{size_download}B\n" & done; wait
# → 全 200；继续加压时调整 curl 并发或使用外部压测工具，curl 建进程开销大摸不到天花板
```
