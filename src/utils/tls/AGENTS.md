# src/utils/tls — 证书材料与 TLS 选项

跨目录只引 `@/utils/tls/index.js`；层内相对引用，**禁止自引 barrel**（目录内部不得出现 `@/utils/tls/index.js`）。本目录**零跨层依赖**（只 type-only 引用 `ConfigAccessor`，不 import 任何 core / server 模块）。

## 职责表

| 文件                | 只负责                                                             | 配置依赖 |
| ------------------- | ------------------------------------------------------------------ | -------- |
| `certs.ts`          | `TlsKeyCert`/`TlsInput`/`LoadedTlsCerts` + `loadCerts`（读不到必抛） | 无       |
| `server-options.ts` | `requiresClientCert` / `tlsServerOptions`（零 IO 纯拼装）           | 无       |
| `upstream.ts`       | `readUpstreamCa` / `upstreamTlsOptions`（出站建链）                | 必填     |

**入站与出站分家**：`certs.ts` + `server-options.ts` 是入站建服选项的唯一入口（HTTPS 与 TLS SOCKS 共用一份），`upstream.ts` 是出站建链选项的唯一入口。两者不要互相调用——入站的证书材料不参与出站校验，出站的 CA 也不参与入站握手。

## 路径绝对化：唯一权威在配置层

`tlsKey`/`tlsCert`/`tlsCa`/`upstreamCa` 在 `FIELDS` 里都标了 `path: true`，`resolveConfigPaths(config, configDir)` 已在**构造期**按 `configDir` 绝对化。

本模块**不再自己 `path.resolve`**（历史上的 `resolvePath` 以 cwd 为基准，与 configDir 语义分叉，且构成第二个权威，已删）；直接把入参路径交给 `readFileSync`/`statSync`——Node 自身仍按 cwd 解析相对路径，行为不变。

推论：**「证书路径相对谁」的唯一答案是「相对 configDir」**，且是在配置加载/构造时定下来的，不是读证书时定下来的。

## 语义要点

- **`loadCerts(tls, logger?, label?)` 的 logger 是内联结构类型** `{ error(msg: string, err?: unknown): void }`，刻意不引 `@/utils/logger`——本目录不该依赖日志实现。HTTPS 与 `TlsSocksProxy` 必须把当前 `this.log` 传进来。
- **`tlsCa` 是 mTLS 开关，不是「可选 CA」**：非空 ⇒ 一律置 `requestCert + rejectUnauthorized`，判定只走 `requiresClientCert`（不要在调用点另写一份 `ca !== ""` 判断）。**生效范围是 `https` 与 `sockss4`/`sockss5`**（即走 `TlsSocksProxy` 的 TLS 分支）——明文 `socks4`/`socks5` 走 `PlainSocksProxy`，根本不建 TLS 服，mTLS 开关对它们无意义。文件缺失/不可读 → `loadCerts` 抛错 → 启动 abort，**绝不静默降级为不校验**；默认空串。
- **`upstreamCa` 默认空串 = 用系统信任库**；一旦配置则**整体替换**系统库（不是追加）。读取走 `readUpstreamCa(config)`，非普通文件/不可读返回 `undefined`。公网 CA 上游留空，自签上游才填。
- **出站 TLS 三选项必须经 `upstreamTlsOptions`**：`servername`/`rejectUnauthorized`/`ca`。校验锚定**建链目标**（`config` 里的 `upstreamHost`）而非转发 Host 头；目标是 IP 时按 RFC6066 置空 SNI。

## 不属本目录的东西

- **握手失败告警**：`bindTlsClientError` 在 `@/core/server/tls-alarm.js`（建服骨架的一部分，与 `BaseProxy.closeServer` 同级；事件文本来自 `@/core/log-events.js`）。放这里会迫使 utils 反向依赖 core/server——历史上正是这么形成目录级环的。接线方：`core/server/https.ts` 的 `doStart` 与 TLS SOCKS 的 `onListenerReady`。
