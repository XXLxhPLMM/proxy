# tests — 测试

## 目录形态与判据

| 目录 | 装什么 | 判据 |
|---|---|---|
| `unit/` | 纯逻辑与源码级断言 | 不起监听端口、不拨号。构造对象直接调 |
| `integration/` | 真 `HttpProxy` / HTTPS / SOCKS 挂空闲端口 | 需要真的收发字节才走这层。每个 core 显式传 `ctx: testContext`，需要鉴权时显式传 disabled 或测试 auth provider |
| `library/` | **库消费方视角的公开 API 契约** | 只 import 包入口（`@b-hole/proxy` 或 `lib/`），不碰内部路径——它证明的是「外部调用方看得见的那一面」 |
| `helpers/` | 公共工具（`getFreePort` / 仓内测试 PKI / 源站桩 / `source-scan`） | **不在任何扫描范围内**（白名单与扫描器自噬的互斥，见下） |
| `manual/` | 裸 `net`/`tls` 脚本 | 服务由用户手动起，脚本只对外建连 |
| `perf/` | 压测器 | 按设计就该打真网络 |

## 理由写在测试文件的头注释里

**每个 `*.test.ts` 的不变量与「为什么」写在它自己的头注释里，`AGENTS.md` 一概不重复。** 这与 `src/core/forward/base.ts:72` 是同一条政策（那份注释里写着「计量语义、落点理由……全部写在那个文件的头注释里，**这里不重复**」）。

理由有三层，都还在成立：

1. **头注释离断言最近**。判据变了，改同一个文件里的注释与代码，不必在两处同步。
2. **本仓 97 个测试文件里 74 个已经这么写了**，理由总量约 199 KB —— 知识从来没丢过。文档再抄一份只会变成**无人守着的副本**：没有任何测试断言文档内容，抄错一边就静默地留着错的。
3. **逐测试文件的护栏档案（哪个文件几例、锁哪一档、变异红数）是可机械推导的**：`ls tests/unit/` 得到文件清单，读 `describe`/`it` 得到判据，`vitest run <file>` 得到例数。文档复述它只是引入漂移源，还会读起来像规格书，让下一个人信文档而不读测试——测试被删了文档还在声称它存在，且没有任何东西会红。

**所以要查「这条断言锁什么」，去那个测试文件的头注释。**

## 写护栏的两条硬纪律

- **源码级负向断言不许锚在已删除的符号上** —— 那种锚点恒真，断言恒绿。判据与三条自检清单见根 `AGENTS.md`。
- **写「幂等」类护栏前先问：第二次调用在实现上凭什么不同？** 答不上来就是恒绿。幂等要由实现里的具体机制提供（例如 `splice(0)` 清空订阅数组），不许另设一个「已释放」标志来给自己发绿牌。

## 零外网依赖（`unit/` `integration/` `library/` 的硬约定）

**不变量：这三个目录下的任何用例都不得把连接打到公网。** 需要真网络时正确做法**永远**是起本地源站：`helpers/net.ts:getFreePort()` 取本机端口 + `helpers/certs.ts` 的仓内测试 PKI（`TEST_TLS_CERTS` / `TEST_CA_PATH`）做 TLS，模式照抄 `helpers/upstream-stub.ts` 与 `tests/http-test-server.mjs`。`manual/` 与 `perf/` **按设计就该打真网络**（`pnpm test:server` / `test:pressure`），不在本约定内。

- **为什么是硬约定（真实踩坑）**：外网 `ws.postman-echo.com` 单次 TLS 握手实测约 **4.2s**，而那条用例的超时预算只有 **5s** —— 并行跑几十个文件时**必然偶发超时**（连续两次全量跑各撞上一次，单独跑通过）。**一个外网依赖是定时炸弹，一组是地雷。** 修法是换本地源站（本地端到端实测 **58ms**），**不是**放宽超时、也**不是** `it.skip`。
- **护栏**：`unit/no-external-network.test.ts` + 扫描器与白名单 `helpers/external-network-scan.ts`。**扫描口径（先 `codeOnly` 去注释 / 只在字符串字面量内匹配 / 「公网」怎么定义）、A 层与 B 层为什么是两层、白名单纪律、防假绿三档判据，全部写在那个 helper 的头注释里** —— 改扫描器前读它，不要来读本文件。
- 扫描器与白名单**刻意住在 `helpers/`**（不在扫描范围内）：白名单必须写出被豁免的公网 host 字面量，若它自己被扫描就是纯自噬。推论：**断言档自己不允许出现任何公网 host 字面量**（探针样本全在 helper 里）。分工与 `helpers/source-scan.ts` 同构：**文本面在 helper，行为面在 `unit/`**。

