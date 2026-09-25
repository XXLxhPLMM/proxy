# src/utils — 基础设施（叶子层）

## 硬不变量

- **依赖树最底层**。运行期只允许两类依赖：`@/utils/*` 内部互引（叶子之间）与 `@/config/index.js` 的 **type-only** 引用。**禁止** import 任何 `@/core/*` 或 `@/server/*`——那会让最底层反向依赖编排层，形成目录级环（历史上 `utils/cert.ts` 反向 import 当时的 `server/log/events-log.ts` 就犯过这条，该文件现已下沉为 `core/log-events.ts`，环已断）。
- **协议常量零函数**：只出纯值。需要拼字符串的函数不属这里（`buildProxyAuthValue` 已因此搬到 `@/core/helpers/`）。
- **归一化/判定只有一份实现**：地址、主机文本、缺省端口、事件码都只有一个权威，见下方「唯一一份」清单。

## 子模块索引

**每个子模块有自己的 `AGENTS.md`，改哪块就改哪份，不要往本文件堆子目录的内部细节。** 各文件的具体职责清单以源码 `@fileoverview` 为第一手说明，本表只作索引。

| 模块      | 一句话                                             | 详细文档              |
| --------- | -------------------------------------------------- | --------------------- |
| `constants/` | 协议常量：HTTP 报文 / SOCKS 应答 / 安全边界 / 预编译正则 | `constants/AGENTS.md` |
| `logger/`    | 日志端口 + 三个实现 + 文本净化 + JSONL 落盘          | `logger/AGENTS.md`    |
| `tls/`       | 证书材料 + 入站建服选项 + 出站建链选项              | `tls/AGENTS.md`       |
| `json-file/` | JSON 配置热加载读取层（本目录的拆分范式样板）        | `json-file/AGENTS.md` |
| `ip.ts`      | 客户端地址提取（取值与轻度归一）                   | 本文件「地址与文本」  |
| `host-text.ts` | 主机文本归一原子（零项目依赖）                     | 本文件「地址与文本」  |

## 什么不属于本目录

判断准则：**带业务概念的东西不属基础设施**。放错层的代价是反向依赖，以及「叫这个名字的读者会误解」。

| 东西                            | 真正的家                        | 为什么                                                     |
| ------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| 自环判定（防循环转发）          | `@/core/helpers/self-loop.js`   | 转发策略而非地址原语；唯一调用方是同目录 `predial.ts`       |
| 目标地址解析（authority/目标三元组） | `@/core/helpers/target.js`  | 请求期语义                                                 |
| 名单条目规则（acl.json 的 IP/主机） | `@/config/files/rules/`     | 配置数据层的条目语法层                                     |
| 上游 URL 契约（`UPSTREAM_URL`） | `@/config/schema/upstream-url.js` | 配置字段的校验/拆项，且不该为拿 `ProxyProtocol` 反向依赖 core |
| 建服与监听（`listenAsync`）     | `@/core/server/base.js`         | 与 `closeServer` 对称，属生命周期骨架                       |
| 日志事件码（`[ip-denied]` 等）  | `@/core/log-events.js`          | core 事实 → 日志文本的翻译层，调用方都在 core/server         |
| banner 与进程守卫               | `@/server/`                     | 进程壳的展示与进程副作用                                   |

## 跨子模块的「唯一一份」清单

改任何一个都要确认没有第二处：

- **缺省端口**：`DEFAULT_PORT_HTTP`/`DEFAULT_PORT_HTTPS` 是 http/https 缺省端口的唯一定义；`config/schema/upstream-url.js` 的 scheme 表必须引它们。SOCKS 系列的缺省端口随明文/TLS 而变（1080/443），语义不同，不受此约束。
- **主机文本归一**：`host-text.ts` 的四个原子（`stripIpBrackets`/`stripZone`/`stripTrailingDot`/`lowerTrim`）是唯一字符级实现，被规则层与 `@/core/helpers/target.js` 共用；反向补括号只有 `formatAuthority` 一处。
- **地址判定**：ACL 名单与自环判定共用 `config/files/rules/` 的 `normalizeHost`+`normalizeIp`+`ipToString`，保证同一 host 在两侧归一结果逐字一致。
- **路径绝对化**：唯一权威是配置层（`FIELDS` 的 `path: true`，构造期按 `configDir` 解析）。`tls/` 不得自己 `path.resolve`。`json-file/` 里的绝对化是例外但合法——它的缓存键契约要求「label + 绝对路径」。
- **TLS 握手告警**：`bindTlsClientError` 属于建服骨架，在 `@/core/server/tls-alarm.js`，不在 `tls/`。
- **JSON 热加载的 logger**：`readJsonCached` 不依赖 logger（零日志）；事件呈现由调用方显式注入——runtime 用 `createJsonFileEventHandler(runtime.logger)` 造回调再传给 users/ACL 读取，`config/files/event-log.ts` 只接受 logger 参数。同理 `setupProcessGuards(logger, label?)`（已搬到 `@/server/process-guards.js`）由 `ProxyServer.start()` 传入当前 logger。

## 地址与文本（`ip.ts` / `host-text.ts`）

- `ip.ts` 只做**取值与轻度归一**：`getClientAddress`（XFF > X-Real-IP > Forwarded > socket）、`getAuthority`、`getSocketAddress`（统一 `"unknown"` 哨兵，让日志能区分「取不到」与「取到空值」）。**零配置依赖、零 IO、零日志**；不做自环判定、不做名单匹配、不解析 authority。
- `host-text.ts` 零项目依赖（不 import 任何模块，含 `node:*`），是字符级主机归一的唯一收口点。

## 引用规约

- 跨目录只引 barrel：`@/utils/{constants,logger,tls,json-file}/index.js`；目录内用相对路径；**禁止自引 barrel**（目录内部不得出现 `@/utils/xxx/index.js`）。
- `@/utils/ip.js`、`@/utils/host-text.js` 是单文件叶子，无 barrel。

## Gotchas

- 新增文件前先自问：**它属于基础设施吗？** 答案通常是「不属于」——带业务概念的（上游、名单、目标、生命周期、进程）都该去 core/config/server。
- 拆目录的模板照 `json-file/` 抄：单一 barrel、层内相对引用、判定面集中在一处、每个文件头写明「为什么不放这里」。
- 生成物不住在本目录：banner 在 `@/server/banner.js`，`scripts/gen-banner.mjs` 与 `build.mjs` 的输出路径必须同步改。
- 别在本目录写全局单例/全局 logger：日志一律显式注入当前实例，见 `logger/AGENTS.md`。
