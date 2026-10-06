# tests/ — 判据都在这儿

本目录回答「哪几处不许漂」。这里是**判据这一层**的地图。
跑法（`pnpm test` / 怎么只跑一段）归根 `AGENTS.md` 的 Commands 一节，**这里不重复**。

## 本目录的文件

- `setup-env.ts` — 测试环境预置（`vitest.config.ts` 的 `setupFiles`，**每个档都跑**）：
  清掉宿主终端 / CI 残留的配置键与代理选择变量，并把账号表 / 名单 / 日志 / 账本目录一律钉到系统临时
  目录下的**不存在**路径。⚠️ 这一层挡的是**静默污染**：`no_proxy` 让「本该被 ACL 拒绝」的用例拿到 200、
  宿主的一个 `MANAGER_ENABLED` 让整批 spawn 用例红、账本目录把文件写回仓库 —— 三者的表现形式都不是报错。
- `http-test-server.mjs` — 本地吞吐源站脚本（响应体大小与端口参数），供 `perf/` 与手动脚本用。

## 子目录：各答什么

| 目录 | 答什么 |
|---|---|
| `unit/` | **不起监听、不拨号**那一半：构造对象直接调的纯逻辑判据 + 读源码文本的边界断言 |
| `integration/` | **真起端口、真收发字节**那一半：入站协议 × 上游协议 × 认证 在真装配下的行为 |
| `library/` | 库消费方视角：只从包入口 import 的那份公开 API 契约 |
| `helpers/` | 与主题无关的公共面：脚手架 / 替身 / 源码文本面 / 零外网扫描器与白名单 |
| `manual/` | 裸 `net` / `tls` 手动建连脚本 |
| `perf/` | 吞吐压测器 |

⚠️ **`unit/` 与 `integration/` 按主题分了层，且每个主题目录都有自己的 `AGENTS.md`**：
`library/` 与 `helpers/` 各只有一份 `AGENTS.md`，逐文件清单就在那两份里。

⚠️ **档间共用的东西不许外提到 `helpers/`**：判据是「它答的是哪个主题的问题」，不是「有几档在用」。
`inert-fixture` 只对名单那块有意义、`matrix-fixture` 只对上游矩阵有意义。

## 手动脚本与压测器

⚠️ **这两块不起 vitest**（`vitest.config.ts` 只收 `tests/**/*.test.ts`，而它们是 `.mjs`），
所以它们里面发生的一切**没有任何机器判据** —— 改端口、改协议、改源站形态之后必须手验。

- `manual/proxy-node-test-http.mjs` — 裸 HTTP 代理手动建连。
- `manual/proxy-node-test-https.mjs` — 裸 HTTPS 代理手动建连。
- `manual/proxy-node-test-socks4.mjs` — 裸 SOCKS4 代理手动建连。
- `perf/http-pressure.mjs` — HTTP 吞吐压测器（统计口径见 skill `proxy-test`）。
- `perf/socks4-pressure.mjs` — SOCKS4 吞吐压测器。
