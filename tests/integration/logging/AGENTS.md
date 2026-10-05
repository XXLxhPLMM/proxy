# tests/integration/logging/ — 事件 → 落盘绑定这一圈

`bindProxyEventLogs` / `bindLifecycleLog` 两族的判据。机制与层不变量归 `src/runtime/event-log.ts`
与 `src/runtime/AGENTS.md`；本文件只答「这几档哪几处不许漂」。

## 一件必须先说的事：两族住在**同一层**

`[lifecycle] state …` 那一族的落盘绑定与 `bindProxyEventLogs` 住在**同一层**
（`src/runtime/event-log.ts`，由 `createProxyRuntime` 装配），两族判据逐条同源：零 `process` 触点 /
落盘不拥有进程 / 同一轮 `activateSubscriptions` + `releaseSubscriptions` 装配与退订。
⚠️ 按层分开就会变成凭直觉做错事的起点 —— **文本契约约束的是那几行逐字不变，不是「它住哪一层」**。

由这一条派生两条档间分工：

- **库调用方能落盘**：绑定在 runtime 层，`createProxyRuntime()` 一条路就有，**没有任何前置条件**。
  挂到「拥有进程」那一层（`ProxyServer`）只会让嵌入方只剩两条烂路：① 接受没有落盘日志；
  ② 自己重写那 11 个订阅，还要自己记得在 stop 时退订，漏了就泄漏监听器。
- **CLI 与库是同一份绑定**：`event-binding-source` 的 ⑦ 与 `lifecycle-binding-rows` 的 ③ 各钉一次，
  两处互为对照。

## 本目录锁住的三条装配裁决（结论 — 为什么）与锁点

### ① `options.eventLogs` 缺省必须是 `true` — 为什么不缺省为「不绑」

CLI 一直是**恒绑定**的，改缺省就**直接改变 CLI 行为**；「CLI 一条不多一条不少」由缺省值兑现、
**不靠开关**。⚠️ 传了 `logger` 就意味着「我给了代理一个日志端口」，缺省绑上正是那个端口的预期语义，
**不想要就得显式说 `false` —— 沉默不等于同意**。两个真实场景：调用方自己已接了事件桥
（代理事实落两遍是噪音）／不想让代理行淹掉宿主应用级 logger。

牙齿**成对**（缺一头就成空断言）：`event-binding-runtime` 的 ①②（库路径**不给** `eventLogs`
也有 `[forward]` / `[auth] deny` / `[route]` 三种行）+ ③（`eventLogs: false` → 零落盘行，
而公共事件面一条不少）+ `lifecycle-binding-source` 的 ② 第二条（`[lifecycle]` 零行而
`lifecycle.changed` 四次跃迁宿主自己一条不少）。改成缺省 `false`，前两条当场红。

### ② `activateSubscriptions` / `releaseSubscriptions` 是「`start` 重建、`stop` 全退」的**唯一权威**

不许在别处也订阅：绑定漏在外面就会在 `start → stop → start` 之后**叠加**（每轮多一份订阅，
同一条 `[forward]` 落 N 次）。catch 回滚路径调**同一个**退订闭包，不留半轮订阅。

牙齿**两面**：

- 行为面：`event-binding-runtime` ④（同一条 `[forward]` 两轮各一遍、恰好 `toHaveLength(2)`，
  叠加会是 3，且 `request.started` 的 `listenerCount` 每轮 `0→1→0`）+ `lifecycle-binding-rows` ④
  （两轮共 8 行、`lifecycle.changed` 轮次 `0→2→0→2→0`，叠加会是 12 / 3）。
- 源码面（两族各一份）：「绑定点在 `activateSubscriptions` 体内、释放点在 `releaseSubscriptions`
  体内、且受 `subscriptionsActive` 旗标管住」—— 见 `event-binding-source` 与
  `lifecycle-binding-source` 各一条。

