# tests/unit/datasource/quota/sqlite/ — 权威账本 `SqliteUsageSource` 的内部机制

本目录只答**这本账怎么活过一次重启、怎么被多个进程共用、怎么被镜像回读**。
被测实现是 `@/datasource/quota/sqlite-source.ts` + `@/utils/sqlite/`（驱动端口）+
`@/datasource/quota/flush-loop.ts`（唯一的定时器站点）。
判定语义在 `../mirror-allow.test.ts`，窗口键在 `../window-key.test.ts`，
另一个后端（jsonl）的等价性与驱动注册表在 `../drivers/`。

## 🔴 本目录是全仓的 Node 版本地板闸门所在

`driver-split.test.ts` 的 builtin 档**真跑** `node:sqlite`（**不是 stub**），而 `node:sqlite`
在 Node **22.5** 出生、**22.13 才免 `--experimental-sqlite` flag**。

⚠️ **那个文件零处 `skipIf`** —— 低版本运行时它**抛错而不是跳过**，而那是**有意的**：
`engines` 与 `devEngines` 都**不拦** pnpm 的开发环境（实测两者都是 `WARN` + **退出码 0**），
真正强制 `>= 22.13` 的就是这条断言。**搬动它时不许加 `skipIf` 让它「稳定」** ——
那等于把全仓的版本防线拆掉。根 `AGENTS.md`「开发必须 Node >= 22.13 由谁保证」一节是它的论证原文。

实测（本机 Node v22.22.1，`builtin` 档**真跑真过**）：

```
✓ 当前运行时选中的那一档真的能开库并记账 69ms
✓ builtin 档：建库 → 累加 → 另开连接读回（该档真跑，不是 stub） 30ms
✓ wasm   档：建库 → 累加 → 另开连接读回（该档真跑，不是 stub） 153ms
✓ WASM 档并发写同一行：合计精确（实测口径：无 WAL，靠 busy_timeout 串行化） 108ms
Test Files  1 passed (1)      Tests  4 passed (4)
```

实测（用 `--require` 预加载把 `node:sqlite` 伪装成「本机没有」＝ 模拟低版本运行时）：

```
✓ 当前运行时选中的那一档真的能开库并记账 284ms      ← openSqliteDriver() 无参分流到 wasm，仍然可用
× builtin 档：建库 → 累加 → 另开连接读回（该档真跑，不是 stub） 11ms
    Error: SQLite 驱动的 builtin 档在当前运行时 (v22.22.1) 不可用
Test Files  1 failed (1)      Tests  1 failed | 3 passed (4)
```

⇒ **抛错，不是跳过**：闸门有牙齿。注意第一格**仍然绿**（无参 `openSqliteDriver()` 会分流到 WASM 档），
这正是那条显式 builtin 用例必须存在的原因。

## 防假绿的位置

- ⚠️ **`windowFor` 的「相邻关系」是跨行判据，必须整段文本匹配。**
  `layout.test.ts` 那条「回读与压缩按用户记忆窗口类型」用 `\s*` 要求「记忆 miss 分支的紧邻下一行就是
  那次查表」：`/if\s*\(cur === undefined\)\s*\{\s*const window = windowFor\(entry\.u\);/`。
  ⚠️ **只断言「`windowFor(entry.u)` 这个字符串存在」是恒绿的** —— 那对「把查表提到 `if` 外面」这个
  正是 bug 的形状完全无感，而性能**完全退化**（`sweep` 是**同步**函数，跑在 flush 回调里且全程无 await；
  实测逐行查表 50000 行 × 50000 账号 = 单轮 9001 ms，那 9 秒里代理一个包都处理不了，而 `busy_timeout`
  只管写锁、救不了纯 CPU）。**判据是形状、不是计时** —— CI 机器必抖，形状不会抖。
  **实测（变异 B）**：把 `const window = windowFor(entry.u)` 提到 `if` 之外 →
  `× 回读与压缩按用户记忆窗口类型`（`AssertionError: compactEntries 的查表必须在记忆 miss 分支内`）。
  同一条在 `sqlite-source.ts` 的 `sweep` 侧还有一个形状（`windows.get(` + `window = this.windowFor(`），
  两处实现各钉一次 —— 而**刻意不数「窗口归属判据出现了几次」**：那样的护栏只对逐字照抄的副本有效，
  换一种写法（换形参名、把 `now` 折成局部变量）就绕过去了，而一个只对精确副本生效的守卫比没有守卫更坏。
  要真管住它得走 AST，那是另一笔账。
- ⚠️ **规模档断言「规模有界」而不是「28 行」**：运行期清理挂在 flush 循环上，第 2 天起前一天的行就已经
  被清掉了 —— 「单调增长」正是要否掉的那个性质，故只能断言有界。
- ⚠️ **账本目录取 `<dir>/ledger` 子目录**：`dir` 本身是 `mkdtemp` 出来的、**必然已存在**，断言它不存在
  永远是假的（这是「负向断言锚到已存在事实」的典型假绿）。这里反过来断言它**存在**，但目录名同样必须
  是不存在的子目录，否则断言恒真。
