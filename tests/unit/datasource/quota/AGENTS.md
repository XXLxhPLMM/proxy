# tests/unit/datasource/quota/ — 配额判定的三层（判定 / 窗口 / 账本）

本目录只答**判定侧**的三件事，判据全是纯函数 + 源码文本，不起库、不建链：

| 层 | 答什么 | 档 |
|---|---|---|
| 判定 | 「这次放不放行」+ **判定本身的同步性** | `mirror-allow` / `consume-sync` |
| 窗口 | 「这条用量属于哪个窗口」+「跨窗口时账本怎么办」 | `window-key` / `window-rollover` |
| 账本 | jsonl 档的**按游标增量回读** | `jsonl-cursor` |

端到端（真代理 + 真字节 + 耗尽事件）不在本目录，在 `tests/integration/quota/`；
计量落点（`core/quota-meter.ts` 的被动计数护栏）在 `tests/unit/core/quota/meter.test.ts`；
sqlite 档那本权威账在 `./sqlite/`，两个内置后端的等价性与驱动注册表在 `./drivers/`。

## 三层共用的六条不变量

① ⚠️ **`consume` 的同步性是本目录全部判定的地基。** 「读-改-写之间没有让出点」（零 `async` /
   零 `await` / 零定时器 / 零微任务）是 `UsageMirror` 无锁论证的**唯一**内容 ——
   `mirror-allow` 那 14 条判定语义、`window-rollover` 那 11 条滚动语义，全都建立在它上面。
   牙齿在 `consume-sync.test.ts`；**任何一档想改判定语义之前先确认那一档还绿**。

② **恒 allow 必须是显式分支，不是「默认上限 0 恰好放行」。** 未配 / `bytes` 为 0 / 用户不存在 /
   非正字节数 / `inertUsageAccount` 五种情形逐条钉在 `mirror-allow.test.ts`；而替身
   `_traffic-account.ts` 刻意**不给缺省上限** —— 替身若偷偷补一个默认值，那正是这一档要否掉的蒙混。

③ ⚠️ **「没有上限」≠「不计量」。** 两条在不同层各钉一次：`mirror-allow.test.ts` 判 `usage` 照常累加，
   `window-rollover.test.ts` 判未配用户同样按缺省 `month` 记窗口。缺任一条，「将来加上限即刻按真账判」
   这句话就没有牙齿。

④ **窗口键只有一个定义，三档从三个角度钉它。** `window-key.test.ts` 钉算法本身（day/month 边界、
   本地时区、DST 近似、`shiftHours` 夹取）；`window-rollover.test.ts` 钉**惰性清账**（比对窗口键 →
   换键清零 → 旧用量不继承）；`consume-sync.test.ts` 钉 `mirror.ts` 里那两个调用点
   （`windowKey(` 与 `windowKey: key`）都在。⚠️ 任何一处漂移，另外两档会先响 ——
   这正是拆成三档之后这条判据仍然只有一份的原因。

⑤ **零 IO 是两层，缺一缝就留。** ① **import 面**：`mirror.ts` 零 `node:` 内置模块（绕不过去的正面声明，
   顺带把 SAB 的形状钉成「由装配点注入」）；② **函数体面**：`consume` 体内零 IO / DB / 阻塞等待
   （一个叫 `store` / `cache` 的注入协作者照样能把 `SELECT` 带进来）。只留 ①：一个注入协作者就能绕过；
   只留 ②：禁用词表能被 `globalThis` 之类写法绕过。**同步 ≠ 无 IO**：`db.prepare("SELECT …").get(user)`
   与 `fs.readFileSync` 里既没有 `await` 也没有定时器，上面十几条**一条都不会红**。

⑥ **源码级判据一律走 `../../../helpers/source-scan.js`**，且**锚「被防住的行为在今天仍然存在的形状」**：
   零定时器、零 `.delete(`、零 LRU 字样、零 `node:` import、零 LRU/限速字段、**槽位不新增只替换**。
   ⚠️ 绝不点名已删除的符号（点一个不存在的符号，断言恒真而不是失败）—— 数据源文件那一组刻意锚
   **当前存在的文件名**（`sqlite-source.ts` / `mirror.ts` / `flush-loop.ts`），锚错了就是恒绿。

