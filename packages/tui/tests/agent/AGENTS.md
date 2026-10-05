# tests/agent/ — 对话那一圈（`@/lib/agent.ts`）的判据

本目录只答一件事：`@/lib/agent.ts` + `@/services/model.ts` + `/batch` 扇出这一圈，**哪几处不许漂**。
机制与层不变量归 `packages/tui/src/lib/AGENTS.md`（`agent.ts` 那几条）与
`packages/tui/src/services/AGENTS.md`（`model.ts` 那个拨号点）。

## 锁什么（四条不变量，每条都配了变异实测）

① ⚠️ **模型绝不许拿到 HTTP client**：它输出的是一条 `Command`，而那条命令能打的地址
   **恒等于** `COMMAND_SPECS` 里有的那些 —— 判据是「模型那一侧的源码里没有 client / token / URL」
   加上「模型看得到的那几段里没有一个字节是控制面凭据」。
② **工具说明与命令表永不漂**：那份表**从 `COMMAND_SPECS` 现算**，故加一条命令它自动跟着走；
   判据是「digest 的每一行都能在表里找到」+「表里每一条命令都在 digest 里」。
③ ⚠️ **模型输出逐字段校验**：`commandOfReply` 走的是 `parseLine` —— 同一个判据、同一张表。
   校验失败的表现**必须看得见**，而静默丢掉是最坏的一种。⚠️ **零兼容在模型这一侧同样成立**：
   表里删掉的那几条命令模型**也挑不到**（它完全可能照旧习惯回一句 `/user add alice`）。
④ **key 零泄露**：模型看得见的那几段对话里一个字节的凭据都没有（`messagesOf` 只取 `user` / `assistant`，
   而请求体里没有 `token` 也没有地址）。⚠️ **打码那一道（`maskEcho`）与回显重建那一道跟着命令表搬了家** ——
   带凭据的那几条命令进了弹窗，而弹窗不回显，故这两道牙现在在 `@/lib/log/rows.js` 与弹窗那一侧；
   执行层的回显**逐字**是用户敲的那一串（留痕的命令里没有一条带凭据）。

## 为什么不用真 `http.Server` 收模型那一头

那要额外起一个服务，而本目录要验的是「模型看得见的面上有什么」与「模型输出怎么被校验」——
前者读请求体就够，后者是纯函数。对真 server 的端到端（控制面那一侧）是
`tests/client/` 的那些档，不在这里重复付。

## 文件（⚠️ 不变量编号 ↔ 位置对照）

- `model-view.test.ts` — **不变量 ① + ②**，外加「判据自检」那一档（`codeOnly` / `maskEcho` /
  `leavesTrace` 三个探测器自身的牙齿，见下）。**模型看得见的那一面**：请求面里没有 client / 凭据 /
  端点表，加上那份命令说明从 `COMMAND_SPECS` 现算（⚠️ 含「弹窗那一族**也在** digest 里」与
  「删掉的那几条**不在**」那对断言 —— 合成一条的话任何一边坏了都看不出来）。
- `reply.test.ts` — **不变量 ③**。**从模型回一行到一条 `Command`**：`commandOfReply` 的输出与手敲
  `parseLine` 逐字同形、校验失败看得见（含**零兼容**：旧命令模型也挑不到）、往返轮数有上限。
  ⚠️ 不变量 ④ 只剩「请求体里没有凭据」那一道 —— 打码与回显重建**随那几条命令搬进弹窗了**。
- `batch.test.ts` — **不变量 ⑤ + ⑥**。模型挑出的那一条 `/batch` 的扇出：三档（全部成功 / 部分失败 /
  全部失败）与「一个挂了不影响别的」，加上那个 N 的来历（显式 / `all` / 空）。
- `_shared.ts` — 两档以上真用到的入参与常量（`SECRET_KEY` 与 `bareDeps`）。
- `AGENTS.md` — 本文件。

⚠️ 编号写在 `describe` 的标题里**且不许重排**：①②③④ 是模型那一圈的四条，⑤⑥ 是 `/batch` 扇出的两条，
而 `packages/tui/AGENTS.md` 与 `src/lib/AGENTS.md` 按编号指路。

## 防假绿的位置

- **① 的判据全是「读源码文本」，探测器认不出那个词时它们会在空集上通过** —— 故第一档是
  「扫描面不是空的」（`SRC.length >= 40` + `services/model.ts` 在里面），而 `codeOnly` 与
  `modelSideSources` 各自另有自检（`判据自检` 那一档）。⚠️ 深度是 `join(__dirname, "..", "..", "src")`：
  少一个 `..` 会解析到 `tests/src` 并抛 `ENOENT`，多一个会枚举到空集而**恒绿**。
- **反向自检不许省**：`manager-client.ts` 那一侧**确实**认 `ManagerClient` 且**确实**认 `ENDPOINTS`
  —— 少了这两条，「模型那一侧没有它」就是「探测器认不出这个词」。
- **② 判据钉在「行数」而不是「某一行文本」**：前者对「表变宽」敏感，后者对「某一行的措辞」敏感 ——
  两者要的是不同的东西，故两条都在。
- **③ 的轮数判据是 `ask` 的行为而不是源码文本**：数它**恰好**被请求了几次，另加一条「真的停在那儿了」
  的正向对照（否则前几条都在「一轮都没跑」的形状上恒绿）。⚠️ 替身在 `MAX_ROUNDS × 8` 次之后**直接抛**，
  那条不变量必须看得见，而「无限」不能变成一条挂死的测试。
- **⑤ 的加强版咬的是顺序**：`Promise.all` 或「catch 一次就整批 return」的实现在「顺序恒等于目标的顺序」
  那条上就红；而「某一台炸了」在真实路径上是 `depsFor`（`clientFor` 归一失败就抛）而不是 `exec`。
- **⑥ 判据逐个值语法档**（空词 / 大小写 / 引号 / 内层命令不对）：`all` 保留成**一个词**是「由上层对着
  台账展开」的契约，在这一层判它反而会逼出第二份展开逻辑。

## 相关路径

- `packages/tui/src/lib/agent.ts` — 被测模块：`ask` / `commandOfReply` 的那一圈 / `toolDigest` /
  `toolSpecs` / `MAX_ROUNDS`。
- `packages/tui/src/services/model/` — 第二个拨号点（provider）与 `messagesOf`（只取两档）；三种 API
  格式的分派在 `dispatch.ts`，逐字段的形状在 `tests/model-dialects/`。
- `packages/tui/src/lib/exec/index.ts` — `exec` / `leavesTrace` / `fanOut`（`/batch` 扇出）。
- `packages/tui/src/services/config/` — 本机台账里的 provider 清单与**打码出口** `redactProviderView`。
- `tests/client/` — 对真 `http.Server` 的端到端（控制面那一侧，不在本目录）。
- 根仓 `tests/unit/manager-tui-contract.test.ts` — 端点路径集合那道牙（**现列**两侧目录）。
