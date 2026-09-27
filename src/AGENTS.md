# src/ — 文件与路径说明

`src/` 根上的两个文件即全仓的两个组合根。

## 文件

- `index.ts` — 库入口，纯导出集合，import 期无副作用（`@b-hole/proxy` 的包门面）。
- `cli.ts` — CLI 组合根，流程为快照宿主来源 → 加载配置 → 建 logger 并转交加载告警 → 起进程。

## 子目录

- `config/` — 配置 schema、加载器、store 与文件数据层；见 `src/config/AGENTS.md`。
- `core/` — 协议实现、事件内核、流量计量、身份与访问控制；见 `src/core/AGENTS.md`。
- `runtime/` — 库运行时门面与公开装配层；见 `src/runtime/AGENTS.md`。
- `server/` — 进程编排层（进程壳 / cluster / 进程策略）；见 `src/server/AGENTS.md`。
- `utils/` — 基础设施叶子层（`constants/`、`logger/`、`tls/`、`json-file/`）；见 `src/utils/AGENTS.md`。

## 对外出口路径

- `src/index.ts` — 包入口（`@b-hole/proxy`）。
- `@/runtime/index.js` — 库装配面。
- `@/utils/{constants,logger,tls,json-file}/index.js` — 基础设施各 barrel。
- `@/config/index.js`、`@/core/events/index.js`、`@/core/helpers/index.js` — 配置与 core 各 barrel。
- `@/config/files/rules/index.js` — 名单规则纯函数的第二出口。

## 相关测试

- `tests/library/entry.test.ts`
- `tests/unit/library-entry.test.ts`
