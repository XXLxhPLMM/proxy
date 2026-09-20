# 方法 D — 本地吞吐源站（`tests/http-test-server.mjs`，无需 build）

> **用途**：测代理服务器能抗多少并发（并发承压），非日常怀疑排障。纯 `node:http + node:cluster`，零依赖、不读 `src/`，本地 `:4000` 消除公网 RTT 抖动 + 终端 `HTTP_PROXY` 污染，单请求 `?size=` 校准基线后逐步加并发打压。源站由用户手动启动，Agent 绝不自行 `pnpm test:server` 拉起 `:4000` 常驻（探活用一次性 `node -e fetch` 或 `curl --noproxy` 点测除外）。

```bash
# === 启动（唯一入口 pnpm test:server；CLI > TEST_* 环境变量 > 默认值）===
pnpm test:server -- --port 4000 --size 2KB             # 固定 2KB（小包口径）
pnpm test:server -- --port 4000 --size 400KB           # 固定 400KB（大包口径）
pnpm test:server -- --port 4000 --min 2KB --max 400KB  # 随机 2KB~400KB
pnpm test:server -- --port 4000 --size 1MB --workers 0 # 自定义：0=CPU 核数（默认 1 单进程）
pnpm test:server -- --port 4000 --size 2KB --workers 4 # 多进程（Node22 下 RR 分发正常，已验 12/13/13/12）

# === 单请求覆盖（每个请求独立，无状态，覆盖启动默认值；非法回 400）===
curl "http://127.0.0.1:4000/?size=2KB"                 # 精确 2048B
curl "http://127.0.0.1:4000/?size=400KB"               # 精确 409600B
curl "http://127.0.0.1:4000/?size=1MB&delay=20"        # 大小 + 慢上游模拟
curl "http://127.0.0.1:4000/?size=abc"                 # 400 bad size
curl http://127.0.0.1:4000/health                      # {ok,pid,worker,uptime,served}（health 自身不计入 served）

# === 请求日志开关（--verbose / TEST_VERBOSE，默认关闭；排查问题时打开）===
pnpm test:server -- --port 4000 --size 2KB --workers 1 --verbose
# 每个请求打一行（health/400 也打）：
# [test-server] worker=0 GET /?size=2KB -> 2048B delay=0ms
```

**直连 vs 经代理对比矩阵（当前 `.env.development` 为 `socks4` + `uid` 鉴权、账号来自 `cfg/users.json` 时实测基线）：**

```bash
# 直连（必须 --noproxy "*" 绕开终端 HTTP_PROXY 污染）
curl --noproxy "*" -s --max-time 10 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "CODE:%{http_code} TIME:%{time_total}s SIZE:%{size_download}B\n"
# → CODE:200 TIME:~0.017s SIZE:2048B
curl --noproxy "*" -s --max-time 15 "http://127.0.0.1:4000/?size=400KB" -o NUL -w "CODE:%{http_code} TIME:%{time_total}s SIZE:%{size_download}B SPEED:%{speed_download}B/s\n"
# → CODE:200 TIME:~0.020s SIZE:409600B SPEED:~19MB/s

# 经 socks4 代理（禁止加 --noproxy，否则直连绕过代理；-v 应见 Opened SOCKS connection via 127.0.0.1 port 3000）
curl -s --max-time 10 --socks4 admin@127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "CODE:%{http_code} TIME:%{time_total}s SIZE:%{size_download}B\n"
# → CODE:200 TIME:~0.017s SIZE:2048B（零开销）
curl -s --max-time 15 --socks4 admin@127.0.0.1:3000 "http://127.0.0.1:4000/?size=400KB" -o NUL -w "CODE:%{http_code} TIME:%{time_total}s SIZE:%{size_download}B SPEED:%{speed_download}B/s\n"
# → CODE:200 TIME:~0.021s SIZE:409600B（仅慢约 1ms）
curl -v --max-time 8 --socks4 admin@127.0.0.1:3000 http://127.0.0.1:4000/health 2>&1 | grep -E "Trying|SOCKS|Established|HTTP/1.1"

# socks4 鉴权矩阵（uid 只看冒号前，失败时 curl exit 97）
curl -s --max-time 8 --socks4 127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "%{http_code}\n" || echo "CURL_EXIT:$?"  # 无鉴权 → exit 97
curl -s --max-time 8 --socks4 nobody@127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "%{http_code}\n" || echo "CURL_EXIT:$?"  # 错用户 → exit 97
curl -s --max-time 8 --socks4 admin:secret@127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "%{http_code}\n"  # 200（uid 只看冒号前，密码被忽略）

# http 代理写法对照（PROXY_PROTOCOL=http 时）
curl -x http://127.0.0.1:3000 http://127.0.0.1:4000/?size=1MB -o NUL -w "%{http_code} %{time_total}s %{size_download}B\n"

# 5 并发起步，逐步加到 N 验证能抗多少并发（看成功率/超时率/5xx + log/*.jsonl 瓶颈）
for i in 1 2 3 4 5; do curl -s --max-time 15 --socks4 admin@127.0.0.1:3000 "http://127.0.0.1:4000/?size=256KB" -o NUL -w "job$i CODE:%{http_code} %{time_total}s %{size_download}B\n" & done; wait
# → 全 200，单请求 11~47ms；加压时加大并发数 / 换 --size 400KB 即可
```

