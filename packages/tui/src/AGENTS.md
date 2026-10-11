# src/ — 控制面契约、请求形状、本地库与启动器（重构空白期）

⚠️ **重构期**：启动一侧已重建为 `cli.tsx`（入口）→ `starter/`（建根 + 插件 + 预设），状态层与 UI 待重建；`api/` `lib/` `config/` `db/` `operations/` `business/` 照旧。

| 路径 | 答什么 |
|---|---|
| `api/` | 控制面 HTTP **契约 + 拨号**：一端点一函数，**唯一**那条 `axios.request` 住 `transport/send.ts`。⚠️ 地址与 token 是**函数参数**（`ManagerTarget`），没有「客户端对象」这一层 |
| `lib/` | 零 IO 纯函数层，深路径直引（无 barrel）：`request/{errors,http,transport}.ts` 请求那一圈三个叶子（⚠️ `api/` 只许引这三个、禁引 barrel——成环）；`model-id.ts` 模型键词汇（⚠️ 按**第一个** `/` 切，`model` 可含 `/`）；`obj-util.ts` 深遍历两件套 `deepFreeze` / `deepEqual`（只认 JSON 形状） |
| `config/` | 本地配置：装载（一节一个文件夹 = 默认值 + 校验，`loader.ts` 只分派）→ 活配置 `ConfigStore`（`get` / `set` / `reload` / `onReload`，交出冻结快照）。⚠️ 坏 JSON / 认不得的项 = 启动失败；`set` 只改内存不写盘 |
| `db/` | 本地库**底座**：开 / 关库（`dialect.ts`，今天只有 sqlite 能开）、drizzle 表（`sqlite/schemas/`：`providers` 提供商 + `models` 模型 + 原有的会话/消息三表）、运行期建表（`sqlite/init.ts`）、行映射与共享校验（`read.ts`：`partFromRow` 仍是 `message_parts` 的行 → DTO，`requiredText`/`badContentError` 供 `operations/` 共享写侧校验，provider/models 走 DTO（`@/db/dto/provider.js` / `model.js`），出入参即 `Provider` / `Model`（drizzle $inferSelect 行类型，派生 `NewProvider` / `ProviderPatch` / `NewModel`））、两档驱动（内置 `node:sqlite` 优先，退 wasm）；**两档都默认不开 WAL（内置档去掉 `PRAGMA journal_mode = WAL`），统一使用删除档（journal_mode = DELETE），保证库文件在任意 Node 版本间可互换，否则 Node 22.13+ 的内置档创建的 WAL 库文件，Node < 22.13 的 WASM 降级档打不开；WASM 档开库失败且识别出文件是 WAL 模式时，会备份旧库（`<path>.wal-journal-incompatible-bak`）并重建** |
| `operations/` | 数据**操作层**：`providers`/`models`/`sessions`/`messages` 的增删改查原语，`deleteProvider` 等跨表**事务**在这里编排；出入参走 DTO（`@/db/dto/`），校验由 `read.ts` 统一兜底。⚠️ 跨目录取库走 `ctx.business`，别直接 import 本层 |
| `business/` | 资源**门面**：`attachResource(db)` 备 schema 一次，交出 `sessions` / `messages` / `providers` / `models` 四个 store（`store/`）。⚠️ 句柄开 / 关归 `starter/plugins/database.ts`、不归门面 |
| `starter/` | 应用树**启动器**（Cordis）：`index.ts` 唯一建根处；`plugins/` 一插件一文件、服务类型与事件声明随提供者（`config.reload` 事件：database 只在 `database` 节变了时重启自己重开库）；`presets/` 组合插件。⚠️ 预设必须 async 并逐个 `await` 装载的插件（孙插件装载失败不传父 `await`，fail-fast 会漏） |
| `cli.tsx` | **组合根（入口）**：`createStarter(defaultPreset)` → 等退出信号 → `disposeStarter`。⚠️ `new Context()` 只住 `starter/index.ts`，入口不自己建 |

机制细节住各文件头（本表只留归属与真禁忌）。

⚠️ **本文件的写法**：推导不写（能从代码与测试名重新推出来的，写在这里只会腐烂）；`⚠️` 只标真禁忌。

## 相关

`src/api/AGENTS.md`（契约逐文件纪律）· `packages/tui/AGENTS.md`（包这一层不变量）· 根仓 `src/manager/routes/`（端点另一侧真值）
