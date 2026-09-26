# src/plugins — 插件契约与默认实现

「万物为插件」这一层是**可替换性的唯一来源**。能力域的 API 形状（契约）住 `contracts.ts`，
内置实现住同目录的 `routing-provider.ts` / `auth-providers.ts` / `forwarders.ts`；
入站协议的注册表在 `core/server/protocols.ts`（协议插件要造内核，依赖方向决定了它留在 core）。

```
contracts.ts          全部 *Provider 接口 + PluginRegistry + createPluginRegistry
├── routing-provider.ts   RoutingProvider 默认实现（读 scope + acl，产出 ForwardPlan）
├── auth-providers.ts     AuthProvider 工厂注册表（none/basic/jwt/uid，值为工厂非实例）
├── forwarders.ts         ForwarderProvider 注册表（direct-stream/http-upstream/socks-upstream）
core/server/protocols.ts ProtocolProvider 注册表（http/https/socks4/5/sockss4/5）
```

## 依赖方向

- **`contracts.ts` 只依赖 `config/` `core/` `utils/` 的类型**（`import type` 全部）+ 一个
  纯运行时实现 `createPluginRegistry`。它**不 import 任何 provider 实现**，否则「契约依赖实现」
  就成了新的循环，接不上自定义替换。
- **各 provider 只依赖 `contracts.ts` + 自己那一层**：`routing-provider.ts` 读
  `ConfigScope` 与 `AccessControlProvider`，`auth-providers.ts` 读账号表快照与 JWT 密钥，
  `forwarders.ts` 只消费 `ForwardPlan`（**一个配置项都不读**）。
- **provider 之间不互相 import**。唯一的接缝是 `core/types/plan.ts` 的 `ForwardPlan`/`RoutingInput`
  —— 路由插件产出计划、传输插件消费计划，两者不认识彼此。
- **禁止反向依赖 `server/`、`cli.ts`**（`src/runtime/` 已随 Cordis 一起删除，没有这条依赖了）。
  插件是内核的依赖方，不是内核的依赖者。
- **组合根在 `src/instance.ts`**：它是唯一装配注册表并选实现的地方（`plugins?` 是覆盖点）。
  `src/server/index.ts` 只经注入的注册表 `require()`，自己不建实现。

## 四条硬约束

1. **注册表是唯一的可替换性来源。** 禁止再出现「按枚举 switch 建实例」
   （原 `core/server/factory.ts` 的六路 switch，已删）或「类字段里 `new` 死实现」
   （原 `forward/*.ts` 的 `new XxxForwarder(sink)`）——那两处正是「加一种能力要改核心源码」的病根。
   新增第 7 种协议 = 实现 `ProtocolProvider` + 往注册表加一项，**不改任何既有文件**。
2. **Provider 不许读全局。** 所有配置经 `ConfigScope` 显式注入，所有本实例事实经构造参数注入。
   曾经的 `utils/log/level.ts` 无参调 `currentLevel()`、`proxy-helpers.isSelfLoop()` 内部
   `get("host")` 都是这条的反例。**`src/config/store.ts` 已删除**，想读配置先问「我这个 scope 是谁给的」。
3. **注册表不承载生命周期。** 资源创建/清理由 `ProxyServer` 的 cleanup ownership
   （`ConnRegistry`/`DisposalTracker`/process guards 的 lease）负责，注册表只是不可变查找表
   ——这样同一份注册表可以被多个实例共享而互不干扰。`PluginRegistry` 因此只有
   `get`/`require`/`has`/`keys` 四个纯查询方法，**没有** `dispose`/`onUnload` 之类回调。
4. **加载顺序由依赖关系表达**（`src/instance.ts` 的装配顺序即拓扑序：
   `ConfigScope → LoggerProvider → AccessControlProvider → UsageProvider → RoutingProvider →
   ForwarderRegistry → AuthRegistry → ProtocolRegistry → ProxyCore`），不靠注册顺序或
   字符串比较猜测。加新插件时**顺着依赖图插位置**，不要在注册表里追加。

## 键 → 实现对照表

| 能力域 | 契约 | 注册表键 | 默认实现 |
| --- | --- | --- | --- |
| 配置 | `ConfigProvider` | 无（实例唯一） | `initConfig` 产出的 `ConfigScope` |
| 日志 | `LoggerProvider` | 无（实例唯一） | `createInstanceLoggerProvider`（`utils/log/logger.ts`） |
| 访问控制 | `AccessControlProvider` | 无（实例唯一） | `acl.json` **与账号内联名单两道串联**（`instance.ts:createAccessControlProvider` + `config/resources/acl/resolve.ts`） |
| 流量配额 | `UsageProvider` | 无（实例唯一） | `createMemoryUsageProvider`（`usage-store.ts`，**进程内计量**） |
| 路由 | `RoutingProvider` | 无（实例唯一） | `createRoutingProvider`（`routing-provider.ts`） |
| 传输 | `ForwarderProvider` | `ForwardTransport`：`direct-stream` / `http-upstream` / `socks-upstream` | `createForwarderRegistry` |
| 鉴权 | `AuthProvider` | `AuthKind`：`none` / `basic` / `uid` / `jwt` | `createAuthProviderRegistry`（值为**工厂**） |
| 入站协议 | `ProtocolProvider` | `ProxyProtocol`：`http` / `https` / `socks4` / `socks5` / `sockss4` / `sockss5` | `createProtocolRegistry`（`core/server/protocols.ts`） |
| 集群 | `ClusterProvider` | 无（CLI 边界） | Node cluster 编排（`server/cluster.ts`） |


