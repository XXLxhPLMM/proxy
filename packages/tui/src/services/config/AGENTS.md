# src/services/config/ — 本机台账（SQLite）与接线

本包要连的是**多个**控制面端点，每个端点 = 一个 base URL + 一份 Bearer token。这个目录管「这份清单存在哪儿、
长什么样、怎么改、怎么变成一个能发请求的客户端」，以及**启动时读回上次选中的那个**（用户需求原话：「有状态，
下次打开能够重连」）。对外唯一出口 `@/services/config/index.js`。机制与决策的完整推导在各文件头，这里只列**不变量**。

## 位置：固定的一个字面量

- ⚠️ **不读任何环境变量**（`XDG_CONFIG_HOME` / `APPDATA` 一律不看）：`~/.config/swain-proxy/tui.db`。
  函数签名上就没有 env 形参（`resolveConfigDir(homedir)` / `dbPath(homedir)`）—— 加一个就等于把「东西在哪儿」
  交给调用环境决定，而那种分裂的部署比一个固定位置难查得多。**Windows 与 POSIX 同一条规则**。
- **零兼容**：本仓还没有第二个版本的用户，故 JSON 台账（`targets.json` / `~/.config/proxy-tui/`）那些旧形态**一概不读**。
- 目录 `0700`、库文件 `0600`；⚠️ **库文件由本层自己先占位成一个 `0600` 的空文件再开**（见 `db.ts:connect`），
  否则 SQLite 建出来的库是 0644（umask 决定）而 token 就落在里面。

## schema

| 表 | 列 | 谁在用 |
|---|---|---|
| `targets` | `id`（主键）/ `name` / `base_url` / `token` / `timeout_ms` | 台账正文；⚠️ 列就是 `Target` 的字段，`baseUrl` / `timeoutMs` 按 SQL 惯例写成 snake_case |
| `meta` | `key`（主键）/ `value` | 放 `selected` 与 **`provider.*` 三行**（地址 / 模型名 / 凭据）；⚠️ **行不存在 = 没配**，故没有给 `null` 造哨兵值 |
| `sessions` | `id`（主键）/ `name` / `created_at` / `updated_at` | **全部**历史会话；⚠️ **不带「在不在侧边栏上」那一位**，也**不带输出桶**（那是内存里 `LOG_KEEP` 条的环形缓冲） |
| `sidebar_sessions` | `session_id`（主键）/ `at` | **侧边栏清单就是这张表**；⚠️ 顺序恒等于 `rowid` = **激活**顺序（不是建成顺序） |
| `messages` | `session_id` + `seq`（复合主键）/ `at` / `turns` | 一格 `LogEntry` 一行；⚠️ `seq` 恒等于 `LogEntry.id`，`turns` 是那一格序列化后的 JSON（**不是**一 `Turn` 一行） |

- ⚠️ **schema 版本只有 `PRAGMA user_version` 一处**（`0 → 4`，`> 4` 即抛）。刻意**没有** `schema_version` 表 ——
  版本与 `meta`（台账状态）两处都自称「meta」会造出第二份版本真相源。
- ⚠️ **升级步一律判「那个形状还在不在」而不是版本号**（`db.ts:ensureSchema`）：`IF NOT EXISTS` 对已存在的表
  一个字节都不写，于是按版本号判既不幂等、又把正确性押在 `user_version` 的可信度上。⚠️ 升级步都在**验列之前**跑，
  于是验列答的永远是「这一版要的那几列在不在」，而不是「上一版的形状还在不在」。
- ⚠️ **v3 → v4 的那一步是 `ALTER TABLE sessions DROP COLUMN visible`**（判据是「`visible` 还在吗」）。
  ⚠️ **没有「补 `visible`」那一步**：v1 与 v4 的 `sessions` 是同一个四列形状，而补上去再删掉只会在每次开库时白动一次 DDL。
- ⚠️ **v2 → v3 的那一步是空 SQL**（`ADD_PROVIDER_META = ""`）：provider 的三样东西落在**早就存在**的
  `meta` 键值表里 ⇒ **一个字节的 DDL 都不用改**。⚠️ 而**版本仍然要升**，理由是升级步骤那张清单：
  少一格，「v3 升了什么」在代码里就没有位置，而 `user_version` 是**这一版库里有哪几样事实**的唯一记录处；
  不升的话一个 v2 库走一次「补列」就**再也升不上来了**（补不出东西，而版本号不会自己动）。
- ⚠️ **`meta` / `sidebar_sessions` / `messages` 也在验列清单里**：provider 的凭据落在 `meta` 里，而
  `CREATE TABLE IF NOT EXISTS` 会把**别人建的同名表**当成自己的用 —— 列不对时必须**当场拒**（读面第一次碰到就拒），
  不是「写进去才炸」。