**node 压测器（找天花板首选，curl 法 wall 时间 80% 花在建进程上测不出真上限）：**

```bash
pnpm test:pressure -- --concurrency 500 --size 200B            # 单波 500 并行
pnpm test:pressure -- --concurrency 1000 --size 200B --rounds 3  # 3 波，每波峰值连接 + 延迟分布
# 输出： [wave 1/1] N=1000 ok=1000 fail=0 wall=8187ms rps=122/s total[min/avg/p50/p95/p99/max]=... peakConn=1000
# 实测基线（静默 + 8 worker，200B）：close 模式 N=1000 → ~380rps/p50~2.1s；keep-alive 下回看
# 日志是主凶之一，极高并发前先确认源站日志已默认关闭、代理 LOG_LEVEL 降级再打

# keep-alive 模式（浏览器体感口径，同隧道串行多请求，建连成本被分摊）
pnpm test:pressure -- --keepalive --requests 50 --concurrency 100 --size 200B  # 100 隧道 × 50 请求
pnpm test:pressure -- --keepalive --concurrency 200 --requests 100 --size 400KB
# 实测（同上配置，5000 请求）：1460rps / p50 56ms / p99 164ms，相对 close 模式约 3.8 倍 rps、p50 降 40 倍；
# 由此可分解单请求成本：转发本身 ~1.3ms + 建连（TCP+握手+拨号+拆除）~1.5ms
# 结论：盲池化上游隧道不做——省的只是拨号零头（loopback 亚毫秒），却赌不透明 TCP 跨客户端无脏数据；
# 真要压建连成本，动 authorize/guard/emit 这些固定开销，profile 定点再动手

# 直连源站打压（A/B 的另一半：先称源站本身，再经代理打，同口径横比）
pnpm test:pressure:direct -- --concurrency 200 --size 10B                       # close：200 并行新建连接
pnpm test:pressure:direct -- --keepalive --concurrency 50 --requests 100 --size 10B  # keepalive：50 长连接各 100 请求
# 经代理 ≈ 直连 → 代理没吃吞吐；经代理明显更差 → 再剖代理

# 多目标扇出（真·多核：N 个 --workers 1 源站各占一端口，压测器侧轮分，总量不变）
pnpm test:server -- --port 4000 --size 2KB --workers 1  # 开 N 个终端，各占 4000/4001/4002…
pnpm test:pressure:direct -- --keepalive --concurrency 99 --requests 50 --target 127.0.0.1:4000,127.0.0.1:4001,127.0.0.1:4002
# SUMMARY 自带 perTarget 分账（如 4000=8250 4001=8250 4002=8250）；实测 3 目标 5 轮平均 ~5.5k/s
```

**何时用**：测代理能抗多少并发时用本地源站打压，先单请求校准直连基线，再上并发模板逐步加压，瓶颈看 `log/*.jsonl` + 超时率/5xx

**已知坑**：

- Windows 下 `cluster` 仍建议先用并发探针验分布（50 并发 `/health` 看各 worker 命中）， eyeball 4 行 `listening` 不等于分活
- `--reuse-port` 在部分 Windows 内核报 `ENOTSUP`（代码已自动降级为共享监听并警告），别写进默认启动命令
- 同机三进程（压测器+源站+代理）抢核时测出的是系统分；第一轮普遍最慢（JIT 热身），报数建议丢首轮或多轮平均
