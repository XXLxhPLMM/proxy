# src/ops/ — 数据源操作层

**做数据源的操作，不做呈现。** 装配（配置 → 三份数据源）、账号 / 名单 / 账本的读写、配置事实，
全部在这里；输出是**结构化数据 + `OpsError`**，一个字符都不渲染。

传输层是 `src/admin/`（`proxy-cli` 的终端呈现）。反过来不成立：`ops` **不 import `@/admin/*`** ——
数据操作不该知道谁在显示它的结果，而那条禁令断了，本层才可能再接一个 HTTP / manager 面而不动它。

## 文件

- `index.ts` — 本目录 barrel。**纯转发**：内部用相对路径，不自我引用。
- `error.ts` — `OpsError` + `OpsErrorCode`（本层**每一个**模块都抛它，故单列，见下）。
- `change.ts` — `OpsChange`（写面唯一的「改成了什么」出口；账号与名单共用，故单列）。
- `sources.ts` — 配置 → 三份数据源的装配（`resolveOpsSources` / `opsSourcesFromContext` / `OpsSources`）、读面「坏内容即拒」的三个 `*OrFail`。
- `accounts.ts` — 账号表的读与写（`AccountPatch` 词汇、`applyPatch`、`findAccount`、`inertNoticeFor`）。
- `acl.ts` — 名单的读与写 + **组名词汇**（`AclGroupName` / `AclListName`，以及组名 → `AclConfig` 键的映射）。
- `usage.ts` — 账本读面（`readUsage` / `usageFor`）。
- `report.ts` — 配置事实（`reportConfig` + `reportConfigKeys` / `redactConfigValue`）。

⚠️ **为什么 `error.ts` 与 `change.ts` 单列而不在 `index.ts` 里**：本目录**禁止自我引用 barrel**
（根 `AGENTS.md` 的 import 路径规约：barrel 会把兄弟模块全拉进循环依赖图）。它们被本层每一个
模块使用，只能住在有名字的模块里。

## 层不变量

- **零 `console` / 零 `process.*` / 零表格渲染**：本层返回对象、数组、`Map`，以及**中性事实陈述**
  （`OpsChange.message`）与 `OpsError`。终端形态（列宽、表头、前缀、走哪条通道）全是传输层的
  决定；打码密码、给账本排序、把 `changed: false` 说成「没动」还是别的，也都是。牙齿：
  `tests/unit/ops.test.ts`「结构化 + 单向依赖」那组 + `tests/unit/admin-cli.test.ts` 的零 console 组。
- **绝不启动代理**：不 import `@/core` / `@/runtime` / `@/server`。向下只用 `@/config/index.js`
  （折接线）、`@/addr/index.js`（名单条目语法原语）、`@/datasource/*`。
  ⚠️ **「绝不启动代理」不等于「绝不与代理同进程」**：控制面（`src/manager/`）就与数据面同进程，
  它经 `opsSourcesFromContext` 复用**服务进程那一份**上下文而不是再 `loadConfig` 一次 —— 那正是
  「工具改的是 A、代理跑的是 B」这条事故的解药。
- **失败一律 `OpsError`，且带 `code`**：`code` 是给传输层读的**闭合**分类（`not-found` /
  `already-exists` / `invalid` / `read-only-driver` / `source-unreadable`），供将来的 HTTP 面映射状态码。
  ⚠️ **文案随便改，`code` 不许增殖** —— 每加一个 `code` 就是给「同一种失败两个名字」开一扇门。
  传输层**不得**拿 `code` 改文案：同一件事说两种话，是「两个入口对不上」那类配置事故的另一种形态。
- **`changed: false` 是一次成功，不是失败**：它表示目标状态**本来就**是那样。用户达到了目的，
  故不报错；数据一个字节都没动，故也不许假装成功。如实返回，让传输层决定怎么呈现。牙齿：
  `tests/unit/ops.test.ts`「幂等 no-op」那组——它断言的是「底层 `write` **没被调用**」，
  而不是「返回值是 `false`」（内容逐字相同地重写一遍，文件上根本看不出来）。
- **读面「坏内容即拒」**（`sources.ts` 的三个 `*OrFail`）：数据源层的读语义是「坏内容 → 保留上一份 /
  空表 + 一个 `error`」。**对代理那是对的**（判据永不因手滑失效）、**对要写数据的工具是错的** ——
  在「我读到的其实是空表」这个前提上 `put`，结果就是**把整份真配置清空**。故本层把 `error` 升级成
  硬失败（`code: source-unreadable`）。
- **账号写只有一个入口**：新建遇已存在的名字**直接拒绝**（底层 `put` 是整条替换，让「新建」静默成功
  等于「我以为在新建」变成「我顺手清掉了他的配额与有效期」）；改字段 / 禁用启用 / 改密码一律
  **读-改-整条写回**，未指定字段逐字保留。
