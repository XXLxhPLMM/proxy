# tests/unit/

文件与路径说明（目录级说明见 `../AGENTS.md`）。

不起监听端口、不拨号，构造对象直接调的 `*.test.ts` 集合。
**唯一的例外是 `manager-http.test.ts`**（起在 `127.0.0.1` 的**随机端口** 0 上）—— 控制面 HTTP
契约里有三样东西只在真 socket 上存在（`writeHead` 之后再 `setHeader` 不生效、
`Content-Length` 与实际字节的一致性、销毁连接的时机），mock 掉 `node:http` 的档全部测不到，
而那恰好是「错误响应泄露了什么」这条边界的真实观测点。

## 文件

- `access-control-port.test.ts` — AccessControl 端口与 `ProxyOptions.access` 必填性的单测。
- `account-store.test.ts` — 账号表存储抽象层（json / sqlite 两后端等价性、驱动切换、CRUD 写族、源码级护栏）的单测。
- `admin-cli.test.ts` — `proxy-cli` 管理命令**传输层**：参数解析与三个退出码、**账号写族的字段保全**（`add` 撞名拒绝 / `set` / `disable` / `passwd` 逐字保留未指定字段）、**读面坏内容即拒**（不许把写坏的账号表当空表改写）、名单写与只读驱动报错、`--expires` 判据取自数据源层、两档后端等价、源码级护栏（不 import 代理侧 / 零 console / `argv: []`；**扫描范围由 `sourceFiles("admin","ops")` 现列，新增文件自动入扫描**）。
- `ops.test.ts` — 数据源**操作层** `src/ops/`：结构化返回值（不是渲染好的字符串）、`OpsError.code` 五档真值表、**幂等 no-op 断言的是底层 `write` 未被调用**、`applyPatch` 的字段保全与判据来源、`reportConfig` **一个文件都不造**、层边界源码级护栏（单向依赖 / `@/config` 出口白名单）。
- `acl-configured.test.ts` — `hasConfiguredAcl` 三组名单非空判定的单测。
- `acl-driver.test.ts` — 名单驱动注册表与 `ACL_DRIVER` 装配接线的单测（**自定义驱动的牙齿**：注册自定义驱动 → `ACL_DRIVER=<自定义名>` 真的被两个装配点各用一次；含三次变异实测）。
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
- `addr-inbound.test.ts` — utils/addr/inbound 的单测（入站对端地址与 authority 取值）。
- `json-file-log.test.ts` — `utils/json-file` 四态事件呈现的单测。
- `json-file.test.ts` — utils/json-file `readJsonCached` 的单测。
- `library-entry.test.ts` — 包入口 `@/index.js` 导出面与 ProxyRuntime 用法的单测。
- `log-events.test.ts` — core/log-events 结构化事件的单测。
- `usage-drivers.test.ts` — 账本驱动抽象的单测：两个内置后端的等价性、**驱动注册表（含自定义驱动与未注册即抛错的牙齿）**、镜像的误差上界、各自机制边界。
- `logger-port.test.ts` — utils/logger 可注入端口的单测。
- `logger.test.ts` — utils/logger 分级、结构化字段与配置绑定的单测。
- `manager-config.test.ts` — 管理面（控制面）四配置项的单测：字段契约与全 startup 相位、端口撞车 abort（不看 enabled）、空 token abort、越界 abort、启动快照脱敏（明文一个字都不许落盘）、未知键闸门认得 `MANAGER_*`。
- `manager-http.test.ts` — 控制面 HTTP 面（`src/manager/{http,routes}/`）的单测：**真 `http.createServer` 起在端口 0**（不 mock `node:http`，因为 `writeHead` 后 `setHeader` 不生效 / `Content-Length` / 销毁连接的时机这三样只有真 socket 看得见）。覆盖鉴权真值表（7 个方法 × 无/错/对 token，外加空 token 的服务恒 401）、404 与 405 的区分、路径穿越（`%2e%2e%2f` 与 `../` 在路由层不可区分）、body 上限、`OpsError.code` → 状态码五档真值表（含「code 缺失 / 表外时**不许**猜 message 文本」）、响应与落盘日志的零泄露（栈 / token / 内部路径）、`changed:false` 的幂等 no-op 是 200、账号 add 撞名 409（且不覆盖）、只读名单驱动 501、**`/api/status` 的数据面状态是现读的真值**（改判据后下一次请求即变；master 模式报 `mode:"master"` + `running:false` 而非谎报在监听）、**没有 `POST /api/restart` 且 routes/ 里不留任何 restart 残留**，以及覆盖 `http/` + `routes/` 两目录的源码级护栏（零 console / 零 `process.*` / 不 import `@/admin/*` / 零 `child_process` / 零 `cluster` / 数据面经 `@/ops`；**变异实测**）。
- `manager-tui-contract.test.ts` — **控制面 ↔ `@b-hole/proxy-tui` 端点表互锁**：两侧 `(method, path)` **分别从源码文本现取**再比集合（**不从任何一侧 import** —— 跨包 import 会抹掉「网络两端版本可以不同」这个现实，契约因此是**手抄的、有测试兜着的弱耦合**）。同一个探测器喂两侧（两套解析器 = 两份会各自漂的判据）；配对窗口吃格式化换行但**不许跨过下一个 `method:`**（否则两条端点错配成一对、条数对而方法名错、无人能看出）。防假绿两档：**两侧各自目录现列的文件数**（`src/manager/routes/` 与 `packages/tui/src/api/endpoints/`，**不手写文件名清单** —— 漏列新文件的后果是两侧都少判一条而集合照样「相等」）+ 两侧取到的条数各一条下界（**「两侧都空 ⇒ 集合天然相等」是这套判据天生的死法**），再加一节判据自检（3 条合成脏文本真的被抠出 / 跨行不是死代码 / 缺 `path` 不与后一条乱配 / 注释里的假端点表被 `codeOnly` 剥掉 / 空文本取零条）。字段形状归 `packages/tui/src/api/wire.ts` 的 `WireContractAssertions`（编译期）管，两道牙互不代替。
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
- `manager-config.test.ts` — 管理面（控制面）四配置项的单测：字段契约与全 startup 相位、端口撞车 abort（不看 enabled）、空 token abort、越界 abort、启动快照脱敏（明文一个字都不许落盘）、未知键闸门认得 `MANAGER_*`。
- `tls.test.ts` — utils/tls 的 `readUpstreamCa` 与 `loadCerts` mTLS 单测。
- `traffic-account.test.ts` — `@/datasource/quota` 的 `UsageMirror` 判定与计量单测（含 core 的计量落点被动计数护栏）。
- `usage-source.test.ts` — sqlite 档用量数据源的布局、回读、恢复与压缩单测（含「数据源层零代理/配置依赖」源码断言）。
- `traffic-window.test.ts` — 窗口键与窗口滚动清账的单测。
- `user-acl-merge.test.ts` — 判定层与用户个人名单合流优先级的单测。
- `user-quota.test.ts` — 用户配额 window 与 loadUserQuota 的单测。
- `config-unknown-keys.test.ts` — 未知配置键闸门的单测（argv 与 `.env` 文件里的未知键必须让启动失败，`process.env` 里的不失败；含三条容忍键的正向存在性）。
- `runtime-floor.test.ts` — Node 运行时地板防漂移护栏（全仓每一处地板声明必须等于 `engines.node`；含判据自检与「sqlite 两个边界并存」的正向存在性）。文本面在 `../helpers/runtime-floor-scan.ts`。
- `zip-contents.test.ts` — `build:pkg` 五个 zip 的内容护栏（清单零命中 + `.env.example` 四个驱动键在位 + cfg 空骨架；产物缺失时显式降级并打出覆盖面）。与 `pack-contents.test.ts` 是两条**不同**通道，后者的 `files` 白名单看不见 zip。

## 相关路径

- `../helpers/source-scan.ts` — 源码级断言的公共文本面（`codeOnly` 去注释、行号口径）。
- `../helpers/external-network-scan.ts` — 零外网扫描器与公网 host 白名单。
- `../helpers/config.ts` — `testConfigStore` / `restoreConfig` / `silenceLogs` / `KEYS` 快照表。
- `../AGENTS.md`、`../integration/`、`../library/`。
