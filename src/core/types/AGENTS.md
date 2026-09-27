# src/core/types — 端口与判别联合的唯一类型源

**只有三个文件，禁止新增第四个。** 端口形状是裁决，不是给你加维度的口袋。

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `proxy.ts` | **SSOT**：`ProxyOptions` / `ProxyStats` / 生命周期类型 / `ProxyForwardKind` / 三个端口 + 判定输入输出类型 / `PipeEvent` 判别联合 / 身份域类型 | 一切端口形状与判别联合改这里 |
| `identity.ts` | 身份域类型的**转发出口**（`IdentityRequestLike` / `IdentityContext` / `IdentityResult` / `IdentityProvider` / `IdentityOptions` / `AuthAccount` / `ProxyAuthEvent`） | 纯 `export type`，禁止独立声明 |
| `pipe.ts` | `PipeEvent` / `PipeEventSink` 的**转发出口** | 同上 |

`IdentityRequestLike` **超出端口六件套**也从 `identity.ts` 出去：它是 `IdentityContext.req` 的形状，调用方要手搓 `IdentityContext` 测试替身时必须能引到它，逼它去引总表 `proxy.js` 反而破坏本叶模块存在的意义。

**公共事件表 `AppEventMap` 不在这里**（住在 `core/events/types.ts`）——`types/` 下零 EventEmitter 事件表。

`proxy.ts` 对外三条 `import type` 出边（编译期擦除、零运行期依赖边）：`../log-events.js`（9 个 pipe 判别键的权威）、`@/core/context.js`（`ProxyOptions.ctx` 的落点）、`@/core/forward/upstream/connector/index.js`（`ProxyOptions.connectors` 的落点）。⚠️ **若将来要断言「`proxy.ts` 零入边」，必须记得 `connector/registry.ts` 是那条 type-only 边**——它引的是本文件的 `ProxyProtocol`，两侧都被擦除，esbuild bundle 内无环。

## 硬约定

- **判定输入一律只读入参对象、无位置参数**。`checkTarget` 有三个事实（host + user + 将来的更多维度），位置参数在下一次加维度时必须改所有调用点；入参对象加字段是纯增量。字段全 `readonly`。
- **`AccessControl` 是三个端口里唯一在 `ProxyOptions` 上必填的**：`identity` / `traffic` 的缺席读作**关闭一项功能**（不鉴权 / 不计费），各有语义明确的 inert 档；`access` 的缺席读作**取消防护**（全放行且零信号），方向相反，故走编译期强制。护栏 `tests/unit/access-control-port.test.ts` 有专门的三条源码级断言（`access:` 声明行不带 `?` / `base.ts` 零 `OPEN_ACCESS_CONTROL` / `runtime/services.ts` 仍解析默认实现）。
- **`AccessDecision.source` 是只在拒绝时写的可选字段**：放行恒为 `{allowed:true}` 不写键——「哪一层放的」对放行没有意义，写了还让「两关都过」与「上层不存在」无法区分。**不要**把分层信息塞进 `reason`（不许写 `"user:blacklist"` 之类），那是两个维度挤进一个字段，运维分不出该改 `acl.json` 还是 `users.json`。
- **不得新增假扩展点**：`IdentityOptions.extractor` 那类形状是被否决的同类（端口形状由 `AccessControl` 那样的裁决定，不由实现方便与否定）。
- **零 `getAll` / `set` / 全局配置状态**在 core 任何位置出现。

## 三个可插值端口

core 与四条入站通道**只认端口、永不自己造实现**。判据不是「core 内部用到了」，而是**库调用方能不能换掉它**：

| 端口 | 声明处 | 唯一内置实现 | 回答的问题 |
|---|---|---|---|
| `IdentityProvider` | `types/proxy.ts`（经 `types/identity.ts` 转发） | `identity/factory.ts:createIdentityFromConfig` + `identity/modes.ts` 四插件 | **你是谁** |
| `AccessControl` | `types/proxy.ts` | `access-control.ts:createFileAccessControl` | **你能访问哪里** |
| `ConnectorSource` | `forward/upstream/connector/types.ts` | `forward/upstream/connector/registry.ts:createConnectorSource` | **怎么到达 dest** |

`CoreServices` = core **内部归一后**的 `{ identity; access; traffic }` 三项全必填包。

**真正的默认实现只在唯一组装根 `runtime/services.ts:buildDefaultServices` 解析**（四项 = `identity` / `access` / `traffic` / `trafficLedger`），`createProxyRuntime` 解析一次并显式注入，故 core 侧那两个缺省档**永不生效**——它们只服务**直构 core** 的低层调用方。⚠️ `RuntimeServices`（`runtime/types.ts`，四项，库可覆盖）与 `CoreServices`（三项，core 内部归一后）**不是同一个东西**：后者刻意不含 `trafficLedger`——core 从不打开账本文件、也从不给它起定时器，塞进去等于向 core 承诺一件它不做的事。装配面见 `src/runtime/AGENTS.md`。

⚠️ **调用方显式注入 `services.access` 时 `acl.json` 整份不生效**（正当用法，但值得一条启动期告警 `acl-inert`）。判据、产出点与落盘行见 `src/runtime/AGENTS.md`，本目录不重述。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

> **判据被测试断言锁住的条目不在这里。** 那类决策住在**断言它的那条 `*.test.ts` 自己的开头条注释**里
> （判据变红时读到它的人就是该改它的人）。

1. **`CoreServices` 打包三个字段，不拆成 `ProxyOptions` 上的散装注入位** — 否掉「散装注入位」— 三条理由：
   - ① **可插值端口不止两个**——`identity` 与 `access` 各自都是（`connectors` 是第三个），而**判据是「改一处好过改四处」**：每加一个可插值服务，散装形态都要同时改 `ProxyOptions` 字段、`BaseProxy` 的归一表达式、`ForwarderBase` 的构造参数与四个子类的 `super(...)`、以及每处使用点的 `this.identity` / `this.services.identity` 选择；打包之后新增一项的改动面从「N 处字段 + N 处构造」降到「一处包成员 + 一处归一」。
   - ② **判据是「外部真的会注入替身」而不是「core 内部用到了」**——真 runtime + 真请求断言替身**真的被调用**（只查字段是 unit 档的活）。
   - ③ **生命周期差异正是打包的理由**——`identity`/`access` 是**纯判定**（无状态、随配置现读），`traffic` 是**进程级可变状态**（内存账本 + 落盘队列），三种不同的东西凑齐在同一个「core 需要什么」的清单里，打包才能把它们当作一个整体注入。
   - ⚠️ **但不要把它拆开**：`services.traffic` 仍可存字段（它是进程级服务、四个转发器共享同一实例），`services.identity` 与 `services.access` 仍每次现读（纯判定、每请求同一个引用，**都不缓存**）。**判据是「生命周期」，不是「存取方式」。**
   - ⚠️ **本条没有测试牙齿**：打包这件事由 `tests/unit/forwarder-request-path-allocation.test.ts` 顺带锁着（四个通道构造签名逐字等于 `(ctx, services, connectors)`——真拆成散装注入位那条会红），但**上面那三条理由、以及「按生命周期决定存取方式」那半条，一条断言都没有**。它们是设计取舍的推理链，代码不表达、测试抓不住，所以留在这里。
