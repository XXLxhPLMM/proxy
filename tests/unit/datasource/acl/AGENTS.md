# tests/unit/datasource/acl/ — 名单数据源（`@/datasource/acl/`）的判据

本目录只答一件事：**一份 acl.json 是怎么被读进来、判成放行/拒绝、又怎么被装配成一个驱动**。
层不变量与取舍理由归 `src/datasource/AGENTS.md`（那份是本目录牙齿的源头）。
名单**判定语义**那一半归 `tests/unit/core/access-control/`，**物化**归 `../ensure-target.test.ts`。

## 锁什么（四条不变量，每条都配了变异实测）

① ⚠️ **驱动名是开放集合，装配点必须经注册表 `resolve`**（`DataSourceDriver = string`，不是字面量
   联合，故没有类型系统兜底）。判据形状一律是**同一目标主机在两种驱动下的相反结果**：自定义档拒、
   json 档读同一份文件放行 —— 于是「装配点忽略了 `aclDriver`」立刻表现为断言失败，而不是「读起来一样」。
   牙齿：`driver-wiring.test.ts`。
② ⚠️ **两个装配点各自独立成钉**：`core/access-control.ts:createFileAccessControl`（判定期）与
   `config/load.ts`（启动期强校验）。三次变异实测（各自会红几条）：

   | 变异 | 变红 |
   | --- | --- |
   | `aclSourceFor` 忽略 `locator.driver()`、恒取 `"json"` | 7 档（判定期 + 经同一条解析的启动期） |
   | `loadConfig` 里的 `aclDriver` 恒取 `"json"` | 启动期 3 档 |
   | 拆掉 `createFileAccessControl` 里的 `aclSourceFor(aclLocator)` | 1 档（「未注册驱动装配即抛错」） |

   ⚠️ 第 1 行与第 2 行的红集**不等**（判定期那条路径不经过 `loadConfig`，反之亦然）⇒ 合并会漏掉
   「两个装配点各读各的」这种分裂。反过来，**若哪天它们不再随接线断裂而红，说明判据锚到了恒真的形状**
   （例如只断言「注册成功」而不断言「装配真的用了它」），必须把锚改回行为面。
③ ⚠️ **形状校验只有一份**（`validateAcl`，零 IO），而**一个判据可以有多个调用点**：
   读侧把引用**传给** `readJsonCached` 的校验位、启动期**调用**一次、写前**调用**一次。
   ⚠️ 所以牙齿是「**实现器里没有本地定义** + 判据从 `src/datasource/acl/validate.ts` 取」+「校验模块零 IO」，
   **不是**「全文恰好出现一次」—— 那个数错一个就会变成「为了对上而改数」，而真正会漂的那件事
   （自己在 `read()` 里手写一段判断）反而漏掉。牙齿：`driver-registry.test.ts`。
④ ⚠️ **数据源层零 `@/config` 依赖**：接线只有两个闭包（`driver()` / `path()`），故本目录**手搓闭包**，
   **不经 `aclLocatorFor`** —— 那样会顺带把「装配层翻译配置」也测了，而那不是本目录要证明的
   （`ConfigAccessor` 的接线由 `src/config/acl-locator.ts` 自己负责）。

## 记忆边界与用例隔离（四档共用）

- **`aclSourceFor` 按 `(接线, 驱动名)` 分槽记忆**：记「哪个驱动」，**绝不记「哪份数据」**。
  实现器每次**现取**位置（`locator()`），故热改 `aclFile` 在下一次读即生效而实例不变。
- ⚠️ **每例一份独立接线**：`ConfigStore` 的记忆表按接线分槽，共用一条会让**上一例的实现器泄漏进
  下一例** —— 那会让断言测到的是「上一例留下的缓存」而不是「本例的接线」。
- ⚠️ **`readJsonCached` 的 1s 节流缓存是模块级、键为 `label + path`**：同路径连写两档会互相污染，
  这正是 `configured.test.ts` 用 `freshPath()`（每档独立文件名）绕开的机制 —— 也是它在 EACCES 那一档
  要 mock `fs.statSync` 的原因（`chmod` 在 Windows 上只切只读属性、造不出稳定的 EACCES）。
- ⚠️ **`loadConfig` 必须给独立 `cwd`**：它在那个 cwd 下解析 FIELDS 的路径缺省，不给就落在仓库里。

