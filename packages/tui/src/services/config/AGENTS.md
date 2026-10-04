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
| `sessions` | `id`（主键）/ `name` / `created_at` / `updated_at` / `visible` | 会话清单；⚠️ **输出桶不在里面**（那是内存里 `LOG_KEEP` 条的环形缓冲），⚠️ `visible` 是 v2 补的那一列（侧边栏显不显示） |

- ⚠️ **schema 版本只有 `PRAGMA user_version` 一处**（`0 → 3`，`> 3` 即抛）。刻意**没有** `schema_version` 表 ——
  版本与 `meta`（台账状态）两处都自称「meta」会造出第二份版本真相源。
- ⚠️ **v2 → v3 的那一步是空 SQL**（`ADD_PROVIDER_META = ""`）：provider 的三样东西落在**早就存在**的
  `meta` 键值表里 ⇒ **一个字节的 DDL 都不用改**。⚠️ 而**版本仍然要升**，理由是升级步骤那张清单：
  少一格，「v3 升了什么」在代码里就没有位置，而 `user_version` 是**这一版库里有哪几样事实**的唯一记录处；
  不升的话一个 v2 库走一次「补列」就**再也升不上来了**（补不出东西，而版本号不会自己动）。
- ⚠️ **`meta` 也在验列清单里**：provider 的凭据落在这张表里，而 `CREATE TABLE IF NOT EXISTS` 会把
  **别人建的同名表**当成自己的用 —— 列不对时必须**当场拒**（读面第一次碰到就拒），不是「写进去才炸」。
- ⚠️ **v1 → v2 的那一步（补 `visible` 一列）判据是「这一列在不在」而不是版本号**（`db.ts:ensureSchema`）：
  `CREATE TABLE IF NOT EXISTS` 对一张已存在的表一个字节都不写，于是 v1 的库建完表仍然只有四列；
  按「列在不在」判则**幂等**，且不依赖那份 `user_version` 的可信度。⚠️ 它在**验列之前**跑，否则 v1 的库
  会先被判成「列不对」而拒掉。
- ⚠️ **`CREATE TABLE IF NOT EXISTS` 之后还要验 `targets` 的列**（`db.ts:ensureSchema`）：别人建的同名表会被
  `IF NOT EXISTS` 当成自己的用下去，而一份 `name` 叫 `title` 的同名表会让每次报错都指向一个不存在的字段。
- 建表语句只在 `tables.ts` 一处；`db.ts` 只认 `LedgerDb` 那五个方法（`run` / `get` / `all` / `exec` / `close`），
  **刻意不暴露通用 SQL 执行器** —— 那会把 SQL 文本散落到调用方，于是「这张表长什么样」有多个真相源。

## 打开时机与生命周期

- ⚠️ **模块 import 期一个字节都不碰磁盘**：`node:sqlite` 由 `createRequire(import.meta.url)` 在**调用点**现取，
  库在第一次真正需要时才开，且**同一个路径只开一次**（换路径先把旧的 `close()` 掉）。
  静态 `import "node:sqlite"` 会让那句 `ExperimentalWarning` 赶在 `@/services/warnings.js` 的过滤器装好之前上屏。
- `closeLedgerDb()` **幂等**（先清引用，于是重复调用是空操作）；组合根 `cli.tsx` 的两条退出路径都调它。
- ⚠️ **先 `mkdir` + `chmod 0700`，再占位库文件 `0600`，最后才开库** —— 「token 落进一个宽权限文件」这个窗口不存在。
- ⚠️ 打开时执行 `PRAGMA journal_mode = WAL` 与 `PRAGMA foreign_keys = ON`。后者今天**是空转**（还没有外键），
  留着它是纪律：将来加表时「外键默认开着」不必再补一次。
- WAL 下库里旁边会有 `-wal` / `-shm` 两个伴随文件，它们**是那份库的一部分**，不是残留；「目录里没有半成品」
  的判据因此写成「除这三者之外一个不多」。

## 错误语义

- ⚠️ **读面「坏内容即拒」，绝不降级成空台账**。库**不存在** ⇒ 空台账（首次启动，且**不**因此创建那个库）；
  库**存在但打不开 / 表的列不对 / 校验不过** ⇒ 抛 `LedgerError` `unreadable`。
  降级成空台账是最坏的一种「体贴」：界面上「重新加一遍」就会拿那份空台账覆盖掉存着凭据的那份。牙齿：`tests/ledger.test.ts`
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

## 会话落盘（接线已做）

- 落库形状是 `@/store` 的 `SessionRecord`（`services/config` **type-only** 引它，故不构成运行期边）。
  `readSessions` / `saveSession` / `renameSession` / `setSessionVisible` / `removeSession` 五条都通到 `sessions` 表。
- ⚠️ **接线在 `@/AppState.tsx`**：建（`spawnSession` + 起步那一个只记一次）/ 改名（`confirmRename`）/
  显隐（`setSessionShown`）/ 关（`closeSession`），**同步调用、不 `await`**（那几条直接返回 `void`）。
- ⚠️ **失败不回滚**：写不进去就在屏上说一句（落进**新会话自己**的桶，而不是上一个会话的 —— 那一刻
  `setActiveId` 已经排进队列，闭包里的 `activeId` 还是上一个）。
- ⚠️ **`readSessions` 的启动恢复在 `@/AppState.tsx`**（本目录只给读面）：它在**第一个 effect 趟**里读回
  全部会话（⚠️ **不等台账**，于是后面那支播种看到的一定是恢复之后那份清单），⚠️ **读不出来就一个字都不写** ——
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

- `packages/tui/tests/ledger.test.ts` — 真 SQLite 库 + 真临时目录、零网络。覆盖库不存在 ⇒ 空台账且不建库、
  不是库 ⇒ 抛且原文件逐字未变、七种坏形状逐条点名字段且**数据逐字未变**、write→read 往返（含顺序）、目录里除
  三者之外一个不多、**库文件在 token 落进去之前就是 0600**（比旧 JSON 时代那条「先 chmod 再 rename」更强）、
  POSIX `0600`/`0700`（win32 `skipIf`）、slugify 幂等 / `idFor` 递增 / 编辑面不改入参、路径（固定名 / 不接
  `APPDATA` / 只由一个入参决定）、打码逐窗口、probe 四档，以及**层边界源码级**那组（零 console / 零 `process.*` /
  内部不自我引用 barrel / barrel 只 export，全部带判据自检，⚠️ 含「锚到的路径今天还在」那条自检）。
- `packages/tui/tests/sqlite.test.ts` — 驱动面：import 不开库、`closeLedgerDb` 幂等、换路径先收旧的、
  两条 pragma 落地、`user_version` 0→1 且**只有一处**存它、POSIX 权限、会话增/改名/删（含「改名不动 `created_at`」、
  「桶不入库：只有四列」、「撞 id 抛」）。
- `packages/tui/tests/warnings.test.ts` — 警告过滤器：吞 SQLite 那条（且**真开一次库**）/ 放过 `DeprecationWarning` /
  放过非 SQLite 的 `ExperimentalWarning` / 判据自检（子进程里不装过滤器确实会上屏）/ 撤销幂等。