## 测试不落盘

- 默认测试 logger 为 noop；需要断言日志的用例必须注入自己的 `LoggerImpl` / config-bound logger 并把 `logFile` 指向临时目录。**禁止依赖默认 logger 从生产 store 读取策略**（可用 `silenceLogs()` 静音显式 `testConfigStore` 的等级与路径）。
- **账本目录必须逐例隔离。** 用量是**持久**的，共享一个 `quotaLedgerDir` 会让上一条用例烧掉的额度漏进下一条；症状是 `[quota-exceeded] … usage=5000` 变成 `usage=15000`，而且**时序相关**（上一条 runtime 的停机落盘有没有赶上本条 `start`），表现为「时红时绿」——最难查的那种污染。修法：在 `beforeEach` 里 `set("quotaLedgerDir", path.join(<本例临时目录>, "quota"))`，并把 `quotaLedgerDir` 加进该文件的 `KEYS` 快照表随 `restoreConfig` 复原。**根因是正当行为**（账本按设计跨进程存活），不要改账本来「迁就测试」。
- `setup-env.ts` 钉住三样，缺一不可：
  - `QUOTA_LEDGER_DIR` / `set("quotaLedgerDir", …)` —— 性质最糟的一项：前三项只是「读到脏数据」，账本目录是**往仓库里写文件**（FIELDS 缺省是相对路径 `cfg/quota`，经 `createConfigContext` 绝对化后落在仓库内），不钉第一次跑就留下未跟踪的 `?? cfg/quota/`。
  - `process.env.LOG_FILE=""` / `set("logFile", "")` —— 前者约束显式启动 CLI 的组合根，后者约束直接注入 `testConfig` 的 core/runtime。两条路径都不写仓库真实 `log/`。
  - `aclFile` / `authUsersFile` 钉成不存在的绝对路径 —— 避免开发者本地 `cfg/*.json` 混进测试。需要名单/账号的用例自行 `set(...)` 或创建显式 context。
- 断言账本内容、断言 `[tls-client-error]`、断言 JSONL 的用例**各自**注入实例 logger / 临时路径，**不依赖任何全局 logger**（理由与做法写在各自文件头注释里）。

## 平台陷阱：Windows 上信号触发不了优雅停机

- **实测事实（Windows + Node 22，本仓主战场）**：`process.kill(pid, "SIGINT")` 与 `"SIGTERM"` 都被 libuv 映射成 `TerminateProcess` —— 目标进程**当场硬退出（exit code 1），Node 侧的信号处理器根本不执行**，于是 `src/server/index.ts` 里那些 `[shutdown] …` 行一条都不会出现，优雅停机路径（`stop()` → 排空连接 → `closeTrafficLedger()` → `logger.flush()`）**一步都没走**。`"SIGBREAK"` 更直接：libuv **不支持**用 `process.kill` 把它 raise 出来，抛 `ENOSYS`。`taskkill` 不带 `/F` 同样是硬终止。`bindSignals` 在 win32 上确实注册了 `SIGBREAK`，但它只能由**真实控制台的 Ctrl+Break** 触发，测试里制造不出来。
- **为什么必须单独记一条**：它制造的是**假绿**而不是红。写「停机必须落盘」这类断言时用信号触发，被测逻辑在 Windows 上**压根没执行**，而「文件内容没变化」之类的断言照样通过 —— 等于静默测了个假的。同理，「信号发出后进程还活着片刻」「文件在信号后仍然完整」都**不构成**优雅路径被走过的证据。
- **两种正确写法**：① 需要「停机必落盘 / 停机必 flush」这类断言时，**一律用可控的 `stop()` 调用**（`await runtime.stop()` / `await proxy.stop()` / `await server.stop()`）—— 它与 SIGINT 最终调用的是**同一个** `ProxyServer.stop()`；② 确实只能经信号触发时，**显式标注该平台未验**（`it.skipIf(process.platform === "win32")`，或至少在用例注释里写明「Windows 未验：信号被映射为 `TerminateProcess`，处理器不执行」）。**不要**留一条「在 Windows 上静默通过」的信号用例。