### ③ 幂等由「清空订阅数组」本身提供，不另设 `released` 布尔标志；退订闭包必须自带归属

**绝不许改用 `hub.removeAll()`** —— 总线可能属于宿主，连带清掉别人的订阅就是**越权**。

⚠️ 判据只钉**真会坏的那两条**（「只摘自己的订阅」与「重新绑一次仍能收」），**不钉任何关于
「幂等标志」的断言**：`EventSubscription.dispose()` 自己也是幂等的，所以任何关于标志位的断言都红不了。
- 「只摘自己的订阅」：`expect(events.listenerCount(), "退订后必须只剩宿主自己那一条").toBe(1)`
  + `expect(hostCalls, "宿主自己的订阅必须仍生效")` —— 改用 `hub.removeAll()` 这两行当场红
  （`event-binding-runtime` ⑤ / `lifecycle-binding-rows` ① 的第二条）。
- 「重新绑一次仍能收」：`expect(logger.debug).toHaveBeenCalledTimes(1)`（同 ⑤ 末尾）。
- 幂等的机制是 `splice(0)` 清空订阅数组（第二次迭代的就是空数组）——**「不另设标志」这句话的
  可执行形态就是上面这两条断言**，不是任何关于标志的断言。

## 零落盘纪律

全部用 `fs.mkdtempSync` 临时目录当 `configDir` 与落盘基址，`afterEach` 里 `rmSync` 清理，
**绝不写仓库的 `log/`**。⚠️ 落盘基址与 `configDir` 分开两个子目录：断言「哪些文件是日志」
时不被别的产物混进来。

⚠️ **JSONL 行序不保证**：落盘是并发 `fs.promises.appendFile`，只在 `flushPendingWrites()` 里
**等完成、不保序**（threadpool 多个槽 ⇒ 两次 append 可以乱序落地）。实测同一轮 `stop` 的
`stopping->stopped` 会落在下一轮 `stopped->starting` **之后**。**按发生顺序逐条比是本仓最贵的一种
flaky**，一律用多重集合口径（排序后比 / 逐条数次数）。另一侧：`structured` 那一档因为走真
`ProxyServer`、启动期 `[config]` 行先落盘，「等到有行」不等于「等到我们要的那行」，必须按谓词轮询。

## 为什么两个 fixture 不住 `tests/helpers/`

`external-network-scan.ts` 的 `SCAN_DIRS = ["unit","integration","library"]` **排除 `helpers/`**，
而 `walk()` 收的是目录下**全部 `.ts`**。于是把含建链位（`net.connect(port, TARGET_IP)`）的脚手架
搬进 `helpers/`，那部分覆盖就从零外网扫描里**静默消失** —— `scanDialSites()` 少报几个点，而
`no-external-network.test.ts` 的两条下界断言（`sites.length > 30`、`refs.length >= 50`）**照样绿**。
那正是「扫不到就恒绿」。

## 防假绿的位置

- **本目录的负向源码断言全部配了判据自检**：`event-binding-source` ⑥ 第一条与
  `lifecycle-binding-source` ⑥ 第一条都把探测器套在**合成脏源码**上，断言它必须真的命中。
  ⚠️ 那几条的锚点是**今天已不存在**的符号（`bindProxyEventLogs` 在 `server/index.ts` 上、
  `bindRuntimeLifecycle` / `lifecycleSubscriptions` / `unboundRuntimeObservers` 三个方法）——
  符号不回来它们就永远不会红，所以自检与它们**必须成对存在**，删掉自检等于删掉护栏。
  配对的正向锚是**今天仍存在的形状**：`createProxyRuntime(` / `class ProxyServer` / `code.length > 2000`。
- **两条「`src/**` 全文恰好两处」是正面断言，扫出空集只会红不会绿**：它们数的是命中条数
  （`toHaveLength(2)`），空集是 0 条。路径来自 `helpers/source-scan.ts` 的 `SRC_DIR` ——
  ⚠️ **层数只许出现在那一处**（`helpers/AGENTS.md` 已写死），本目录的任何文件都不许自己数 `..`。
