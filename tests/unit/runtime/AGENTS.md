# tests/unit/runtime/ — `src/runtime/` 的运行时门面与依赖承载体

本目录只答一件事：**库调用方拿到 `createProxyRuntime(...)` 之后，那一堆装配决策与依赖从哪儿来、
怎么活、怎么停**。机制与层不变量归 `src/runtime/AGENTS.md` 与各源文件头；这里是**这一层的判据**。
⚠️ **档与档之间的主题级不变量住在这份文件里**，单档文件头只留「这一档管哪一段 + 指向本文件」。

## 地图

- `create.test.ts` — **构造期**：零副作用、配置实例彼此隔离、`isEnabled` 口径、总线隔离、缺省
  logger、协议选择与非法协议的**构造期**失败。
- `lifecycle.test.ts` — **启停**：`start`/`stop` 幂等与派生事件、启动失败只上报不退出宿主、
  服务注入优先于缺省装配、观察者抛错不穿透生命周期、每轮 `start` 重建 / 每轮 `stop` 释放订阅。
- `context.test.ts` — **live store 与热改**：加载后的 context 与 runtime 共享 store 而 startup
  字段只要求重启、三个配额项按相位分流、终态 publisher 注册表按 accessor 隔离、
  `options`/`services`/`accessor` 冻结而 `store` 可变、名单热加载的公共事件面。
- `upstream-url.test.ts` — **配置值怎么落到 core 上**：`UPSTREAM_URL` 构造期拆解、热改启动 URL
  后新旧 runtime 的冻结/共享、`configDir` 捕获一次、`config.loaded` 来源优先级、归一化 warning。
- `assembly.test.ts` — **`assembly` 优先级链**：显式 `options` > `assembly` > 配置/缺省；
  `services` 逐字段合并、`connectors` 工厂、`protocol` 让 assembly 赢；覆盖**不豁免**配置校验。
- `presets.test.ts` — `src/runtime/presets.ts` 的**全部公开面**（选预设 / 注册表 / 零 `process.env`）
  **加** `@/config/presets.ts` 的配置值预设。
- `services.test.ts` — `runtime/context.ts` 的依赖持有者与 `core/context.ts` 的承载体接口
  （三个 `protected` getter ↔ 三个 `public` setter 是同一份可写面的两头）。
- `_proxy-runtime.ts` — 档间共用（不带 `.test.ts`，不会被 vitest 收集）：`own` / `processSnapshot` /
  `stopOwnedRuntimes`。
- `bridge/` — 事件桥接那一半，三档 + 一个共用模块，见 `bridge/AGENTS.md`。

⚠️ **`presets.test.ts` 有两个形状不同的 `processSnapshot`**：档内那份带 `cwd`（库入口那一档要断言
工作目录也不变），`./_proxy-runtime.ts` 那份不带（runtime 各档不查 cwd）。**不是重复**，是两个观测面。

## 锁什么

① **生命周期事件的唯一来源 + 派生顺序** — `lifecycle.changed` 由 core 发（`BaseProxy.setState`），
   runtime 是**观察方**、只从中派生 `runtime.starting` / `started` / `stopping` / `stopped`。
   被否掉的是「core 与 runtime 各发一遍」：同时发布会重复（一次 `start()` 两条 `runtime.started`，
   落盘面多出一行）。**顺序**也是契约的一部分 —— 必须是「`lifecycle.changed` 先、派生出的
   `runtime.*` 后」，反过来就意味着 runtime 在「自己宣布」状态跃迁。
   牙齿（`lifecycle.test.ts`）：整条时间线**逐项** `toEqual` 那八元素名单；`4 次跃迁 → 4 + 4` 两条
   `toHaveLength`；停机后人为 `publish("lifecycle.changed", …)` 不得派生任何 `runtime.*`；
   停机后同端口可重绑（`listen`/`close` 两行）。

② ⚠️ **`stopped` 跃迁仍能发出 `runtime.stopped`** — 靠「`await proxy.stop()` 落地时（内部 `doStop`
   之后才 `setState`）事件已 publish 完、订阅尚未摘除」。**这条不是巧合而是次序契约**：上面那份
   八元素名单的最后两项同时是它的牙齿。推论：**「停机后再补发一条派生事件」是错的** ——
   那等于承认订阅可以在事实之后才到。

