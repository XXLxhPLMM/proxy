# tests/unit/ — 不起监听、不拨号那一半

判据目录（目录级说明见 `../AGENTS.md`）：构造对象直接调的纯逻辑，加上一批读源码文本的边界断言。
逐档清单不在本文件 —— 它住在**该档所在主题目录**的 `AGENTS.md` 里，见下面那张对照表。

## 目录 ↔ `src/` 对照

一个主题目录对应 `src/` 的一层（`src/` 内部的机制与层不变量归 `src/**` 各自的 `AGENTS.md`）。

| 主题目录 | 它答什么 | 判据在哪个文件 | 往下：哪几级子目录带 `AGENTS.md` |
|---|---|---|---|
| `admin/` | `proxy-cli`（账号 / 名单 / 用量）的传输层、账号写族的字段保全、读面坏内容即拒 | `src/admin/` | `admin/cli/` |
| `config/` | 外部输入怎么变成配置 / `users.json` 能不能被读成可信账号表 / 配置状态只存在于实例里 / 拼错的键还有没有机会静默生效 | `src/config/` | `config/auth-users/` `config/loader/` `config/store/` `config/unknown-keys/` |
| `core/` | 依赖承载体 / 错误边界 / 事件内核 / 日志词汇 / 终态守卫 / 逐请求状态 / 转发两轴 / 入站那一侧 | `src/core/` | `core/access-control/` `core/events/` `core/forward/channel/` `core/forward/upstream/` `core/forward/upstream/connector/` `core/helpers/` `core/identity/` `core/request-scope/` `core/server/` |
| `datasource/` | 一份 `acl.json` 怎么被读进、判成放行或拒绝、又装成驱动 / 账本的判定侧、驱动抽象、sqlite 本体 / 账号表端口的等价性 / 目标物化 | `src/datasource/` | `datasource/acl/` `datasource/quota/` `datasource/quota/drivers/` `datasource/quota/sqlite/` `datasource/users/` |
| `library/` | 包入口 `@/index.js` 的导出面与库模式用法 | `src/index.ts` | — |
| `manager/` | 控制面装配点起不起来 / 端点表与 TUI 那侧还对不对得上 / 配置层 fail-closed / 传输面契约 | `src/manager/` | `manager/config/` `manager/http/` |
| `meta/` | 跨主题的仓级护栏：测试零外网、Node 运行时地板零漂移 | ⚠️ **不判某个 `src/` 模块**，判的是整棵树 + `package.json`；两个扫描器都在 `../helpers/` | `meta/runtime-floor/` |
| `ops/` | 数据源操作层交出去的东西不许变成某一个界面的实现细节 | `src/ops/` | — |
| `packaging/` | tarball 与五个 standalone zip 里装了什么、`files` 白名单与打包脚本的源码面有没有被改坏 | ⚠️ **不判 `src/`**，判 `package.json` + `build.mjs` + `scripts/package-dist.mjs` + 真跑出来的产物 | `packaging/npm-pack/` `packaging/zip/` |
| `runtime/` | 库调用方拿到 `createProxyRuntime(...)` 之后的装配决策与依赖从哪儿来 / core 的请求期事实怎么变成公共事件面 | `src/runtime/` | `runtime/bridge/` |
| `utils/` | 地址文本的语法层 / `readJsonCached` 的读面 / logger 的分级与渲染 / TLS 证书加载 | `src/utils/` | `utils/addr/` `utils/json-file/` `utils/logger/` |

⚠️ **`library/entry.test.ts` 与 `../library/entry.test.ts` 同名而判据不同**：前者从源码视角
（`@/index.js` 的导出面 + 库模式用法），后者从消费方视角（只从包入口 import，双向穷尽 + import 期零副作用）。
改一个不许顺手改另一个。

⚠️ **真 socket 的唯一例外是 `manager/control-plane.test.ts`**（起在 `127.0.0.1` 的**随机端口** 0 上）——
判据是「装配点声称在监听而实际没监听」这条失效 mock 不掉：
「真的在监听」「端口真的被占」只有真 `listen` 才作数 —— mock 掉 `node:http` 的话，「装配点声称在听而
实际没听」这条失效完全看不见。本目录其余全部不起监听。

## 拆分纪律

⚠️ **一个主题一个文件夹**（上面那张表就是文件夹清单），**文件夹内部按子主题分档**
（`core/access-control/decision.test.ts`）—— 不许把两个主题塞进同一个 `tests/unit/<主题>/`。

