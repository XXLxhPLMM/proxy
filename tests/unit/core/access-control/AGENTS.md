# tests/unit/core/access-control/

访问控制（`src/core/access-control.ts` 的 `createFileAccessControl`）与 `AccessControl` 端口的判定层档。
八档 + 两份共用面，**只答一件事**：名单怎么判、端口怎么接、以及「哪些形状不许回来」。

- 结构校验那一层（`acl.json` 的形状真值表）**不在这里**，在 `../../datasource/acl/validate.test.ts`。
- 四条转发路径的接线与事件去重**不在这里**，在 `../../../integration/acl/`。

## 文件头只留「这一档管哪一段」

⚠️ 下面两节（端口的六条硬裁决 + 合流语义的三条判据归属）是**八档共用的牙齿**。
每档的文件头**只留「这一档管哪一段 + 指向本文件」**，不许把它们抄进 8 份 —— 抄一次就是
一次会各自腐烂的 8 份真相。判据的落点（哪个 `expect` / 哪条 `toEqual`）在对应那一档里。

## 端口的六条硬裁决（八档共用，不是「现在恰好是对的」）

`AccessControl` 与 `IdentityProvider` 是两个可插值端口，`checkClient` / `checkTarget` /
`checkRoute` 收成**一个注入对象**。这六条是端口的**裁决**，每条都点名了它排除了什么。

**① 三个方法必须同步。** 被否掉的是「改成 async 以便将来查远程策略」：`checkRoute` 被四条
入站通道在**拨号之前**调用，返回值要立刻喂给「选哪个连接器 / 拒绝应答 / 发 `route` 事件」
这一整串**同步**控制流，改成 async 会级联重排整条转发链。**需要远程查策略的诉求归
`identity`**（`identify` 本来就是 async）——身份判定允许等，准入判定不允许。
锁点：`file-engine.test.ts`「三个方法都是同步的」那条的
`expect(r).not.toBeInstanceOf(Promise)` 与 `expect(typeof (r as { then?: unknown }).then).toBe("undefined")`。
断言形状刻意是「返回值不是 thenable」而不是「函数不是 async」——后者会被「async 函数但内部
同步返回」骗过；任一方法改 async 两条立刻红。

**② `proxyMode` 模式门留在 `resolveRoute`，不进 `AccessControl.checkRoute`。** 被否掉的是
「让 `checkRoute` 读 `proxyMode`」与「给 `AccessRouteInput` 补一个模式维度」：两者都意味着
**每个自定义策略实现都得重写一遍模式门**，而策略端口漏进路由关切比「工具层读配置」更坏。
锁点：`file-engine.test.ts`「server 模式零开销短路」那条的 `expect(access.calls.route).toHaveLength(0)`
与 `port-injection.test.ts`「三个方法各被调用」那条的 `expect(access.calls.route[0]).not.toHaveProperty("user")`
（路由判定入参刻意**没有** `user` 维度 = 「个人名单绝不参与路由」的另一半，判据在 `user-merge-runtime.test.ts`）。
模式门一旦挪进判定层，`resolveRoute` 必然去问 `checkRoute`，计数立刻从 0 变 1 → 红。

**③ `AccessDecision.reason` / `source` 与 `PipeTargetDeniedEvent.source` 是自由 `string`
而非闭合字面量集。** 被否掉的是「把 `whitelist`/`blacklist`/`global`/`user` 固化成闭合集」：
端口一旦对外暴露，替换实现可能是限速引擎、地理封锁、订阅制网关，闭合集会让它们没法用类型
描述自己的结论，只能回去 `as never` 强转。代价（消费方不能再假设取值）由两条负向纪律承担：
① `runtime/bridge.ts` 原样透传、不认闭合集（静默吞掉等于安全事实在事件流里消失，比「载荷里带一个
没人认识的 reason」坏得多）——锁点 `file-engine.test.ts` 那两条自定义 `rate-limited` /
`geo-blocked` 逐字到达 `access.target-denied`；② 缺失即跳过、**绝不臆造**——`source` 缺失
**不**倒填成 `global`，那会把「个人名单拒的」伪装成「全局拒的」，锁点
`expect(data.source).not.toBe("global")` 与 `user-merge-event.test.ts` 的
`expect(events[0].data).not.toHaveProperty("source")`。类型层的正面锁点是
`expectTypeOf<AccessDecision["reason"]>().toEqualTypeOf<string | undefined>()`（`user-merge-matrix.test.ts`）。
**内置引擎的自律另在源码级**：`AclReason` 是模块私有类型、不导出——**收窄是消费方自己的事**。

