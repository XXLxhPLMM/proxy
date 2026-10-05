# tests/unit/datasource/quota/drivers/ — 账本**驱动抽象**（`QUOTA_USAGE_DRIVER`）

本目录只答**抽象本身**：换一个后端 / 加一个后端，判定语义不变、装配真的换掉。
被测实现分两处：驱动注册表与两个内置工厂在 `@/datasource/quota/registry.ts` + `index.ts`，
**装配点**在 `@/runtime/services.ts:buildDefaultServices`。
sqlite 档那本权威账的内部机制在 `../sqlite/`；jsonl 档的游标在 `../jsonl-cursor.test.ts`。

## 锁什么（四条不变量）

① ⚠️ **注册表是唯一的驱动判据，未注册即抛错并列出全部已注册项，绝不静默落到某一支。**
   抽象最容易腐烂成「注册表接好了，配置那条线却还写死在两支三元里」——那是一个**静默失效**的
   注入位：`registerUsageSource` 编译通过、`listUsageSourceDrivers()` 返回自定义名、而
   `buildDefaultServices` 压根不问注册表，于是 `quotaUsageDriver=mysql` 真跑起来接的还是内置的某个
   后端。**用户以为接上了自己的后端，实际没有。**

② **等价性的锚是「读回来的数字」，不是「文件存在」。** 后者在「写了个空文件」时也成立。
   `readTotal` **另开一个连接 / 另一次读**，不 spy —— spy 证明不了 IO，而「另开连接」顺带证明了
   「别的进程也能读」（多进程共享的必要条件）。

③ **装配切换的锚是「账本文件名形态」，不是「实例类型」。** `usage.jsonl` vs `usage.db` 是
   「哪个后端真的在写」的**可观察**证据；实例类型只是装配的中间态。
   配套一条负向：**文件名里不得有 `worker-<数字>`**（分槽的可观察证据），锚的是今天仍成立的形状，
   不是已删的 `normalizeSlot`。

④ **镜像的误差上界是一个声明过的量，不是「等一会儿就看见了」。** `mirrorLagBoundMs(P) === 2P`
   （推导见 `@/datasource/quota/mirror.ts` 文件头）。后者会随机器快慢漂移，且**测不出「回读从周期循环
   里被摘掉」这种退化** —— 而那看起来只是「省一次 IO」。

## ③ 的三段判据（缺一段就有一类退化测不出来）

- **行为面**：`registerUsageSource("mem", …)` 之后 `buildDefaultServices` 装出来的那个对象的 `file`
  就是自定义工厂造出来的（**不是**内置两档的任何文件名，也不是内置类的实例）。
  ⚠️ 判据锚的是「自定义工厂造出的可观察身份」而不是「不是内置两档之一」—— 后者在退回的内置恰好不是
  json 时会假绿。
- **编译期面**：`BUILTIN_USAGE_DRIVERS` 只有两项，所以「判断驱动名是不是内置的」这件事一旦写成
  运行时三元就必然与注册表分叉。
- **源码级面**：`buildDefaultServices` 函数体里**必须出现 `resolveUsageSource(`**，且**不许**出现
  「取驱动名后与内置名字比较」的三元 / 开关 / 裸字面量。
  ⚠️ 另外还钉 `spec` 是**平值闭包**（`dir` / `flushMs` / `resetHour` / `windowFor` 四项 `typeof === "function"`），
  不是 `ConfigAccessor` —— 而 `enabled` **刻意不在那张表里**：它是「有没有人配了非 0 配额」的判据，
  账本落盘无条件之后那条接线连同它带来的「判定生效、落库不生效」一起删掉了，
  列进来会让这条断言要求一个已删除的接线复活。

## 防假绿的位置

- ⚠️ **`blockAfter` 的锚点是「返回类型那一行」**（`"): RuntimeServices"`）：`export function
  buildDefaultServices(` 后面第一个 `{` 在**参数**里，切错块的表现是**零命中**而不是报错。
  所以 `toContain("overrides.usageSource")` 这条正向存在性必须排在 `toContain("resolveUsageSource(")`
  **之前** —— 它是「切对了块」的证据。
- **负向断言锚的是裸字面量**（`"(json|sqlite)"`）与比较形状（`quotaUsageDriver) ===`），
  不是某个符号名：符号名会随重构消失，而**这两种写法今天仍在源码里以别的身份存在**。
- **`readTotal` 的 sqlite 分支用 `openSqliteDriver()` 而不是账本实例**：跨档 / 跨连接读同一个 `.db`
  会撞上「no such table」这类像 bug 的现象。
- **`harness` 与 `buildDefaultServices` 逐字同构**（同一个 `UsageMirror` + `bindSink` +
  `onSnapshot → absorb` + 平值闭包 `spec`），所以这里跑通的路径就是生产路径。
  ⚠️ 它刻意**不走**默认装配：那层要 `ConfigAccessor` 与 `users.json`，而本目录要的是
  「窗口 / 时刻 / 目录 / 后端」四个可自由注入的口子。
- ⚠️ **临时目录的生命周期住在这个目录**（`_usage-drivers.ts` 的 `beforeEach` / `afterEach` +
  best-effort 重试）：Windows 上任何尚未释放的句柄都会让 `rmSync` 报 `EBUSY`，而**清理失败不该把一条
  断言正确的用例判成失败**。`dir` 是**活绑定**、档侧只读 —— 于是「谁在改这个变量」只有一个答案
  （两档各写一份 `let dir` 会让它有两个作者，而 `harness` 只会读到其中一个）。
