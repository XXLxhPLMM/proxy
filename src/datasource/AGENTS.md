# src/datasource/ — 数据源层

**数据源是「数据从哪来」，不是「数据是什么意思」。** 一个端口 + 若干实现器 + 一张驱动注册表。

## 层不变量

**本节只列不变式，理由留在各文件的头注释里**（理由会随代码一起改，抄进本文件就变成第二份要维护的真相）。

- **零 `@/config` 依赖**：本层任何文件都不 import `@/config/index.js`、不认识 `ConfigAccessor`。装配层（`@/config/account-locator.ts`）把配置翻译成 {@link AccountLocator}（两个闭包：`driver()` / `pathFor(driver)`）再传进来。破了这条，「不启动代理、单独用一个数据源」就在类型上不成立。牙齿：`tests/unit/account-store.test.ts`「读面不认配置端口」那条源码级断言。
- **形状校验只有一份，且零 IO**：每个后端都把原始值交给自己那一份 `validateAuthUsers`（名单是 `validateAcl`），**绝不逐列复写判据**。判据的第二份真相源与 json 档漂移的那一天，就是「配了 A、行为悄悄不同」的开始。代价是放弃「在 SQL 里筛」——账号表只读、几百到几千行，整表读与读文件同量级，那笔交易划算。
- ⚠️ **一条判据可以有多个调用点，别把「出现次数」当判据**：账号表读侧把 `validateAuthUsers` **传给**节流读取层、启动期与写前各**调用**一次；名单读侧传引用、启动期与写前各调用一次。那几个调用点全都在调用**同一个函数**。这条不变量的牙齿是「**实现器里没有本地定义**、判据从那一个模块取」；用「全文恰好出现一次」当判据会让人为了对上而改数，而真正会漂的那件事（自己在 `read()` 里手写了一段判断）反而漏掉。牙齿：`tests/unit/acl-driver.test.ts` 的「实现器只调用那一个 validateAcl，从不自己实现一份」。
- **名单的写只有一个成员，且它是**可选的整份覆盖**（只有 `acl/` 有这层分叉）：`AclSource.write?(next)`。**没有**「加一条 / 删一条」这种数据库语义——名单是一份文档、一次判定的量（见 `acl/types.ts` 文件头）。它是**可选成员**而不是必填：驱动名是开放集合，第三方名单驱动完全可能只读（名单来自一个下发系统），把写设为必填就是强迫每个只读驱动造一个「假装写成功」的实现——那是最贵的一种假绿。**缺省 = 这份名单改不了**，消费方（`@/admin/context.ts:requireAclWrite`）据此明确报错退出。写之前整份过**同一个** `validateAcl`（与读侧同一个），故「写得进去、读不出来」不存在。
- **驱动名是开放集合，闭合性由注册表这个运行时事实保证**：`DataSourceDriver = string`，不是字面量联合。**未注册驱动必须抛错并列出全部已注册项，绝不静默回落到内置档**——`else → json` 会把 `AUTH_USERS_DRIVER=mysql` 变成「静默按 json 跑」，用户以为接上了数据库、实际读的是 `users.json`。牙齿：`tests/unit/account-store.test.ts` 驱动注册表那组（**已做变异测试**：把查表换回硬编码 if/else 会红）。
- **绝不许另开第二个读取点**：每个后端内**恰好一处**读取调用，共享 `@/utils/json-file` 的节流 / 缓存 / 四态事件（缓存键是 `label + path`）。两份节流缓存撞上同一个键就会互相污染出无法解释的观察结果，而且「在读哪一份缓存」在调用方那里根本不可见。牙齿：`tests/unit/account-store.test.ts` 与 `auth-users.test.ts` / `user-quota.test.ts` 的读取点计数断言。
- **路径与驱动名都现取，记忆的只有「实现器是哪一个」**：两者都是 runtime 相位（可热改）。实现器若持有固定路径、而装配层又记忆了实现器实例，「改配置指向另一个数据源」就**永远不生效**——表现是「读出来是空的」，极难定位。
- **名单的两条读路径不得合并**（只有 `acl/` 有这层分叉）：`AclSource.read()` 是判定期热路径（mtime 节流 + 内容快照身份复用 + 四态事件），`AclSource.readStartup()` 是启动期强校验（直接读一次，不进热加载缓存、不发观察事件）。合成一条会让启动期校验**要么污染热加载缓存、要么失去 fail-closed** —— 启动那一刻「上一份有效值」根本不存在，坏内容必须让启动失败而不是回退成空名单（那是一次配置事故伪装成「没配名单」）。
- **坏名单内容永不接管**（只有 `acl/` 有这层取舍）：非法内容 → `error` + 沿用上一份有效值。名单是放行 / 拒绝的判据，「手滑写坏一行」绝不能等价于「全放行」。真正读不到（缺失 / 统计错误）才回退空名单，且空名单 = 不拦任何请求 = 部署者的显式意图。
- **判据必须在装配点，不许懒解析**：`createFileAccessControl` 与 `loadConfig` 各自在装配那一刻就经注册表 `resolve` 一次。懒解析会让「驱动名拼错」的表现是「所有请求全放行 + 一条 `acl-inert` 告警」，也就是「启动成功、代理全通」——**fail-fast 一条不丢，只是挪到它该在的位置**。牙齿：`tests/unit/acl-driver.test.ts` 的三次变异实测。
- **接线（`AccountLocator` / `AclLocator`）按 `ConfigAccessor` 记忆**：`WeakMap`，随 accessor 一起被回收。读面有**每请求**（`loadUserPolicy`、以及名单判定每连接都走的 `compiled`）与**每 chunk**（`loadUserQuota`）两条热路径，接线每调用现造等于每次判定重新 new 一个实现器。⚠️ 同一份数据源的两处下游（`core/access-control.ts` 的三张 `WeakMap` 与本层的实现器记忆表）**必须拿到同一个接线对象**，否则「装了 handler 却没人收」或「每请求 new 一个数据源」。