③ ⚠️ **只有 runtime **自建**的 `EventHub` 才在最后 `removeAll()`；外部 `events` 归调用方所有** ——
   否掉「一律 `removeAll()` 收尾」：总线可能属于宿主，连带清掉别人的订阅就是越权。
   牙齿：停机后 `events.listenerCount()` 回到宿主自己那 5 条、`hostSubscription.disposed === false`、
   两轮 `start` 之后订阅总数回到第一轮停机时的水位。
   ⚠️ 这条**跨目录**：`bridge/lifecycle.test.ts` 的「`stop()` 不清外部 hub」是同一不变量的另一半。

④ **每次后续 `start()` 都重新建立全套**（bridge / `lifecycle.changed` / store / 名单文件订阅）。
   牙齿：`listenerCount("lifecycle.changed") === 基线 + RUNTIME_LIFECYCLE_SUBSCRIPTIONS` 在**两轮**
   `start` 之后都成立；`stop-before-start` 后首次 `start` 仍恢复完整链路是同一裁决的独立一档。
   ⚠️ **`lifecycle.changed` 上 runtime 自己恒为两条**（① `runtime.*` 派生、② `[lifecycle] state …`
   落盘）；用例没传 `logger`、走 `createNoopLogger()` 缺省档时**绑定照样装** ——「logger 是 noop」
   关的是 IO，不是订阅。⚠️ **退订闭包必须自带归属**（靠闭包持有自己的 hub 记录，对另一个 hub 调用
   等于静默空操作）—— 那条在 `tests/integration/runtime/request-terminal-events.test.ts`。

⑤ **零 `process.env` / 零 `process.argv`**（`presets.ts` 与 `runtime.ts` **两处**都不许读）——
   env 的影响**全部**收敛在 `loadConfig`（它把校验后的值一次 merge 进 `ConfigStore`）；库层再读一次
   就是「协议由两处决定」的第二真相源，形态是容器里 `PROXY_PROTOCOL=socks5` 起服务、库代码里
   `pickStartupPreset(context)` 又读到宿主 env 的另一个值 ——「配置里写的协议」与「实际跑的协议」
   不一致，**且没有任何日志或事件能解释这个差异**。`upstreamProtocol` 那次已经付过学费（记忆化的
   `ConnectorSource` 一旦读到热改后的第二个值就成第二真相源）。
   ⚠️ `runtime/services.ts` 的 `usageSource` 接线是**显式形参**（CLI 的 env 快照一路传下来），
   属于「槽位必须显式传进来」，**不属于**「库层自己读宿主 env」。
   牙齿（`presets.test.ts`，源码级三条）：`offendingLines(code, /process\s*\.\s*env/)` 为空 +
   `pickStartupPreset` 那个函数体只含 `context.accessor.get("proxyProtocol")` +
   `runtime.ts` 零 env 且含 `protocolFor(config)`。

⑥ **`pickStartupPreset`：未注册名字 fail-closed，不给名字按 `proxyProtocol` 合成** ——
   静默回落是最坏的失败形态（点名 `"sockss5"` 拼成 `"socks5s"`，服务起来了但跑的是配置里那个协议 =
   **「配错了、没报错、还起来了」**）。⚠️ **非法协议值在这一步刻意不 throw**（`ConfigStore` 零校验，
   库路径能把 `"ftp"` 塞进来）：合成出的那份**不带 `protocol`**，错误让给 `protocolFor` 报**同一条**
   消息 —— 同一个错误信息在两处各写一份是最容易漂移的那种重复。
   ⚠️ 内置只有 6 个协议预设、每个**只**声明 `protocol` + `description`：六个协议 × N 种服务 × M 种
   进程策略的笛卡尔积只会得到一份**没人维护的菜单**；要组合就直接
   `registerStartupPreset({ name, protocol, services })` 三行代码的事。

⑦ **`assembly` 三条纪律** — ① **`services` 逐字段合并**而不是整体替换（四项服务彼此正交；整体替换
   会让「显式注入某一项」与「预设声明其余项」无法同时成立）；② `protocol` / `connectors` 让
   `assembly` **覆盖**配置（程序化决策天然比声明式具体）；③ **`assembly.connectors` 是工厂
   `(ctx) => ConnectorSource`，`options.connectors` 是实例** —— 两处形状不同**不是不一致**，
   别「顺手统一」（`ctx` 只有装配期才存在，预设要能「声明意图」而不绑死某次运行的依赖三件套）。

