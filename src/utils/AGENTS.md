# src/utils/ — 文件与路径说明

依赖树最底层的基础设施目录。

## 文件

- `ip.ts` — 客户端地址取值与轻度归一：`getClientAddress`（XFF > X-Real-IP > Forwarded > socket）、`getAuthority`、`getSocketAddress`。
- `host-text.ts` — 字符级主机文本归一原子：`stripIpBrackets` / `stripZone` / `stripTrailingDot` / `lowerTrim`。

`ip.ts` 与 `host-text.ts` 为单文件叶子，无 barrel。

## 子目录

- `constants/` — 协议常量；见 `src/utils/constants/AGENTS.md`，出口 `@/utils/constants/index.js`。
- `logger/` — 日志端口与实现、JSONL 落盘；见 `src/utils/logger/AGENTS.md`，出口 `@/utils/logger/index.js`。
- `tls/` — 证书材料与 TLS 建服/建链选项；见 `src/utils/tls/AGENTS.md`，出口 `@/utils/tls/index.js`。
- `json-file/` — JSON 配置热加载读取层；见 `src/utils/json-file/AGENTS.md`，出口 `@/utils/json-file/index.js`。
- `sqlite/` — SQLite 驱动层（端口 + Node 22 内置 / Node 16–22 WASM 两档分流）；见 `src/utils/sqlite/AGENTS.md`，出口 `@/utils/sqlite/index.js`。

## 业务概念所在路径

- 自环判定 — `@/core/helpers/self-loop.js`
- 目标地址解析 — `@/core/helpers/target.js`
- 名单条目规则 — `@/config/files/rules/`
- 上游 URL 契约 — `@/config/schema/upstream-url.js`
- 建服与监听 — `@/core/server/base.js`
- TLS 握手告警 — `@/core/server/tls-alarm.js`
- 日志事件码 — `@/core/log-events.js`
- banner / 进程守卫 / 进程策略 — `src/server/{banner,process-guards,process}.ts`
- 路径绝对化权威 — `src/config/normalize/paths.ts`

## 相关测试

- `tests/unit/ip.test.ts`、`tests/unit/tls.test.ts`
- `tests/unit/logger.test.ts`、`tests/unit/json-file.test.ts`
