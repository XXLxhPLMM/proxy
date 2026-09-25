# 本地 HTTP 测试源站（`tests/http-test-server.mjs`）

> **用途**：为黑盒验证提供一个稳定、可控制响应大小的本地目标。纯 `node:http` + `node:cluster`，零第三方依赖、不读取 `src/`、不需要 build。源站由用户手动启动，Agent 不自行拉起常驻进程。

## 启动

```bash
pnpm test:server -- --port 4000 --size 2KB             # 固定 2KB
pnpm test:server -- --port 4000 --size 400KB           # 固定 400KB
pnpm test:server -- --port 4000 --min 2KB --max 400KB  # 随机大小
pnpm test:server -- --port 4000 --size 1MB --workers 0 # 0=CPU 核数
pnpm test:server -- --port 4000 --size 2KB --verbose   # 输出逐请求日志
```

CLI 参数优先于 `TEST_*` 环境变量，再使用默认值。

## 单请求验证

```bash
curl "http://127.0.0.1:4000/?size=2KB"                 # 精确 2048B
curl "http://127.0.0.1:4000/?size=400KB"               # 精确 409600B
curl "http://127.0.0.1:4000/?size=1MB&delay=20"        # 大小 + 慢响应
curl "http://127.0.0.1:4000/?size=abc"                 # 400 bad size
curl http://127.0.0.1:4000/health                      # 健康信息和 worker 状态
```

## 直连与经代理

直连时必须绕开终端的 `HTTP_PROXY` 污染；经 SOCKS 代理时不要使用 `--noproxy`，否则会绕过代理。

```bash
# 直连源站
curl --noproxy "*" -s --max-time 10 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "CODE:%{http_code} SIZE:%{size_download}B TIME:%{time_total}s\n"

# 经 SOCKS4 + uid 鉴权
curl -s --max-time 10 --socks4 admin@127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "CODE:%{http_code} SIZE:%{size_download}B TIME:%{time_total}s\n"

# 经 HTTP 代理
curl -x http://127.0.0.1:3000 "http://127.0.0.1:4000/?size=2KB" -o NUL -w "CODE:%{http_code} SIZE:%{size_download}B TIME:%{time_total}s\n"
```

## 注意事项

- 该源站只验证目标可达性、响应大小和代理路径，不负责代理协议自身的正确性。
- Curl 适合功能黑盒验证，不适合作为严谨的吞吐量基准；需要压测时请使用专门的外部工具。
- Windows 下使用多 worker 时，先观察 `/health` 的 worker 分配是否符合预期。
- `--reuse-port` 在部分 Windows 内核上可能报 `ENOTSUP`，不要把它作为默认启动参数。
