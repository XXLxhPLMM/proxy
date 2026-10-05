# tests/unit/manager/ — 控制面那一族

本目录只答一件事：**控制面（`src/manager/**`）那一圈的三份判据**——
它装配时能不能起来（`control-plane`）、它对外声明的端点表与 TUI 那侧是否还对得上（`tui-contract`）、
以及它的配置层 fail-closed（`config/`）。传输面契约（鉴权真值表 / 状态码 / 零泄露）在 `http/`。

机制与层不变量归 `src/manager/AGENTS.md`、`src/manager/routes/AGENTS.md` 与
`src/config/AGENTS.md`；`config/` 那一族自己的不变量在 `./config/AGENTS.md`。

## 目录级共用的两条

① **控制面与数据面共用同一份 `loadConfig` 快照与同一个生命周期** —— 控制面**不是第三个入口**：
它与数据面同进程，拆成第二个进程只会让「控制面看到的配置」与「代理跑着的配置」之间出现漂移空间；
启用方式是配置项（`MANAGER_ENABLED`）不是另一个命令。牙齿：`control-plane.test.ts` 的
「走的是**服务进程那一份**配置」（argv 覆盖的值在 `/api/config` 里原样可见）—— 控制面若自己再
`loadConfig` 一次且 argv 传空，`--auth-users-file` 这类 CLI 覆盖就只改到数据面，
而那正是「代理跑的是 A、这边改的是 B」这条事故。

② **端口 / 凭据 / 监听地址这三样是配置层 fail-closed 的三个出口**（`./config/AGENTS.md` ①②③）：
未启用 ⇒ `null` 且零副作用；启用 ⇒ 真的在监听且看到**注入进来的**那份数据面事实；`listen` 失败必须
抛且 `EADDRINUSE` 那条含修法（静默继续 = 运维以为控制面开着而它根本没开）。⚠️ 空 token 那条是
**双保险**：配置层那道闸门被移除时，装配点这一侧仍不许开着大门。牙齿：`control-plane.test.ts`。

## 防假绿的位置

- **`tui-contract` 的判据天生怕空**：两侧都抠不出东西时 `[]` 集合**天然相等**，探测器一个正则字符
  写错就让整档安静地永远通过。故它自带三组牙：判据自检（合成脏文本里那 3 条端点**真的被抠出来**
  （证明它看得见，而不是恒返回空）/ 被换行拆开的 `method` / `path` **仍然抠得出来**（证明跨行那一档
  不是死代码）/ **缺 `path` 的 `method` 不会与后一条的 `path` 配成一对**（证明配对窗口被「不许跨过
  下一个 `method:`」这条否定向望约束住了 —— 那正是把两条端点错配成一对的形状）/ 注释里写的端点
  不参与判定（`codeOnly` 真的在生效；`routes/index.ts` 的文件头里就有一张端点表的 markdown，
  若不去注释它会成为第二个真相源）/ 空文本取零条）+ 覆盖面（**两侧各自目录现列的文件数** +
  两侧取到的**条数各一条下界** —— 目录被清空 / 路径写错时**立刻红**，而不是让整档变成「空集相等」）
  + 核心的双向集合相等。
  ⚠️ **两侧都现列**而不是各手写一份文件名清单：手写那份一旦漏了新文件，后果是**静默少判一条**
  （两侧都少，集合照样「相等」）。
- ⚠️ **两侧的 `(method, path)` 都从源码文本现取，不从任何一侧 `import`**：跨包 `import` 共享契约表
  会抹掉**网络两端版本可以不同**这个现实（TUI 连的是别的机器上那个进程，那个进程可能跑着旧版本
  服务端）。契约是**手抄的、有测试兜着的弱耦合**，刻意不是编译期绑定（理由写在
  `packages/tui/src/api/endpoints/index.ts` 的文件头里）。推论：**「两边今天还对得上」这件事绝不能
  靠 import 保证** —— 唯一可靠的证据是两侧文本里那两张表**逐条相等**，而这份相等必须由本档实时验证。
- **本档管路径集合**（`method` + `path` 逐条相等）：手抄的表在**集合**层漏一条 / 多一条 /
  拼错动词，立刻红。**字段形状由 `packages/tui/src/api/wire.ts` 的 `WireContractAssertions` 管
  （编译期）** —— 那是 TypeScript 类型层的单向可赋值性断言，锁的是「响应体逐字段同形」；
  `tui-contract` 只管路径集合 —— **两个包互不代替**：本档管不到字段形状（它只读文本，
  不 import 也不运行 TUI 的类型），那一半的失效模式是 `pnpm --filter @b-hole/proxy-tui typecheck` 红。