- **只读驱动明确报错**：`AclSource.write` 是**可选成员**（只读名单驱动缺省），`requireAclWrite` 据此
  报错（`code: read-only-driver`），**绝不静默成功**。
- **「无副作用」那条约束在 `report.ts` 更硬了**：账本位置那个字段叫 `dir` 而不是 `path` ——
  文件名的算法住在两个数据源实现器里，而为了多打一行造一个数据源，等于把「看一眼配置」变成
  「可能建出一个账本文件」。牙齿：`tests/unit/ops.test.ts`「配置报告是**字段**，且一个文件都不造」。
- **打码判据只有一份**：`report.ts:CONFIG_SECRET_KEYS`（`jwtSecret` / `tlsPassphrase` /
  `upstreamPassword` / `managerToken`，外加 `upstreamUrl` 的 userinfo）与
  `src/server/log/config-log.ts` 的启动快照脱敏是**同一条判据**。传输层**不得**另起一份：
  那两个是**两个读者、同一份秘密**（落盘的 debug 快照与 HTTP 的 `GET /api/config`），清单漂了
  就是一处打码一处明文。**空串保持空串**（不是 `***`）：「没配」与「配了但不给你看」是两种
  不同的事实，渲染成同一个值等于让运维看不出自己配的东西到底有没有被读进来。
  牙齿：`tests/unit/manager-http.test.ts` 断言两份清单**逐键相同**。
- **`reportConfigKeys` 的 `fileOrigin` 只能来自 `ConfigSourceMetadata.fileOrigins`**
  （本层已加字段，见 `src/config/context.ts`）。⚠️ 它**不是**「值来自哪里」的完整答案：
  不在表里的键可能来自宿主 env、CLI **或缺省**，这三者在 `loadConfig` 之后已不可区分。
  **谎称可区分比承认不可区分更坏** —— 运维会照着一个错的文件名去查。
- **本层不持有「界面词汇」**：组的**呈现顺序**、字节的可读形态、密码怎么打码都在 `admin`。但
  **数据的词汇在本层**（`AccountPatch`、组名与组名 → 键的映射）——读写两面都要用，各写一份就是
  「两处对不上」的原料。

## 未做（是「不变量」，不是「没来得及」）

- **`usage` 没有任何写操作**。判定读的是代理进程内镜像，合并用 `max(本进程值, 账本值)`；从第二个
  进程删账本里的行对运行中的代理**永不生效**，而命令退出码会是 0。完整推导见 `usage.ts` 文件头。
- **不提供字段级的账号改写接口**。`AccountSource` 只有整条替换一个出口，在它之上发明
  `patch(field, value)` 会让「哪些字段可 patch」在每个后端各写一遍，而单列 `UPDATE` 出来的记录
  **未必还过 `validateAuthUsers`** —— 那正是「写得进去、读不出来」的来源。

## 相关路径

- `src/admin/` — 传输层（解析 / 派发 / 渲染 / 退出码）；本层的**唯一**消费者。
- `src/manager/routes/` — **第二个**消费者（HTTP 控制面，与数据面同进程）。它同样零渲染、
  零 console，且与 `admin/` 互不引用 —— 一条数据操作面能挂两个传输面，恰好是本层存在的证明。
- `src/manager/control-plane.ts` — 第二个消费者的**装配点**，且它经 `opsSourcesFromContext`
  **复用服务进程那一份配置快照**而不是再 `loadConfig` 一次（同进程里存在两份配置快照时，
  「控制面看到的配置」与「代理跑着的配置」之间就有漂移空间）。
- `src/cli-admin.ts` — 组合根（快照宿主来源、`process.exitCode`、shebang）。
- `src/datasource/users/index.ts` — 账号表（`list` / `put` / `delete`）。
- `src/datasource/acl/index.ts` — 名单（`read` + 可选 `write`）。
- `src/datasource/quota/index.ts` — 账本（`UsageSourceController.open/close` + `onSnapshot`）。
- `src/config/account-locator.ts` / `src/config/acl-locator.ts` — 「哪个键装哪个驱动」的唯一一份。
- `src/addr/index.ts` — 名单条目语法的纯函数原语（本层对它只有 barrel 这一个合法出口）。
- `.env.example` / `cfg/users.json.example.md` — 账号与名单的字段文档。

## 相关测试

- `tests/unit/ops.test.ts` — 结构化返回值、`OpsError.code` 真值表、幂等 no-op（**`write` 调用次数**）、
  `applyPatch` 的字段保全与判据来源、层边界源码级护栏（单向依赖 / `@/config` 出口白名单）。
- `tests/unit/admin-cli.test.ts` — 同一批操作**经传输层**的行为（表头 / 文案 / 退出码 / 字段保全），
  以及「零 console / 零 process.* / 不 import 代理侧」那组**覆盖两层**的源码级断言。
