# packages/tui/ — `@b-hole/proxy-tui`（控制面终端控制台）

本目录是一个**独立的 pnpm 包**（`@b-hole/proxy-tui`），不是根包的一部分代码。为什么要拆成两个包
（依赖面 / 分发形态 / 收尾命令）写在根 `AGENTS.md` 的「两个包」一节，**不在这里复述**。

## 文件

- `package.json` — 包名 `@b-hole/proxy-tui`、`private: true`、`type: module`、`bin.proxy-tui → dist/cli.js`；
  运行期依赖只有 `ink` / `react` / `string-width`（**React 是纯前端运行时**，这就是它不能进根包依赖的理由）。
- `build.mjs` — 本包自己的 esbuild 调用（`src/cli.tsx` → `dist/cli.js`），**不用 tsc**。
- `tsconfig.json` / `vitest.config.ts` / `.eslintrc.cjs` — 本包三件套；`@` 别名指向**本包的 `src/`**，
  与根包的 `@/` → `src/` 是两套互不相干的别名。
- `AGENTS.md` — 本文件（包级说明）。

## 子目录

- `src/client/` — 控制面 HTTP 客户端：`endpoints.ts` 那张端点表、`types.ts` 手写接口、
  `wire.ts` 的字段判据、`decode.ts` 的组合子、`client.ts` 的请求实现。**本包唯一拨号的地方在 `client.ts`**，
  其余模块都只做纯变换。
- `src/ledger/` — 本地台账（控制面目标的存盘与校验）到客户端的接线；`connect.ts` 是唯一的转换点。
- `src/ui/` — 排版与着色的判据 + 终端设施（详见下）。
- `tests/` — 本包的 vitest 档（`pnpm test:tui`）。
- `dist/` — `build:mjs` 的产物（gitignored）。**不在** npm tarball 里，也不在运行时地板扫描面里。

各子目录的机制细节以各自的 `AGENTS.md` 与源码文件头为准（`@fileoverview` / `@description` 块），
本文件不抄。

## 一屏长什么样

**全屏接管**（`?1049` 归 Ink，本包自己管光标显隐与鼠标上报），**不是**「终端里的几个面板」：

- **屏顶没有横向区域**（会话级事实全在底部状态行的右半）；
- 左侧边栏 = 台账里的控制面清单，**可点**，选中的那一行有 `▍` 记号 + 一段连续反底色；
- 右侧主区**上下分栏**：上半是命令结果（**可滚**，滚轮与 `PageUp`/`PageDown` 都行），下半是输入区
  （输入行 + 一行瞬时消息 + **底部状态行**：左边当前控制面的地址与端口，右边版本号与控制面数量）；
- ⚠️ **输入行里有一个 `/` 时，上半被**命令面板**接管**：逐行「命令名 + 说明」，可上下走，`Tab` 或
  鼠标点接受。**判据只有「以 `/` 开头」这一条**（光标在哪都不影响），而它带出来的不变式是
  「面板开着 ⇒ `↑`/`↓` 归面板、滚轮滚面板」—— 否则同一个键在两种屏上有两种意思。

⚠️ **没有页面**：本工具的全部功能是**命令**（`help` 就是一条命令），结果区与输入区是同一块主区的
上下两半。故 `1`-`6` 是**命令里的字符**，不是页签序号。
⚠️ 窄终端（< 60 列）下侧边栏整个不画、只留主区（见 `@/console/geometry.ts` 的
`MIN_TERMINAL_COLUMNS`）；极矮的屏（1–3 行）与窄到画不下框的屏**如实少画**（框越界会让「每一行
都不超宽」那把尺失效），而那是有意的诚实形态。

### 子目录各答一件事

- `src/cmd/` — **命令层**：那张**唯一**的命令表 + 分词器（`parse.ts`）、Tab 补全（`complete.ts`，
  只管**形参的值**）与**命令面板**（`palette.ts`，只管**命令名**）。零终端、零 React、零 HTTP、
  零 `fs`。⚠️ **每一行命令都必须以 `/` 开头**（`parse.ts:COMMAND_PREFIX`），而「带前缀的命令名
  给人看是什么样」只有**一个**出口（`CommandSpec.path` = `/` + `name`）。
- `src/console/` — **全屏 console**：`geometry`（坐标与命中测试的唯一真相来源）/ `log`（条目 → 行）/
  `exec`（命令 → 行 + 副作用）/ `layout`（**本包唯一挂 Ink 的文件**）。
