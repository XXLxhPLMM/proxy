# tests/helpers/

文件与路径说明（目录级说明见 `../AGENTS.md`）。

## 文件

- `access.ts` — 测试用的 access / identity 替身。
- `certs.ts` — 仓内测试 PKI（`TEST_TLS_CERTS` / `TEST_CA_PATH`）。
- `config.ts` — `testConfigStore` / `restoreConfig` / `silenceLogs` / `KEYS` 快照表。
- `external-network-scan.ts` — 零外网扫描器与公网 host 白名单。
- `net.ts` — `getFreePort()` 本机空闲端口。
- `proxy.ts` — `withProxy` 起停一整套代理的测试脚手架。
- `source-scan.ts` — 源码级断言的公共文本面（`codeOnly` 去注释、行号口径、`blockAfter` 函数体切片、`sourceFiles` 现列目录里的 `*.ts`）。
- `runtime-floor-scan.ts` — Node 运行时地板的扫描器与判据自检样本（合成脏文本刻意住在本 helper：断言档是被扫描对象，在里面写真版本号会把自己判成违规）。
- `socks-client.ts` — 裸 SOCKS4/5 客户端。
- `upstream-stub.ts` — 本地源站桩。

## 相关路径

- `../unit/no-external-network.test.ts` — 零外网扫描的行为面断言。
- `../unit/`、`../integration/`、`../library/`、`../AGENTS.md`、`../http-test-server.mjs`。
