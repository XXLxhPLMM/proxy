# tests/helpers/ — 与主题无关的公共面

判据目录（目录级说明见 `../AGENTS.md`）：脚手架 / 替身 / 源码文本面 / 零外网扫描器与白名单。

⚠️ **本目录不在零外网扫描的范围内**（`SCAN_DIRS` 只有 `unit` / `integration` / `library`）——
放在这里的东西**带公网 host 字面量就是静默失效**：护栏对它一句话都不会说，而它看起来正在生效。
本目录的纪律是**不靠豁免掩盖能改掉的命中**（写法改得掉，就不要给它开豁免）。

## 文件

- `source-scan.ts` — 源码级断言的公共文本面：`codeOnly()` 去注释（换行保留 → 行号不漂）、
  `sourceOf()` / `codeOf()` / `sourceFiles()` / `blockAfter()` / `offendingLines()`，
  以及 **`REPO_ROOT` / `TESTS_DIR` / `SRC_DIR` 三个路径常量**（层数的唯一出处，见下）。
  ⚠️ **只去注释、不去字符串字面量**：字符串里出现被禁词汇往往正是要盯的泄漏形态。
  ⚠️ `sourceFiles()` 是**按目录现列一层**（适合「这一层不许有什么」），
  `src-files.ts` 的 `srcFilesRecursive()` 是**递归**（适合「全仓不许有什么」）—— 两者取舍是刻意的：
  现列那份漏了新增子目录时，「恰好 N 处」会**少算而照样绿**。
- `src-files.ts` — `srcFilesRecursive()`：`src/**` 全量 `.ts` 的递归清单（相对 `SRC_DIR`，
  可直接喂给 `codeOf()`）。
  ⚠️ 刻意用 `readdirSync` + `statSync` 的**字符串**形态，而不是 `withFileTypes` —— 后者每一项都要读
  它的 `name` 成员，而 `name` 正是 `external-network-scan.ts` 的 `PUBLIC_TLDS` 里的一项；本目录不在
  扫描范围内，那种写法会让这道护栏对本文件**彻底失效且一声不吭**。
- `external-network-scan.ts` — 零外网扫描器（两条断言面的素材出口 + 白名单的**拼接**；条目本体在
  `public-hosts/`）。自检样本 `SELF_CHECK` / `LITERAL_PROBES` **刻意住在这里**：断言档是被扫描对象，
  在里面写真公网 host 会把自己判成违规。
- `config.ts` — `testConfigStore` / `restoreConfig` / `silenceLogs` / `KEYS` 快照表。
- `proxy.ts` — `withProxy` 起停一整套代理的测试脚手架。
- `net.ts` — `getFreePort()` / `listen()` / `sleep()`。
  ⚠️ `getFreePort()` 是 `listen(0)` 再 `close()`，**有 TOCTOU 窗口**（关掉到真 listen 之间那个号可能
  被抢）—— 它降低撞车概率、不消除，而**硬编码端口在并行 fork / 同机多跑时必撞**。
- `upstream-stub.ts` — 本地源站桩（端口一律 `getFreePort()`，配套 `certs.ts` / `net.ts`）。
- `socks-client.ts` — 裸 SOCKS4/5 客户端。
- `access.ts` — 测试用 access / identity 替身。
- `certs.ts` — 仓内测试 PKI（`TEST_TLS_CERTS` / `TEST_CA_PATH`；对应仓库根 `keys/`）。
- `child-proxy.ts` — 「spawn 真 `dist/app.js` 子进程」那一套（`ensureDistBuilt` / `spawnProxy` /
  `baseArgs` / `waitForPort` / `stopChild` + `SPAWN_CWD` / `disposeSpawnCwd`）。
  ⚠️ **子进程就是独立进程，不与测试进程共享 store** —— 那正是生产上「代理套代理」的形态，in-process
  装配测不到串联时才出现的那几类形状。
  ⚠️ 它有两道**互相不能替代**的隔离：① `SPAWN_CWD` 刻意在 tempdir（cwd 在仓库里就等于每次 spawn 都
  吃开发者本地的 `.env.development`，**且没有任何提示**）；② `stripEnv` 按调用点申报剔除宿主
  `process.env` 里恰好同名的键 —— cwd 挪到仓库外**挡不住继承来的 env**。**「参数都走 CLI」顶替不了
  ①**：优先级里 env 文件**始终**被读入，只是被 CLI 覆盖的那几个键不出声。
- `runtime-floor-scan.ts` — Node 运行时地板的扫描器与判据自检样本。⚠️ 合成脏文本刻意住在本 helper：
  断言档是被扫描对象，在里面写真版本号会把自己判成违规。

## ⚠️ 路径层数只许出现在 `source-scan.ts` 那一处

**判据**：任何要走出 `tests/` 的相对路径都从 `REPO_ROOT` / `TESTS_DIR` / `SRC_DIR` 派生。理由是
「每个文件自己往上数几级 `..`」这件事天生不可靠 —— 测试目录会继续往下嵌套，而层数跟着调用点搬家。
**两个失效形态的危险程度完全不对等**：

- **少一个 `..`** → 解析到 `tests/src`，`readdirSync` / `readFileSync` 抛 `ENOENT`，**自己暴露**。
- ⚠️ **多一个 `..` → 枚举到空集，那条护栏从此恒绿**，且**一声不吭** —— 它只是静静地不再判任何东西，
  看起来仍然「在生效」。这是必须从常量派生、而不能靠人数的那个原因。

嵌套变深时只改 `source-scan.ts` 一处，调用点改的只是 import 层数。

## `public-hosts/` — 零外网白名单按目标目录分片