## 防假绿的位置

- ⚠️ **`offendingLines` 按行匹配**：它 `split("\n")` 之后逐行 `re.test`，所以 `consume` 一旦被重排版
  （一个 IO 调用拆成两行），那四组「零」全在**空集上通过**。唯一的牙齿是紧随其后的两条口径自检
  （`this.slotFor(` 与 `this.sink?.record(` 今天都在块里）—— **它们是「切对了块」的证明，不是装饰**。
- **`blockAfter` 的锚点 + 一条正向存在性**：`blockAfter(code, anchor)` 在锚点消失时**抛错**（响红），
  但「切错块」的表现是**零命中**。所以每处 `blockAfter` 后面都有一条 `toContain(...)` 证明切对了块。
- **禁用词表刻意不收 `.get(` / `.all(`**：`Map.prototype.get` 是合法内存操作，收了就是一条**会假红**的
  护栏，而会假红的护栏比没有护栏更坏 —— 它教下一个人「这条可以注释掉」。同理**刻意不收
  `Atomics.load/store/add`**（SAB 后端将来要用的），只收真正阻塞事件循环的 `Atomics.wait` / `waitAsync`。
- **`window-key.test.ts` 的时区判别不假装**：本机偏移小到 UTC±11 以内时任何本地时刻换算到 UTC 都还是
  同一天，此时那条只锁住「键 = 本地日历日」这一半语义，**判别不了的就走 `else` 分支**而不是硬编一个
  判别时刻。DST 那条按**近似**断言（切换点必落在本地午夜 ±1 小时），**不是**按精确午夜。
- **`window-rollover.test.ts` 那条「已知限制」读的是原文（含注释）**：`sourceOf` 而非 `codeOf` ——
  文档本身也是契约的一部分。锚点锁的是**当前机制名**（`compactEntries`），不是任何时间坐标；
  文档改写时这条断言要跟着改锚，**不该反过来让文档迁就它**。
- **`windowKey` 的定义域夹取不是洁癖**：库调用方可以绕过 `loadConfig`（`createProxyRuntime({ config })`
  走 `ConfigStore`，而它**零校验**），所以「配置层保证 0..23」对库路径**不成立**，窗口键必须自己守住。
- ⚠️ **`_*` 模块不许上提 `tests/helpers/`**：`external-network-scan.ts` 的 `SCAN_DIRS` 排除 `helpers/`，
  而 `walk()` 收目录下**全部** `.ts` —— 搬进去等于让那部分覆盖从零外网扫描里**静默消失**，
  而 `../../meta/no-external-network.test.ts` 的两条下界断言照样绿。**可见的重复优于看不见的失效。**
- ⚠️ **本目录零公网 host 字面量 ⇒ 没有白名单片，也不需要**（`tests/helpers/public-hosts/` 下没有
  `unit-datasource-quota.ts`）。纪律是「零公网字面量的新文件不建条目」—— 建了会被判 stale。

## 变异表（每条都实测过「断言真的会红」）

| 破坏什么 | 哪一档响 |
|---|---|
| `mirror.ts` 的 `consume` 加一个 `await` | `consume-sync`（零 async / 零 await 两条） |
| `mirror.ts` 的 `consume` 里加 `fs.readFileSync` | `consume-sync`（函数体面那条；**import 面那条不会红** —— 这就是两层缺一不可的证明） |
| 删掉 `mirror.ts` 的 `sink?.record(` | `consume-sync`（挂了落盘账本那条 + 零定时器那条） |
| `mirror.ts` 加一个 `setInterval` | `consume-sync` + `sqlite/layout`（两档各钉一次） |
| `windowKey` 改用 `toISOString()` | `window-key` |
| `windowKeyOf`/`windowKey` 的 `shiftHours` 去掉夹取 | `window-key`（非有限值 / 越界 / 定长形状三条） |
| `mirror.ts` 的滚动改成 `.delete(旧槽位)` | `window-rollover`（不删槽位那条 + 清账 ≠ 除名） |
| `mirror.ts` 文件头删掉 `jwt` / `compactEntries` 那句限制 | `window-rollover`（已知限制那条） |
| `jsonl-source.ts` 的游标去掉内容哨兵 | `jsonl-cursor`（压缩变大 / 变短 / 换文件三条） |

