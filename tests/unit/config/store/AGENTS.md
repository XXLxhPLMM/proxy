# tests/unit/config/store/ — 配置状态那一个实例的判据

本目录只答一件事：**配置状态只存在于 `ConfigStore` 实例里**，而从它读出去的面只有
`configAccessorFromStore` 一个。

## 文件

- `instance.test.ts` — 实例形状面（5 `it`）：缺省种子、任意子集补丁、实例间隔离、
  `getAll` 浅拷贝、`merge` 只报实际变更。
- `notify.test.ts` — 变更通知面（4 `it`）：写同值不触发、`changed` 键口径、退订幂等、订阅者抛错隔离。
- `accessor.test.ts` — 读取端口 + context 工厂（12 `it`，**两半合档**）。
- `load-library.test.ts` — `loadConfig` 的**库模式**（5 `it`）：调用方自带 store。
- `type.test.ts` — `@/config/index.js` 的**导出面**（4 `it`）：不许再出现模块级配置状态。
- `withTmpConfigDir` 只被 `load-library.test.ts` 一档用 ⇒ **留在那一档文件头**，不另起 `_*` 模块。

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
