# tests/integration — 真收发字节（34 个文件）

## 路径说明

真 `HttpProxy` / HTTPS / SOCKS 挂空闲端口。每个 core **显式传 `ctx: testContext`**，需要鉴权时显式传 disabled 或测试 auth provider。三个主题簇：

| 主题 | 判据 |
|---|---|
| **全矩阵** | 协议 × 认证 × 端口矩阵，逐格断言可连 / 407 / 403 / 502 |
| **护栏式集成** | 断言一条跨层不变式（实例复用、单一路径、告警只报一次、CLI 与库逐字段相等） |
| **停机与落盘** | 断言停机把账本与日志落到位（**必须用可控的 `stop()`，不能用信号**——见下） |

## 硬约定

- **零外网**：需要真上游时起**本地源站**（`../helpers/net.ts:getFreePort()` + `../helpers/certs.ts` 的仓内 PKI），模式照抄 `../helpers/upstream-stub.ts` 与 `../tests/http-test-server.mjs`。
- **账本目录必须逐例隔离**：在 `beforeEach` 里 `set("quotaLedgerDir", <本例临时目录>)`，并把 `quotaLedgerDir` 加进该文件的 `KEYS` 快照表。⚠️ **不要改账本来「迁就测试」**——用量按设计跨进程持久。
- 需要断言日志的用例**自己注入 `LoggerImpl`**（值位置只能写 `LoggerImpl`；`@/utils/logger/index.js` **不导出 `Logger` 值**，只有 `type Logger`），别依赖任何全局 logger。
- **每条断言的不变量与「为什么」写在这个测试文件自己的头注释里。**

## 决策清单

1. **Windows 上「用信号触发停机」制造的是假绿而不是红** — `process.kill(pid, "SIGINT"|"SIGTERM")` 在 Windows + Node 22 上被 libuv 映射成 `TerminateProcess`：**目标进程当场硬退出、Node 侧信号处理器根本不执行**，于是优雅停机路径（`stop()` → 排空连接 → `closeTrafficLedger()` → `logger.flush()`）**一步都没走**，而「文件内容没变化」之类的断言照样通过。「信号发出后进程还活着片刻」「文件在信号后仍完整」**都不构成**优雅路径被走过的证据。
   - **两种正确写法**：① 需要「停机必落盘 / 必 flush」这类断言时，**一律用可控的 `stop()` 调用**（`await runtime.stop()` / `proxy.stop()` / `server.stop()`）——它与 SIGINT 最终调用的是**同一个** `ProxyServer.stop()`；② 确实只能经信号触发时，**显式标注该平台未验**（`it.skipIf(process.platform === "win32")`，或至少在用例注释里写明原因）。**不要**留一条「在 Windows 上静默通过」的信号用例。
2. **断言 JSONL 必须与行序无关** — 落盘是 `appendFile`，**不保序**（threadpool 多个槽 ⇒ 两次 append 可以乱）。要断言先后就用**多重集合**口径（逐条数次数），不要断言下标。
3. **断言「CLI 与库等价」时逐字段相等、不逐行相等** — 判据是**同一份绑定**（`ProxyServer` 把同一个 `LoggerImpl` 传给 `createProxyRuntime`），所以「一份流量两条路径落盘行逐字段相等」才是它；顺序不是这个判据的一部分。
4. **「替身被原样透传」不等于「替身生效」** — 断言注入的 access / identity **真的被调用**（真 runtime + 真请求 + 真事件），否则一个「透传了但没人调」的替身照样让这档绿。
5. **四档警告的断言按 `warnings.filter((w) => w.code === …)` 断言**恰好**条数**（不是 `>= 1`）——启动期告警是**一次性事实**，`>= 1` 挡不住「每请求报一次」。
