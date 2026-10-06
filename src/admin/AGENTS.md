# src/admin/ — 管理命令层（传输层）

`proxy-cli` 的**执行面**，且**只是**执行面：解析 argv → 派发到 `@/ops` → 渲染 → 映射退出码。
进程那一侧在 `src/cli-admin.ts`（组合根），与 `src/cli.ts` 逐字对称。

数据源的操作（装配 / 读 / 写 / 账本读 / 配置事实）在 `@/ops`。**本目录不认识数据**：它调 ops、
把 ops 给的结构化结果排成表、挑一条通道。分界线的形状是「ops 出结构化 + `OpsError`，本目录出
终端形态」，理由与「为什么不让 ops 自己 `console`」见 `src/ops/AGENTS.md`。

## 文件

- `index.ts` — 目录 barrel + `runAdminCli` 编排（解析 → 解析配置 → 派发 → 退出码）。
- `args.ts` — 命令树与 argv 解析（**纯函数、零 IO**）；`AdminUsageError`（退出码 2）。
- `users.ts` — `user` 子命令的呈现与派发。
- `acl.ts` — `acl` 子命令的呈现与派发（含 `GROUP_ORDER` / `LIST_ORDER`）。
- `usage.ts` — `usage show`（**只读**）的呈现与派发。
- `config.ts` — `config show`（此刻操作哪三份数据）的排版。
- `out.ts` — `AdminIo` 写入面、三个退出码、表格 / 键值 / 小节 / 字节格式化。
- `help.ts` — `--help` 与 `help <topic>` 的全部文本。

## 相关路径

- `src/ops/` — 数据源操作层（本目录**唯一**的数据来源）；见 `src/ops/AGENTS.md`。
- `src/cli-admin.ts` — 组合根（快照宿主来源、`process.exitCode`、shebang）。
- `.env.example` / `cfg/users.json.example.md` — 账号与名单的字段文档（帮助文本之外的字段文档）。

## 相关测试

- `tests/unit/admin/cli/` — 命令解析、账号写族的字段保全、名单写、只读驱动报错、退出码，
  以及覆盖 `admin/` 与 `ops/` **两层**的源码级护栏（零 console / 零 `process.*` / 不 import 代理侧 /
  `argv: []` / `skipFileValidation` / 同一份接线）。
- `tests/unit/ops/` — 同一批操作在**结构化**那一侧的形状与错误分类。
