# src/ — 文件与路径说明

`src/` 根上的文件即全仓的组合根与包门面。

## 文件

- `index.ts` — 库入口，纯导出集合，import 期无副作用（`@b-hole/proxy` 的包门面）。
- `cli.ts` — **代理** CLI 组合根，流程为快照宿主来源 → 加载配置 → 建 logger 并转交加载告警 → 起进程。
- `cli-admin.ts` — **管理** CLI（`proxy-cli`）组合根：快照宿主来源 → 跑一条命令 → 按退出码退出。
  **绝不启动代理**（不装配 `ProxyServer` / `ProxyRuntime`、不装进程守卫、不 fork cluster）。
  与 `cli.ts` 逐字对称，**三个组合根，一个进程一个**。
- `cli-manager.ts` — **manager 控制面**（`proxy-manager`）组合根：快照宿主来源 → 加载配置 →
  建 logger → 拉子进程（`createSupervisor`）→ 开 HTTP 端口（`createManagerServer`）→ 装自己的
  信号处理。常驻服务，收到信号后停机并返回退出码。**它自己不 spawn / kill 任何进程**（那是
  `manager/supervisor.ts` 的活）；`MANAGER_ENABLED=false` 时明确打印并以非零码退出。

## 子目录

- `config/` — 配置 schema、加载器、store 与文件数据层；见 `src/config/AGENTS.md`。
- `core/` — 协议实现、事件内核、流量计量、身份与访问控制；见 `src/core/AGENTS.md`。
- `datasource/` — 三份数据源的端口 / 实现器 / 驱动注册表（账号表 / 名单 / 账本）；见 `src/datasource/AGENTS.md`。
- `ops/` — 数据源**操作**层：配置 → 装配、账号 / 名单 / 账本的读写、配置事实。**只出结构化数据与 `OpsError`，零渲染**；见 `src/ops/AGENTS.md`。
- `admin/` — `proxy-cli` 的传输层（解析 / 派发 / 渲染 / 退出码）；见 `src/admin/AGENTS.md`。
- `runtime/` — 库运行时门面与公开装配层；见 `src/runtime/AGENTS.md`。
- `server/` — 进程编排层（进程壳 / cluster / 进程策略）；见 `src/server/AGENTS.md`。
- `manager/` — manager 控制面（`supervisor` 子进程监管者 + `http/` 传输层 + `routes/` 资源端点）；见 `src/manager/AGENTS.md`。
- `utils/` — 基础设施叶子层（`constants/`、`logger/`、`tls/`、`json-file/`、`sqlite/`）；见 `src/utils/AGENTS.md`。

## 对外出口路径

- `src/index.ts` — 包入口（`@b-hole/proxy`）。
- `@/runtime/index.js` — 库装配面。
- `@/ops/index.js` — 数据源操作面（`resolveOpsSources` 与三份数据的操作；**不启动代理、不渲染**）。
- `@/admin/index.js` — 管理命令传输面（`runAdminCli` 与 `AdminIo`）。
- `@/utils/{constants,logger,tls,json-file,sqlite}/index.js` — 基础设施各 barrel。
- `@/config/index.js`、`@/core/events/index.js`、`@/core/helpers/index.js` — 配置与 core 各 barrel。
- `@/config/files/rules/index.js` — 名单规则纯函数的第二出口。

## 相关测试

- `tests/library/entry.test.ts`
- `tests/unit/library-entry.test.ts`
- `tests/unit/ops.test.ts`
- `tests/unit/admin-cli.test.ts`
- `tests/unit/manager-http.test.ts`（`proxy-manager` 的 HTTP 面；组合根本身靠
  `src/cli-manager.ts:runManager` 的入参形状被间接覆盖）
