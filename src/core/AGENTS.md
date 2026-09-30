# src/core/

文件与路径说明。

## 层不变量

以下四条已逐条核过（`src/core/**` 内零反例）。**本节只列不变式，理由留在各文件的头注释里**（理由会随代码一起改，搬进本文件就变成第二份要维护的真相）。

- **零日志，只抛不记**：core 不写日志也不打 `console`（`this.log.*` / `console.*` 在本目录恒为 0）。已发生的事实一律经注入的 `EventHub` 上抛，事件契约见 `./events/types.ts` 的 `AppEventMap`；落盘**唯一**真源是 `src/runtime/event-log.ts:bindProxyEventLogs`——CLI 与库调用方共用同一份，core 不自己拼日志文本。
- **依赖载体只有一个 `ctx`**：`CoreContext` 三件套（`config` / `logger` / `events`）只读、三个字段全必填、**无缺省无兜底**；基类 `ContextualBase` 收成 `config` / `log` / `events` 三个 getter，getter 名字是契约。缺省解析只允许发生在唯一组装根 `createProxyRuntime()`。
- **零 EventEmitter**：core 不继承、不构造 Node `EventEmitter`，`types/` 下零事件表。`createEventEmitter` 只是**容错发射器**（观察面抛错不得反噬协议收尾），不是事件总线。
- **依赖方向向下**：`src/core/**` 只 import `@/core`（层内）、`@/utils`、`@/config`、`@/datasource`，**不 import `@/runtime` 或 `@/server`**（那两层反过来依赖 core）。断了这条，库调用方才能拿 core 自己组一套代理。数据源层零 `@/config` 依赖，于是 core → datasource 这条边不构成环。

## 根文件

- `src/core/context.ts` — `CoreContext` 三件套只读接口与 `ContextualBase`，core 的依赖承载体。
- `src/core/access-control.ts` — `AccessControl` 的内置实现 `createFileAccessControl` 与观察面 `bindAclFileEvents`。全局名单**从哪来**由它装配（`@/datasource/acl` 的注册表按 `aclDriver` 选实现器，**未注册即装配期抛错**）；账号级个人名单**从哪来**是 `@/datasource/users` 的读面（`loadUserPolicy`，经 `@/config` 的接线拿驱动与路径）。名单**是什么意思**归它判定。core 向下依赖 `@/datasource`，反向永不成立。
- `src/core/error-boundary.ts` — 错误分类默认实现（`classifyError` / `classifyClientError` / `DEFAULT_ERROR_CLASSIFIER`）与终态边界 `ErrorBoundary`（分类 + 发 `request.failed` / `request.rejected` / `runtime.error`，**不写协议应答**）。分类本身是可替换端口 `types/proxy.ts:ErrorClassifier`（⚠️ 对客户端可见状态码零影响，那 7 处手写逻辑不经它）。
- `src/core/guard.ts` — 拨号后上下游生命周期联动与状态行读取（`guardDialing` / `socksUpstreamGuard` / `readResponseHead` / `awaitStatusLine`）。
- `src/core/log-events.ts` — `LogEvent` 事件码表与 `[event-code]` 文本词汇层。
- `src/core/request-terminal.ts` — `RequestTerminal`，请求一次性终态守卫与终态发布。
- `src/core/request-scope.ts` — `RequestScope` 值对象与工厂 `createRequestScope`。
- `src/core/scope-ids.ts` — 关联 id 生成（`connectionIdFor` / `newRequestId`）。
- `src/core/identity.ts` — 身份层出口，逐个 re-export `identity/` 各文件。
- `src/core/quota-meter.ts` — 计量落点 `meterStream` / `openLinkMeter`（在源流上挂被动 `data` 监听器）；消费的端口 `UsageAccount` 住在 `@/datasource/quota/`，**计量在哪条流上数**是 core 的事。
- `src/core/index.ts` — core 的选择性 barrel。

## 子目录

每个子目录一份 `AGENTS.md`。

- `src/core/types/` — 三个端口与判别联合的类型声明处。
- `src/core/server/` — 入站建服骨架、`BaseProxy` 生命周期状态机、两阶段准入、入站派发表。
- `src/core/forward/` — 转发层，根上 `forward/base.ts`，子目录 `forward/channel/`、`forward/upstream/`、`forward/upstream/connector/`。
- `src/core/identity/` — 四种认证模式插件与配置驱动门面。
- `src/core/helpers/` — 跨转发层共享纯工具（凭证、目标、自环、头、路由、上游、线缆、拨号前守卫）。
- `src/core/events/` — 事件内核 `EventHub` / `EventScope` / `AppEventMap`。

## 出口与相关路径

- 层 barrel：`@/core/helpers/index.js`、`@/core/events/index.js`。
- 相关：`src/config/`（配置状态、加载器与数据源接线）、`src/datasource/{acl,users,quota}/`（数据源读面与驱动注册表）、`src/runtime/event-log.ts`（事件落盘绑定）、`src/server/`（进程编排与进程策略端口）、`src/utils/`（协议无关纯工具）。
- 相关测试：`tests/unit/core-context.test.ts`、`tests/unit/access-control-port.test.ts`、`tests/unit/error-boundary.test.ts`、`tests/unit/request-terminal.test.ts`、`tests/unit/inbound-dispatch.test.ts`、`tests/integration/tls-client-auth.test.ts`、`tests/integration/request-terminal-events.test.ts`。

## 注释纪律：不许写指向本目录 AGENTS.md 的指针

**代码注释里不许出现「见 `./AGENTS.md` …」「判据全文见 …」这类指针。**

本目录的 `AGENTS.md` 按目录自动注入读者上下文（不需要谁去点链接），所以注释里的指针是同一条内容的**第二条冗余信道**——而冗余信道必然腐烂。2026-09 清理前 core 内共 **103 处**这类指针，散在 39 个文件里，指向的章节（「决策清单」第 1–9 条、「硬约定」第 1–4 条、「入站两阶段准入」、「入站派发表」、「三个可插值端口」、「路径说明」…）**已全部不存在，存活率 0**。其中两处还把落盘位置写错成 `src/server/index.ts`——因为那个文件确实存在，grep 与 review 都发现不了。

各归其位，同一条内容只存一份：

| 内容 | 住处 |
| --- | --- |
| 不变式、层纪律、出口约定 | **本文件**（自动注入） |
| 理由、边界、反例、实测数据、护栏路径 | **代码注释**，紧贴它解释的那几行 |
- 两者之间 —— **不留指针**。理由写在它所解释的代码旁边就够了；理由不跟着代码走的那部分，宁可没有。
