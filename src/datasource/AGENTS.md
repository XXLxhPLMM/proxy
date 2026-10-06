# src/datasource/ — 数据源层

**数据源是「数据从哪来」，不是「数据是什么意思」。** 一个端口 + 若干实现器 + 一张驱动注册表。

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
- `@/utils/addr/` — 名单条目语法纯函数（`users/validate.ts` 与 `acl/validate.ts` 各自的唯一条目判据）。零配置依赖、零 IO、零日志，与「零 `@/config` 依赖」那条同向而不是例外；它住在 `@/utils` 叶子层而不是本层子目录，因为两个数据源、`core/` 的判定、建链归一与 manager 入参白名单**共用**它，而挂在任何一个业务目录下都等于让其余几层反向依赖那一层。
- `@/utils/json-file/` — 节流 / 缓存 / 四态事件，三个数据源共用。
- `@/utils/sqlite/` — SQLite 驱动端口（`users/sqlite-source.ts` 与 `quota/` 各一个实现）。

## 相关测试

- `tests/unit/datasource/users/` — 账号数据源（等价性、驱动切换、写族、注册表、跨层护栏）。
- `tests/unit/config/auth-users/` — 账号表形状与读面。
- `tests/unit/datasource/acl/driver-registry.test.ts` + `tests/unit/datasource/acl/driver-wiring.test.ts` — 名单数据源的注册表与 **`ACL_DRIVER` 装配接线的牙齿**（注册自定义驱动 → 两个装配点真的各用一次；含三次变异实测）、「形状校验只有一份」的**三个调用点逐个点名**（读侧传引用 / 启动期 / 写前）与其先后次序、`tests/unit/datasource/acl/configured.test.ts`（`hasConfiguredAcl` 真值表 + 唯一读取点）、`tests/unit/datasource/acl/validate.test.ts` + `tests/unit/core/access-control/decision.test.ts`（形状校验 + 判定语义）。
- `tests/unit/datasource/quota/drivers/` — 账本数据源（等价性、装配切换、驱动边界）。
- `tests/unit/utils/json-file/` — 共用的节流 / 缓存机制。
