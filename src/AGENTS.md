# src/ — 文件与路径说明

`src/` 根上的文件即全仓的组合根与包门面。

## 文件

- `index.ts` — 库入口，纯导出集合，import 期无副作用（`@b-hole/proxy` 的包门面）。
- `cli.ts` — **代理** CLI 组合根，流程为快照宿主来源 → 加载配置 → 建 logger 并转交加载告警 → 起进程。
- `cli-admin.ts` — **管理** CLI（`proxy-cli`）组合根：快照宿主来源 → 跑一条命令 → 按退出码退出。
  **绝不启动代理**（不装配 `ProxyServer` / `ProxyRuntime`、不装进程守卫、不 fork cluster）。
  与 `cli.ts` 逐字对称，**两个组合根，一个进程一个**。

## 子目录

- `config/` — 配置 schema、加载器、store 与文件数据层；见 `src/config/AGENTS.md`。
- `core/` — 协议实现、事件内核、流量计量、身份与访问控制；见 `src/core/AGENTS.md`。
- `datasource/` — 三份数据源的端口 / 实现器 / 驱动注册表（账号表 / 名单 / 账本）；见 `src/datasource/AGENTS.md`。
- `admin/` — `proxy-cli` 的命令层（解析 / 派发 / 退出码）；见 `src/admin/AGENTS.md`。
- `runtime/` — 库运行时门面与公开装配层；见 `src/runtime/AGENTS.md`。
- `server/` — 进程编排层（进程壳 / cluster / 进程策略）；见 `src/server/AGENTS.md`。
- `utils/` — 基础设施叶子层（`constants/`、`logger/`、`tls/`、`json-file/`、`sqlite/`）；见 `src/utils/AGENTS.md`。

## 对外出口路径

- `src/index.ts` — 包入口（`@b-hole/proxy`）。
- `@/admin/index.js` — 管理命令层（`runAdminCli` 与 `AdminIo`）。
- `@/runtime/index.js` — 库装配面。
- `@/utils/{constants,logger,tls,json-file,sqlite}/index.js` — 基础设施各 barrel。
- `@/config/index.js`、`@/core/events/index.js`、`@/core/helpers/index.js` — 配置与 core 各 barrel。
- `@/config/files/rules/index.js` — 名单规则纯函数的第二出口。

## 相关测试

- `tests/library/entry.test.ts`
- `tests/unit/library-entry.test.ts`
- `tests/unit/admin-cli.test.ts`
