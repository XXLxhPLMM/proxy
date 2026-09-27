# src/config/normalize — 配置副本的归一化

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `record.ts` | `asRecord(value)` | 把泛型配置对象收窄成可按 `ConfigKey` 索引的 record，层内共享 |
| `paths.ts` | `resolveConfigPaths(config, configDir)` | 按 `FIELDS` 的 `path` 把相对路径绝对化；**只在副本上写** |
| `upstream.ts` | `applyUpstreamUrlToConfig(target, raw, explicitlyProvided?)` | `UPSTREAM_URL` 拆项的**唯一编排入口**；返回「显式拆项被覆盖」的 warning 列表 |
| `prepare.ts` | `prepareRuntimeConfig` / `prepareRuntimeConfigStore` | 纯内存 runtime 装配：前者只出副本，后者把**真正变化的字段** merge 回 store |
| `index.ts` | 本层出口（跨目录只出 `prepareRuntimeConfigStore`） | |

**不属于本层**：`UPSTREAM_URL` 的**拆项实现**（`../schema/upstream-url.ts:parseUpstreamUrl` / `applyUpstreamUrl`）与 `FIELDS` 表本身。本层只做编排。

## 硬约定

- **纯内存、只写副本**：`resolveConfigPaths` / `applyUpstreamUrlToConfig` 都不碰传入对象以外的任何状态；`prepareRuntimeConfigStore` 先在副本上校验、成功才 merge。
- **`loadConfig` 与纯内存 runtime 共用这一套实现**——两条路径永不对同一 URL 得出不同结果。改 `UPSTREAM_URL` 语义只改 `../schema/upstream-url.ts` 一处。
- **不实现拆项**：`upstream.ts` 只调 `../schema/upstream-url.ts` 的两个函数（字段契约与归一编排因此只有一份实现、两处调用）。
- `resolveConfigPaths` 遇空串保留、绝对路径原样——空串是「显式清空这个字段」的合法取值，不是「没配」。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

**有断言锁住的裁决一律不写在这里**——它们的结论、否掉了什么、为什么、以及逐字锁点全在
`tests/unit/config-loader.test.ts`（先 parse 再触碰 target / 非法 URL 不半写 store /
拆项覆盖只进 `context.warnings`、配置层零日志）与 `tests/unit/config-instance.test.ts`
（`resolveConfigPaths` 只按 `FIELDS` 的 `path: true` 判、不按字段名硬编码）的开头条注释里。
**下面五条全是「无牙齿」的**，所以必须留在这里。

1. **拆项入口只有 `applyUpstreamUrlToConfig` 一个，不塞进 `createConfigContext`** — 否掉「在 context 工厂里顺手拆」— 那会造出第三套入口，破坏「两条路径对同一 URL 永不出不同结果」的不变量（见根 [`../AGENTS.md`](../AGENTS.md) 决策 3）。⚠️ **没有任何断言**：入口**数量**在本仓不可观测——`createConfigContext` 里也藏一份拆项，那两条 `prepareRuntimeConfigStore` 用例照样绿。真正有牙齿的是**结果一致**与**不半写**那两条。
2. **空串 = 未配置** — 否掉「空串当非法」— `.env` 里写 `UPSTREAM_URL=` 是「这一项我不配」，与写 `UPSTREAM_URL=https://…` 语义相反。⚠️ **没有任何断言**：全仓没有一条用例把 `UPSTREAM_URL` 设成空串再断言「不抛错且六项全空」——这条路径**从未被跑过**，把它判成非法也全仓绿。
3. **`prepareRuntimeConfigStore` 只 merge 真正变化的字段** — 否掉「整份 replace」— store 有订阅者，整份 replace 会让所有键都发 `config.changed`；runtime 相位字段被无谓标记为「变了」会误导订阅方。⚠️ **没有任何断言**：`tests/unit/config-loader.test.ts` 那两条 `prepareRuntimeConfigStore` 用例只断言返回值与 store 的**最终值**，**没有一条挂 `onChange` 数通知次数**。改成整份 replace，全仓绿。
4. **`prepare.ts` 独立于 `load.ts`、不复用它的编排** — 否掉「抽一个共用的加载管线」— 两条路径的来源集合根本不同（`loadConfig` 读 env/argv/文件，runtime 路径是纯内存对象），共用管线只会让两边各自加 `if` 退化成两份。**共用**的是本层这三个纯函数。⚠️ **没有任何断言**（纯结构取舍）。
5. **`prepareRuntimeConfigStore` 是本层唯一的跨目录出口** — 否掉「把 `resolveConfigPaths` / `applyUpstreamUrlToConfig` 也出去」— 它们是 `load.ts` 与 `createConfigContext` 的内部编排件，没有跨目录调用方（见根决策 2）。⚠️ **没有任何断言**：`@/config/normalize/index.ts` 的导出面从未被逐项枚举（与根决策 2 是同一条警告）。
