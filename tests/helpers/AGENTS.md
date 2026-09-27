# tests/helpers — 公共工具（9 个模块）

**这些文件本身不被任何测试断言，所以它们刻意住在 `helpers/` 而不是 `unit/`。**

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `source-scan.ts` | 源码级断言的公共文本面：`codeOnly` 去注释、行号口径 | 源码扫描型护栏的**唯一**实现。`codeOnly` 必须复用它，否则各处扫描口径会漂 |
| `external-network-scan.ts` | 「测试零外网依赖」护栏的扫描器 + 公网 host 白名单 | ⚠️ **白名单里必须逐条写出被豁免的公网 host 字面量**，若这张表放在被扫描的目录里，扫描器会把自己的白名单当成违规命中——那是纯自噬。**分工与 `source-scan.ts` 同构：文本面在 helper，行为面（断言）在 `unit/`。** |
| `net.ts` | `getFreePort()` 取本机空闲端口 | 需要真网络时**永远**起本地源站，不用公网 |
| `certs.ts` | 仓内测试 PKI（`TEST_TLS_CERTS` / `TEST_CA_PATH`） | 私钥已入库，**勿用于生产** |
| `proxy.ts` | `withProxy` 起停一整套并 `finally` 停机 | 它的 `finally` 走的是可控的 `stop()` 调用，**不是信号**（见 `tests/AGENTS.md` 的 Windows 信号陷阱） |
| `upstream-stub.ts` | 本地源站桩 | 新写需要真上游的用例时照抄它 |
| `socks-client.ts` | 裸 SOCKS4/5 客户端 | SOCKS 握手断言 |
| `config.ts` | `testConfigStore` / `restoreConfig` / `silenceLogs` / `KEYS` 快照表 | 改配置键时**必须**把该键加进对应文件的 `KEYS` 表 |
| `access.ts` | 测试用的 access / identity 替身 | 替身要能被断言「真的被调用」，不是「原样透传就当生效了」 |

## 硬约定

- **不在任何扫描范围内**：护栏扫的是 `unit/` / `integration/` / `library/`，**永远不含 `helpers/`**（理由见上）。推论：**断言档自己不允许出现任何公网 host 字面量**——探针样本全在 helper 里。
- 相对路径一律**先绝对化**再交给被测代码，否则测试会往仓库里写文件。
- ⚠️ **注释里点名被禁 host 是在描述这条不变量本身**——所以扫描必须先 `codeOnly` 去注释。这不是理论风险，本仓真踩过：一条带反引号的处置记录会让朴素引号扫描把注释内容吞成「字符串字面量」，凭空造出一条违规命中。

## 本文件不列决策

零外网扫描的**结论与否掉了什么**（为什么住 `helpers/` 不住 `unit/`、为什么只在字符串字面量内匹配、`example.com` 为什么算公网、为什么要 A/B 两层、白名单纪律、三档防假绿自证）**全部写在 `external-network-scan.ts` 的文件头注释里** —— 那里是文本面，断言在 `unit/no-external-network.test.ts`。改扫描器前读 helper 的头，不要来读本文件。同理，`codeOnly` 的口径（只去注释、不去字符串字面量）在 `source-scan.ts` 的文件头。