- `src/ui/` — `theme` / `format` / `columns` 三份判据 + `mouse` / `screen` 两个终端设施 + `logo` 的
  两串常量。**零 Ink 组件**：呈现全在 `@/console/layout.tsx`，因为画在哪必须与点在算哪逐字一致。
- `tests/` — 本包的 vitest 档（`pnpm test:tui`）；含两档**假 TTY 真渲染**：
  `tests/layout.test.ts`（画）与 `tests/input.test.ts`（**输入通路**：喂进去的鼠标报告一个字都不许
  进输入行）。

## 关键事实

### 端点契约是**手抄的、有测试兜着的弱耦合**，不是编译期绑定

`src/client/endpoints.ts` 的 `ENDPOINTS` 与服务端 `src/manager/routes/*.ts` 里那批
`{ method, path }` **各写一份**。跨包 `import` 共享契约会抹掉一个现实：**本包连的是别的机器上那个进程，
而那个进程可能跑的是旧版本的服务端**。所以这里是刻意选的弱耦合，两道牙各管一半、互不代替：

- **路径集合** → 根仓 `tests/unit/manager-tui-contract.test.ts`：从**两侧源码文本现取** `(method, path)`
  再比集合（不从任何一侧 import —— 那会把「网络两端版本可以不同」这个现实重新抹掉）。
- **字段形状** → `src/client/wire.ts` 的 `WireContractAssertions`（编译期单向可赋值性断言）。

**控制面加端点时必须同时改本包的 `ENDPOINTS`**，否则本包少一个功能而两边都绿；反过来本包写了服务端没有的
端点，就是对着一个永远 404 的路径发请求。

### 产物必须是 ESM（唯一一条技术硬要求）

`ink` 的 `build/reconciler.js` 里有一句**顶层 await**（`await import('./devtools.js')`），
esbuild 的 `cjs` 输出格式表达不了它，实测构建直接失败：
`Top-level await is currently not supported with the "cjs" output format`。故本包
`"type": "module"` + 产物 ESM，而根包 `"type": "commonjs"` 装不下它。

⚠️ **别把这条读成「Ink 不能 bundle」或「TypeScript 编译不了 ESM」** —— 两者都不成立：
`format: "esm"` 下 bundle 成单文件实测能出（1.77MB），TypeScript 编译 ESM 一直是正常的。
被卡住的是**输出格式**，不是语言。

### `packages: "external"` 是**选择**，不是要求

`build.mjs` 只打 `src/`，第三方留在 `node_modules`。理由只有一条：bundle 会把 `ink` 的 peer
依赖 `react-devtools-core` 提成**产物的运行期**静态 import（esbuild 把顶层 `await import` 里的
动态导入外提了），而那是个只在 `process.env.DEV` 下才真正干活的包。代价是 `dist/cli.js`
不是自足的单文件产物 —— 本包 `private: true`，产物只服务仓库内的开发与端到端验证，这个代价
是白付的。

⚠️ **不要**按「`ink` 打包会坏」去论证这条（那是错的：`yoga-layout` 的 wasm 是 **base64 内嵌在
JS 模块**里的，没有独立的 `.wasm` 文件、也没有任何相对路径的资产定位）。哪天 Ink 不再有顶层
await、而你也愿意让产物拖一个 dev-only 的 peer，那时改回 bundle 是一条正当的演进 —— 但要先
把它**当选择**来改，不要当成在修一个 bug。

### 本包**不进** `build:pkg` 的二进制通道

`build:pkg` 的入口表是 `scripts/pkg-binaries.mjs`（平台 × 入口逐行一次 pkg 调用），本包**不在那张表里**：
它要持续重绘、要终端原始模式，是一个「跑在终端里的前端」，而二进制分发的那条路服务的是代理服务本身。
新增二进制入口时**不要**顺手把本包加进去；`pnpm build:tui` 是它唯一的构建通道。

### `build --watch` 走一次性子进程

与根 `build.mjs` 同一纪律：Windows 上 Node 22 退出时偶发 `STATUS_STACK_BUFFER_OVERFLOW`，
常驻 watcher 绝不能加载 esbuild 原生模块。故 watch 模式由 `execFileSync` 反复起一次性子进程。

## 命令

从**仓库根**跑（`pnpm --filter @b-hole/proxy-tui <script>` 的直白形态）：