- ⚠️ **验列只查「少没少」：多余列放行**（将来加列时旧库不必重建），少一列即拒。故一张**还没**升级的 v3 库里
  `visible` 还在，那属于「多余列」而放行；升级步跑完它就没了。
- ⚠️ **`sidebar_sessions` 与 `messages` 都没有外键**：级联删由**应用层在一个事务里显式做**
  （`store.ts:removeSession` 逐张点名删）。⚠️ 加外键会让「删一个会话」变成一个**可能失败**的操作。
- 建表语句只在 `tables.ts` 一处；`db.ts` 只认 `LedgerDb` 那五个方法（`run` / `get` / `all` / `exec` / `close`），
  **刻意不暴露通用 SQL 执行器** —— 那会把 SQL 文本散落到调用方，于是「这张表长什么样」有多个真相源。
  ⚠️ 事务也只在 `store.ts:transact` 一处开：「几件事必须同时生效」的那个窗口不许散到调用方。

## 打开时机与生命周期

- ⚠️ **模块 import 期一个字节都不碰磁盘**：`node:sqlite` 由 `createRequire(import.meta.url)` 在**调用点**现取，
  库在第一次真正需要时才开，且**同一个路径只开一次**（换路径先把旧的 `close()` 掉）。
  静态 `import "node:sqlite"` 会让那句 `ExperimentalWarning` 赶在 `@/services/warnings.js` 的过滤器装好之前上屏。
- `closeLedgerDb()` **幂等**（先清引用，于是重复调用是空操作）；组合根 `cli.tsx` 的两条退出路径都调它。
- ⚠️ **先 `mkdir` + `chmod 0700`，再占位库文件 `0600`，最后才开库** —— 「token 落进一个宽权限文件」这个窗口不存在。
- ⚠️ 打开时执行 `PRAGMA journal_mode = WAL` 与 `PRAGMA foreign_keys = ON`。⚠️ 后者曾经空转（还没有外键），
  留着它是纪律；而 `sidebar_sessions` / `messages` **刻意不加外键**（级联删由应用层在一个事务里显式做），
  于是它**仍然是**空转 —— 别把「有外键」当成它已生效的理由。
- WAL 下库里旁边会有 `-wal` / `-shm` 两个伴随文件，它们**是那份库的一部分**，不是残留；「目录里没有半成品」
  的判据因此写成「除这三者之外一个不多」。

## 错误语义

- ⚠️ **读面「坏内容即拒」，绝不降级成空台账**。库**不存在** ⇒ 空台账（首次启动，且**不**因此创建那个库）；
  库**存在但打不开 / 表的列不对 / 校验不过** ⇒ 抛 `LedgerError` `unreadable`。
  降级成空台账是最坏的一种「体贴」：界面上「重新加一遍」就会拿那份空台账覆盖掉存着凭据的那份。牙齿：`tests/ledger/`
  断言的是**抛错之后库里那份数据逐字未变**（用一份不认识本包的原始句柄倒表比对，不用逐字节 —— WAL 下数据可能整段还在 `-wal` 里）。
- ⚠️ **文件系统的失败点变了，对外的档位与文案不变**：旧 JSON 底座下的「目录建不了 / 文件读不出来」现在落在
  「库打不开 / 表的列不对 / 查询失败」上，一律包成 `unreadable` 并在文案里点名位置。
- ⚠️ **转述驱动的 `message` 是安全的**：SQLite 的失败文案只点表名与列名（`no such column: token`、
  `UNIQUE constraint failed: targets.id`），**从不**回显被绑定的值 —— 那也是「一律全量绑定、不拼 SQL 文本」的另一个理由。
- ⚠️ **`LedgerError` 与 `TuiError` 是两件事，不许混用**：后者的三档是**传输层**的失败词汇，一份本机库形状不对与
  「连不上那个控制面」的排查方向完全相反。故 `LedgerError` 只有 `unreadable` / `invalid-target` 两档，
  **文案随便改、`code` 不许增殖**。同理 ⚠️ **token 绝不进日志、不进错误文案、不进快照**。
- **`selected` 指向不存在的 id 是报错，不是静默置 null**；`setSelected` / `upsertTarget` 指向不存在的 id 一律抛
  （否则那份库会**再也读不出来**，连里面其余几条好端点一起赔进去）。删一个不存在的 `id` 则是**成功的 no-op**。
- ⚠️ **落盘的字节恒是校验过的形态**：`writeLedger` **先校验再开事务**；一次写里「清单 + `selected`」**必须同时生效**
  （分两次提交会留一个「清单换了而 `selected` 还指着已删的那条」的窗口，那份库就再也读不出来了）。