- **另开连接真读证明落盘**（`totalIn` / `rowCount` / `readUsage`），不用 spy；用完必须 `close()`，
  否则 Windows 上文件句柄不释放会挡住 `rmSync`（`EBUSY`）⇒ 临时目录清理走 **best-effort 重试**：
  清理失败不该把一条断言正确的用例判成失败，而真失败（文件确实被占用）会在重试耗尽后照常抛出来。
- **窗口键由 `windowKeyOf` 现算，不硬编日期串**：窗口口径变了那条会给出「查 0 行」而不是「查到别的行」
  这种更费解的失败。
- ⚠️ **临时目录的生命周期住在这个目录**（`_usage-source.ts` 的 `beforeEach` / `afterEach`）：
  `dir` 是**活绑定**、档侧只读，于是「谁在改这个变量」只有一个答案。
  ⚠️ **`_*` 不带 `.test.ts` 后缀**（vitest 收不到它 ⇒ 不是空跑的空档），且**必须**留在本目录、
  **不许上提 `tests/helpers/`** —— 那里不在零外网扫描的 `SCAN_DIRS` 范围内，
  **可见的重复优于看不见的失效**。
- ⚠️ **`function` 声明 + 返回类型标注 + 箭头体这个形态本仓的转换链不认**
  （`export function f(): T => ({…})` 在 esbuild 与 vite 的 oxc 上都直接解析失败，而全仓从不这么写）。
  `_usage-source.ts` 的 `withWindow` 因此写成 `export const withWindow = (…) => ({…})` ——
  这也是旧文件本来的写法。

## 文件

- `layout.test.ts` — 纯源码级：`<dir>/usage.db` 布局、槽位机制全仓已消失、`windowFor` 的记忆 miss 分支
  相邻关系、零定时器、零 `process.env`、零 `@/config|core|runtime|server` import（6 `it`）。
- `durability.test.ts` — 多进程共享同一本权威账（同行相加 / N 个实例并发精确）、重启恢复（只认当前窗口 /
  `seed` 是 set 而非相加）、落盘无条件（无配额也建库记账 / 建不了目录走 `onError`）、停机落盘
  （真读 / `close` 幂等 / 短间隔真 sleep 的定时器路径）（11 `it`）。
- `resilience.test.ts` — 写库失败韧性（重试不双计 / 绝不让 `consume` 抛错）与窗口过期清理
  （启动期清过期行 / 28 个 sub 规模档 / 不误删别人的当前窗口行 / day 与 month 同表各按自己的键 /
  `QUOTA_RESET_HOUR` 改口径）（7 `it`）。
- `driver-split.test.ts` — 🔴 **Node 版本地板闸门**：当前运行时那一档能开库记账 + builtin / wasm 两档
  各真跑一遍 + WASM 档并发写精确（3 个 `it` 声明 / **4** 个运行时用例，因为 `for (const kind of […])`
  那个模板字面量展开成两条；守恒按**声明数**算）（3 `it`）。
- `_usage-source.ts` — 四档共用的装配面与真读面：`at` / `windowKeyOf` / `withWindow` / `DriverFactory` /
  `driverOfKind` / `harness` / `totalIn` / `rowCount` / `dir` / `day12` / `DAY_KEY` +
  `Harness` / `HarnessOptions` 两个类型 + 临时目录生命周期。
  ⚠️ `readUsage` 与 `UNLIMITED` **刻意不导出**（各只有一个调用点，留在模块内即可）。
- `AGENTS.md` — 本文件。

⚠️ **拆档纪律**：本目录的档头**只留「这一档管哪一段 + 指向本文件」**。旧文件那 63 行文件头
（八条决策的逐条论证）**不许**整段搬进新档 —— 本文件就是那几段的唯一落点。

## 相关路径

- `../../../../../src/datasource/quota/sqlite-source.ts` — 被测实现（`sweep` / `deleteStale` /
  幂等 UPSERT 事务 / 启动期与运行期清理）。
- `../../../../../src/datasource/quota/flush-loop.ts` — 本层唯一的定时器站点（`setTimeout` × 1 + `unref`）。
- `../../../../../src/datasource/quota/mirror.ts` — 镜像侧（`absorb` 的 `max` 合并语义与
  `mirrorLagBoundMs`，后者在 `../drivers/registry.test.ts` 断言）。
- `../../../../../src/utils/sqlite/index.ts` — SQLite 驱动端口（`openSqliteDriver` 的分流：
  指定档不可用时**抛**而不是静默回落 —— 静默回落会让「这条用例其实测的是另一档」变成假绿）。
  两个边界的分流口径见 `src/utils/sqlite/AGENTS.md`。
- `../../../../../src/server/index.ts` / `src/runtime/services.ts` / `src/cli.ts` — 分槽机制的
  可观察证据面（`layout.test.ts` 那条「槽位已消失」读的就是它们）。
- `../../../../helpers/source-scan.ts` — `codeOf`（⚠️ 路径层数只许出现在那一处；本目录是
  `../../../../helpers/`）。
- `../AGENTS.md`、`../drivers/AGENTS.md`、`../../../AGENTS.md`、`../../../../../AGENTS.md`。
