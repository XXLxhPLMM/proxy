# Curl 黑盒验证

> **特点**：最贴近用户，无代码。三条铁律见下，其中第 1 条（`NO_PROXY`）会让**整个测试静默退化成直连并全绿**，是最危险的坑。

> 账号来自 `cfg/users.json`（`AUTH_USERS_FILE`，见仓库 `cfg/users.json.example`）；下面示例用 `admin` / `admin:secret`，请按你的账号表替换。plaintext 密码只作示例。

## 铁律 1：`NO_PROXY` 会覆盖显式 `-x`，本地目标必须 `--noproxy ""`

很多机器的环境里有 `NO_PROXY=127.0.0.1,localhost,::1`。**curl 里 `NO_PROXY` 的优先级高于显式 `-x`/`--proxy`**，于是：

```bash
# 错：想经代理打本地源站，但 NO_PROXY 命中，curl 直接连源站，全程不过代理
curl -x http://127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB"   # 返回 200，却什么都没测到

# 对：空串覆盖 NO_PROXY，强制经代理
curl --noproxy "" -x http://127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB"
```

**自检**：`curl -v` 里出现 `Uses proxy env variable no_proxy`、且下一行是 `Trying 127.0.0.1:4000`（而不是代理地址），就是被绕过了。

**反向对照（矩阵类测试必做）**：全部跑通后**再杀掉代理/上游跑一遍**。若此时仍是 `200`，说明前面全是假绿；正确表现是 `000` / `rc=97`（exit 97 = `CURLE_PROXY`）。

| 场景 | 参数 |
| --- | --- |
| 经代理访问**本地**源站 | `--noproxy ""` + `-x` / `--socks*` |
| 经代理访问**外网**（`example.com`） | 只给 `-x`（`NO_PROXY` 一般不含外网域名） |
| 直连本地源站（绕过代理验源站本身） | `--noproxy "*"` |

## 铁律 2：自签证书

`https` 自签代理必加 `-k --proxy-insecure`：前者跳目标证书校验、后者跳**代理层**校验，缺一报 `SEC_E_UNTRUSTED_ROOT`。

## 铁律 3：curl 没有 SOCKS-over-TLS

`curl` **不存在** `--sockss4` / `--sockss5` 选项。`sockss4`/`sockss5` 入站只能用 `openssl s_client` 在 TLS 通道里手工跑握手（按 `xxd` 实字节判定，**不要套用预期值**）；openssl 也不可用时**如实报「未覆盖」，禁止编造结论**。

> **别误判成 bug**：SOCKS 入站**不发 `forward` 事件**——`ProxyForwardEvent.req` 的类型是 `http.IncomingMessage`，SOCKS 会话没有该对象。所以 SOCKS 链路只有 `[socks]` / `[route]` 行，grep 不到 `[forward]` 是契约使然。`http`/`https` 入站才有。

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

> 注意这三条都打**本地** `:4000`，必须带 `--noproxy ""`（铁律 1），否则全部被 `NO_PROXY` 绕过而假绿。

```bash
curl -s --noproxy "" --max-time 8 --socks4 127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "%{http_code}\n" || echo "CURL_EXIT:$?"        # 无鉴权 → exit 97
curl -s --noproxy "" --max-time 8 --socks4 nobody@127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "%{http_code}\n" || echo "CURL_EXIT:$?"  # 错用户 → exit 97
curl -s --noproxy "" --max-time 8 --socks4 admin:secret@127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "%{http_code}\n"                        # 200（冒号后被忽略）
```

## 5 并发模板（加压起步）

```bash
for i in 1 2 3 4 5; do curl -s --noproxy "" --max-time 15 --socks4 admin@127.0.0.1:3000 "http://127.0.0.1:4000/?size=256KB" -o NUL -w "job$i CODE:%{http_code} %{time_total}s %{size_download}B\n" & done; wait
# → 全 200；继续加压时调整 curl 并发或使用外部压测工具，curl 建进程开销大摸不到天花板
```
