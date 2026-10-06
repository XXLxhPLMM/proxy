# AGENTS.md

## Package manager

只准 `pnpm`（Node `>=22.13`、pnpm `>=9`），锁文件 `pnpm-lock.yaml`。改完 `package.json` 跑 `pnpm install`。带构建脚本的依赖按 `pnpm-workspace.yaml` 的 `allowBuilds` 白名单放行，否则装不上。

### Workspace 与独立包

- workspace（`pnpm-workspace.yaml` 只列这两项）：`.`（`@b-hole/proxy`，服务端 + 库）与 `packages/tui`（`@b-hole/proxy-tui`，终端控制台，`private: true`）。分开的理由：运行期依赖面不同（根包只有 `dotenv` + `node-sqlite3-wasm`，TUI 要 `ink` + `react`）、分发形态不同（TUI 不进 `build:pkg`，只出 `packages/tui/dist/cli.js`）。
- `packages/mcp`（`@b-hole/proxy-mcp`）是**独立包，不在 workspace 里**：根仓的 `lint` / `typecheck` / `test` 看不到它。改完它要进目录单独跑那四条，装依赖用 `pnpm install --ignore-workspace`。详见 `packages/mcp/AGENTS.md`。
- 根仓三条收尾命令都串了子包（TUI）：`lint` / `typecheck` / `test`。一律用 `--filter @b-hole/proxy-tui` 显式点名，不用 `pnpm -r`（根包自己也在 workspace 里，递归会把命令再派发回根包）。

### Node >= 22.13 由谁保证：不是 `engines`

`engines` 在 npm/pnpm 下都不拦开发环境（实测见 git 历史）。真正强制的是测试：`tests/unit/datasource/quota/sqlite/driver-split.test.ts` 里 builtin 档断言真跑 `node:sqlite`（0 处 `skipIf`），低版本直接抛错。`22.13` 是 `node:sqlite` 免 flag 的版本（22.5 出生但要 `--experimental-sqlite`），22.5–22.12 必须探 `require` 成不成，见 `src/utils/sqlite/AGENTS.md`。

## Commands

```
pnpm build          # esbuild src/cli.ts -> dist/app.js + src/cli-admin.ts -> dist/proxy-cli.js (cjs, node22)，每次先清空 dist/
pnpm build:dev      # 同上，dev 模式（不压缩、带 sourcemap）
pnpm build:watch    # fs.watch src/ → 每次变更起一次性 node build.mjs（watcher 本体不加载 esbuild）
pnpm build:lib      # clean lib/ + tsc -p tsconfig.build.json + tsc-alias → lib/（必须用这份 tsconfig，默认那份会产出 lib/src/**）
pnpm build:tui      # esbuild packages/tui/src/cli.tsx → packages/tui/dist/cli.js
pnpm build:all      # build + build:lib + build:tui
pnpm build:pkg      # build → patch-pkg-fetch → build-pkg → package-dist（不含 TUI）
pnpm start          # node dist/app.js（CLI 快照宿主来源并显式调 async loadConfig）
pnpm start:dev/prod # 只设 NODE_ENV=development/production，不用 node --env-file
pnpm dev            # build:dev && start:dev
pnpm dev:watch      # scripts/dev-server.mjs 盯 dist/ + .env* 自动重启（只重启不构建）
pnpm dev:hot        # concurrently: build:watch + dev-server.mjs
pnpm dev:tui        # build:tui && 起 TUI
pnpm lint           # eslint ./src ./tests，再 lint 子包（两包，不含 mcp）
pnpm typecheck      # tsc --noEmit，再 typecheck 子包（两包，不含 mcp）
pnpm test           # vitest run，再跑子包那一套（两包，不含 mcp）
pnpm test:tui       # 只跑子包那一套
```

收尾顺序：`pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`，全绿才算完。`.cnb.yml` 已有 `verify`（install --frozen-lockfile → lint → typecheck → test → build → docker push），但 `Dockerfile` 本身不跑测试，验证仍以本地为准。

- **跑单个测试**：`pnpm exec vitest run unit/acl` 或 `pnpm exec vitest run driver-split`（按目录/文件名片段过滤，别把层数写死；子包用 `pnpm test:tui`）。⚠️ **不要写 `pnpm test <过滤器>`**：pnpm 把参数追加到整条脚本末尾，过滤器只喂给链条最后一条（子包那份），根包全量跑、子包因无匹配而红。
- **改了 `packages/tui/src/**` 最后一条必须是 `pnpm build:tui`**：`pnpm build` 只构建根包，与 `packages/tui/dist/cli.js` 无关，不重建屏上一个字不变。自查：`dist/cli.js` 时间戳必须比 `src/` 里最新的文件新。
- Windows + Node22 + esbuild 退出码 `3221226505` 即使产物已写出也属已知现象（`build.mjs` 按产物 mtime 前后对比当成功处理）。别在 watcher 里加载 esbuild，用 `scripts/dev-server.mjs`。
- **两个入口、两个 `bin`**：`dist/app.js`（`proxy`，起服务；`MANAGER_ENABLED=true` 时同进程兼管控制面）与 `dist/proxy-cli.js`（`proxy-cli`，只读数据源，绝不启动代理）。入口表在 `build.mjs` 的 `entryPoints`，与 `package.json` 的 `bin` + `files` 互相锁（护栏 `tests/unit/packaging/npm-pack/files-whitelist.test.ts` 反向断言）。控制面不是第三个入口；一个文件只对应一个 `bin` 名。

