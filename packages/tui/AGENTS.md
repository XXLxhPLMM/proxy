# AGENTS.md — `@b-hole/proxy-tui`（控制面终端控制台）

独立 pnpm 包（`private: true`、`type: module`、`bin: proxy-tui → dist/cli.js`）：回答「怎么在终端里驱动
**别的机器上**那个控制面」。机制细节归各目录 `AGENTS.md`；`src/` 内的分层地图见
`src/AGENTS.md`。本文件只记**包这一层**的不变量。

⚠️ **重构空白期**：`src/` 现有 `api/`（控制面契约 + 拨号）、`lib/request/`（请求那一圈的三个纯叶子）与
`services/`（本地会话库 `db/` + 门面 `resource/` + 单例装配 `container.ts`）；入口 `src/cli.tsx` 与其余各层待重建 ——
在那之前 `pnpm build` 必然失败。

## Commands（在本目录跑；根仓经 `--filter @b-hole/proxy-tui` 点名）

```
pnpm build         # node build.mjs：src/cli.tsx → dist/cli.js（每次先清空 dist/）
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

## 快速验证阶段（`tests/` 已删，不新建）

- `tests/` 整个删除（git 可恢复），本阶段**不新建**任何测试；`pnpm test` 为 `--passWithNoTests` 空跑。
- 验证只有三条：`pnpm lint` → `pnpm typecheck` → `pnpm build`（⚠️ 入口待重建前它必然失败）。下文所有指到
  `tests/` 的「牙齿」在本阶段统一暂停，恢复测试时再逐条接回。

## 文档写不变量，不写变更日志

- **AGENTS.md 记「今天这套代码为什么长这样」，不记「我这几轮改了什么」。** 删任何一行前问：**① 删掉它，
  今天的判断会变吗？② 它在讲代码，还是在讲过去某次对话？** 「实测踩过一次」「上一版写的是 X」这类变异
  记录与前后对照**一律不进文档**——它们是工单，读的人不接下一棒。
- **唯一该留的残留物是「负载在哪」**：一句话说清「改坏 X ⇒ 哪条断言会红」。