- **清单顺序靠 `rowid`**（= 插入序）：整份清单换掉是**先全删再按数组序插回去**，而不是逐行 UPSERT。

## 编辑面与输入面

- **`token` 明文入库是结论不是疏忽**：没有可加密它的密钥，OS keychain 要原生依赖；防线是 `0600` 库 + `0700` 目录
  + 位置约定。⚠️ **打码只有一份出口**（`redactTarget`），且**绝不**返回半截明文、**空串保持空串**。
- ⚠️ **provider 的凭据与 `token` 同级**（配了它，模型才有资格让本包去动控制面）：同一条防线，
  打码出口是 `redactProvider`，而那个掩码**与 `REDACTED_TOKEN` 同形**（两个不同的真凭据不许看起来一样长）。
  ⚠️ **内存里真凭据只在 `providerRef` 一处**（`@/AppState.tsx`），而**屏上那一侧永远是现算的掩码版**。
- ⚠️ **provider 三样同生共死**（`validateProviderInput`）：配了一半时它与「没配」在界面上是同一句话，
  而用户会去查一个他改过的东西。`/provider set` 三样一起给，`/provider key` 读出另外两样再整体写回。
- ⚠️ **provider 的地址不归一**：`normalizeBaseUrl` 那份判据是**控制面**的，而 provider 可以是任何
  OpenAI 兼容端点 —— 拿它判就是「界面说合法、请求打不通」。
- **`baseUrl` 的判据只有一份**（`@/lib/http.js` 的 `normalizeBaseUrl`），三处各过一次、绝不重打；**`token` 的
  字符集判据在本层不存在**（服务端比的是 SHA-256 摘要），本层只判「非空」与「端部空白 trim」。
- **`id` 是稳定身份、`name` 是可变显示名**：`id` 只由 `idFor` 的 slug-递增避让产生（**不是**随机后缀），
  且 `slugify` **幂等**是契约。⚠️ **`edit.ts` 的每个函数都是纯函数**（不改入参）。
- **探活不 re-throw**（`TuiError` 三档原样交给界面；非 `TuiError` 的异常照旧往上抛）。
- ⚠️ **零 `console`、零 `process.*`** —— `resolveConfigDir` 的 `homedir` 是注入参数正是为了这条。
  ⚠️ 那个纪律在**宿主边界**上唯一的例外是 `@/services/warnings.js`（stderr 是宿主的）。

## 会话、侧边栏与对话落盘（接线在 wave 2）

- 落库形状是 `@/store` 的 `SessionRecord` / `SidebarEntry`（`services/config` **type-only** 引它们，故不成环）。
- **会话**：`readSessions`（**全部**历史会话）/ `saveSession` / `renameSession`（**不动**对话）/ `removeSession`。
- **侧边栏清单**：`pinSession` / `unpinSession` / `readSidebar`。⚠️ 再 pin 同一个 `id` 与 pin 一个不存在的 `id`
  **都是成功的 no-op**（判据与「删一个不存在的 id」同族），而 `pinSession` **不碰 `sessions`**、**不动 `updated_at`** ——
  「出现在侧边栏上」不是「这个会话动了一次」。
- **对话**：`appendMessages`（**新追加**的那几格，一次事务）/ `trimMessages` / `clearMessages` / `readMessages`。
- ⚠️ **`removeSession` 是级联的**（`sessions` + `sidebar_sessions` + `messages` 一次事务删净）：`sessions` / `messages`
  的不一致是**可能存在的真实状态**（写盘失败、库被人动过），而只删 `sessions` 那一行的话，库里会攒出一堆指向
  已删会话的孤儿消息。
- ⚠️ **`readMessages` 坏内容即拒**（`LedgerError` `unreadable`）而**绝不降级成空对话** —— 那会让一次坏数据看起来像
  「这个会话还没说过话」。⚠️ 它的错误文案**只点名那一列**，因为载荷可能是一句用户聊天消息。
- ⚠️ **编解码归 `@/lib/log/codec.js`**（`encodeTurns` / `decodeTurns`），本层只管把那一段 JSON 存进 `turns` 那一格
  与从那一格取出来。⚠️ `seq` 恒等于 `LogEntry.id`，`at` 恒等于 `LogEntry.at`，而**本层不读时钟**。
- ⚠️ **落盘的字节里没有明文凭据**：凭据在 `@/lib/log/rows.js:maskEcho` 那一层就打过了，而落盘这一层写的是**回显行**
  —— 牙齿是 `tests/sqlite/messages.test.ts` 里那一条（真跑 `/target add` 与 `/user pass` 再倒表比对）。
