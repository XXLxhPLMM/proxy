# 方法 A — 集成测试（`pnpm test` / vitest）

> **特点**：起本地桩自动断言，零手动，适 CI。全身而退：桩 + 代理都随测随起随关。

## 跑法

```bash
pnpm test                                           # 全量（13 文件 72 用例量级）
pnpm test tests/integration/http-proxy-node.test.ts # 单文件
pnpm test:watch                                     # watch 模式
pnpm test:coverage                                  # 覆盖率
```

## 覆盖

`http 200` / `鉴权 407` / `https CONNECT 200` / `wss 101 echo`，参考 `tests/integration/http-proxy.test.ts:44` / `http-proxy-auth.test.ts:44`。

## 新增用例模板（`tests/integration/http-proxy-node*.test.ts`）

```ts
const targetPort = getFreePort();
http.createServer((req, res) => res.end("hello-target")).listen(targetPort); // 桩
set("port", proxyPort);                                                      // 配代理（store，现配现用）
const proxy = new HttpProxy(); // 或 HttpsProxy()
await proxy.start();
// …断言…
afterAll(async () => { target.close(); await proxy.stop(); set("port", origPort); }); // 关桩 + 还原
```

要点：

- 真起 `HttpProxy`/`HttpsProxy` 打真端口（`getFreePort()` 防冲突），不是 mock
- 日志保持 `set("logLevel", "silent")`，别在 CI 里刷屏
- `vitest.config.ts`：`@`→`src` 别名，`pool: "forks"`，单文件超时 15s

## 失败定位

- 超时 → 看是不是端口被占 / `proxy.stop()` 漏了（afterAll 必关）
- 断言 `407` 不对 → 核对 `Auth` 构造参数与 `AUTH_TYPE`
- 只改 `src/` 需先 `pnpm build`？**不需要**——vitest 直跑 `src` TS；`build` 只给 `dist` 打包