- **「CLI 与库逐字段相等」两条都带「两侧非空」的正向证据**（`toBeGreaterThan(0)` / `toHaveLength(4)`），
  否则「两边都空 → 逐字相等」就是恒绿。`[lifecycle]` **不在** `CLI_ONLY_PREFIXES` 豁免名单里，
  两族各有一条独立的「必须非空」。

## 文件（⚠️ 档 ↔ 编号对照）

- `event-binding-runtime.test.ts` — `bindProxyEventLogs` 的**行为面** ①–⑤（纯库路径真落盘 /
  context 模式 / `eventLogs: false` / `start→stop→start` 不叠加 / 退订幂等）。
- `event-binding-source.test.ts` — ⑥ **源码级**（双绑零容忍 / `src/**` 恰好两处 / 绑定与释放落点 /
  `pipe` switch 14 变体 / 11 类订阅一条不少）+ ⑦ **CLI 与库逐字段相等**。
- `lifecycle-binding-rows.test.ts` — `[lifecycle]` 的**落盘行文本**四档：① 文本 / 等级 / 字段逐字
  （含退订幂等）、③ CLI 与库逐字段相等、④ `start→stop→start` 不叠加、⑤ `eventLogs: false` → 零行。
- `lifecycle-binding-source.test.ts` — ② **纯库路径真落盘**（`[lifecycle]` 恰好 4 行逐字 +
  `eventLogs: false` 零行）+ ⑥ **源码级**（双绑零容忍 / `src/**` 恰好两处 / 绑定与释放落点 /
  文本契约逐字且零 `process` 触点）。
- `structured.test.ts` — 走**真 `ProxyServer`** 的落盘行字段面（6 条各钉一类落盘行）：
  请求头 dump 掩码 / `[forward]` 身份维度 / `[auth] deny` / 多账号不串号 / `[ip-denied]` / `[route]`。
  与上面四档的分工：**它验「行里有哪些字段」，那四档验「绑定装在哪一层、装几次」**。
- `event-binding-fixture.ts` / `lifecycle-fixture.ts` — 两档共用一份（临时目录 + 账号表 / 名单文件
  + 真 logger + 原始往返采集 + `TRANSITIONS` 逐字契约）。`.ts` 非 `.test.ts` ⇒ vitest 不收集。
- `AGENTS.md` — 本文件。

⚠️ 编号写在 `describe` 的标题里**且不许重排**：①②③④⑤⑥⑦ 是两个原文件合起来的那份编号清单
（`event-binding-*` 用 ①–⑦，`lifecycle-binding-*` 用 ①–⑥），两边同号指的是**不同的东西**。

## 相关路径

- `../../../src/runtime/event-log.ts` — 两族绑定的本体（定义 + `pipe` switch 14 变体 + `[lifecycle]` 文本契约）。
- `../../../src/runtime/runtime.ts` — `activateSubscriptions` / `releaseSubscriptions` 那一轮的装配点。
- `../../../src/server/index.ts` — `ProxyServer`：它**零**绑定（防双绑），故走 `createProxyRuntime(` 装配。
- `../../helpers/src-files.ts` — `srcFilesRecursive()`，`src/**` 全量 `.ts` 的递归清单。
- `../../helpers/source-scan.ts` — `codeOf` / `offendingLines` + `SRC_DIR`（层数的唯一出处）。
- `../../helpers/net.ts` — `getFreePort()` / `listen()`。
- `../AGENTS.md`、`../../AGENTS.md`、`../../../tests/unit/core/events/pipe-contract.test.ts`（14 变体的编译期契约）、
  `../../../tests/unit/runtime/bridge/forward-events.test.ts`（掩码在 publish 前发生）。
