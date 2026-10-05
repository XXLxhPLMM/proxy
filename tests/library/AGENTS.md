# tests/library/ — 库消费方视角

判据目录（目录级说明见 `../AGENTS.md`）：**只从包入口 import**，即一个真实的库调用方拿得到什么。
这一层与 `../unit/library/` 是**同名的两份、判据不同**：`../unit/library/entry.test.ts` 从源码视角
（`@/index.js` 的导出面 + 库模式用法），这里从消费方视角（双向穷尽 + import 期零副作用）。

## 文件

- `entry.test.ts` — 包入口的公开面契约，**收录判据是「要写一个自定义插件的人必须能 import 到它吗」**。
  两层断言把「双向穷尽」做实：① 编译期 —— 一份**真数组**（不从 `keyof` 派生）与 `PublicTypeSurface`
  的键逐项相同，差集非空即 `never`；② 运行期 —— 逐个 name 检查包入口与源码入口**真的**导出了它，
  且明确不导出那几个内部出口。少导一个红、多导一个红。另有 import 期零副作用（不读 env / argv /
  配置文件、不写 `process.env`、不装守卫、不建 server、不写日志、不 fork）。

  ### 值面分四桶，**桶归属的唯一判据是运行期 `typeof`**

  `requiredFunctionExports` / `requiredObjectExports` / `requiredNumberExports` /
  `requiredStringExports` 四桶各带一个 `typeof` 谓词，加起来构成 `hasCompleteValueSurface`。
  加导出时先确认运行期 `typeof` 再决定进哪个桶，**别按名字长相分**：`class` 运行期
  `typeof === "function"`，所以 PascalCase 的类名（`EventHub` / `SqliteUsageSource` / …）归**函数**桶；
  `Object.freeze({...})` 归**对象**桶；`export const X = "字面量"` 归**字符串**桶。

  ⚠️ **桶归属由一条**无门控**的断言守**：`declares every required value export in the source entry,
  each in its runtime typeof bucket` 逐**成员**重算运行期 `typeof` 并与所属桶比对，输入取
  `readyEntryOr(packagedEntry, sourceEntry)`（**不查 `entryIsReady`**）。

  ⚠️ 为什么不能挂 `skipIf`：`entryIsReady` 恰恰由上面那四个 `typeof` 谓词算出，拿它当门控等于
  **前提即结论** —— 桶放错 ⇒ 门先关 ⇒ `exposes the complete public value surface` 里那四个
  `typeof` 循环永远轮不到执行（实测把那四个谓词硬算成 true，它们**立刻**红，证明断言没写错、
  只是轮不到执行）。同一条断言两类错一起抓：名字缺失 ⇒ `actual` 落在 `"undefined"`；名字在、桶错
  ⇒ `actual` 等于另一个桶的字面量。判据是 `filter(...)` 后比 `[]`，故失败时**逐条列出**所有错的名字。

  ⚠️ **桶只有真有成员时才存在**：空桶上 `every` 返回 `true`，于是「这个桶在守」与「这个桶什么都
  不管」在断言层**不可区分**。某个桶清空就删掉它（判据：那个面还在不在，而不是桶名保不保留）。
  兜底是断言里那条**下界**（枚举出的判据条数 > 0）：四桶全空时它红，而不是让
  `toEqual([])` 在空集上恒过。

  ⚠️ **对象桶的谓词 `typeof === "object"` 同时接受 `null`** —— 这是**已知口径，不修**：`null` 与
  任何值导出一样「运行期就是个 `null`」，而桶归属要答的是「它属于哪一类导出」，`null` 归对象桶
  在这个口径下说得通。真要改成 `(typeof v === "object" && v !== null)` 就得同时回答「`null` 该进
  哪个桶 / 要不要单开一个桶」，那是**扩大判据面**，不属于修一条假绿；且今天 7 项全是真对象，
  改与不改的**可观测差别是零**。

  ⚠️ **一个已知缺口（交回给上层裁决）**：
  `declares every required value export in the source entry, each in its runtime typeof bucket`
  的**名字**那一半覆盖面止于 `src/index.ts` 的 `export { … } from` 列表：在**更深处**（如
  `src/datasource/quota/sqlite-source.ts`）拿掉一个导出的**定义**、而 `src/index.ts` 的转发名单
  原封不动时，那一半仍然绿（实测把 `USAGE_DB_NAME` 改名后 `src` 入口运行期 `typeof` 已是
  `undefined`，整档仍 21/21 绿）—— 因为 `entry` 优先取打包产物，而本机 `lib/` 恰好是
  **过期但完整**的。⚠️ **桶归属那一半不受此限**：它对「已就绪的 entry」取事实，而错桶/缺名会让
  `packagedEntryIsReady` 为 false ⇒ `readyEntryOr` 退回 `sourceEntry`（恒有定义）⇒ 照样红。
  `pnpm typecheck` 会以 TS2305 兜住名字那一半，`pnpm test` 不会。

  ⚠️ **第二个已知缺口：「多导一个」那一半没有断言在守**。文件头声称值面「少导一个红、多导一个红」，
  而**只有前半句为真** —— 四桶只钉「列在桶里的名字存在且桶对」，**不钉「入口没有桶外的值导出」**。
  实测今天入口上有 **16 个值导出不在任何桶里**（10 函数 / 4 对象 / 2 字符串）：`createSourceRegistry` /
  `unknownDriverError` / `hasUsageSource` / `sharedUsageFileName` / `parseUsageEntries` / `compactEntries` /
  `clampFlushIntervalMs` / `startFlushLoop` / `quotaWindow` / `windowKey`、`BUILTIN_ACL_DRIVERS` /
  `BUILTIN_ACCOUNT_DRIVERS` / `BUILTIN_USAGE_DRIVERS` / `EMPTY_ACL`、`ACCOUNTS_DB_NAME` /
  `JSONL_USAGE_FILE_NAME`。⚠️ **别把个数写进判据**（会随导出增减腐烂）；上列是快照，不是上限。
  这 16 个该不该进契约是一个**收录判据的裁决**（按段首那句「要写一个自定义插件的人必须能 import
  到它吗」逐个答），不是补断言能顺手带出来的，故交回上层。
- `datasource-standalone.test.ts` — **数据源可脱离代理单独使用**的运行期判据：刻意**不 import**
  `createProxyRuntime` / `createProxy`（一旦 import 进来，「不启动代理」就退化成「import 了但没调用」，
  证明不了独立性）；另钉驱动名是**开放集合**（注册一个非内置名立刻能 `resolve`，未注册的名字**抛错
  且错误文本列出全部已注册项**）与工厂吃**平值闭包**（不认 `ConfigAccessor`，故不跑代理的调用方
  自己就能造数据源）。

## 相关路径

- `../unit/library/entry.test.ts` — 包入口 `@/index.js` 导出面的**源码视角**判据。
- `../unit/datasource/ensure-target.test.ts` — 目标物化（目标不存在就造出来，且已存在的绝不被改写）。
- `../helpers/net.ts` — `getFreePort()` / `listen()`。
- 出口 barrel：`@/index.js`（本体在 `src/index.ts`）。
- `../unit/`、`../integration/`、`../AGENTS.md`。
