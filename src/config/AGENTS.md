# src/config/ — 文件与路径说明

子目录：`schema/`、`sources/`、`normalize/`。

- `types.ts` — 配置字段契约的纯类型定义。
- `store.ts` — 唯一配置状态 `ConfigStore` 与 `defaults` 种子。
- `context.ts` — `ConfigAccessor` 只读端口、`ConfigContext` 冻结快照与 context 工厂。`ConfigSourceMetadata` 的四份来源元数据（`envKeys` / `envFiles` / `argvKeys` / `fileOrigins`）**只记键名与路径、不记任何值** —— 日志与诊断消费方可以知道配置来自哪些来源，而密码不会被复制进上下文。`fileOrigins`（「哪个 env 文件带来了哪个键」）是**唯一**能答这个问题的出口：`loadConfig` 里 `readEnvFiles` 算出的那一份，**重读文件会与合并结果漂移**（`baseEnv` 优先级与文件顺序都在那个函数内完成）。⚠️ 「不在 `fileOrigins` 里」= **不是文件带来的**（可能来自宿主 env、CLI 或缺省，三者在本层之后不可区分），消费方不许把它读成「一定来自缺省」。
- `account-locator.ts` / `acl-locator.ts` — 配置访问器 → 数据源**接线**的翻译层（`accountLocatorFor` / `accountLocatorFrom` 与 `aclLocatorFor` / `aclLocatorFrom`）。**「哪个配置键装哪个驱动」每个数据源各只有这一份**，数据源层不认识任何 `*_DRIVER` / `*_FILE` 键名（`AclLocator` 只有 `driver()` / `path()` 两个闭包）。
- `presets.ts` — 配置预设（`name` + 部分 `AppConfig`）注册表。
- `load.ts` — async 配置加载器 `loadConfig`，配置 IO 的编排入口。**未知键闸门也在这里**：`argv` 与 env 文件里出现 `FIELDS` 之外的键一律让启动失败（`NON_CONFIG_ENV_KEYS` 是容忍名单，恰好两个键 `NODE_ENV` / `NO_COLOR`，每个成员都必须在本仓有唯一一处真实读取，且**不得收入 `FIELDS` 已有的键**——那份字段被删时名单会继续放行它，把删除掩盖掉；`USE_HOME_CONFIG` 虽被早于字段解析地单独读取，但它是 `FIELDS` 字段，故不在名单里。显式 `env` 入参**不**查，宿主环境的无关变量不是配置错误）。判据必须是「键名」而不是「这个键的值有没有被用上」——落选的键会走现成的回落通路静默拿到缺省值。
- `index.ts` — 本目录对外 barrel。
- `schema/` — 字段元数据 `FIELDS`、解析原语、校验与 `UPSTREAM_URL` 字段契约 → [`schema/AGENTS.md`](./schema/AGENTS.md)
- `sources/` — 外部输入采集（configDir、env 文件、argv）→ [`sources/AGENTS.md`](./sources/AGENTS.md)
- `normalize/` — 配置副本的路径与 `UPSTREAM_URL` 归一化 → [`normalize/AGENTS.md`](./normalize/AGENTS.md)

对外唯一出口：`@/config/index.js`，**无例外**。

**本层只出接线，不持有任何读面**：账号表与全局名单的读面、端口、驱动注册表分别在 `@/datasource/users/index.js` 与 `@/datasource/acl/index.js`。名单条目语法在 `@/utils/addr/`（`@/utils` 叶子层内的纯函数层），文件热加载事件的渲染在 `@/utils/json-file/event-log.ts`。

相关路径：`src/cli.ts`（宿主来源采集）、`src/utils/addr/`（名单条目语法）、`src/datasource/acl/`（全局名单读面与 `ACL_DRIVER` 注册表）、`src/datasource/users/`（账号表读面与 `AUTH_USERS_DRIVER` 注册表）、`src/core/access-control.ts`（请求期名单判定）、`src/datasource/quota/`（配额计量与账本）。

相关测试：`tests/unit/config-instance.test.ts`、`tests/unit/config-loader.test.ts`、`tests/unit/config-loader-import.test.ts`、`tests/unit/config-unknown-keys.test.ts`、`tests/unit/proxy-runtime.test.ts`、`tests/unit/usage-source.test.ts`、`tests/unit/quota-config-fields.test.ts`、`tests/integration/upstream-protocol-fail-closed.test.ts`、`tests/library/entry.test.ts`。
