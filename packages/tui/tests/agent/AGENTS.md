# tests/agent/ — 对话那一圈（`@/lib/agent.ts`）的判据

本目录只答一件事：`@/lib/agent.ts` + `@/services/model.ts` + `/batch` 扇出这一圈，**哪几处不许漂**。

## 为什么不用真 `http.Server` 收模型那一头

那要额外起一个服务，而本目录要验的是「模型看得见的面上有什么」与「模型输出怎么被校验」——
前者读请求体就够，后者是纯函数。对真 server 的端到端（控制面那一侧）是
`tests/client/` 的那些档，不在这里重复付。

## 防假绿的位置

- **① 的判据全是「读源码文本」，探测器认不出那个词时它们会在空集上通过** —— 故第一档是
  「扫描面不是空的」（`SRC.length >= 40` + `services/model.ts` 在里面），而 `codeOnly`（`../_source.js`）与
  `modelSideSources` 各自另有自检（`判据自检` 那一档）。⚠️ 深度是 `join(__dirname, "..", "..", "src")`：
  少一个 `..` 会解析到 `tests/src` 并抛 `ENOENT`，多一个会枚举到空集而**恒绿**。
- **反向自检不许省**：拨号那一侧（`api/send.ts`）**确实**认 `ManagerTarget` 且**确实**在拨号 ——
  锚在**今天仍然存在的形状**上（`axios.request(`），**不是**「它引用了某个端点名」：
  后者会在端点搬家那一刻恒红，而那与本条要护的东西（模型侧不许认契约）毫无关系。
- **② 判据钉在「行数」而不是「某一行文本」**：前者对「表变宽」敏感，后者对「某一行的措辞」敏感 ——
  两者要的是不同的东西，故两条都在。
- **③ 的轮数判据是 `ask` 的行为而不是源码文本**：数它**恰好**被请求了几次，另加一条「真的停在那儿了」
  的正向对照（否则前几条都在「一轮都没跑」的形状上恒绿）。
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