**④ 判定面只导出一个对象字面量，私有判定全不导出。** 被否掉的是「导出三个模块级函数」：
每个导出函数各收一个 `config` 形参就有四种传法（三处调用 + 一处装配），错一处就是「拿 B 实例的
名单、判 A 实例的请求」，运行期表现为**名单时灵时不灵**。藏进 class 或深层闭包会让源码级护栏
失去锚点，而失去锚点的护栏不是「红」，是**抛错**。锁点：`source-guards.test.ts`
「判定面真的只有一个出口」那三条 `not.toMatch(/export\s+function\s+check(Client|Target|Route)/)`
加上 `expect(code).toMatch(/return\s*\{\s*checkClient:\s*\(input\)/)`——工厂返回对象字面量，
三个判定体留在模块级，锚点可切。隔离行为由 `file-engine.test.ts`「工厂闭包捕获 config」那条承担。

**⑤ `upstream` 组的动作与 `target` 组相反。** 真值表是**走上游 ⇔ 命中 whitelist ∧ 未命中
blacklist**：黑名单命中 → 直连（优先）；白名单非空且未命中 → 直连；皆空（含整组缺失）→ 走上游。
**仅 `PROXY_MODE=client` 有意义**（server 模式由 `helpers/route.ts:resolveRoute` 短路）。
条目与 `target` 同形，判定对象同样是「客户端请求的目标」，**上游地址永不进名单**。
锁点：`decision.test.ts`「upstream：黑名单命中优先直连，盖过白名单命中」那条的三个 `toEqual` 逐档锁死。

**⑥ 三个端口的缺席语义方向相反，所以只有 `access` 走编译期必填。** `identity` / `traffic` 的
缺席读作**关闭一项功能**（不鉴权 / 不计费），各有语义明确的 inert 档；`access` 的缺席读作
**取消防护**（全放行且零信号），方向相反，故走编译期强制。被否掉的两侧各有具体危害：
「三个都配显式 inert 档」把三种相反语义混成同一个「关闭」；「`access` 走 fail-closed 缺省（全拒）」
则让「只想跑直连、不部署 `acl.json` 的最小部署」被自己拒绝。**两侧都不做，把决定交回编译期。**
代价如实记：低层直构 core 的调用方（测试、嵌入方）从此必须显式写一份判定。**想要「不判名单」就
写一份显式放行实现**（`../../../helpers/access.ts` 的 `openAccessControl`）——那比省略多一行代码，
换来的是「这一行是**你写的决定**」而不是「core 替你猜的」。

### `access` 必填的防复活锁点（`required-port.test.ts`）

- `expect(decl[0], "`access` 不许带 `?`（缺席 = 取消防护，必须编译期强制）").not.toContain("?")`
  —— 锚点是 `core/types/proxy.ts` 里**今天仍存在**的 `access:` 声明行；有人把 `?` 加回去、顺手
  把 20+ 处构造补成显式放行，那是一次**能通过全部检查**的改动，只有本条会红。
- `expect(codeOnly(raw)).not.toMatch(/access\s*:\s*options\.access\s*\?\?/)` —— 归一表达式不许把
  `access` 重新接回 `??`。
- 配套的「放行档不写 source」（第 2 组 `expect(Object.keys(...)).toEqual(["allowed"])`）与
  「两个缺省档语义各不相同」那档，一起把「放行档」钉成**显式写出来的那份实现**。
