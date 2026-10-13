# AGENTS.md — `@b-hole/proxy-tui`（控制面终端控制台）

独立 pnpm 包（`type: module`、`bin: proxy-tui → dist/cli.js`）：回答「怎么在终端里驱动
**别的机器上**那个控制面」。机制细节归各目录 `AGENTS.md`；`src/` 内的分层地图见
`src/AGENTS.md`。本文件只记**包这一层**的不变量。

## 依赖全在 bundle 里，`dependencies` 刻意为空

产物 `dist/cli.js` 由 esbuild **完全内联**（`build.mjs`），运行期只 import `node:` 内置模块，**不解析任何 npm 包**
（护栏：把 `dist/cli.js` + `dist/node-sqlite3-wasm.wasm` 复制到无 `node_modules` 的空目录，`node cli.js` 仍能跑起来）。
故 `package.json` 的 `dependencies` **是空的**，那些第三方依赖全归 `devDependencies`（构建期用，打进产物即止）。
连 `node-sqlite3-wasm`（降级档驱动）也是 devDependency：胶水层 JS 被静态 import 内联，`.wasm` 二进制
由 build 复制到 `dist/` 旁边（emscripten 用 banner 注入的 `__dirname` 定位它）。
⚠️ 代价：wasm 在**模块顶层**实例化（≈24ms），走 builtin 档的用户也付这笔——换来别人装包不必带任何东西。
⚠️ 改动 `packages` / `alias` / `banner` 后自查内联是否还成立：`grep -oE 'require\("[a-z@][^"]+"\)' dist/cli.js`
应当无外部包命中。

⚠️ **内联会把依赖的语法下限拖进产物**：external 档下依赖留在 `node_modules`，老 Node 只是加载到那个
包时才炸；内联后它的语法被固化进产物，**加载期就炸**。⚠️ **`engines.node` 的下限是 22，而抬它的是
`@ai-sdk/mcp`（`agents/mcp/` 那圈唯一的第三方依赖）——它声明 `engines.node >= 22`**；那是今天唯一一条
把下限顶上去的依赖，降级它等于放弃 MCP 那圈，不是「顺手改个版本」。⚠️ **`string-width` / `slice-ansi`
那两个 root `pnpm.overrides` 现在已是冗余的**（它们当初是为「保 18」下的），**但别顺手拆**：拆了会改动
产物里 ink 一族的语法下限，属另一件事，要单独验。自查：`grep -oE '"v"\)' dist/cli.js` 应当 0 命中。
⚠️ **语法能降、运行时全局降不了**：`target` 只管语法，`TransformStream` / `structuredClone` / 全局
`fetch` 这类**全局**是另一回事（Node 18 才齐）。加新依赖前先问它用了哪些「Node 22 之前没有的全局」
——devDependencies 里的 `ai@7` 就要 `TransformStream` + 全局 `fetch`，是这条判据的现成例子。
新增依赖还要查它有没有「比 `engines` 更新的语法下限」，升级后用 `/e/envs/nvm/v22 / v24` 各跑一遍产物。
⚠️ **`@ai-sdk/mcp` 还拖进来一条 `cross-spawn`（CJS）**：它动态 `require("child_process")`，
全靠 `build.mjs` banner 注入的 `createRequire` 才活得下来——banner 少那一行，产物**加载期**就抛
`Dynamic require of "child_process" is not supported`（这也是任何探针脚本照抄 banner 的原因）。

## 冷启动：bundle 是默认，external 是排查档

import 阶段从 ≈1.46s 降到 ≈0.20s（7 倍），代价是产物 21KB → 755KB（本包不分发，体积无所谓）。
`pnpm build:ext` 可切回 `packages: "external"` 排查「某依赖没被内联」。理由与两个必补的坑
（banner 注入 `createRequire`、stub 掉 ink 的 DEV-only devtools 路径）见 `build.mjs` 文件头。

⚠️ **重构空白期**：`src/` 现有 `api/`（控制面契约 + 拨号）、`lib/`（零 IO 纯函数层）、`config/`（本地配置：装载 + 默认值 + `get`/`set`/`reload`）、
`db/`（本地库底座）、`service/`（业务服务层）、`agents/`（工具注册表 + MCP 加载器）与 `starter/`（Cordis 启动器：建根 + `plugins/` + `presets/`）；入口 `src/cli.ts` 是组合根（建树即交给 Ink 接管退出，**自己不等信号**）。
整棵应用是 Cordis 插件树（`starter` 建根；配置 → 本地库 → 行操作目录 → 业务服务是头几个服务，api / 状态层 / UI 按 `inject` 挂上、由容器排序），
插件的服务类型声明按惯例住在各自文件里。

## Commands（在本目录跑；根仓经 `--filter @b-hole/proxy-tui` 点名）

```
pnpm build         # node build.mjs：src/cli.ts → dist/cli.js（每次先清空 dist/；内联依赖，默认档）
pnpm build:ext     # node build.mjs --external（依赖不内联；只用于排查「某依赖没被打进去」）
pnpm dev           # build --dev && node dist/cli.js（dev = 不压缩 + sourcemap）
pnpm start         # node dist/cli.js（要真 TTY）
pnpm lint          # eslint ./src --ext .ts,.tsx
pnpm typecheck     # tsc --noEmit（bundler 解析，@/* → src/*）
pnpm test          # vitest run --passWithNoTests（快速阶段：空跑恒绿，不新建 tests/）
```

- 顺序 `lint → typecheck → test → build`（快速阶段 `test` 为空跑，验证靠 `lint/typecheck/build`）。根仓同名三条会串行带上本包。
- ⚠️ **动了 `src/` 必须重建本包**：根 `pnpm build` 只建根包，碰不到 `dist/cli.js` ⇒ 只改子包时
  「四条全绿」是假信号。自查：`dist/cli.js` 的时间戳比 `src/` 里最新的文件新。**别为此加单测**
  （test 跑在 build 之前）。
- `build.mjs` 纪律：`format: "esm"` 硬要求（理由在 `build.mjs` 文件头）；`banner` 的 shebang 不许掉（掉了就是
  `Bad interpreter`）；⚠️ `process.env.APP_VERSION` 必须**逐字**写（`{...process.env}["APP_VERSION"]`
  会绕过 esbuild `define`，产物里是 undefined）；`ESBUILD_WORKER_THREADS=0` + watch 常驻进程只
  `fs.watch src/` 再起一次性子进程构建（Windows + Node22 加载 esbuild 原生模块偶发无输出崩溃，
  退出码 `3221226505` 即使产物已写出也按成功处理）。

## 快速验证阶段（本包无 `tests/`，不新建）

- 本包没有 `tests/`，`pnpm test` 是 `--passWithNoTests` 空跑；验证只有三条：
  `pnpm lint` → `pnpm typecheck` → `pnpm build`。任何指向 `tests/` 的「牙齿」在无测试阶段都不可用，
  要接回哪一条以那时的代码为准。

## 文档写不变量，不写变更日志

- **AGENTS.md 记「今天这套代码为什么长这样」，不记「我这几轮改了什么」。** 删任何一行前问：**① 删掉它，
  今天的判断会变吗？② 它在讲代码，还是在讲过去某次对话？** 「实测踩过一次」「上一版写的是 X」这类变异
  记录与前后对照**一律不进文档**——它们是工单，读的人不接下一棒。
- **唯一该留的残留物是「负载在哪」**：一句话说清「改坏 X ⇒ 哪条断言会红」。