`external-network-scan.ts` 只负责扫描与**拼接**；**条目本体按目标目录主题分片**住在
`public-hosts/<主题>.ts`，每片导出一个 `readonly PublicHostEntry[]`。分片的理由是这张表会被多个
agent 并发改不同主题 —— 单文件必冲突；**分片粒度就是目标目录名**，每个 agent 只碰自己那一片。

| 片 | 归谁管（目标目录） | 导出的常量 |
|---|---|---|
| `public-hosts/unit-admin.ts` | `../unit/admin/` | `UNIT_ADMIN_HOST_REFS` |
| `public-hosts/unit-config.ts` | `../unit/config/` | `UNIT_CONFIG_HOST_REFS` |
| `public-hosts/unit-core.ts` | `../unit/core/`（含 `events/`） | `UNIT_CORE_HOST_REFS` |
| `public-hosts/unit-core-access-control.ts` | `../unit/core/access-control/` | `UNIT_CORE_ACCESS_CONTROL_HOST_REFS` |
| `public-hosts/unit-core-forward.ts` | `../unit/core/forward/`（`upstream/` 与 `upstream/connector/`） | `UNIT_CORE_FORWARD_HOST_REFS` |
| `public-hosts/unit-core-helpers.ts` | `../unit/core/helpers/` | `UNIT_CORE_HELPERS_HOST_REFS` |
| `public-hosts/unit-core-identity.ts` | `../unit/core/identity/` | `UNIT_CORE_IDENTITY_HOST_REFS` |
| `public-hosts/unit-datasource-acl.ts` | `../unit/datasource/acl/` | `UNIT_DATASOURCE_ACL_HOST_REFS` |
| `public-hosts/unit-datasource-users.ts` | `../unit/datasource/users/` | `UNIT_DATASOURCE_USERS_HOST_REFS` |
| `public-hosts/unit-manager.ts` | `../unit/manager/`（`http/` 与 `config/`） | `UNIT_MANAGER_HOST_REFS` |
| `public-hosts/unit-meta.ts` | `../unit/meta/` | `UNIT_META_HOST_REFS` |
| `public-hosts/unit-ops.ts` | `../unit/ops/` | `UNIT_OPS_HOST_REFS` |
| `public-hosts/unit-packaging.ts` | `../unit/packaging/` | `UNIT_PACKAGING_HOST_REFS` |
| `public-hosts/unit-runtime.ts` | `../unit/runtime/`（`bridge/` 与根层各档） | `UNIT_RUNTIME_HOST_REFS` |
| `public-hosts/unit-utils.ts` | `../unit/utils/`（`addr/` 与 `logger/`） | `UNIT_UTILS_HOST_REFS` |
| `public-hosts/library.ts` | `../library/` | `LIBRARY_HOST_REFS` |
| `public-hosts/integration-acl.ts` | `../integration/acl/` | `INTEGRATION_ACL_HOST_REFS` |
| `public-hosts/integration-forward-contract.ts` | `../integration/forward/contract/` | `INTEGRATION_FORWARD_CONTRACT_HOST_REFS` |
| `public-hosts/integration-forward-flat.ts` | `../integration/forward/` **平铺档**（`forward/*.test.ts`） | `INTEGRATION_FORWARD_FLAT_HOST_REFS` |
| `public-hosts/integration-forward-ohr.ts` | `../integration/forward/outbound-header-rewrite/` | `INTEGRATION_FORWARD_OHR_HOST_REFS` |
| `public-hosts/integration-upstream.ts` | `../integration/upstream/` | `INTEGRATION_UPSTREAM_HOST_REFS` |

⚠️ **本表刻意不写「每片几条」**：条数是那份导出的长度，而写死一个数只会在下一次加条目时变成一句谎话
（而读者会信它）。要看今天有几条，读那一份 `public-hosts/<主题>.ts` —— 它是唯一真相。
⚠️ **上表那一列常量名是编译期钉的**：`external-network-scan.ts` 逐个 `import` 它们并展开进
`PUBLIC_HOST_ALLOWLIST`，少一个导出或改一个名字就构建红。

⚠️ **零条目的目标目录还没有片**：那片在第一次有文件带公网 host 字面量时才新建（命名
`public-hosts/<主题>.ts`），并在上表补一行。⚠️ **主题目录里带公网 host 的 `_*` 前导模块也在扫描面内**
（那道护栏扫的是 `SCAN_DIRS` 下的一切 `.ts`），所以它带字面量时要**按自己的路径单独建一条** ——
挂到旁边那档的条目上不算申报。

⚠️ **分片粒度是目标目录，不是来源文件**：一个档的条目可能落在两片里（当它跨了两个目标目录），
此时**两片都要动**。反过来，带公网 host 的 `_*` 前导模块**不许外提到本目录** ——
本目录不在 `SCAN_DIRS` 里，搬进来等于让这道护栏对它彻底失效且一声不吭。
**看得见的副本优于看不见的失效。**

**纪律（`reason` 答什么、零字面量不建条目、`(file, host)` 不许重复）与断言侧的双向判据**
在 `../unit/AGENTS.md`「四条白名单纪律」那一节；行为面断言在 `../unit/meta/no-external-network.test.ts`。

## 相关路径

- `../unit/meta/no-external-network.test.ts` — 零外网扫描的行为面断言（双向：未申报即红、豁免失效也红）。
- `../setup-env.ts` — 每个档都跑的环境预置（它 `import` 本目录的 `config.ts` 来钉值）。
- `../http-test-server.mjs` — 本地吞吐源站脚本。
- `../unit/`、`../integration/`、`../library/`、`../AGENTS.md`。