- ⚠️ **`base.ts` 零 `OPEN_ACCESS_CONTROL` 那条不是护栏**：该符号已不存在，`src/**` 的仅剩命中全在
  `base.ts` 与 `runtime.ts` 的注释里，`codeOnly` 逐条剥掉后恒为零命中。**判据有指称对象的是上面
  那三条「锚点仍存活」的断言**——而本目录靠 `source-guards.test.ts` 里那组**正向面**（先证明锚点
  存在，再谈零命中）把这件事守住。

## 合流语义与「分层信息不进 reason」的三条判据归属（`user-merge-*` 三档共用）

```
放行 ⇔ 全局 target 组放行 ∧ 该用户的 target 组放行
```

**① 先全局、后个人、全局短路，两关都拒时报全局那一条。** 被否掉的是「合成一层」。全局拒绝是
**绝对**的（个人名单只能更严、不能更松），故全局拒时**连 `users.json` 都不读**；两关都拒时报
**全局那一条**——全局是权威层，运维先看到自己的全局配置问题，而不是「某用户碰巧也被全局禁了」。
两层走同一个私有 `hostDenied`，抄两份迟早漂移。锁点：`user-merge-matrix.test.ts` 那张 3×3
**穷举**真值表（不抽样），每档逐字断言 `toEqual({ allowed, reason, source })` **以及键的集合**
（放行恒只有 `["allowed"]`）。两档特别钉死了「两关都拒报全局」。共用实现由同档源码级的
`blockAfter(code, "function hostDenied(")` 承担。

**② 个人名单绝不参与 `checkClient` 与 `checkRoute`。** 被否掉的是「`checkClient` 也支持
per-user」。鉴权之前没有身份；`checkRoute` 是路由决策，与「你是谁」正交。行为面由
`user-merge-runtime.test.ts`「带 acl 与不带 acl 逐项相同」承担；路由侧的端到端佐证在
`port-injection.test.ts`（裁决 ② 那条）。

**③ 「分层信息只走独立的 `source` 字段」的落点是生产者，不是类型。** 被否掉的是「在 core 侧固化成
闭合集以获得类型安全」——那等于把名单语义重新摆成公共承诺，而事件契约那一份是自由 `string`
（裁决 ③），两处各挂一个公共闭合集正是「两份真相」的起点。所以编译器那一半**已经不可能存在**：
port 侧的类型断言现在锁的是「reason/source 已是 `string | undefined`」这个**放宽后**的事实，
「内置引擎只产两个字」改由三重自律接住 —— **任何一层失效，另外两层还在**：

1. **运行期**：9 档真值表的 `reason` 全部落在 `{whitelist, blacklist}` 内，且两种值都真出现过
   （`user-merge-matrix.test.ts`「运行期：上述 9 档…」那条末尾的 `expect(new Set(reasons).size).toBe(2)`）。
2. **源码级**：`hostDenied` 函数体只返回两个字面量、不出现拼接式 reason、写出的 `source:`
   字面量集合恰为 `{global, user}`（`user-merge-matrix.test.ts`「源码级：判定层不出现任何
   `'user:blacklist'`」那条）。
3. **事件面**：`source` 原样透传、缺失即跳过、**绝不倒填成 `global`**
   （`user-merge-event.test.ts` 三条）。

**「消费方绝不臆造」那半条**由 `user-merge-event.test.ts` 的
`expect(events[0].data).not.toHaveProperty("source")` 与
`expect(events[1].data).not.toMatchObject({ source: "global" })` 钉死。

⚠️ **降级这件事必须被写下来**，否则下一个读代码的人会以为内置引擎可以随便吐 reason。

## 源码级断言的判据口径（四档共用，防假绿）

这一族的源码级断言密度是全仓最高的，所以口径统一写在这里、各档只留落点。

- **工具面**：`../../../helpers/source-scan.ts` 的 `codeOnly`（**只去注释、不去字符串字面量**）/
  `codeOf` / `sourceOf` / `offendingLines` / `blockAfter` / `SRC_DIR`。字符串里出现被禁词汇则往往正是要盯的泄漏形态。
- ⚠️ **`__dirname` 一律换成 `SRC_DIR`**，不许自己数 `..` 层数（`source-guards.test.ts` 三处）。
  少一个 `..` 解析到 `tests/src` 会抛 `ENOENT`（自己暴露）；**多一个 `..` 枚举到空集则恒绿** ——
  后者只会静静地不再判任何东西，正是上面那条失效形态本身。
