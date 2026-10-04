# tests/sqlite/ — `@/services/config` 那个 SQLite 库的**驱动面**与**落盘形状**

被测对象是 `~/.config/swain-proxy/tui.db`（机制、schema 与错误语义归 `src/services/config/AGENTS.md`）。
真库 + 真临时目录、零网络。四条不变量分两档：`driver.test.ts`（①打开时机 / ②打开之后那个库长什么样）
与 `rows.test.ts`（③会话落盘 / ④provider 落盘）。

**锁什么**：那个库**什么时候**被打开（import 期一个字节都不碰）、打开成什么模式（两条 pragma /
`user_version` / 权限位），以及那三张表里**落的是什么**（列清单与键清单）。

## 为什么这一目录与 `tests/ledger/` 分开

ledger 那一档锁的是「**台账**这份数据的成败语义」（坏内容即拒、拒写之后数据逐字未变）；这里锁的是
「**那个库本身**的性质」—— 什么时候被打开、打开成什么模式、权限位、以及会话那三张表的落盘。
故两档的判据不重叠。

## 档内三条纪律

- ⚠️ **「import 期不打开」不能靠「import 之后目录里没有文件」一句话**：那份模块根本不知道 homedir，
  它要真开了库只会开在**真实的** `~/.config/swain-proxy` 下。故 `driver.test.ts` 验两件事：① 一份
  **新鲜**的模块注册表（`vi.resetModules()`）import 之后，真实位置与临时位置**都没有**多出任何东西；
  ② 那份新鲜模块的 `closeLedgerDb()` 是**空操作**（它没有握着任何句柄）。
  ⚠️ 「真实位置本来就有」的那种情形下第 ① 条只能证明「没被打开过」，故那条断言逐字写成
  「import 前后**存在性不变**」而不是「不存在」—— 后者在用户已经配过端点的机器上恒红。
- ⚠️ **升级路径只能造出来量**：`sessions.visible` 是 v2 补上去的一列，而 `CREATE TABLE IF NOT EXISTS`
  对已存在的表一个字节都不写 ⇒ 「v1 的库被 v2 的代码打开会发生什么」只能**自己造一份 v1 形状的库**
  （`rows.test.ts` 的「v1 库被 v2 代码打开」那一档），而「按代码读一遍觉得应该没问题」在迁移这件事上
  恰好是最容易错的推理。
- ⚠️ **pragma、schema 版本与列清单必须从**外面**量**：`rawHandle` 用 `createRequire(import.meta.url)`
  在**调用点**现取 `node:sqlite`，而本包自己的接口（`dbPath` / `readProvider` / `readSessions`）正是被测的
  那一份 —— 用它去量就是自证。同理，「库不存在 ⇒ 空清单且**不**建库」那几条判据量的是
  `fs.existsSync`，而不是读面返回了什么。

## 单例的开关顺序（⚠️ 拆成两档之后最容易悄悄出错的地方）

`writeLedger` / `saveSession` / `readProvider` / `writeProviderField` 全都走 `db.ts` 里**同一个**模块级
句柄，而换路径时它先把旧的 `close()` 掉。故：

- **每一档都自带同一个 `afterEach`**（`closeLedgerDb()` → `vi.restoreAllMocks()` → `removeCreated()`），
  三步顺序照抄：先收句柄（句柄开着时 Windows 上那个目录删不掉），再撤 mock，最后删临时目录。
- ⚠️ **`_shared.ts` 注册不了 hook**：一个模块没法把 `afterEach` 塞进引用它的那个档，故清理的**动作**
  （`removeCreated()`）住在共享模块里而**注册**留在各档 —— 抄走 `afterEach` 却忘了抄 `removeCreated()`
  的那一档，症状是**临时目录留在 `os.tmpdir()` 里**，不是「测试失败」。
- ⚠️ **两档之间不存在顺序依赖**：vitest 每个档一个 fork（`vitest.config.ts` 的 `pool: "forks"`）且
  各自一份模块注册表 ⇒ 那个句柄是**逐档**的；加上每档的 `afterEach` 都收它，于是「A 档把句柄开着
  留给 B 档」在结构上就不可能发生。⚠️ 但**档内**仍有真依赖：「换路径先收旧的」那一条依赖同档前一条
  开出来的形状，改动用例顺序时要重看。
- **需要句柄是关着的**那一档**自己**调 `closeLedgerDb()`：`rows.test.ts` 的 v1 迁移档与「`meta` 列不对」
  档都这么做（理由写在各自用例的注释里），而 `driver.test.ts` 那条「一份还没被用过的模块」调的是
  **那份新鲜模块**的 `closeLedgerDb()` —— 故它幂等这件事在两个地方都被量着。

## 已知的一处平台 skip

- POSIX `0600`（库文件）/ `0700`（配置目录）那一档 `skipIf(process.platform === "win32")`：NTFS 的 ACL
  不由 `chmod` 表达，Node 在 Windows 上只把 mode 映射到只读位。
  ⚠️ 它**不是**权限这件事唯一的牙齿：`tests/ledger/write.test.ts` 的「库文件在**任何 token 落进去
  之前**就已经是 0600」那一条**不**依赖平台（它量的是次序），win32 上照跑。

## 相关

`_shared.ts`（临时库工厂 + 原始句柄 + 清理）· `@/services/config/db.js` 与 `tables.js`（被测的两份）
`src/services/config/AGENTS.md`（schema / 生命周期 / 错误语义的原文）
`tests/ledger/`（台账数据的成败语义）· `tests/warnings/warnings.test.ts`
（`node:sqlite` 那条 `ExperimentalWarning` 的过滤器）