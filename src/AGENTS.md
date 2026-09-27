# src — 组合根

`src/` 根上只有两个文件，它们是全仓的**两个组合根**：`index.ts`（库入口，纯导出）与 `cli.ts`（唯一宿主组合根）。其余五个子目录各自有一份 `AGENTS.md`。

## 路径说明

| 文件 / 子目录 | 装什么 | 判据 |
|---|---|---|
| `index.ts` | **库入口**。`import "@b-hole/proxy"` 不做任何事 | 门面 / 可插值端口 / 进程级 API 三者**正交**。库调用方要换掉任何一层，只需 `createProxyRuntime({ services, connectors, assembly })`；要换「谁拥有这个进程」才去看 `ProcessPolicy` 那一组 |
| `cli.ts` | **唯一宿主组合根**。`main()` 只做四件事 | 快照宿主来源 → 加载配置 → 建 logger 并转交加载告警 → 起进程。**没有第五件事** |
| `config/` | 配置 schema / 加载器 / store / 文件数据层 | 见 [`config/AGENTS.md`](./config/AGENTS.md) |
| `core/` | 协议实现、事件内核、流量计量、身份、访问控制 | 见 [`core/AGENTS.md`](./core/AGENTS.md) |
| `runtime/` | 库运行时门面 | 见 [`runtime/AGENTS.md`](./runtime/AGENTS.md) |
| `server/` | 进程编排层 | 见 [`server/AGENTS.md`](./server/AGENTS.md) |
| `utils/` | 依赖树最底层（logger / constants / tls / json-file） | 见 [`utils/AGENTS.md`](./utils/AGENTS.md) |

## 硬约定

- **库入口零副作用**：`import "@b-hole/proxy"` 绝不读 `.env` / `argv` / 宿主 env、绝不写 `process.env`、不注册 `process` 监听、不建 server、不写日志文件、不 fork cluster。
- ⚠️ **`server/process-guards` 与 `server/log/config-log` 必须保持动态 import 形态**——改成静态 import 就等于把守卫装进 import 期。护栏 `tests/library/entry.test.ts`。
- **不留兼容层**：任何旧名**一律不导出、也不加别名**。本项目零兼容，一个符号改名就是改名。
- **包入口明确不导出** `get` / `getAll` / `set` / `defaultConfigStore` / `globalConfigAccessor`。
- **import 路径规约**：`index.ts` 与 `cli.ts` 位于 `src/` 根上，它们 import 的任何模块都是**跨目录引用**，因此**禁止出现 `./` 相对导入**——否则会误导读者以为根级文件属于某个子目录。跨目录一律 `@/xxx/index.js`。
- **CLI 是唯一读宿主来源的地方**：`loadConfig` 只消费调用方显式给出的 `env` / `envFiles` / `argv`，省略即空，**不猜宿主来源**。`start` / `start:dev` / `start:prod` 脚本只设 `NODE_ENV`，**不得**用 Node `--env-file` 预注入。
- `env` 的影响**全部收敛在 `loadConfig`**。库层（`runtime/` / `presets.ts`）再读一次就是「协议由两处决定」的第二真相源。

## 决策清单

1. **包入口的收录判据只有一条：「要写一个自定义插件的人，必须能 import 到它吗？」** — 否掉「把 core 内部件也出去」— `helpers/**` 的出站头剥离原语、`meterStream` 计量挂点、压缩/解析纯函数、`sources/` 的 argv/env 解析器**一律不导出**：它们要么是装配期就定死的实现细节，要么没有跨目录调用方，而**出口膨胀会让「删掉一个内部函数」变成破坏性变更**。
2. **每一层都同时导出「接口 + 输入/结果类型 + 内置实现」** — 否掉「只导出接口，实现留给调用方自己写」— 否则「可插值」只是口号。端口的依赖承载体 `CoreContext` 也必须出去：几乎每个工厂的第一个形参就是它（`createIdentityFromConfig(ctx)`、`assembly.connectors(ctx)`），调用方连类型都写不出来就没法正确接线。
3. **门面 / 可插值端口 / 进程级 API 三层正交、不互相调用** — `runServer()` / `ProxyServer` / `ProcessPolicy` 拥有进程的那一侧，`createProxyRuntime()` 零进程副作用那一侧。把它们揉成一个「Proxy 类」会让库调用方要么被迫接信号、要么被迫放弃换实现的能力。
4. **`cli.ts:main()` 在第一次 `await` 前快照 env / argv / cwd / `NO_COLOR`** — 否掉「加载后再读」— 异步加载期间宿主可能改写这些值，配置就会与「当时的宿主状态」不一致。⚠️ **`trafficWorkerSlot` 只从那份 env 快照取**（不新读 `process.env`）：cluster master 在 fork 时把它注入子进程环境，于是每个 worker 拿到一个稳定序号，而 core/runtime 全程零 `process.env` 读取——槽位会被拼进账本文件名，**不能靠猜**。
5. **`runServer` 的四项（`logger` / `noColor` / `trafficWorkerSlot` / `assembly`）一律走 `RunServerOptions`** — 否掉「位置参数」— 形状与 `ProxyRuntimeOptions` / `ProxyServerOptions` 刻意统一（三者都是「一个必填 `context` + 一个可选项对象」），加选项不必改签名。
6. **`StartupPreset` 全部符号带 `Startup` / `startup` 前缀** — 与 `@/config/presets.ts:ProxyPreset`（**配置值**打包）名字刻意错开，因为两者**完全无关**。前缀让读代码的人一眼分清「我在动配置值，还是在动装配」。