```
pnpm build:tui      # esbuild src/cli.tsx → dist/cli.js
pnpm dev:tui        # build:tui && 起 TUI
pnpm test:tui       # 只跑本包的 vitest 档
```

⚠️ 根包的 `lint` / `typecheck` / `test` **已经串上了本包**（`--filter @b-hole/proxy-tui`），
所以「跑全绿」覆盖两包；只想跑本包时用上面那三条。⚠️ 根仓那条链式 `test` 会把 pnpm 的附加参数追加到
**整条脚本末尾**，因此**位置过滤器只能直接给 `pnpm exec vitest run <路径>`**，别写 `pnpm test <过滤器>`。

## 相关路径

⚠️ **本包的 `@/` 指向 `packages/tui/src/`，不是根仓的 `src/`。** 引用**根仓**的文件一律写
「根仓 `src/…`」/「根仓 `tests/…`」，**不写** `@/ops/…`、`@/admin/…` —— 那种写法在本包里解析到
一个不存在的文件（本包没有 `ops/` 也没有 `admin/`），而符号又确实在根仓，于是它读起来像
「本包里的一个类型」而实际指的是**另一个包**。这是本包全体注释的写法，不是个别几处。

- 端点集合的另一侧 — 根仓 `src/manager/routes/*.ts`（服务端真值），表头在 `src/manager/routes/index.ts`
- 路径集合护栏 — 根仓 `tests/unit/manager-tui-contract.test.ts`
- 字段形状护栏 — `src/client/wire.ts`（本包，编译期）
- 运行时地板 — 本包 `engines.node` 与根包同为 `Node >= 22.13`（同一个数；全仓地板零漂移由根仓
  `tests/unit/runtime-floor.test.ts` 扫全工作树判定，它也扫本目录）
- 拆包理由与根仓收尾命令 — 根 `AGENTS.md`「两个包」一节

## 人工验收（⚠️ 单测**测不到**的那一半）

本包的单测（含两档假 TTY 真渲染）覆盖不了三件事，它们**只能**在真终端里看：

1. **终端真的发 SGR 鼠标报告吗**：起一次界面，**动一下鼠标**，看侧边栏那一行会不会变高亮。
   收不到报告时输入区会出现一句「本终端似乎不支持鼠标；全部键位仍可用」—— ⚠️ 那句话只说明
   **开了上报但从未收到**，而「开都没开成功」是另一种情况（`screen.ts` 的开启序列会抛）。
   ⚠️ 与此同时，**动鼠标时输入行必须一个字都不许变** —— 那一档已由 `tests/input.test.ts` 在
   假 TTY 上钉住（真终端上再看一眼是验收，不是查新东西）。
2. **退出后终端干净吗**：敲 `Ctrl+C`，然后看三件事：屏幕回到**原来的画面**（备用屏幕退了）、
   光标**可见**、**鼠标能拖选与粘贴**了。三件里任何一件不对，都是收尾漏了一条序列。
3. **鼠标点哪儿就在哪儿**：点侧边栏第三行 → 应当切到第三个控制面；点输入行中间某个字 →
   插入符应当落在**那个字**的前一格或后一格（按显示列算，CJK 占两列）。

4. **命令面板**：敲一个 `/`，那一块**接管**上半屏，逐行「命令名 + 说明」；按 `↓` 往下走（**输入行
   会跟着变**，所以 `↓` `↓` `Enter` 就是跑第三条）、`Tab` 接受（**不执行**）、`Enter` 执行输入行上
   **逐字**那一串、鼠标点某一行 = 补进行内（**不执行**）。⚠️ 面板开着时 `↑`/`↓` **不切目标**，
   而输入行清空（`Esc` 或回车）之后它们才切回去。⚠️ 敲完回车之后命令回显在**上半屏第一行**
   （`❯ /status`），而**底部那一行不再列命令** —— 这一条就是本轮改动的主项。
   ⚠️ **终端不够高时面板自己滚**：确认「共 19 条」那一行说的是真的、且高亮那一行始终看得见。

⚠️ 端到端（对着一个真的控制面）还需要操作者自己起服务端：见交接说明里的那行命令
（`MANAGER_ENABLED=true MANAGER_PORT=18080 MANAGER_TOKEN=… AUTH_ENABLED=false
PROXY_PROTOCOL=http node <repo>/dist/app.js`，**从一个临时 cwd 起**，别在仓库根起 ——
根目录那份 `.env.development` 会被静默吃下）。