## 文件

- `mirror-allow.test.ts` — 判定语义：恒 allow 的五种情形、唯一合计上限、`<=` 边界、按用户分槽（14 `it`）。
- `consume-sync.test.ts` — `consume` 的同步性（零 `async`/`await`/定时器/微任务）+ 零 IO 的两层牙（8 `it`）。
- `window-key.test.ts` — `windowKey` 与 `quotaWindow`：day / month 边界、本地时区与 DST 取舍、
  `shiftHours` 夹取（17 `it`）。
- `window-rollover.test.ts` — 窗口滚动清账（惰性、不继承旧用量）、槽位规模有界、`resetHour` 热改（11 `it`）。
- `jsonl-cursor.test.ts` — jsonl 档按游标增量回读：残缺行、内容哨兵、文件被换、快照不可原地改（7 `it`）。
- `_traffic-account.ts` — `mirror-allow` / `consume-sync` 共用的 `QuotaResolver` 替身（`accountWith`）。
  ⚠️ 临时目录那类**可变状态**不进这里（本目录没有）；`drivers/` 与 `sqlite/` 两份 `_*.ts` 才各自持有
  `dir` 与它的 `beforeEach` / `afterEach`。
- `AGENTS.md` — 本文件。

⚠️ **拆档纪律**：本目录的档头**只留「这一档管哪一段 + 指向本文件」**。旧文件那几段 50~80 行的
文件头**不许**整段搬进新档 —— 那会让同一段不变量在五份档里各有一份副本，改一处要改五处。
本文件就是那几段的唯一落点。

## 相关路径

- `../../../../src/datasource/quota/mirror.ts` — 被测的判定层（`UsageMirror` / `consume` / `usage` /
  `slotFor` / `windowKey` 消费点 / `absorb` / `sink?.record`）。
- `../../../../src/datasource/quota-window.ts` — `windowKey` / `quotaWindow` /
  `DEFAULT_QUOTA_WINDOW`（账号表与账本共用的**纯函数**；⚠️ 它住在 `src/datasource/` **根上**而不在
  `quota/` 里 —— 两边必须有同一份定义，而代理层不是它们的公共祖先；本目录经
  `@/datasource/quota/index.js` 转发它）。
- `../../../../src/datasource/quota/jsonl-source.ts` — jsonl 档实现（游标 / 内容哨兵 / `compactEntries` /
  `foldText`）。
- `../../../../src/datasource/quota/flush-loop.ts` — 全仓在这一处唯一的数据源定时器站点。
- `../../../../src/core/quota-meter.ts` — 计量落点（被动计数），护栏在 `tests/unit/core/quota/meter.test.ts`。
- `../../../helpers/source-scan.ts` — `codeOf` / `blockAfter` / `offendingLines` / `sourceOf` +
  `REPO_ROOT` / `SRC_DIR`（⚠️ 路径层数只许出现在那一处；本目录是 `../../../helpers/`）。
- `../../../../src/datasource/AGENTS.md` — 数据源层不变量（零 `@/config` 依赖 / 驱动名是开放集合）。
- `./drivers/AGENTS.md`、`./sqlite/AGENTS.md`、`../../../AGENTS.md`（`tests/`）、`../../../../AGENTS.md`（仓库根）。
  ⚠️ **本目录的正上一层 `tests/unit/datasource/` 不建 `AGENTS.md`** —— 它只直接放 1 档
  （`ensure-target`），而判据是「这段不变量有几档共用」（`packages/tui/AGENTS.md` 的原话），
  那一档的不变量就地住在它自己的文件头里。