## 子目录

| 目录 | 端口 | 内置驱动 | 对外出口 |
|---|---|---|---|
| `users/` | `AccountSource`（账号表） | `json` / `sqlite` | `@/datasource/users/index.js` |
| `acl/` | `AclSource`（名单；`write?` 是可选的整份覆盖） | `json` | `@/datasource/acl/index.js` |
| `quota/` | `UsageSource`（配额账本） | `json`（单文件 JSONL）/ `sqlite` | `@/datasource/quota/index.js` |

## 根文件

- `driver.ts` — 驱动名词汇表（`DataSourceDriver` / 三组 `BUILTIN_*_DRIVERS`）与 `unknownDriverError`。
- `registry.ts` — 注册表本体 `createSourceRegistry`（驱动名 → 工厂；未注册即抛错并列出已注册项；退订只删自己写的那一项）。
- `quota-window.ts` — 配额窗口键（`QuotaWindow` / `quotaWindow` / `windowKey`），三份数据源共用的**纯函数**。
- `index.ts` — 本层 barrel（跨目录引它，不引子目录路径）。

## 装配点在哪

配置侧每个数据源各一处：`@/config/index.js:accountLocatorFor(config)` / `accountLocatorFrom(driver, file, db)`，与 `aclLocatorFor(config)` / `aclLocatorFrom(driver, file)`。**「哪个配置键装哪个驱动」只有这一份**——数据源层不认识 `AUTH_USERS_*` / `ACL_*` 任何键名，消费方（`core/access-control.ts`、`core/identity/factory.ts`、`runtime/services.ts`、`runtime/runtime.ts`、`server/log/config-log.ts`）一律先取接线再传给读面。

⚠️ **先注册、再装配**：`register*` 是模块级可变全局状态，`createProxyRuntime` / `loadConfig` 之后的任何时刻注册不会崩，但**那一次装配解析不到新驱动**，于是抛「驱动未注册」并列出当时已注册的项。

## 相关路径

- `src/config/account-locator.ts` / `src/config/acl-locator.ts` — 配置 → 接线的翻译层（本层与配置层之间唯一的接缝）。
- `src/config/files/rules/` — 名单条目语法纯函数（`users/validate.ts` 与 `acl/validate.ts` 各自的唯一条目判据；本层对它只有「第二出口」这一个合法引用）。⚠️ 这是「零 `@/config` 依赖」那条的**唯一例外**，且不削弱它的意图：那个模块零配置依赖、零 IO、零日志，而条目语法是两个数据源**共用**的词汇，搬进本层只会让它们互相依赖。
- `@/utils/json-file/` — 节流 / 缓存 / 四态事件，三个数据源共用。
- `@/utils/sqlite/` — SQLite 驱动端口（`users/sqlite-source.ts` 与 `quota/` 各一个实现）。

## 相关测试

- `tests/unit/account-store.test.ts` — 账号数据源（等价性、驱动切换、写族、注册表、跨层护栏）。
- `tests/unit/auth-users.test.ts`、`tests/unit/user-quota.test.ts` — 账号表形状与读面。
- `tests/unit/acl-driver.test.ts` — 名单数据源的注册表与 **`ACL_DRIVER` 装配接线的牙齿**（注册自定义驱动 → 两个装配点真的各用一次；含三次变异实测）、「形状校验只有一份」的**三个调用点逐个点名**（读侧传引用 / 启动期 / 写前）与其先后次序、`tests/unit/acl-configured.test.ts`（`hasConfiguredAcl` 真值表 + 唯一读取点）、`tests/unit/acl.test.ts`（形状校验 + 判定语义）。
- `tests/unit/usage-drivers.test.ts` — 账本数据源（等价性、装配切换、驱动边界）。
- `tests/unit/json-file.test.ts` — 共用的节流 / 缓存机制。