⑧ **`assembly.protocol` 覆盖不豁免校验** — 覆盖只改变**用哪个值**，不改变**是否校验**。
   牙齿（`assembly.test.ts`）：「`ftp` + `assembly.protocol: "http"` → 仍然抛」+ 两条对照组
   + **次序**那条源码级断言（`atValidate < atPick`）。把两行对调，功能面看不出差别，但非法配置就会从
   「启动报错」变成「静默用覆盖值跑起来」。

⑨ **`ConfigStore` 零校验 → 非法枚举的**两个**出口**（两端各自有断言）** ——
   被否掉的是「让 `ConfigStore` 跑 FIELDS 校验」：`ConfigStore` 是**纯存储**，跑校验就得把「存」与「验」
   耦在一起。① **入站协议在构造期抛**（`runtime.ts:protocolFor`，本目录 `assembly.test.ts`）；
   ② **上游协议在请求期抛**（`tests/integration/upstream/` 的 fail-closed 那档）。
   ⚠️ **别把「① 已经启动才报」误读成「② 也可以前移」** —— 前移会让 `forward.error` 那条安全事实
   消失（静默降级直连 = 流量旁路）。两个出口**不是同一个决策的两半**。

⑩ ⚠️ **`runtime/context.ts` 三个 setter 为何在 `src/` 内零调用方** —— 那**不是死代码**：
   `ProxyRuntimeImpl` 把 `RuntimeContext` 经 `services` / `ProxyOptions.ctx` 暴露给库调用方，而这三个
   setter 是库调用方**唯一**能在运行期热换配置 / 日志器 / 事件总线的入口。删掉它们 = 库调用方失去这个
   能力，而本仓测试**一条都不会红**（没有调用方就没有覆盖）。
   ⚠️ **代价必须写下来**：`core/server/base.ts` 那两条「**绝不允许**把 `events` 缓存成字段」的强纪律，
   其论证前提正是「`RuntimeContext.setEvents()` 能在运行期换总线」——**而在本仓内部这件事永不发生**
   （`src/` 零调用方）⇒ 那条纪律在本仓**是靠源码注释与源码级断言维持的，不是靠运行时压力**：谁把
   `this.events` 缓存成字段，全仓测试仍然全绿。这是一条**无运行时保障的纪律**，如实写出比再加一条
   测试更重要。`services.test.ts` 能做的是**守住接口的可见性**（别把公开面改成 `private`/
   `protected`，那样库调用方在编译期就断了，而那至少是**响亮的**失败）；它**不能**证明有人真的在用它。

## 账本目录：本目录每一条 `start()` 的账都不许落在仓库里

⚠️ **这是本目录最容易回归的一条纪律，且回归形态是「静默写进仓库」。** 三条机制合起来才是完整那句话：
① **库模式不经 `loadConfig`**（`createProxyRuntime({ config: <内联对象> })` 走 `new ConfigStore(内联)`，
   一个与 `testConfigStore` 毫无关系的新实例）⇒ `tests/setup-env.ts` 钉的 `QUOTA_USAGE_DIR` env 与
   `set("quotaUsageDir", …)` **两侧全落空**；`loadConfig({ env: <显式对象> })` 同样落空（`env` 是显式
   入参、缺省为空，`store` 也是另建的一个）；② `configDir` 缺省 = `process.cwd()`（= 仓库根）且
   `quotaUsageDir` 的 FIELDS 缺省是相对路径 `cfg/usage`；③ **账本的 `open()` 在 `start()` 里就跑，
   与是否真计量无关**（配额为零也照建）⇒ 于是一条字节都没传的用例照样在仓库里留下
   `cfg/usage/usage.jsonl`。
⇒ **凡是会 `start()` 的用例必须逐处显式给 `quotaUsageDir`（或给仓库外的 `configDir`）**；
本目录的做法是每档一个 `LEDGER_DIR = path.join(os.tmpdir(), "<档名>-usage")`。
⚠️ **`start()` 在 `try/finally` 或 `afterEach` 之前跑过就晚了** —— `stop()` 不删那个文件。
基准档在 `tests/integration/quota/` 与 `tests/integration/runtime/custom-services-wiring.test.ts`。

## 文件（⚠️ 不变量编号 ↔ 位置对照）

