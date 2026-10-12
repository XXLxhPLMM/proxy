# src/ — 控制面契约、请求形状、本地库与启动器（重构空白期）

⚠️ **重构期**：启动一侧已重建为 `cli.ts`（入口）→ `starter/`（建根 + 插件 + 预设）；**UI 在 `ink-ui/` 重建中**，状态层待定；`api/` `lib/` `config/` `db/` `service/` 照旧。

| 路径 | 答什么 |
|---|---|
| `api/` | 控制面 HTTP **契约 + 拨号**：一端点一函数，**唯一**那条 `axios.request` 住 `transport/send.ts`。⚠️ 地址与 token 是**函数参数**（`ManagerTarget`），没有「客户端对象」这一层 |
| `lib/` | 零 IO 纯函数层，深路径直引（无 barrel）：`request/{errors,http,transport}.ts` 请求那一圈三个叶子（⚠️ `api/` 只许引这三个、禁引 barrel——成环）；`model-id.ts` 模型键词汇（⚠️ 按**第一个** `/` 切，`model` 可含 `/`）；`obj-util.ts` 深遍历两件套 `deepFreeze` / `deepEqual`（只认 JSON 形状） |
| `config/` | 本地配置：装载（一节一个文件夹 = 默认值 + 校验，`loader.ts` 只分派）→ 活配置 `ConfigStore`（`get` / `set` / `reload` / `onReload`，交出冻结快照）。⚠️ 坏 JSON / 认不得的项 = 启动失败；`set` 只改内存不写盘 |
| `db/` | 本地库**底座**：开 / 关库（`dialect.ts`，今天只有 sqlite 能开）、drizzle 表（`sqlite/schemas/`：`providers` 提供商 + `models` 模型 + 原有的会话/消息三表）、运行期建表（`sqlite/init.ts`）、**DAO（`dao/`：各表原子 CRUD，无事务）、行映射与共享校验**（`read.ts`：`partFromRow` 仍是 `message_parts` 的行 → DTO，`requiredText`/`badContentError` 供 `service/` 共享写侧校验，provider/models 走 DTO（`@/db/dto/provider.js` / `model.js`），出入参即 `Provider` / `Model`（drizzle $inferSelect 行类型，派生 `NewProvider` / `ProviderPatch` / `NewModel`））、两档驱动（内置 `node:sqlite` 优先，退 wasm）；**两档都默认不开 WAL（内置档去掉 `PRAGMA journal_mode = WAL`），统一使用删除档（journal_mode = DELETE），保证库文件在任意 Node 版本间可互换，否则 Node 22.13+ 的内置档创建的 WAL 库文件，Node < 22.13 的 WASM 降级档打不开；WASM 档开库失败且识别出文件是 WAL 模式时，会备份旧库（`<path>.wal-journal-incompatible-bak`）并重建** |
| `service/` | 业务**服务层**（类）：`SessionsService` / `MessagesService` / `ProvidersService` / `ModelsService`，构造时注入 `Db`，方法同原门面函数；由 `starter/plugins/resource` 挂到 `ctx.resource.sessions` / `messages` / `providers` / `models` 上。对 DAO（`@/db/dao/`）校验后调用，编排跨表**事务**（`deleteProvider` 级联删模型 / `deleteSession` 级联删消息与段 / `appendMessage` 建消息 + 推进 `updatedAt`）；出入参走 DTO（`@/db/dto/`），读侧坏内容闸由 `read.ts` 兜底。⚠️ 事务内部只调 DAO 的原子行操作，不再直接 import 本层的 drizzle 表对象 |
| `plugins/` | **插件**：`starter` 树的插件按“一文件一插件”存放（`config.ts` / `database.ts` / `ui.tsx`…），提供 `ctx` 服务与事件、挂载副作用；事件/服务的类型声明随提供者写在各自文件里。本档的 `defaultPreset` 负责按顺序 `await ctx.plugin(...)` 装上它们。⚠️ 纯函数叶子不插件化 |
| `starter/` | 应用树**启动器**（Cordis）：`index.ts` 唯一建根处；`plugins/` 一插件一文件、服务类型与事件声明随提供者（`config.reload` 事件：database 只在 `database` 节变了时重启自己重开库）；`presets/` 组合插件。⚠️ 预设必须 async 并逐个 `await` 装载的插件（孙插件装载失败不传父 `await`，fail-fast 会漏） |
| `ink-ui/` | **Ink 渲染层**：重建中的 UI。顶层 `app.tsx`（UI 树根）经 ink 渲染挂载，且按预设顺序**最先启动**；内部按 `store/`（Zustand 全局状态，含 `ctx`）→ `theme/`（样式基座）→ `components/`（原子构件）→ `hooks/`（自定义 Hook）→ `layout/`（页面框架）→ `views/`（视图）组织，外加一个**叶子层** `utils/`（跨层通用纯逻辑：零 IO、零 React、零依赖，今日有调用节奏控制 `flow-control.ts`（标准节流 / 防抖：`throttle(fn, wait)` / `debounce(fn, wait)` → 可调用函数 + `.flush()` / `.cancel()`，定时器在模块内）与单条调用缓存 `memo.ts`（**工具留用、当前无接线**）；⚠️ 只许被上层引，自己**不许**反向引 `hooks/` `layout/` `views/` `components/` `store/`——成环时 lint 与 typecheck 都拦不住）；`layout/` 已落地 `SplitLayout`（左右两栏 + 鼠标拖中间分隔条调左栏列宽；策略性判断如「哪些事件算高频」归鼠标层 `hooks/mouse/source.ts`、机制才进 `utils/`）；`hooks/mouse/`（终端鼠标事件）与 `hooks/keyboard/`（`useKeyboard` 捕获键盘事件）已落地：鼠标是**中心源单例** `source.ts`（全进程解析一次 + 按 ≈一帧合并一次；两个消费面 = 快照给「读当前值」、订阅给「一条不丢」；`startMouse` / `stopMouse` 是**应用级**的一对开关，由组合根 `starter/plugins/ui.tsx` 在渲染后与清理时调，视图不参与 ⇒ ⚠️ 跟踪常开，全应用输入处理器永远收得到鼠标上报噪声，判键前必须用 `isMouseSequence` 滤）——接线是 `app.tsx` 的 `useMouseInput`（全应用唯一一处），消费方用 `useMouse`（事件）/ `useMouseState`（采样），`protocol.ts` 解上报（另出 `isMouseSequence` 供别的处理器滤噪声）+ `tracking.ts` 拼开关码；键盘是零 IO 的实现模块 `keys.ts` 把 ink 的 `(input, key)` 归一成 `KeyboardEvent`；barrel 转出 hook（键盘另转选项类型；鼠标没有选项 —— 开关在应用级）与事件类型（处理器标注参数要用；鼠标另转 `isMouseSequence`，别的处理器滤噪声要用）；⚠️ ink 7 无 `useMouse`，且**只认 SGR 1006 坐标编码**（老编码的裸字节会被 ink 的 `input-parser` 拆散），判据见 `hooks/mouse/protocol.ts` 文件头；⚠️ ink 的 `useInput` 会**丢弃 F1–F12 / insert / clear**（置空 `input` 且 `key` 上无标志位），故 `NamedKey` 刻意不含它们，且**任何人都不许往 ink 的 stdin 挂 `'data'`**（ink 用 `'readable'` + `read()` 拉输入，挂 `'data'` 会切 flowing 模式、全应用输入死掉），判据见 `hooks/keyboard/keys.ts` 文件头；承接 `starter` 产出的 `ctx` 与资源门面，负责终端绘制与退出边界（Ink 的 `waitUntilExit()`）。`starter/` 之上、`cli.ts` 之内 |
| `cli.ts` | **组合根（入口）**：`createStarter(defaultPreset)` → 等退出信号 → `disposeStarter`。⚠️ `new Context()` 只住 `starter/index.ts`，入口不自己建 |

机制细节住各文件头（本表只留归属与真禁忌）。

⚠️ **本文件的写法**：推导不写（能从代码与测试名重新推出来的，写在这里只会腐烂）；`⚠️` 只标真禁忌。

## 相关

`src/api/AGENTS.md`（契约逐文件纪律）· `packages/tui/AGENTS.md`（包这一层不变量）· 根仓 `src/manager/routes/`（端点另一侧真值）

## 改坏会红在哪

本包无单元测，依赖这三条：`pnpm lint`（语法/死代码）→ `pnpm typecheck`（跨层调用与事务代理）→ `pnpm build`（产物可产出）。schema 变动另用 `pnpm exec drizzle-kit check`（`Everything's fine` = 无漂移）。⚠️ `service/` 直接 import drizzle 表对象 ⇒ `typecheck` 在事务回调里报“事务代理不是 `SqliteDatabase`”；`service/` 的类方法名改了 ⇒ `typecheck` 报 property 不存在；删 `src/service/` 任一文件 ⇒ `starter/plugins/resource.ts` 报 import 错误；删 `dao/` 任一导出 ⇒ `typecheck` 报 property 不存在。
