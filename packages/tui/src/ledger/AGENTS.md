# src/ledger/ — 控制面台账（多个 manager 端点的存盘与接线）

本包要连的是**多个**控制面端点，每个端点 = 一个 base URL + 一个 Bearer token。这个目录管的就是
「这份清单存在哪儿、长什么样、怎么改、怎么变成一个能发请求的客户端」，以及**启动时读回上次选中的
那个**（用户需求原话：「有状态，下次打开能够重连」）。

对外唯一出口：`@/ledger/index.js`（跨目录只引这一个 barrel）。

## 文件

- `types.ts` — 数据契约 `Target` / `Ledger` / `TargetInput` / `UpsertInput`，与数值边界常量
  （`DEFAULT_TIMEOUT_MS` / `TIMEOUT_BOUNDS` / `NAME_MAX_LEN`）。**零判据**。
- `path.ts` — 台账落在哪儿。`resolveConfigDir` / `targetsPath`，两个宿主参数都是**注入**的。
- `validate.ts` — 形状判据 + 本层唯一的失败类型 `LedgerError`。`validateLedger`（磁盘面）/
  `validateTargetInput`（用户输入面）。
- `store.ts` — 读 / 原子写 / 打码形态。`readLedger` / `writeLedger` / `redactTarget` /
  `REDACTED_TOKEN` / `TargetView`。
- `edit.ts` — **纯函数**编辑面：`slugify` / `idFor` / `upsertTarget` / `removeTarget` /
  `setSelected` / `selectedTarget`。
- `connect.ts` — 台账 → 客户端的**唯一**转换点：`clientFor` / `probeTarget` / `ProbeResult`。
- `index.ts` — 目录 barrel（只转发）。

机制与决策的完整推导在各文件头（`@fileoverview` / `@description`），这里只列**不变量**。

## 层不变量

- **读面「坏内容即拒」，绝不降级成空台账**。文件**不存在** ⇒ 空台账（首次启动，且**不**因此创建那个
  文件）；文件**存在但 parse / 校验失败** ⇒ 抛 `LedgerError`。⚠️ 降级成空台账是最坏的一种「体贴」：
  用户在界面上「重新加一遍」就会拿那份空台账覆盖掉那份好的，而丢的是控制面管理员凭据。
  牙齿：`tests/ledger.test.ts`「坏台账的错误文案」那组断言的是**抛错后原文件逐字未变**，不是「抛了没有」。
- **`LedgerError` 与 `TuiError` 是两件事，不许混用**。后者三档（wire / transport / shape）是**传输层**
  的失败词汇；一份本机文件形状不对与「连不上那个控制面」的排查方向完全相反。混用的后果是界面显示
  「连不上」，用户去查一台根本没问题的机器。故 `LedgerError` 只有 `unreadable` / `invalid-target` 两档，
  **文案随便改、`code` 不许增殖**；`readLedger` **只**抛 `LedgerError`（`normalizeBaseUrl` 的 `TuiError`
  在读面被换成前者）。
- **`selected` 指向不存在的 id 是报错，不是静默置 null**。静默置 null 会把「上次选中的端点不见了」
  显示成「你还没选过端点」，用户于是重走向导并把 `selected` 指到一个**新建**的端点上 —— 「上次那个」
  被永久顶掉，且无处可查。同理 `setSelected` / `upsertTarget` 指向不存在的 id 一律抛
  （否则那份文件会**再也读不出来**，连里面其余几条好端点一起赔进去）。
- **落盘的字节恒是校验过的形态**。`writeLedger` 先跑一遍 `validateLedger` 并写它返回的那份，故手改乱的
  `baseUrl` 在下一次写盘时被归一，且一份坏形状的台账写盘时**一个字节都不动**。
- **原子性 = `.tmp` + `rename`，且 `chmod` 必须在 `rename` 之前**。反过来会留一个「文件已是 0644 且
  token 已在里面」的窗口 —— 而那正是权限位唯一的作用所保护的东西。原子性的真实边界（Windows 先
  `rmSync` 再 `rename`，两步之间有极短的「文件不存在」窗口；并发写会互相覆盖）见 `store.ts` 文件头。
  牙齿：`tests/ledger.test.ts` 的「先 chmod 再 rename」记录**真实调用序列**（不依赖平台），
  「不残留 `.tmp`」断言目录内容（真目录，不是 spy）。
- **token 明文落盘，是结论不是疏忽**。没有可加密它的密钥（硬编码 = 等于没加密；存同机 = 与明文同一
  条攻击路径还多一个能丢的东西）；OS keychain 要原生依赖，与本包「只依赖 `ink` / `react` /
  `string-width`」的形态冲突。防线是三样：`0600` 文件 + `0700` 目录（POSIX，chmod 失败**不拦人**）+
  位置约定。与本仓 `cfg/users.json` 里明文存密码同纪律。⚠️ 因此 **token 绝不进日志、绝不进错误文案**：
  本目录的判据与文案里没有一处引用它的内容，连「token 为空」都只说「为空」。
- **打码只有一份出口**（`redactTarget`），且**绝不**返回半截明文 —— 「前 4 位 + 星号」砍掉的是密钥的
  有效长度，不是遮住它。牙齿：逐个 4 字节窗口验。**空串保持空串**（不是星号）：「没配」与「配了但
  不给你看」是两种不同的事实。
- **`baseUrl` 的判据只有一份**（`@/api` 的 `normalizeBaseUrl`），三个地方各过一次、绝不重打：
  输入面（落盘前归一）、读面（读出即归一，故手改的尾斜杠不会变成一个 404）、`clientFor`（台账与
  `Target` 都可能被手改 / 内存里直接构造）。两份判据漂了就是「界面说合法、落盘判非法」。
