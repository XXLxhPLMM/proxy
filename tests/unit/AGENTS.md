# tests/unit/

文件与路径说明（目录级说明见 `../AGENTS.md`）。

不起监听端口、不拨号，构造对象直接调的 `*.test.ts` 集合。

## 文件

- `access-control-port.test.ts` — AccessControl 端口与 `ProxyOptions.access` 必填性的单测。
- `acl-configured.test.ts` — `hasConfiguredAcl` 三组名单非空判定的单测。
- `acl-rule-host.test.ts` — 名单主机名规则（normalize / parse / match）的单测。
- `acl-rule-ip.test.ts` — 名单 IP 规则（normalize / parse / match / compile）的单测。
- `acl.test.ts` — acl.json 结构校验与访问控制判定语义的单测。
- `auth-users.test.ts` — users.json 账号表校验、读取与用户策略加载的单测。
- `base-lifecycle.test.ts` — BaseProxy 生命周期与配置访问器归一化的单测。
- `config-access.test.ts` — 无全局状态的实例读取端口单测。
- `config-instance.test.ts` — ConfigStore 实例化、变更通知与 loadConfig 显式加载的单测。
- `config-loader-import.test.ts` — 配置加载器 import 边界的单测。
- `config-loader.test.ts` — argv 归一、schema 字段解析与 loadConfig 的单测。
- `config-store.test.ts` — config/store 的单测。
- `connector-open.test.ts` — direct / http-connect / socks4 / socks5 连接器 `open()` 的单测。
- `connector-registry.test.ts` — 协议到连接器的映射与记忆化单测。
- `connector-transport.test.ts` — 连接器 `transport()` / `peerTarget()` 的单测。
- `core-context.test.ts` — core/runtime 依赖承载体与运行时 setter 的单测。
- `core-event-bridge.test.ts` — runtime/bridge 事件桥接、路由与清理的单测。
- `dead-optionality-cleared.test.ts` — 转发与守卫入口可选参数形态的源码级断言。
- `dialer-protocol-boundary.test.ts` — dial 传输层与连接器协议实现归属的源码级断言。
- `error-boundary.test.ts` — core/error-boundary 的分类真值表、脱敏、事件收尾，以及 `ErrorClassifier` 端口的替换生效性与「类体不许直调 `classifyError`」源码级护栏。
- `event-hub.test.ts` — core/events 的 EventHub 与 EventScope 单测。
- `forward-directory-layout.test.ts` — core/forward 两轴目录清单与依赖方向的源码级断言。
- `forwarder-request-path-allocation.test.ts` — 请求路径转发器构造次数的源码级断言。
- `guard-client-lifetime.test.ts` — guard 的 clientLifetime 档与 socksUpstreamGuard 参数单测。
- `identity-credential-seam.test.ts` — 身份插件 `isOwnCredential` 与出站头剥离的单测。
- `identity-snapshot-memo.test.ts` — 身份快照记忆化失效判据的单测。
- `identity.test.ts` — 身份提取器与 FileAccountIdentity 的单测。
- `inbound-dispatch.test.ts` — HTTP 入站派发表与 RequestScope 组装的单测。
- `ip.test.ts` — utils/ip 的单测。
- `json-file-log.test.ts` — config/json-file-log 事件呈现的单测。
- `json-file.test.ts` — utils/json-file `readJsonCached` 的单测。
- `library-entry.test.ts` — 包入口 `@/index.js` 导出面与 ProxyRuntime 用法的单测。
- `log-events.test.ts` — core/log-events 结构化事件的单测。
- `logger-port.test.ts` — utils/logger 可注入端口的单测。
- `logger.test.ts` — utils/logger 分级、结构化字段与配置绑定的单测。
- `no-external-network.test.ts` — 测试零外网依赖的源码级扫描断言。
- `pack-contents.test.ts` — `npm pack` tarball 清单与 `files` 白名单的断言。
- `pipe-event.test.ts` — PipeEvent 联合类型的契约单测。
- `preset.test.ts` — configuration presets 的单测。
- `proxy-helpers.test.ts` — core/proxy-helpers 与访问控制注入后的路由判定单测。
- `proxy-runtime.test.ts` — runtime/createProxyRuntime 的单测。
- `quota-config-fields.test.ts` — 每用户配额三个配置项的 FIELDS 契约单测。
- `request-terminal.test.ts` — core/request-terminal 的单测。
- `scope-ids.test.ts` — core/scope-ids 的单测。
- `self-loop.test.ts` — core/helpers/self-loop 通配监听与归一化的单测。
- `startup-preset.test.ts` — runtime/presets 与 assembly 优先级链的单测。
- `tls.test.ts` — utils/tls 的 `readUpstreamCa` 与 `loadCerts` mTLS 单测。
- `traffic-account.test.ts` — core/traffic 的 MemoryTrafficAccount 判定与计量单测。
- `traffic-ledger.test.ts` — core/traffic 落盘账本的布局、恢复与压缩单测。
- `traffic-window.test.ts` — core/traffic 窗口键与窗口滚动清账的单测。
- `user-acl-merge.test.ts` — 判定层与用户个人名单合流优先级的单测。
- `user-quota.test.ts` — 用户配额 window 与 loadUserQuota 的单测。

## 相关路径

- `../helpers/source-scan.ts` — 源码级断言的公共文本面（`codeOnly` 去注释、行号口径）。
- `../helpers/external-network-scan.ts` — 零外网扫描器与公网 host 白名单。
- `../helpers/config.ts` — `testConfigStore` / `restoreConfig` / `silenceLogs` / `KEYS` 快照表。
- `../AGENTS.md`、`../integration/`、`../library/`。