⚠️ **一个文件夹里有两档以上时，主题级不变量归该目录的 `AGENTS.md`**（那是这个文件夹里所有档共用的
牙齿与那张变异表），**单档的文件头只留「这一档管哪一段 + 指向 `AGENTS.md`」**，否则拆一次档就把同一段
不变量抄成 N 份。⚠️ **只有一档的文件夹不建 `AGENTS.md`**（`core/guard/`、`library/` 这类：各自只有
一个 describe，拆不动也不该拆）—— 那份不变量就地住在那唯一一档的文件头里，多一跳只是让人多找一次。
**判据是「这段不变量有几档共用」，不是「目录里有没有 `AGENTS.md`」。**

⚠️ **档间共用的一起东西归该目录的 `_*` 前导模块或 `*fixture.ts`**
（`core/identity/_identity.ts` / `config/auth-users/_auth-users.ts` /
`core/forward/upstream/connector/_connector-open.ts` …）—— **不带 `.test.ts` 后缀的那些不会被
`vitest.config.ts` 的 `tests/**/*.test.ts` 收集**，所以放那儿不会变成一份空跑的空档。
⚠️ 它们**仍在零外网扫描面内**（那道护栏扫的是 `SCAN_DIRS` 下的一切 `.ts`），见下面白名单那一节。

⚠️ **走出 `tests/` 的相对路径一律从 `../helpers/source-scan.ts` 导出的 `REPO_ROOT` /
`TESTS_DIR` / `SRC_DIR` 派生**，**层数只许出现在那一个文件里**。判据是「每个文件自己往上数几级
`..`」天生不可靠：目录会继续往下嵌套而层数跟着调用点搬家。⚠️ 少一个 `..` 解析到 `tests/src` 抛
`ENOENT`（自己暴露），**多一个 `..` 枚举到空集则恒绿** —— 后者危险得多，因为它只会静静地不再判任何东西。

## 零外网白名单：为什么按主题分片

那张表会被多个 agent 并发改不同主题，**单文件必冲突**。故**分片粒度就是目标目录名，agent 边界 = 目标
目录**：条目本体住在 `../helpers/public-hosts/<主题>.ts`，一个 agent 只碰自己主题那一片，
`../helpers/external-network-scan.ts` 按固定顺序把各片拼成 `PUBLIC_HOST_ALLOWLIST`，断言按集合比对
（顺序只为了让 diff 里「谁动了哪一片」一眼可见）。逐片归属见 `../helpers/AGENTS.md` 那张表。

⚠️ **零条目的目标目录还没有片**：那片在第一次有文件带公网 host 字面量时才新建（命名
`public-hosts/<主题>.ts`），并在 `../helpers/AGENTS.md` 的表里补一行。

### 四条白名单纪律

断言侧（双向：未申报即红，**豁免失效也红**）在 `meta/no-external-network.test.ts`。

1. **`reason` 答「为什么它不建链」**，不是「这是什么」。「测试用」「不会真的连」不算理由
   （断言侧只卡长度下限，所以「那句话必须真的有信息」靠人读）。
2. ⚠️ **零公网 host 字面量的文件不建条目** —— 建了当场被判 stale。条目**按文件聚合**
   （一个文件一条、`hosts` 列多个），因为本仓的公网字面量高度聚集而理由往往是同一个事实；
   比对仍按 `(file, host)` 集合，所以「在已豁免文件里新加一个 host」照样变红。
3. **同一 `(file, host)` 对不许出现两次** —— 出现两次说明有人复制粘贴，放任会掩盖真实的第二个引用。
4. ⚠️ **目录内的 `_*` 前导模块与测试档同等对待**：它带 `.ts` 而不带 `.test.ts`，**仍在扫描面内**
   （`scannedFiles()` 收的是 `SCAN_DIRS` 下的一切 `.ts`）。所以 `core/identity/_identity.ts` 这类
   模块一旦带公网 host 字面量，**要按它自己的路径单独建一条** —— 挂到旁边那档的条目上不算申报。

⚠️ **分片粒度是目标目录，不是来源文件**：一个档的条目可能落在两片里（当它跨了两个目标目录），
此时**两片都要动**。反过来，带公网 host 的 `_*` 前导模块**不许外提到 `../helpers/`** ——
`helpers/` 不在 `SCAN_DIRS` 里，搬进去等于让这道护栏对它彻底失效且一声不吭。**看得见的副本优于
看不见的失效。**

## 相关路径

- `../helpers/source-scan.ts` — 源码级断言的公共文本面 + `REPO_ROOT` / `TESTS_DIR` / `SRC_DIR`。
- `../helpers/external-network-scan.ts` — 零外网扫描器与白名单拼接。
- `../helpers/config.ts` — `testConfigStore` / `restoreConfig` / `silenceLogs` / `KEYS` 快照表。
- `../setup-env.ts` — 每个档都跑的环境预置（清宿主噪音、把账本与名单钉到临时目录）。
- `../AGENTS.md`、`../integration/`、`../library/`。
