# tests/unit/datasource/users/ — 账号表数据源（`@/datasource/users/`）的判据

本目录只答一件事：**一个「账号表」端口在多个实现器上是否真的等价、可切换、可扩展**。
账号表的**形状校验与策略加载**那几档归 `tests/unit/config/auth-users/`，
**物化**归 `../ensure-target.test.ts`。

## 记忆边界与用例隔离（三档共用）

- **路径与驱动名都现取，记忆的只有「实现器是哪一个」**（按接线 `WeakMap`）。实现器若持有固定路径、
  而装配层又记忆了实例，「改配置指向另一个数据源」就**永远不生效** —— 表现是「读出来是空的」，极难定位。
  牙齿：`source.test.ts` 的「热改 `AUTH_USERS_FILE`」那条，判据锚在**两个不同文件的内容**上
  （不是「读到了非空」——那会漏掉「读到了旧文件」）。
- ⚠️ **判据一律取读取面上的真数据**（`readAuthUsers(...).value`），不是「实例类型」也不是「库文件存在」——
  后两者在「接线断了但库里数据完好」时也成立。
- ⚠️ **`tests/setup-env.ts` 把 `AUTH_USERS_DRIVER` 全局钉成 `json`**：于是全仓**没有任何一个测试**让
  `authUsersDriver=sqlite` 走过 `readAuthUsers` —— 接线若坏了，全部集成测试照样全绿（它们都走 json），
  而生产上会静默读出空账号表 → 全员 407。**一个只在特定配置下才发作的缺陷，被一份钉死默认值的
  测试环境完美地藏了起来。**
- ⚠️ **坏内容必须绕过 `put` 直接塞底层**：`put` 自己就校验，「读侧会不会判非法」只能这样测 ——
  真实的坏数据来源是人手改过的库文件、或从另一个实现器迁过来的数据。
- ⚠️ **「坏内容保留上一份有效值」的前提是**真的有过上一份** ⇒ 两条形状分别断言。少那步先读好数据，
  失败形态是「空表 + error」（fail-closed 的正确行为，不是 bug），断言会写成「保留上一份」而实际验的
  是「没有上一份」。
- ⚠️ **每个 `it` 都是全新的 `mkdtemp` 目录**：指望上一个用例留下的文件是测试之间的隐式耦合，
  而那种耦合恰好会在并发跑、或有人调整顺序时变成一个查不出来的偶发失败。
- ⚠️ **临时目录回收要重试**（共用前导里的 `removeStoreDir`）：SQLite 有 `-wal` / `-shm` 旁挂文件，
  且 Windows 上未释放的句柄让 `rmSync` 报 EBUSY。清理失败不该把一条断言正确的用例判成失败，
  真占用会在耗尽后照常抛。

## 防假绿的位置

- ⚠️ **`_account-store.ts` 不许上提 `tests/helpers/`**：`ACCOUNTS` 带着三个公网 host 字面量，而
  `external-network-scan.ts` 的 `SCAN_DIRS` 排除 `helpers/`、`walk()` 收目录下全部 `.ts` ——
  搬进去等于让那份覆盖从零外网扫描里**静默消失**，而 `no-external-network.test.ts` 的下界断言照样绿。
  **可见的重复优于看不见的失效**（`source.test.ts` 里 `loadUserPolicy("carol", …)` 逐字重写那份名单，
  正是这种可见重复：正向断言必须自己写出内容，不许改成引用 `ACCOUNTS`）。
- **「读面不认配置端口」那条要覆盖全部七个文件**（`index` / `types` / `validate` / `json-source` /
  `sqlite-source` / `read` / `registry`）—— 少列一个文件，那一层就有个能 import `@/config` 的入口没人管。
- **注册表那组的三条判据各配一个变异实测**（把查表换回硬编码 if/else ⇒ ① 与 ② 同时红；
  摘掉 `registerAccountSource` 的写操作 ⇒ ① 与 ③ 红）；另有一条跨层护栏实测过：给 `read.ts` 加一行
  `import type { ConfigAccessor } from "@/config/index.js"`，「读面不认配置端口」立刻红。

## 文件

- `_account-store.ts` — 三档真用到的档面：`ACCOUNTS` + 三个路径 + `json` / `sqlite` 两个后端实现器
  + 逐例重造目录与那段回收重试。**只有一档用的（`sqliteConfig` / `storeWith` / `readDocsFromDb` /
  `MemoryAccountSource`）留在那个档里。** ⚠️ 三个路径是**可变导出**：ESM 的导入绑定是活的而从调用方
  赋值非法，所以重造只发生在本模块内，调用方只读。
- `AGENTS.md` — 本文件。

## 相关路径

- `../../../../src/datasource/users/` — 被测模块：`types.ts`（`AccountLocator` 两个闭包）
  / `validate.ts`（`validateAuthUsers` 与那三个判据函数）/ `json-source.ts` / `sqlite-source.ts`
  / `read.ts`（经驱动选后端的接线）/ `registry.ts`（`accountSourceFor` 与驱动注册表）。
- `../../../../src/config/account-locator.ts` — 配置 → 接线的翻译层（本层与配置层之间唯一的接缝）。
- `../../../../src/utils/sqlite/index.ts` — `openSqliteDriver` 那个端口（`readDocsFromDb` 经它绕开
  实现器直接读 `doc` 列，用来模拟「把库里的数据搬到另一个后端」）。
- `../../../helpers/source-scan.ts` — `codeOf` / `codeOnly` 与三个路径常量。
- `../../../helpers/public-hosts/unit-datasource-users.ts` — 本目录的零外网白名单片（两份文件有公网
  字面量：`hosts` 相同是可见的重复，不是漏检；另两档零字面量故不建条目）。
- `../../../helpers/public-hosts/unit-datasource-acl.ts` — 名单数据源那一片（账号表里的
  `acl.target` 条目在 `users/` 这边，判定语义在 `core/access-control/` 那边）。
