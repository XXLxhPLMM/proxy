# src/config/ — 文件与路径说明

子目录：`schema/`、`sources/`、`normalize/`、`files/`、`files/rules/`。

- `types.ts` — 配置字段契约的纯类型定义。
- `store.ts` — 唯一配置状态 `ConfigStore` 与 `defaults` 种子。
- `context.ts` — `ConfigAccessor` 只读端口、`ConfigContext` 冻结快照与 context 工厂。
- `account-locator.ts` / `acl-locator.ts` — 配置访问器 → 数据源**接线**的翻译层（`accountLocatorFor` / `accountLocatorFrom` 与 `aclLocatorFor` / `aclLocatorFrom`）。**「哪个配置键装哪个驱动」每个数据源各只有这一份**，数据源层不认识任何 `*_DRIVER` / `*_FILE` 键名（`AclLocator` 只有 `driver()` / `path()` 两个闭包）。
- `presets.ts` — 配置预设（`name` + 部分 `AppConfig`）注册表。
- `load.ts` — async 配置加载器 `loadConfig`，配置 IO 的编排入口。
- `index.ts` — 本目录对外 barrel。
- `schema/` — 字段元数据 `FIELDS`、解析原语、校验与 `UPSTREAM_URL` 字段契约 → [`schema/AGENTS.md`](./schema/AGENTS.md)
- `sources/` — 外部输入采集（configDir、env 文件、argv）→ [`sources/AGENTS.md`](./sources/AGENTS.md)
- `normalize/` — 配置副本的路径与 `UPSTREAM_URL` 归一化 → [`normalize/AGENTS.md`](./normalize/AGENTS.md)
- `files/` — 名单条目语法层（子目录 `rules/`）与热加载事件日志渲染 → [`files/AGENTS.md`](./files/AGENTS.md)
- `files/rules/` — 名单条目语法层（IP/CIDR 编译、主机/通配匹配），全局名单与账号级个人名单共用 → [`files/rules/AGENTS.md`](./files/rules/AGENTS.md)

对外唯一出口：`@/config/index.js`；唯一允许的第二出口：`@/config/files/rules/index.js`。

**本层不再持有任何数据源的读取面**：账号表与全局名单的读面、端口、驱动注册表分别在 `@/datasource/users/index.js` 与 `@/datasource/acl/index.js`。本层对它们只出**接线**。

相关路径：`src/cli.ts`（宿主来源采集）、`src/datasource/acl/`（全局名单读面与 `ACL_DRIVER` 注册表）、`src/datasource/users/`（账号表读面与 `AUTH_USERS_DRIVER` 注册表）、`src/core/access-control.ts`（请求期名单判定）、`src/datasource/quota/`（配额计量与账本）。

相关测试：`tests/unit/config-instance.test.ts`、`tests/unit/config-loader.test.ts`、`tests/unit/config-loader-import.test.ts`、`tests/unit/proxy-runtime.test.ts`、`tests/unit/usage-source.test.ts`、`tests/unit/quota-config-fields.test.ts`、`tests/integration/upstream-protocol-fail-closed.test.ts`、`tests/library/entry.test.ts`。