- **负向源码断言的锚必须落在「今天仍存在的形状」上**，自检三条（锚到的形状今天还在吗 /
  判据形状天然跨行吗 / 注释里点名被禁符号会不会被自己误判）照根 `AGENTS.md`「写护栏时」。
- ⚠️ **「零命中」必须配一条「正向面」先证明锚点存在**。本目录的做法是把它写进同一条 `it`：
  `source-guards.test.ts`「判定层工厂与三个判定」那条先断言
  `export function createFileAccessControl(` 与三个 `function <name>(` 存在、且扫到的文件数
  `toBeGreaterThan(20)`，再谈 `core/**` 的零调用；「全 src/ 恰好两处」那条断言 `hits` 长度恰为 2
  且两条都在预期位置；「只有两个出口」那条断言 `names.length` 非零且 `createFileAccessControl`
  真的在里面；「记忆模块零 import」那条先断言 `core/acl-memo.ts` 真的导出那三个名字、扫到的文件数
  `toBeGreaterThan(20)`、且判定层那份 import 真的在命中里（**两种拼法都收**，判据按**文件**而不是
  按路径拼法判——唯一合法那处用同目录相对路径，按拼法判就等于把它也放行）。**空集会让这四条恒绿。**
- **合法出现要逐条写明而不是「过滤掉就算了」**：`source-guards.test.ts` 的 `JUDGEMENT_FILE`
  （判定层自己）与 `PORT_TYPE_FILE`（端口接口声明处）各自有注释说明为什么合法——若哪天端口类型
  搬出 `types/proxy.ts`，那一档会红，届时改这一条或删掉。
- **裸名字 vs 无接收者**：`(?<!\.)` 前置断言是承重的——`access.checkTarget({…})` 是**合法**的端口
  消费形态（`helpers/predial.ts` / `server/admission.ts` / `helpers/route.ts` 各一处），裸名字会把
  它们一起判红；而 `checkTarget({…})` 这种**无接收者**的调用在 core 内部只可能来自「绕过端口」。
  ⚠️ 而**锚在已删符号名上的那条不是护栏**（见上面「`access` 必填的防复活锁点」末段）。

## 共用面：为什么住在这个目录的 `_*.ts` 里

`_access-control-port.ts` 与 `_user-acl-merge.ts` **不带 `.test.ts` 后缀**，所以 vitest 不会把它们
收集成空跑的空档。⚠️ **它们绝不许搬进 `tests/helpers/`**：零外网扫描的 `SCAN_DIRS` 排除那个目录，
把带公网 host 字面量的东西搬进去等于让那部分覆盖**从扫描里静默消失**，而
`no-external-network.test.ts` 的两条下界断言照样绿。**可见的重复优于看不见的失效。**

进共用面的门槛是**两个以上档真用到**：

- `_access-control-port.ts`：`HOST`、`countingAccess`（含它的记账判据）、`activeRuntimes`、
  `absoluteGet`。⚠️ 排空 `activeRuntimes` 的 `afterEach` **由用它的档自己挂**（共用面不挂钩子），
  排空靠 `splice(0)`，第二次排空是**同一份实现**给出的空转，不另设「已释放」标志。
- `_user-acl-merge.ts`：`acc`、`HOST` / `OTHER` / `USER`、两层名单的六个档位常量、`accounts`、
  `writeLists`、`newAccess`、`MERGE_KEYS`、`cleanupMergeDirs`。
  ⚠️ **`access` 是工厂而不是一个 `let`**：它每例都被 `beforeEach` 重新赋值，而 ES 模块的导入
  绑定**不可从外部赋值**。所以共用面给构造器，可变的那个 `let access` 归拥有它的那一档。
- **只被一档用到的刻意留在那个档里**：`KEYS` 快照表（`file-engine`）、`normalizedAccess`
  （`required-port`）、`JUDGEMENT_FILE` / `PORT_TYPE_FILE`（`source-guards`）、
  `MERGE_CASES` / `MergeCase` / `ListReason`（`user-merge-matrix`）、`writeUsers` + 它的 `clock` 与
  `GLOBAL` 夹具（`user-merge-runtime`）。

