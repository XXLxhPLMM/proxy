# src/config/ — 文件与路径说明

子目录：`schema/`、`sources/`、`normalize/`、`files/`、`files/rules/`。

- `types.ts` — 配置字段契约的纯类型定义。
- `store.ts` — 唯一配置状态 `ConfigStore` 与 `defaults` 种子。
- `context.ts` — `ConfigAccessor` 只读端口、`ConfigContext` 冻结快照与 context 工厂。
- `presets.ts` — 配置预设（`name` + 部分 `AppConfig`）注册表。
- `load.ts` — async 配置加载器 `loadConfig`，配置 IO 的编排入口。
- `index.ts` — 本目录对外 barrel。
- `schema/` — 字段元数据 `FIELDS`、解析原语、校验与 `UPSTREAM_URL` 字段契约 → [`schema/AGENTS.md`](./schema/AGENTS.md)
- `sources/` — 外部输入采集（configDir、env 文件、argv）→ [`sources/AGENTS.md`](./sources/AGENTS.md)
- `normalize/` — 配置副本的路径与 `UPSTREAM_URL` 归一化 → [`normalize/AGENTS.md`](./normalize/AGENTS.md)
- `files/` — 磁盘配置资源（`users.json` / `acl.json`）与热加载事件日志 → [`files/AGENTS.md`](./files/AGENTS.md)
- `files/rules/` — 名单条目语法层（IP/CIDR 编译、主机/通配匹配）→ [`files/rules/AGENTS.md`](./files/rules/AGENTS.md)

对外唯一出口：`@/config/index.js`；唯一允许的第二出口：`@/config/files/rules/index.js`。

相关路径：`src/cli.ts`（宿主来源采集）、`src/core/access-control.ts`（请求期名单判定）、`src/core/traffic/`（配额计量）。

相关测试：`tests/unit/config-instance.test.ts`、`tests/unit/config-loader.test.ts`、`tests/unit/config-loader-import.test.ts`、`tests/unit/proxy-runtime.test.ts`、`tests/unit/traffic-ledger.test.ts`、`tests/unit/quota-config-fields.test.ts`、`tests/integration/upstream-protocol-fail-closed.test.ts`、`tests/library/entry.test.ts`。
