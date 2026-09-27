# tests/

文件与路径说明。

## 文件

- `AGENTS.md` — 本目录的文件与路径说明。
- `setup-env.ts` — 测试运行环境预置（账本、日志、名单与账号文件的测试路径）。
- `http-test-server.mjs` — 本地吞吐源站脚本（响应体大小与端口参数）。

## 子目录

| 目录 | 内容 |
|---|---|
| `unit/` | 纯逻辑与源码级断言，52 个 `*.test.ts` |
| `integration/` | 真 `HttpProxy` / HTTPS / SOCKS 收发字节，34 个 `*.test.ts` |
| `library/` | 包入口公开 API 契约，1 个 `*.test.ts` |
| `helpers/` | 公共测试工具，9 个模块 |
| `manual/` | 裸 `net`/`tls` 手动建连脚本 |
| `perf/` | 吞吐压测器 |

各目录的文件清单见其自己的 `AGENTS.md`：`unit/AGENTS.md`、`integration/AGENTS.md`、`library/AGENTS.md`、`helpers/AGENTS.md`。

## 手动脚本与压测器

- `manual/proxy-node-test-http.mjs` — 裸 HTTP 代理手动测试脚本。
- `manual/proxy-node-test-https.mjs` — 裸 HTTPS 代理手动测试脚本。
- `manual/proxy-node-test-socks4.mjs` — 裸 SOCKS4 代理手动测试脚本。
- `perf/http-pressure.mjs` — HTTP 吞吐压测器。
- `perf/socks4-pressure.mjs` — SOCKS4 吞吐压测器。
