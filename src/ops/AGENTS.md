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
- `src/utils/addr/index.ts` — 名单条目语法的纯函数原语（本层对它只有 barrel 这一个合法出口）。
- `.env.example` / `cfg/users.json.example.md` — 账号与名单的字段文档。

## 相关测试

- `tests/unit/ops/` — 结构化返回值、`OpsError.code` 真值表、幂等 no-op（**`write` 调用次数**）、
  `applyPatch` 的字段保全与判据来源、层边界源码级护栏（单向依赖 / `@/config` 出口白名单）。
- `tests/unit/admin/cli/` — 同一批操作**经传输层**的行为（表头 / 文案 / 退出码 / 字段保全），
  以及「零 console / 零 process.* / 不 import 代理侧」那组**覆盖两层**的源码级断言。