- **`token` 的字符集判据在本层不存在**。服务端比的是 SHA-256 摘要（`timingSafeEqual`），任何字节都合法，
  本层再造一份就是一份会漂的假约束。本层只判「非空」（空 token 恒 401，存一条永远连不上的记录等于
  骗用户「加上了」）与「端部空白 trim」（服务端 `BEARER_TOKEN` 以 `$` 锚定，尾随空白让它恒 401，而复制
  粘贴带上一个换行是常态）。
- **`id` 是稳定身份、`name` 是可变显示名**。改名字 / 改地址 / 改 token 都不改 id —— id 是 `selected`
  指的那种引用键，改了它等于「下次打开连到另一个端点」。`id` 的来源是 {@link ./edit.ts:idFor} 的 slug
  - 递增避让，**不是**随机后缀（人读 slug 的全部价值是「看一眼就知道这条是谁」）。
    `slugify` **幂等**是契约：不幂等则「已存在的 id 是怎么来的」这条推理会在重算时给出另一个答案。
- **`edit.ts` 的每个函数都是纯函数**：不改入参、不做 IO、不重新判一遍形状之外的东西。牙齿：
  「入参一个字节都没改」那几组拿入参的 JSON 快照对比。
- **探活不 re-throw**。`probeTarget` 的问题是「连上了吗」而不是「能不能连上」——后者**包含**前者为假的
  情形，而「manager 还没起」是一种**常态答案**。故结果是判别联合，`TuiError` 三档原样交给界面；
  非 `TuiError` 的异常**照旧往上抛**（那是本包的 bug，探活替它兜住就等于让编程错误伪装成网络失败）。
- **零 `console`、零 `process.*`**。`resolveConfigDir` 的 `env` 与 `homedir` 都是注入参数，正是为了这条。
  牙齿：`tests/ledger.test.ts`「层边界」那组（带判据自检，防探测器写坏后恒绿）。
- **Windows 与 POSIX 走**同一条**配置目录规则**（`XDG_CONFIG_HOME` → `~/.config` → `proxy-tui`），
  **不接 `APPDATA`**。理由见 `path.ts` 文件头：接了会让台账分裂成 WSL 与 Windows 两份，而本工具连的是
  别的机器上的控制面、自己跑在哪台机器上与被代理的服务无关。代价（Windows 上它不在最顺手的位置）写在
  文件头而不是藏起来。相对 `XDG_CONFIG_HOME` 一律忽略（会被解析到 cwd = 台账位置取决于从哪敲的）。

## 未做（是「不变量」，不是「没来得及」）

- **不加密 token**（理由见上）。
- **不做并发写锁**。本包是交互式单进程工具，「两个人同时改同一份台账」是运维场景而非常态；那个契约
  只在 `store.ts` 文件头写明。
- **`readLedger` 没有大小上限**。`src/utils/json-file` 那层有，因为那份文件是运维手改的共享配置；
  台账是本机自己的文件，而读它的路径来自本包自己算出来的位置。
- **没有 `Ledger` 的字段级 patch**。端点写只有 {@link ./edit.ts:upsertTarget} 一个出口（整条替换），
  与 `src/ops` 那条「账号写只有一个入口」同纪律：在它之上发明 `patch(field)` 会让「哪些字段可 patch」
  在每个调用点各写一遍。
- **不迁移、不兼容**。`version` 是数字字面量 `1`，没有第二个版本也没有迁移层（本仓零兼容）：
  「版本不是 1」不是「旧版本」，而是「这份文件不是本包写的」，照实拒掉。

## 相关路径

- `@/api/index.js` — 本层唯一的下游依赖（`normalizeBaseUrl` / `ManagerClient` / `TuiError` /
  `StatusBody`）。⚠️ `Target` `extends ManagerEndpoint`，所以「台账的哪几个字段喂给客户端」这件事的
  答案只有一处：`connect.ts:clientFor`。
- 服务端侧的三条事实（不在本包、但判据以其为准）：鉴权 `src/manager/http/auth.ts`（空 token 恒 401、
  比 SHA-256 摘要、`$` 锚定）、端点表 `src/manager/routes/index.ts`、读面「坏内容即拒」的同源纪律
  `src/ops/AGENTS.md`。
- `src/utils/json-file/write.ts` — 原子写的**真实边界**（`.tmp` + `rename`、Windows 先删后改、
  并发写互相覆盖），本目录的 `writeLedger` 是它的同构实现（额外多一步 `chmod`）。
- 消费方（本包内）— `src/cli.tsx`（组合根：注入 `process.env` / `os.homedir()`，决定何时写盘）。

## 相关测试

- `packages/tui/tests/ledger.test.ts` — 真文件 + 真临时目录、零网络（探活那几组用注入的 `fetch`）。
  覆盖：缺失 ⇒ 空台账且不造文件、坏 JSON / 坏形状 ⇒ 抛 `LedgerError` **且原文件逐字未变**、
  write→read 往返、POSIX `0600`/`0700`（win32 `skipIf` + 写明理由）、先 chmod 再 rename 的调用序列、
  无 `.tmp` 残留、slugify 幂等 / `idFor` 递增 / upsert 不改入参 / 替换保 id 保位置保 selected /
  remove 清 selected / setSelected 指向不存在则抛、输入面拒 15 种坏输入、token 字符集零约束、
  路径注入（XDG 命中 / 回落 / 相对值忽略 / Windows 不接 APPDATA）、打码逐窗口、
  probe 四档（ok / transport / wire 401 / shape）+ 非 TuiError 照旧抛、以及层边界源码级那组
  （零 console / 零 process.* / 内部不自我引用 barrel / barrel 只 export，全部带判据自检）。