## 实现约定

- `require(key)` 在**装配期**抛错（fail-fast），`get(key)` 返回 `undefined`。请求路径上只允许
  `require`：静默回落默认值会把「配置写了不存在的协议」变成难查的运行时行为。
  未知配置字段同理（`phaseOf()` 对未知 key 抛错，不返回 `undefined`）。
- **鉴权注册表里存的是工厂（`AuthProviderFactory`）而不是已配置实例**。鉴权实现是唯一
  **必须持有配置**（账号表 / JWT 密钥）的能力，而配置是实例级的：注册表保持无状态、
  可被任意多个实例共享，每个实例用自己的 scope 调工厂产出自己的实现。
  空账号表在**组合根与 loader 两处**都 fail-fast（`assertAuthConfig` + `selectAuthProvider`），
  否则等于静默全放行/全拒绝。
- `RoutingProvider.plan(input)` 输出**自包含**的 `ForwardPlan` 或 `RoutingOutcome` 的拒绝分支；
  它**不碰 socket、不碰字节流**，只做判定。判定顺序（路由 → 自环 → 目标名单）是安全边界，
  不可调换：自环 → 502、名单 → 403，两者的状态码语义不同，合并是一次真实的行为回归。
- **路由插件是唯一把配置投影成计划的地方**，因此「某个配置字段怎么影响转发」的语义也只该在这里
  出现一次。目前只有一条这样的投影规则：**上游 TLS 承载 = `upstreamSecure` 显式配置 OR
  `isTlsUpstreamProto(upstreamProtocol)` 推导**（`secureForUpstream`）。两个来源缺一不可——
  只读显式配置会让「只配 `UPSTREAM_PROTOCOL=sockss5`、不碰 `UPSTREAM_SECURE`」的正常拆项配置
  被静默降级成明文（往 TLS 端口发明文 SOCKS 握手，无任何报错）；只留推导则 `UPSTREAM_SECURE=true`
  配 `http` 协议会被无视。传输策略侧只读 `plan.upstream.secure` 决定 `net.connect` / `tls.connect`，
  **不得**再回头查 `upstreamProtocol` 自己推导一遍——同一事实只允许有一个来源。
- `ForwarderProvider` 不认协议（应答经 `ctx.responder`，由入站协议插件注入），因此同一个策略
  实现可同时服务 http/tunnel/upgrade/socks 四种入站。
- **访问控制与流量配额是两个不同能力域，不得合并**：`AccessControlProvider` 是**无状态纯判定**（同输入恒同输出），`UsageProvider` **必须跨请求累计**。把累计状态塞进访问控制会让那三个判定方法不再是纯判定，也没法替换存储实现。依赖图里两者都只依赖「文件路径 + 身份」，无先后；实现分别在 `config/resources/acl/resolve.ts` 与 `plugins/usage-store.ts`。
- **`UsageProvider` 的三条诚实性边界**（写在实现里，不只写文档）：**不持久化**（重启归零）、**不跨进程**（cluster 多 worker**各算各的**，不是全局 N 倍额度）、**不抱进行中的传输**（只拒绝**新**请求）。要真全局额度就换一种实现（不是给契约加字段）。
- `AuthProvider.authenticate()` 内部异常一律转 deny，**不得把异常抛给数据面**；审计经
  `ctx.onAuthEvent` 上抛，插件自身零日志。

## 与公共库边界的关系

这些契约是**公共 API 的一部分**（`src/index.ts` 逐项导出，门禁
`LIBRARY_BOUNDARY_PUBLIC_EXPORTS` 强制双向一致），因此 `contracts.ts` 与 `core/types/plan.ts`
**不得 import `cordis`、不得 import `src/server/`、不得 import `src/cli.ts`**。
项目已经**零 ESM 依赖**（cordis 与 `src/runtime/` 已删除），门禁里的 cordis / `runtime` 断言是
防复活守卫——把 cordis 悄悄加回插件层会同时破坏 CJS 库边界和这条依赖方向规则。
默认实现工厂同样公共（想复用内置实现而不自己写插件时用）。
改契约 = 改公共 API，按根 `AGENTS.md` 的破坏性变更政策走，别加兼容层。