## 库模式内联 config 必须逐处钉 `quotaUsageDir`（两档五处）

`createProxyRuntime({ config: <内联对象> })` **不经 `loadConfig`**，于是 `tests/setup-env.ts` 钉的
`process.env.QUOTA_USAGE_DIR` 与 `set("quotaUsageDir", …)` **两侧全落空**（库模式
`new ConfigStore(内联)` 造的是另一个实例）。而 `quotaUsageDir` 的 FIELDS 缺省是**相对路径**
`cfg/usage`、按 `configDir`（缺省 = `process.cwd()` = 仓库根）绝对化；用量数据源的 `open()` 又在
`start()` 里就跑（**与是否真计量无关**）。于是**一条字节都没传的用例照样会在仓库里留下
`cfg/usage/usage.jsonl`**。

⇒ 本目录里**每一个**内联 config（`port-injection.test.ts` 三处、`file-engine.test.ts` 两处）都必须
显式给一个 **`os.tmpdir()` 下的绝对路径**（本仓那两档用的是 `path.join(os.tmpdir(), …)` 形状的
模块级常量）。基准形状与那三条机制见 `tests/setup-env.ts` 的 `TEST_LEDGER_DIR` 注释；两档各自用
**不同**的目录名（账本可能被并发写，同名会互相踩）。判定覆盖：`ls -d cfg/usage` 跑完必须不存在。

## 文件

- `decision.test.ts` — 内置判定引擎的判定语义与热加载（`acl.json` 三组各自的动作与优先级、模式门短路、越过 1s 节流）。
- `file-engine.test.ts` — `createFileAccessControl` 三个方法的行为真值表 + 自定义 `reason` / `source` 走得通公共事件面。
- `port-injection.test.ts` — 注入的替身**真的被转发路径问到**（真请求 + 计数 + 结论被采信）。
- `required-port.test.ts` — `ProxyOptions.access` 必填、core 侧零缺省解析，以及它的三条源码级形态。
- `source-guards.test.ts` — 源码级：`core/` 一律走端口、全仓只有两个合法出口（**`import … from` 与 `export … from` 两侧都扫** —— 包门面走的是 `export … from`，只扫一侧时它整条走掉了白名单）、记忆模块 `@/core/acl-memo.js` 零取用面（判定层是唯一读者）、判定面只有一个出口、helpers 层只 type-only。
- `user-merge-matrix.test.ts` — 合流优先级 3×3 穷举真值表 + 内置引擎的 `reason` 取值集合 + 无身份即无个人层。
- `user-merge-runtime.test.ts` — 个人名单不越界（行为 + 源码两面）、热加载生效、策略快照零分配。
- `user-merge-event.test.ts` — `access.target-denied` 的 `source` 转述（透传 / 缺失即跳过 / 绝不倒填）。
- `_access-control-port.ts` / `_user-acl-merge.ts` — 两份共用面（见上）。
- `AGENTS.md` — 本文件。

## 相关路径

- `../../../../src/core/access-control.ts` — 被测的判定层（唯一出口 `createFileAccessControl`）。
- `../../../../src/core/types/proxy.ts` — 端口类型与 `access: AccessControl`（无 `?`）声明行。
- `../../../../src/runtime/services.ts` — `buildDefaultServices`：唯一组装根（默认实现的唯一调用点）。
- `../../../../src/datasource/acl/index.js` / `../../../../src/datasource/users/index.js` — 两份名单的读取与个人策略加载。
- `../../../helpers/source-scan.ts` — 源码级断言的公共文本面 + `SRC_DIR`。
- `../../../helpers/access.ts` — 显式放行档（`access` 没有 core 侧缺省档的对应物）。
- `../../../helpers/public-hosts/unit-core-access-control.ts` — 本目录的零外网白名单片（**只有 4 档有公网字面量**）。
- `../../AGENTS.md`、`../../../AGENTS.md`。
