# src/ — 控制面契约、请求形状、本地库与启动器（重构空白期）

⚠️ **重构期**：`api/`（控制面 HTTP 契约 + 拨号）、`lib/`（零 IO 纯函数层：`request/` 三个请求叶子 +
`model-id.ts` 模型键）、`config/`（本地配置：装载 + 默认值 + `get` / `set` / `reload`）与 `services/`
（会动手的那一半：本地库 + 资源门面）照旧；启动一侧已重建为 `cli.tsx`（入口）→ `starter/`
（建根 + 插件 + 预设），状态层与 UI 待重建（`cli.tsx` 目前只等退出信号，没有渲染）。

| 路径 | 答什么 |
|---|---|
| `api/` | 控制面 HTTP **契约 + 拨号**：按服务端模块分目录（`schema.ts` 管验证与类型，`client.ts` 管接口，一个端点一个函数）/ **唯一**那条 `axios.request`（`transport/send.ts`）/ 响应体类型（`z.infer` 从 schema 推）。⚠️ 地址与 token 是**函数参数**（`ManagerTarget` 三格普通数据，形状住 `lib/request/transport.ts`），没有「客户端对象」这一层 |
| `lib/request/` | 请求那一圈的三个纯叶子：失败词汇（`errors.ts`，`TuiError` 三档）/ 地址变换（`http.ts`：归一、抹 userinfo、`:username` 代入）/ 请求形状（`transport.ts`，纯类型）。⚠️ `api/` 只许引这三个叶子，禁引任何 barrel（成环） |
| `lib/model-id.ts` | `provider/model` 模型键的词汇：类型 `ModelId` + 切分 `splitModelId` / 判形 `isModelId`。⚠️ 按**第一个** `/` 切（`model` 自己可含 `/`，如 openrouter 的 `anthropic/claude-x`） |
| `config/` | 本地配置的**装载 + 活配置**：文件落点 `~/.config/swain-proxy/tui/config.json`（缺则看 `config.jsonc`；都没有先建空 `config.json`），装载 = 各节校验 + **用文件覆盖默认值**（默认值唯一真值住代码——顶层 `defaults.ts`、各节在自家文件夹如 `database/`；文件只写要覆盖的项；`.jsonc` 吃注释与尾逗号，`.json` 严格），组装出 `ConfigStore`（`get` / `set` / `reload`，交出深冻结快照）。⚠️ 一节一个文件夹（默认值 + 校验，如 `database/`），顶层 `loader.ts` 只分派；`~/` 开头的路径装载时展开；坏 JSON / 认不得的项 = 启动失败；`set` 只改内存不写盘 |
| `services/db/` | 本地库的**底座**：开 / 关库（`dialect.ts`，今天只有 sqlite 真能开）/ drizzle 表（`sqlite/schemas/`，JS 侧驼峰 ↔ 库内蛇形）/ 运行期建表（`sqlite/init.ts`：基线 DDL 的 `IF NOT EXISTS` 镜像 + 列校验，列集合靠 `getColumns` 现取）/ 行 → DTO 判据（`read.ts`）/ DTO（`dto/`）/ 两档驱动（`sqlite/driver/`：内置 `node:sqlite` 优先，退 `node-sqlite3-wasm`） |
| `services/resource/` | 本地资源的**门面**：组装点 `attachResource(db)`（`attach.ts`：备 schema **一次**）交出 `Resource` —— `sessions` / `messages` **各自**一个 store（`store/sessions.ts` / `store/messages.ts`：`attach(db)` 包装已打开的句柄，方法即操作）。⚠️ 句柄**开 / 关不归门面**（归 `starter/plugins/database.ts`）；无连接池、无重连（单进程单连接）；`ops/` 是实现原语（库句柄走函数参数、时刻由调用方给），**不外转**（跨目录取库走 `ctx.resource`） |
| `starter/` | 应用树的**启动器**（Cordis）：`index.ts` 是唯一建根处（`createStarter(preset)` / `disposeStarter(ctx)`）；`plugins/` 每个插件一个文件、服务类型声明随提供者——`config.ts` 先装载配置（`ctx.cfg`；缺文件先建），`database.ts` 声明 `inject: ["cfg"]`、按 `ctx.cfg.get("database")` 开库（`ctx.database`）并在卸载 effect 里关库，`resource.ts` 声明 `inject: ["database"]`（**等句柄装载完成才加载**）、备 schema 后挂 `ctx.resource`（`.sessions` / `.messages` 各自一个 store）；`presets/` 是**组合插件**——一档要装哪些插件。⚠️ 预设必须 async 并逐个 `await` 它装的插件（孙插件的装载失败不传父 `await`，fail-fast 会漏）；插件是装配单元、纯函数叶子不插件化；上游自述 API 未稳定 ⇒ 精确锁版，升级先跑冒烟 |
| `cli.tsx` | **组合根（入口）**：`createStarter(defaultPreset)` → 等退出信号 → `disposeStarter`（宿主来源归 `config/`，入口不注入）。⚠️ `new Context()` 只住 `starter/index.ts`，入口不自己建；UI 层重建后 Ink 渲染与退出边界补在这里 |

⚠️ **本文件的写法**：推导不写（能从代码与测试名重新推出来的，写在这里只会腐烂）；`⚠️` 只标真禁忌。

## 相关

`src/api/AGENTS.md`（契约的逐文件纪律）· `packages/tui/AGENTS.md`（包这一层的不变量）· 根仓 `src/manager/routes/`（端点集合的另一侧真值）