- ⚠️ **`_*` 不带 `.test.ts` 后缀**：vitest 收不到它，所以它不是一份空跑的空档；而它**必须**留在本目录，
  **不许上提 `tests/helpers/`** —— 那里不在零外网扫描的 `SCAN_DIRS` 范围内。
- 本目录零公网 host 字面量 ⇒ **没有白名单片，也不需要**（纪律：零公网字面量的新文件不建条目）。

## 变异实测（已跑过，结论写在这里是因为「护栏有没有牙齿」这句话本身必须由一次实测背书）

⚠️ **变异 A —— 把装配那一行从注册表换成写死的内置档**（`src/runtime/services.ts`：
`resolveUsageSource(ctx.config.get("quotaUsageDriver"))(spec)` → `new SqliteUsageSource(spec)`）：

```
× registry.test.ts > 未注册的驱动名**抛错**并列出全部已注册项，绝不静默落到某一支
× registry.test.ts > 装配只经注册表查表，不许出现「与内置驱动名比较」的三元/开关
× registry.test.ts > registerUsageSource + quotaUsageDriver=<自定义名> → 装出来的就是它
    AssertionError: 自定义工厂真的被调用了一次: expected +0 to be 1
× equivalence.test.ts > driver=json → 账本文件名是 usage.jsonl；driver=sqlite → usage.db
Test Files  2 failed (2)      Tests  4 failed | 10 passed (14)
```

换回 `resolveUsageSource` 后全绿。**这一档的牙齿在拆档之后仍然咬得住**（原先它与
「镜像的误差上界」「等价性」同处一个文件，现在它与 `equivalence` 分属两档，判据一个没少）。

⚠️ **变异 B —— 破坏跨行源码判据的形状**（`src/datasource/quota/jsonl-source.ts` 的 `foldText` 里把局部
`key` 改名成 `wkey`，语义完全不变）：

```
× equivalence.test.ts > 两档的**回读与清理同出一趟扫描**（同一个「什么算过期」的定义）
    AssertionError: foldText 是唯一做窗口键比较的地方: expected '   \n …' to match
      /private foldText\(text: string\): void \{[\s\S]*windowKey\(entry\.ts, window, resetHour\) !== key[\s\S]*?this\.authoritative\.set/
```

**教训**：那条判据是**整段文本**匹配（`[\s\S]*` 跨行），所以它对「纯改名 / 折局部变量」这类**零语义变化**
的重构**一并变红 —— 搬动它时**必须整段逐字保留**，不许拆成几条单行断言（拆了就再也锁不住「同一条
fold 同时做窗口键比较与落权威值」这件事）。同目录另一条同类判据的实测见 `../sqlite/AGENTS.md`。

## 文件

- `equivalence.test.ts` — 两个内置后端的等价性（回读总量 / 停机必落盘）、装配按 `QUOTA_USAGE_DRIVER` 选
  （文件名形态 / 不分槽）、各自的能力边界（都丢过期窗口但机制不同 / json 不承诺并发写安全 /
  回读与清理同出一趟扫描）（7 `it`）。
- `registry.test.ts` — 驱动注册表（内置两项就位 / 未注册即抛错 / 只经注册表查表）、自定义驱动真的被装配用上、
  镜像的误差上界（7 `it`）。
- `_usage-drivers.ts` — 两档共用的装配面：`at` / `day12` / `dir` / `harness` + 临时目录生命周期。
  ⚠️ `QUOTA` 与 `readTotal` **刻意不进来**：前者只被 `harness` 的缺省参数与 `../jsonl-cursor.test.ts` 用到
  （跨子目录共用会让「哪个目录拥有这份装配面」变成要靠猜的问题 ⇒ **可见的重复优于看不见的失效**），
  后者只被 `equivalence` 一档用到。
- `AGENTS.md` — 本文件。

⚠️ `registry.test.ts` 第二个 describe 的标题里那句「（护栏牙齿，见文件头）」是**旧指针**：那段内容
（判据三段 + 变异实测）搬到了本文件。标题逐字保留是因为施工清单钉了 `describe` 骨架，改它会让
守恒校验失配 —— 读到那句的人以本文件为准。

## 相关路径

- `../../../../../src/datasource/quota/registry.ts` — 驱动注册表本体（驱动名 → 工厂；未注册即抛错并列出
  已注册项；退订只删自己写的那一项）。
- `../../../../../src/datasource/quota/index.ts` — `registerUsageSource` / `resolveUsageSource` /
  `listUsageSourceDrivers` / `JsonlUsageSource` / `SqliteUsageSource` 的对外出口。
- `../../../../../src/runtime/services.ts` — **装配点** `buildDefaultServices`（`overrides.usageSource` 是
  真注入位，两条分支都读它；驱动由注册表解析）。
- `../../../../../src/config/account-locator.ts` / `src/config/index.ts` — 配置 → 接线的翻译层
  （数据源层**零 `@/config` 依赖**那条不变量就靠它成立）。
- `../../../../helpers/config.ts` — `testContextFor`（给 `ConfigStore` 套一层可断言的 context）。
- `../../../../helpers/source-scan.ts` — `codeOf` / `blockAfter`（⚠️ 路径层数只许出现在那一处；
  本目录是 `../../../../helpers/`）。
- `../../../../../src/datasource/AGENTS.md` — 「驱动名是开放集合，未注册必须抛错」这条层不变量的原文。
- `./AGENTS.md`、`../AGENTS.md`、`../sqlite/AGENTS.md`、`../../../AGENTS.md`、`../../../../../AGENTS.md`。