- ⚠️ **接线在 `@/AppState.tsx`**（本目录只给读写面）：建 / 改名 / 激活 / 摘下 / 关 / 追加 / 收口 / 恢复，**同步调用、不 `await`**。
- ⚠️ **失败不回滚**：写不进去就在屏上说一句（落进**新会话自己**的桶，而不是上一个会话的 —— 那一刻
  `setActiveId` 已经排进队列，闭包里的 `activeId` 还是上一个）。
- ⚠️ **启动恢复在 `@/AppState.tsx`**（本目录只给读面）：⚠️ **读不出来就一个字都不写** ——
  写会把存着凭据的那份库覆盖掉，而「这一趟只有起步那一个会话」在屏上说了为什么。
- ⚠️ **库里已经有会话时不再凭空造那一个**（零兼容：没有第二个版本，也没有「每次启动都补一个」的规矩）。

## 相关路径

- `@/lib/errors.js` + `@/lib/http.js` + `@/services/index.js` — 本层仅有的下游依赖（`TuiError` /
  `normalizeBaseUrl` / `ManagerClient` / `ManagerEndpoint` / `installSqliteWarningFilter`）。⚠️ 刻意走**深层路径**
  而不走 `@/lib/index.js` 的 barrel：`lib/index` 转发 `failures.js`，而那份要引本目录的 barrel ⇒ 走 barrel 就是一条运行期环。
- `@/store/index.js` — **只 type-only** 引 `SessionRecord`（本目录不引 `@/store` 的运行期值，故不成环）。
- `@/api/index.js` — 只取**响应体类型**（`StatusBody`）。
- 服务端侧的三条事实：鉴权 `src/manager/http/auth.ts`、端点表 `src/manager/routes/index.ts`、读面「坏内容即拒」的同源纪律 `src/ops/AGENTS.md`。
- 根包 `src/utils/sqlite/open.ts` — 两档驱动分流的**同族**实现（本包只用 builtin 档，故没有 WASM 那一档）。
- 消费方 — `src/cli.tsx`（组合根：注入 `os.homedir()`、装警告过滤器、退出时收库）。

## 相关测试

- `packages/tui/tests/ledger/` — 真 SQLite 库 + 真临时目录、零网络。覆盖库不存在 ⇒ 空台账且不建库、
  不是库 ⇒ 抛且原文件逐字未变、七种坏形状逐条点名字段且**数据逐字未变**、write→read 往返（含顺序）、目录里除
  三者之外一个不多、**库文件在 token 落进去之前就是 0600**（比旧 JSON 时代那条「先 chmod 再 rename」更强）、
  POSIX `0600`/`0700`（win32 `skipIf`）、slugify 幂等 / `idFor` 递增 / 编辑面不改入参、路径（固定名 / 不接
  `APPDATA` / 只由一个入参决定）、打码逐窗口、probe 四档，以及**层边界源码级**那组（零 console / 零 `process.*` /
  内部不自我引用 barrel / barrel 只 export，全部带判据自检，⚠️ 含「锚到的路径今天还在」那条自检）。
- `packages/tui/tests/sqlite/` — 真 SQLite 库 + 真临时目录、零网络。`driver.test.ts`（import 不开库 / 句柄记账 / 两条 pragma /
  `user_version` / 表清单 / POSIX 权限）、`rows.test.ts`（会话那四列 + v3 → v4 的那一步 + 级联删无孤儿 + provider 落盘）、
  `sidebar.test.ts`（激活 / 摘下 / 激活序 / 两类 no-op / 不动 `updated_at`）、`messages.test.ts`（一格一行 /
  `seq` 升序 / 收口 / 清空 / **坏内容即拒且盘上未变** / **落盘字节里没有明文凭据**）。
- `packages/tui/tests/ledger/` — 台账数据的成败语义（库不存在 ⇒ 空台账且不建库、不是库 ⇒ 抛且原文件逐字未变、
  七种坏形状逐条点名字段且**数据逐字未变**、write→read 往返、目录里除三者之外一个不多、**库文件在 token 落进去
  之前就是 0600**、POSIX 权限、打码、probe 四档，以及**层边界源码级**那组）。⚠️ `_shared.ts:dump` 倒的是
  **`sqlite_master` 现列的每一张表**（不写死清单：漏一张就是「那个实现把那张表清空了而断言照样绿」）。
- `packages/tui/tests/warnings/warnings.test.ts` — 警告过滤器：吞 SQLite 那条（且**真开一次库**）/ 放过 `DeprecationWarning` /
  放过非 SQLite 的 `ExperimentalWarning` / 判据自检（子进程里不装过滤器确实会上屏）/ 撤销幂等。