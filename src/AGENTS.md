# src/ — 文件与路径说明

`src/` 根上的文件即全仓的组合根与包门面。

## 文件

- `index.ts` — 库入口，纯导出集合，import 期无副作用（`@b-hole/proxy` 的包门面）。
- `cli.ts` — **服务** CLI 组合根，流程为快照宿主来源 → 加载配置 → 建 logger 并转交加载告警 →
  按 `MANAGER_ENABLED` 起控制面 → 起数据面 → 常驻。**数据面与控制面同进程**、共用同一份配置
  快照（绝不二次 `loadConfig`：两份快照之间的漂移正是「控制面看到的配置 ≠ 代理跑着的配置」的
  来源）。数据面起不来时先把控制面关掉再抛（不留一个还在监听、却已经没有数据面的面）；
  停机时控制面先关、数据面后排空。数据面归谁管由 `DataPlaneOwner` 回答（`runServer` 填，
  控制面现读）——cluster master 那一档是唯一「本进程不持有数据面」的部署形状。
- `cli-admin.ts` — **管理** CLI（`proxy-cli`）组合根：快照宿主来源 → 跑一条命令 → 按退出码退出。
  **绝不启动代理**（不装配 `ProxyServer` / `ProxyRuntime`、不装进程守卫、不 fork cluster）。
  与 `cli.ts` 逐字对称，**两个组合根，一个进程一个**。

## 子目录

- `config/` — 配置 schema、加载器与 store；见 `src/config/AGENTS.md`。
- `core/` — 协议实现、事件内核、流量计量、身份与访问控制；见 `src/core/AGENTS.md`。
- `datasource/` — 三份数据源的端口 / 实现器 / 驱动注册表（账号表 / 名单 / 账本）；见 `src/datasource/AGENTS.md`。
- `ops/` — 数据源**操作**层：配置 → 装配、账号 / 名单 / 账本的读写、配置事实。**只出结构化数据与 `OpsError`，零渲染**；见 `src/ops/AGENTS.md`。
- `admin/` — `proxy-cli` 的传输层（解析 / 派发 / 渲染 / 退出码）；见 `src/admin/AGENTS.md`。
- `runtime/` — 库运行时门面与公开装配层；见 `src/runtime/AGENTS.md`。
- `server/` — 进程编排层（进程壳 / cluster / 进程策略）；见 `src/server/AGENTS.md`。
- `manager/` — 控制面（`control-plane` 装配 + `http/` 传输层 + `routes/` 资源端点）；见 `src/manager/AGENTS.md`。
- `utils/` — 基础设施叶子层（根上零 `.ts` 文件；`addr/` 地址文本层、`constants/`、`logger/`、`tls/`、`json-file/`、`sqlite/`）；见 `src/utils/AGENTS.md`。

## 对外出口路径

- `src/index.ts` — 包入口（`@b-hole/proxy`）。
- `@/runtime/index.js` — 库装配面。
- `@/ops/index.js` — 数据源操作面（`resolveOpsSources` / `opsSourcesFromContext` 与三份数据的操作；**不启动代理、不渲染**）。
- `@/admin/index.js` — 管理命令传输面（`runAdminCli` 与 `AdminIo`）。
- `@/utils/{constants,logger,tls,json-file,sqlite,addr}/index.js` — 基础设施各 barrel。
- `@/config/index.js`、`@/core/events/index.js`、`@/core/helpers/index.js` — 配置与 core 各 barrel。
- `@/utils/addr/index.js` — 地址文本层：字符原子（`text.ts`）、名单条目语法（`ip.ts` / `host.ts`）、入站对端取值（`inbound.ts`）；零配置依赖、零 IO、零日志。

## 相关测试

- `tests/library/entry.test.ts`
- `tests/unit/library/entry.test.ts`
- `tests/unit/ops/`
- `tests/unit/admin/cli/`
- `tests/unit/manager/http/`（控制面的 HTTP 面；`src/manager/control-plane.ts` 的装配
  与 `src/cli.ts` 的组合靠 `tests/library/` 侧的间接覆盖）
