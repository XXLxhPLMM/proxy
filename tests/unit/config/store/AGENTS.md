# tests/unit/config/store/ — 配置状态那一个实例的判据

本目录只答一件事：**配置状态只存在于 `ConfigStore` 实例里**，而从它读出去的面只有
`configAccessorFromStore` 一个。机制与层不变量归 `src/config/` 自己的 `AGENTS.md`。

## 文件

- `instance.test.ts` — 实例形状面（5 `it`）：缺省种子、任意子集补丁、实例间隔离、
  `getAll` 浅拷贝、`merge` 只报实际变更。
- `notify.test.ts` — 变更通知面（4 `it`）：写同值不触发、`changed` 键口径、退订幂等、订阅者抛错隔离。
- `accessor.test.ts` — 读取端口 + context 工厂（12 `it`，**两半合档**）。
- `load-library.test.ts` — `loadConfig` 的**库模式**（5 `it`）：调用方自带 store。
- `type.test.ts` — `@/config/index.js` 的**导出面**（4 `it`）：不许再出现模块级配置状态。
- `withTmpConfigDir` 只被 `load-library.test.ts` 一档用 ⇒ **留在那一档文件头**，不另起 `_*` 模块。

## 锁什么（五条不变量，每条都配了变异锁点）

① ⚠️ **`context.config` 是创建时复制并 `Object.freeze` 的初始快照**，不是 live store 的替代品
否掉的是「让消费方直接读它」。热读必须经 `context.accessor` 或 `context.store`，否则热加载
的配置改动永远看不到。锁点：`expect(Object.isFrozen(first.config)).toBe(true)` —— 改成 live store
（活引用或 getter 门面）就不可能是冻结对象，当场红。同档的
`expect(first.accessor).not.toBe(second.accessor)` 与 `expect(Object.keys(first)).toEqual(["get"])`
一起锁住「读配置的面只有 accessor 一个」。

② **`startupKeys` 恒取完整的 `keysByPhase().startup`，不是 `createConfigContext` 的入参**
否掉的是「让调用方传」。调用方一传就能删减，那道门（「startup 相位必须重启才生效」）就形同虚设。
锁点两行缺一不可：`expect(context.startupKeys).toEqual(keysByPhase().startup)`（**逐项**相等）
与 `expect(context.startupKeys).toContain("upstreamUrl")`。

③ ⚠️ **`ConfigStore` 零 IO 零校验**：库调用方 `new ConfigStore(partial)` 能用**任意子集**
否掉的是「构造期跑一遍 FIELDS 解析 / 范围校验 / 文件校验 / auth 交叉校验」。
**本目录只锁「任意子集」这一半**：`new ConfigStore({ port: 18099 })` 之后
`expect(store.get("logLevel")).toBe(defaults.logLevel)`。
⚠️ **但「零校验」那一半的牙齿不在本目录** —— 「合并在 `defaults` 之上」与「不校验」是两件事，
一个「存在即校验、缺席即容忍」的构造器同样能让上面这些全绿。真正的牙齿在**消费侧**：
`../../runtime/create.test.ts` 的「未知协议在构造阶段给出清晰错误」与
`../../../../tests/integration/` 的 `upstream-protocol-fail-closed` 那一档。
**代价是明说的**：库路径能把非法值塞进 store，兜底在那两个 fail-closed 出口上。

④ **`getAll()` 恒返回新对象**（浅拷贝），调用方 mutate 不得影响 store；`merge` 返回**实际变更**的键
这是「配置状态只有 `ConfigStore`」的形状面：没有可被外部 mutate 的内部引用，也没有「写同值
也算变更」这种会误报订阅者的口径。锁点：`expect(store.getAll()).not.toBe(snapshot)`（拷贝）与
`expect(store2.merge({ port: undefined })).toEqual([])`（同值 / `undefined` 一律不算变更）。
写同值就发通知会让 `config.changed` 变成噪音，订阅方无从判断「到底改了什么」。

⑤ **`resolveConfigPaths` 只按 `FIELDS` 的 `path: true` 判，不按字段名硬编码**
否掉的是「在归一层维护第二张路径字段表」。那张表一漂就出现「某个路径字段忘了绝对化」，
而症状是相对路径被解释到进程 cwd。锁点：六个字段（`authUsersFile` / `aclFile` / `logFile` /
`tlsKey` / `tlsCert` / `upstreamCa`）逐个 `toBe(path.join(configDir, …))`。

## 为什么 `accessor.test.ts` 是两半合档

`ProxyOptions.ctx` 那几格断言「显式绑定 ctx」，`context.config` 那几格断言「只能建时读」——
两半拆开会各自缺一半的前提：只钉实例隔离，说不出「读面只有一个」；只钉 context 快照，
说不出「换掉 ctx.config 就换掉真相源」。

## 防假绿的位置

- **`type.test.ts` 的负向断言点名的是「模块级配置 API」这个形状**（`config` / `get` / `getAll` /
  `set` / `defaultConfigStore` 五个**属性名**），不是某个已删符号的引用 ——
  点名已删符号会**恒真**（那个符号重新出现时断言也不会红）。本档的判据是「导出面上没有这些属性」。
- **`notify.test.ts` 的「退订幂等」**：第二次调用在实现上凭什么不同？答不上来就是恒绿 ——
  牙齿来自订阅数组的清空语义，而本档断言的是**行为**（连续三次 `unsubscribe()` 之后计数不动），
  不是「有个 released 标志」。
- **`instance.test.ts` 的「两个实例互不影响」带一条正向对照**
  （`expect(new ConfigStore().get("port")).toBe(defaults.port)`），否则「所有 store 共享同一份
  状态但没被写过」也会在这一档里部分通过。
- **`accessor.test.ts` 的 `MISSING_ACL` / `MISSING_USERS` 指向 `os.tmpdir()` 下两个不存在的路径**：
  让判定面返回「全放行」而不真的读盘。⚠️ 换成一个真实存在的名单文件会让
  「`createFileAccessControl` 必须显式绑定实例」那一条在**名单命中**的形状上变红（那不是它要验的面）。

## 相关路径

- `src/config/store.ts` — `ConfigStore` / `defaults` / `configAccessorFromStore` / `createConfigContext`。
- `src/config/schema/index.ts` — `keysByPhase()`（相位分流的唯一真相源）与 `FIELDS` 的 `path` 标记。
- `src/config/load.ts` — `loadConfig`（`../loader/` 是它的服务侧视角，本目录的 `load-library` 是库侧）。
- `../../../helpers/config.ts` — `testConfigStore` / `testContextFor`。
- `../../../helpers/access.ts` — `openAccessControl()`（不判名单的替身）。