- **判据形状**：从一处现取一份表，跟另一处比对；探测器把一段文本里全部 `{ method: "…", path: "…" }`
  抠成 `(method, path)` 对，**同一个探测器同时喂给两侧** —— 两套解析器就等于两份可以各自漂的判据。
- ⚠️ **刻意的口径收窄**（写明理由，别当成漏检）：
  - **锚在「`method` 在前、`path` 在后」这一排版形状上**：反过来排版（`path` 先写）的那条端点
    抠不到，会表现为「本档报少了一条」—— 失败信息里逐条列了缺哪一条，人一眼能看出该改哪。
  - **窗口 80 字符且不许跨过下一个 `method:`**：窗口开大是为了吃住格式化后的换行与缩进；
    否定向望是为了**不跨到下一个对象把两条端点配成一对**。两者缺一都会造出「条数看着正好、
    其中一条的方法名却是错的」这种没人看得出的表格。
- **`control-plane` 的牙齿全在真 socket 上**：「真的在监听」「端口真的被占」只有真 `listen` 才作数
  （端口 0 → 真实分配；第二个 server 绑同一个固定端口 → 真 EADDRINUSE）。mock 掉 `node:http` 的话
  这两条全恒绿。
- ⚠️ **本目录不走 `__dirname`**：`../../helpers/source-scan.ts` 已导出 `REPO_ROOT` / `TESTS_DIR` /
  `SRC_DIR`，层数只许出现在那一处。少一个 `..` 抛 `ENOENT`（自己暴露），
  **多一个 `..` 枚举到空集则恒绿** —— `tui-contract` 那道互锁的失效形态**恰好就是后者**
  （两侧目录枚举落到空集 → 集合天然相等 → 整档永远绿）。**改路径层数时先跑一遍那档。**

## 文件

- `control-plane.test.ts` — 装配点那三件事（未启用 ⇒ `null` / 启用 ⇒ 真在监听且看到注入的数据面事实 /
  起不来必须抛），加上「同进程里只允许一份配置快照」那条纪律。
- `tui-contract.test.ts` — **控制面 ↔ `@b-hole/proxy-tui` 的端点表互锁**：两侧 `(method, path)`
  分别从源码文本现取再比集合（**不从任何一侧 import**）。判据自检 + 覆盖面下界 + 双向相等三组牙，
  推导与取舍见本文件「防假绿的位置」（单档文件头只留「这一档答什么」，理由见
  `../../meta/comment-budget/AGENTS.md`）。
- `config/AGENTS.md` — 管理面五个配置键的配置层判据（键名 / 相位 / 撞车 / 空 token / CORS 语法 /
  快照脱敏 / 未知键闸门）。
- `config/` — 上面那一族的 5 档 + 1 个共用前导模块。
- `AGENTS.md` — 本文件。

### ⚠️ 交回收尾批次：`http/` 那 8 档

`manager/http/` 由另一组并发写入（传输面契约：真 `http.createServer` 起在端口 0、鉴权真值表、
404 / 405 区分、body 上限、`OpsError.code` → 状态码五档真值表、零泄露、`/api/status` 现读真值、
无 restart 残留，以及覆盖 `http/` + `routes/` 两目录的源码级护栏）。

**本文件刻意不登记那 8 档** —— 并发写同一个文件必冲突。收尾批次需在本文件补：
① `http/` 那 8 档的条目（`AGENTS.md` / `auth` / `cors` / `routing` / `acl-entry` / `errors` /
`status` / `endpoints` / `source-guards`）；② 传输面那一族自己的不变量段
（`writeHead` 之后再 `setHeader` 不生效 / `Content-Length` 与实际字节一致 / 销毁连接的时机
这三样只有真 socket 看得见）；③ 与 `./config/` 与 `tui-contract` 的分工指路。

## 相关路径

- `../../../src/manager/control-plane.ts` — 装配点（`startControlPlane` / `ControlPlane`）。
- `../../../src/manager/routes/` — 服务端端点表的唯一来源（**现列**，`tui-contract` 的服务端一侧）。
- `../../../packages/tui/src/api/endpoints/` — TUI 侧端点表的唯一来源（**现列**，另一侧）。
- `../../../packages/tui/src/api/wire.ts` — 字段形状那一半（编译期，`WireContractAssertions`）。
- `../../../src/config/schema/validate.ts` — `assertManagerConfig`（`./config/` 那一族的被测面）。
- `../../helpers/source-scan.ts` — `codeOnly` + `REPO_ROOT` / `TESTS_DIR` / `SRC_DIR` 三个路径常量。
- `../../helpers/public-hosts/unit-manager.ts` — 本目录整片的零外网白名单（4 条）。
- `../AGENTS.md`、`../../AGENTS.md`、`../../../AGENTS.md`。