## 防假绿的位置

- **判据取行为面（判定值 / 抛出的错误文本 / 调用计数），不取「注册成功」「kind 变了」「文件存在」**：
  前三者会被「按 driver 分别记忆」「注册表只是个 Map」这类实现细节满足，哪怕装配压根没换过去。
  牙齿：`driver-wiring.test.ts` 的 `factoryCalls` / `readCalls` / `startupCalls` 三处。
- ⚠️ **`validate.test.ts` 刻意不 `blockAfter(source, "public read(")` 再数出现次数**：那个锚点后面第一个
  `{` 是形参默认值 `options: AclReadOptions = {}` 的花括号，于是切出来的是空对象 `{}`，
  计数恒为 0 —— **一条恒为 0 的断言比没有断言更坏**。三个使用点逐个点名（`toContain` 各自那句原文）。
- ⚠️ **「已存在的目标绝不被空骨架覆盖」那条用真内容而不是「文件大小非 0」**，否则空文件也能骗过
  （那是 `../ensure-target.test.ts` 那边，但同一份理由对这里的写路径成立）。
- **`readAcl` 缺失 ≠ 错误**、**坏内容永不接管**（沿用上一份有效值）：判据必须把「读不到」与「读坏了」
  分成两格断言，否则「读不到就当没配」这条退化看不出来。
- ⚠️ **`_acl-driver.ts` 不许上提 `tests/helpers/`**：`CUSTOM_ACL` 带着一个公网 host 字面量，而
  `external-network-scan.ts` 的 `SCAN_DIRS` 排除 `helpers/`、`walk()` 收目录下全部 `.ts` ——
  搬进去等于让那份覆盖从零外网扫描里**静默消失**，而 `no-external-network.test.ts` 的下界断言照样绿。
  **可见的重复优于看不见的失效。**

## 文件

- `validate.test.ts` — `validateAcl` 的结构校验真值表：补空 / 非法顶层 / 非法组内 / `clientIp` 与
  `target` 的条目语法差异。**只管形状**，不管这份形状怎么变成放行/拒绝。
- `configured.test.ts` — `hasConfiguredAcl`（`acl-inert` 启动期告警的判据）真值表 + 「读失败 → false
  但必须另有可见 `error` 事件」那两格 + 「零新增 `readJsonCached` 调用点」的实现纪律。
- `driver-wiring.test.ts` — 不变量 ① 与 ②：两个装配点各自真的换了实现器（判定期 / 启动期），
  含未注册驱动即抛错并列出全部已注册项。
- `driver-registry.test.ts` — 注册表原语（列出 / 退订幂等 / 重名抛错 / 覆盖后退订只删自己那一项 /
  resolve 未注册即抛）+ `aclSourceFor` 的记忆边界 + 不变量 ③④ 的源码级牙齿。
- `_acl-driver.ts` — `driver-wiring` 与 `driver-registry` 两档真用到的假驱动面（`CUSTOM` /
  `DENIED_HOST` / `newProbe` / `fakeSource` / `register` / `storeWith`）。**只有一档用的（`accessorOf` /
  `writePermissiveJson` / `tempCwd` / `locatorOf` / 临时 `dir`）留在那个档里。**
- `AGENTS.md` — 本文件。

## 相关路径

- `../../../../src/datasource/acl/` — 被测模块：`types.ts`（`AclLocator` 两个闭包 / `write?` 可选整份覆盖）
  / `validate.ts`（那份唯一的形状判据）/ `registry.ts`（注册表 + `aclSourceFor` + `hasConfiguredAcl`）
  / `json-source.ts`（内置档，两个读路径 + 物化 + 写前校验）。
- `../../../../src/core/access-control.ts` — 判定期那个装配点（吃 `ConfigAccessor`）。
- `../../../../src/config/load.ts` — 启动期强校验那个装配点。
- `../../../helpers/source-scan.ts` — `codeOnly` / `codeOf` / `sourceOf` / `blockAfter` 与三个路径常量。
- `../../../helpers/public-hosts/unit-datasource-acl.ts` — 本目录的零外网白名单片（4 档里 3 档有公网字面量，
  第 4 条是共用前导 `_acl-driver.ts`；`driver-registry.test.ts` 零字面量故不建条目）。
- `../../meta/no-external-network.test.ts` — 那张表的断言面（双向：未申报即红，失效条目也红）。