| 档 | 承载的不变量 |
|---|---|
| `create.test.ts` | 构造期零副作用、配置实例隔离、`isEnabled` 口径、总线隔离、缺省 logger、协议选择与构造期失败 |
| `lifecycle.test.ts` | ①②③④ + 服务注入优先于缺省装配、观察者抛错不穿透生命周期 |
| `context.test.ts` | ④ 的订阅计数那一半、配额三项按相位分流、publisher 注册表按 accessor 隔离、冻结视图、名单热加载事件面 |
| `upstream-url.test.ts` | 配置值 → core 的拆解、`configDir` 捕获一次、来源优先级、归一化 warning |
| `assembly.test.ts` | ⑦⑧⑨ + preset 覆盖与零副作用 |
| `presets.test.ts` | ⑤⑥ + `@/config/presets.ts` 的注册表与合并顺序 |
| `services.test.ts` | ⑩ + 依赖三件套的交换语义（幂等 / 观察者抛错 / 发布通道抛错 / 只换引用） |
| `_proxy-runtime.ts` | 档间共用的 `own` / `processSnapshot` / `stopOwnedRuntimes` |

## 防假绿的位置

- ① 的判据钉在「整条时间线**逐项** `toEqual`」+ 两条计数上，而不是「某一条出现过」：只判「出现过
  `runtime.started`」的实现（少发一次、顺序错乱）会绿。
- ①③ 的正向对照都在：真 `publish` 一条 `lifecycle.changed` 证明派生订阅确实在（否则「零派生」与
  「订阅已摘」是同一种形状）；停机后重新 `listen` 同一端口证明订阅真的摘干净了。
- ⑤ 的探测器（`codeOnly` + `offendingLines`）认不出那个词时会在**空集**上通过 ⇒ 配了
  「`pickStartupPreset` 只消费已落进 store 的值」那条**正向存在性**断言（源码里真有那一行）。
- ⑩ 的「三个 setter 是 public」那条**只能是编译期**的（vitest 走 esbuild，类型全被擦除）⇒ 刻意不带
  `@ts-expect-error`；它与「三个 getter 保持 protected」那条恰好互为镜像（一侧证明外部取不到、
  一侧证明外部取得到），拆开任一侧那对镜像就少一半。
- ⚠️ **`assembly.test.ts`「两侧都没有时走 `createConnectorSource(ctx)` 缺省」那一档的三半判据** ——
  「缺省来源整个生命周期只造一次」这条不变量由三半拼起来判，**任何单独一半都是空的**：
  ① `connectors.upstream()` 两次调用**返回同一实例**（摘掉 `registry.ts` 那个 `upstream ??=` 记忆，
  两次就是两个连接器）；② 那个实例的 `kind` 是 `"http"` —— 证明它真的是**按 `ctx.config` 的
  `upstreamProtocol` 查那张缺省表**造出来的，而不是某个什么都能给的空壳门面（摘掉查表就红）；
  ③ 先 `store.set("upstreamProtocol", "socks5")` 热改，再断言 `upstream().kind` **仍是 `"http"`** ——
  那份记忆是**构造期快照**，热改带不走它（带走了就成了「协议由两处决定」的第二真相源）。
  ⚠️ ③ 前面那条 `store.get("upstreamProtocol") === "socks5"` 的正向对照是它的前提：没有它，③
  分不清「记忆抗住了热改」与「热改根本没落进 store」。
  ⚠️ **变异实测**：把 ① 改成 `.not.toBe`、或把 ③ 的期望值改成 `.toBe("socks5")`，两处各自立刻红 ——
  这条判据的牙齿在「同一实例」与「记忆的值」上，不在「`options.connectors` 被读过」上（后者恒真：
  同一个冻结属性读两次必然相等）。
  ⚠️ **分层理由**：`../core/forward/upstream/registry.test.ts` 那档已直接调
  `createConnectorSource(testContext)` 锁过同一组记忆化语义；**本档独有的是「经 runtime 观测」这一层**
  —— 直接调工厂看不到组装根，也就看不到「缺省解析被算完并**冻进** `runtime.options`」这件事。

## 相关路径

- `src/runtime/index.ts`（`createProxyRuntime`）、`src/runtime/context.ts`（`RuntimeContext`）、
  `src/runtime/presets.ts`（`StartupPreset` / `pickStartupPreset`）、`src/runtime/bridge.ts`、
  `src/runtime/services.ts`、`src/core/context.ts`（`ContextualBase` / `CoreContext`）。
- `../../helpers/config.ts`（`testContext` / `get`）、`../../helpers/net.js`（`getFreePort` / `sleep`）、
  `../../helpers/source-scan.ts`（`codeOnly` / `offendingLines` / `sourceOf`）。
- `../AGENTS.md`（`tests/` 层）、`../../../tests/setup-env.ts`（账本钉值的由来与其失效边界）。
- `bridge/AGENTS.md` — 事件桥接那一半。