细节住别处：机制与决策看 `src/**`、`tests/**` 各目录自己的 `AGENTS.md`（改哪块先读哪份）；判据锁什么写在那个 `*.test.ts` 头注释；怎么配/怎么查用 `.opencode/skills/` 四个 skill（`proxy-test` / `proxy-config` / `proxy-auth` / `proxy-logger`）。

## Service startup（服务归用户）

- Agent 绝不自动 `pnpm start` / `node dist/app.js` / `taskkill`，除非用户明确要求。否则提示请用户自己启动。
- ⚠️ 仓库根的 `.env.development` 是开发者本地配置（`socks4` + `AUTH_TYPE=uid` + `AUTH_USERS_FILE=./cfg/users.json` + `LOG_FILE=log`），在仓库根直接起服会被静默吃掉。手工起服要么显式覆盖（argv 优先级最高，如 `--auth-enabled=false --proxy-protocol http`），要么把 cwd 挪开（`cd <临时目录> && node <repo>/dist/app.js`）。
- 不要修改 `.env.development`（本地状态）。改模板改 `.env.example`（与 `FIELDS` 集合相等，由 `tests/unit/config/unknown-keys/tolerance.test.ts` 钉住）。
- 配置优先级：`argv > 终端环境变量 > .env 文件 > 默认值`。`.env` 候选名固定三档（`src/config/sources/env-files.ts:defaultEnvFileNames`），纯 `.env` 永不被读；`USE_HOME_CONFIG` 只能由 argv/终端变量切换，写进文件不生效。

## import 路径规约

- 跨目录一律 `@/`（`@/` → `src/`）。`src/index.ts` 与 `src/cli.ts` 的任何 import 都是跨目录，禁 `./`。
- 同目录/子目录内部用相对路径，禁自我引用 barrel（防循环依赖）。
- 目录对外只暴露一个 barrel：`@/config/index.js` / `@/datasource/index.js` / `@/core/events/index.js` / `@/core/helpers/index.js` / `@/utils/{logger,constants,tls,json-file,sqlite,addr}/index.js`。跨目录禁深路径，无例外。
- `src/datasource` 零 `@/config` 依赖：装配层经 `accountLocatorFor(config)` 把配置译成闭包再传进去。
- `src/utils` 是叶子层：运行期只许 `@/utils/*` 互引 + `@/config` 的 type-only 引用，禁 `@/core/*` / `@/server/*`。唯一例外是 `src/utils/addr/`（四层共用的名单条目词汇）。

## 项目阶段与写护栏

- 库尚未投入使用：破坏性变更无需兼容层（删字段、改签名、删旧配置名一律直接改），但须同步更新相关 `AGENTS.md`、skill 与测试，并保证四条全绿。
- 负向源码断言点名已删除符号会恒真：必须验证“符号被重新引入时会红”，锚换成当下仍存在的行为形状。自检：锚符号还在吗、跨行判据是否整段匹配、注释点名是否被 `codeOnly` 误判。
- 写“幂等”护栏前先问第二次调用凭什么不同：必须由实现里的具体机制提供（如 `splice(0)`），不许另设“已释放”标志自发绿牌。

## 已裁决的 git 状态（不要再去“修”）

- `keys/{ca,client,server}.key` + `ca.srl` 故意入库（自签测试 PKI，`.env.example` 已写明勿用于生产），`.gitignore` 刻意不写 `*.key`。真纪律是 npm 包不携带它们（`files` 白名单 + 护栏 `tests/unit/packaging/npm-pack/scan.test.ts` 跑真 `npm pack`）+ `build.mjs` 每次重建前清空 `dist/`。
- `.env.production` 历史里只有一行注释（blob 30 字节）。“被跟踪”是索引状态，“内容进历史”查 blob，别混为一谈造出不存在的安全事件。
- 改 `package.json` 的 `files` / `build.mjs` 前先跑 `pnpm exec vitest run tests/unit/packaging/npm-pack`。

## AI 协作

- 输出语言跟随用户输入；用户提意见时先给明确判断（是否认同 + 理由 + 替代建议），再改代码。
- 有主见、敢反驳，以事实和工程原则为准，不无脑迎合；对事不对人。
