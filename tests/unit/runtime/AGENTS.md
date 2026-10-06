# tests/unit/runtime/ — `src/runtime/` 的运行时门面与依赖承载体

本目录只答一件事：**库调用方拿到 `createProxyRuntime(...)` 之后，那一堆装配决策与依赖从哪儿来、
怎么活、怎么停**。这里是**这一层的判据**。

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
  三半拼起来判，**任何单独一半都是空的**：
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
