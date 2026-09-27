# src/server/log — 配置快照（唯一一块）

## 路径说明

**整个 `log/` 目录只剩 `config-log.ts` 一个文件。** 它打印启动期的配置冻结快照，并脱敏 secret / 口令 / 上游凭证。

## 硬约定

- ⚠️ **不要再往本目录塞事件词汇表或事件订阅。**
  - **事件词表**（`[event-code]` 与 pipe 事件文本）归 `src/core/log-events.ts`——它的唯一直接调用方是 `core/server/*`，放这里就要求 core **反向依赖进程编排层**。
  - **事件 → 落盘的绑定**归 `src/runtime/event-log.ts`——它的唯一直接调用方是 `createProxyRuntime`，放这里就要求库调用方**反向依赖进程层**，而落盘零 `process` 触点、压根不属于这一层。
  - 启动 banner 归 `../banner.ts`；`[config]` / `proxy started:` / `[shutdown]` 这几条归 `ProxyServer`（它们真需要「谁拥有这个进程」才说得清）。
- **运行期文件事件不由本模块抓全局 logger**——由 runtime 显式把当前 logger 注入 config 层。
- `logConfig(context, logger)` 由 `ProxyServer.start()` **动态 import** 调用；模块 import 本身不加载配置、不打印任何东西。

## 决策清单

**三条全部无断言**，所以三条都必须留在本文件：有断言锁住的裁决住在对应 `*.test.ts` 的头注释里，这三条没有。
（对照：本目录**硬约定**最后那条
`log/config-log.js` **动态 import** 形状**有**断言，在 `tests/library/entry.test.ts`。）

1. **`log/` 收缩到只剩这一块** — 否掉「把事件订阅搬回进程层」— 落盘零 `process` 触点，把零副作用的纯函数挂到「拥有进程」那一层，读者只能推断「落盘 = CLI 面 = 进程面」。⚠️ **没有任何断言钉「收缩」这件事**：`src/server/log/` 下多放一个模块，本仓不会红（`tests/unit/pack-contents.test.ts` 只把 `lib/server/log/config-log.js` 登记在白名单里当作「源码目录名不是日志目录」，不枚举该目录内容）。间接的只有两处：`tests/integration/library-event-log-binding.test.ts` 的 `CLI_ONLY_PREFIXES` 把 `"=== config ==="` 与 `"[config]"` 标成 CLI 独有（证明 `[config]` 由 `ProxyServer` 那一侧打），以及 `tests/library/entry.test.ts` 钉住 `logConfig` 只被 `await import("./log/config-log.js")` 调。判据与逐条映射见 `src/runtime/AGENTS.md` 的「有断言锁住的裁决」段。
2. **脱敏在这一层做，不在 `LoggerImpl` 里做** — 落盘要能对**任何**注入的 logger 生效（`src/runtime/AGENTS.md` 决策 5 的同款推理），所以脱敏不能绑在某一个 logger 实现上。⚠️ **没有任何断言**：`jwtSecret` / `tlsPassphrase` / `upstreamPassword` 的 `"***"` 与 `upstreamUrl` 的 `//***@` 掩码**全仓零测试引用**（`tests/integration/log-structured.test.ts` 只断言 JSONL 每行可 `parse` 与 `[forward]` / `[auth]` / `[route]` 三种行的字段，**没有任何一格读 `[config]` 那一行的内容**）。把脱敏挪进 `LoggerImpl`，或干脆去掉，全仓绿——而那是一次**明文密钥进落盘文件**的静默回归。⚠️ 这是本目录**最该补一条断言**的地方。
3. **打印的是 `context.config` 的加载时冻结快照，不是 live store** — 「启动时它长什么样」是配置快照要回答的问题；live 读会打出「加载后又热改过」的值，而那份事实由 `[config-*]` 事件行回答。⚠️ **没有任何断言**：`config-log.ts:logConfig` 读 `context.config` 这一行**从未被扫描或行为断言**（源码面钉住的只有「只被动态 import 调」）。改成 `loadAuthUsers(context.accessor)` 之外再从 `context.store` 现读几个字段，全仓绿。快照本身的「冻结、不随 store 变」在 `tests/unit/config-instance.test.ts`（`expect(Object.isFrozen(first.config)).toBe(true)`），但**没有一条断言说 `[config]` 那一行读的是它**。
