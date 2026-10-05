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

## 层不变量

- **绝不启动代理**：本层不 import `@/core` / `@/runtime` / `@/server`。理由与 `src/datasource` 的
  「零 `@/config` 依赖」同源但结论相反：那边是不许认识配置端口，这边是**没有理由持有任何代理侧的
  东西**。
- **零 `console` / 零 `process.*`**：三个写入面经 `AdminIo` 注入。命令层因此能在单测里直接断言
  输出，捕获 `console` 是一种会漏（异步交错、格式化被重定向）的间接做法。
- **成功提示走 stderr**（`AdminIo.changed`）：`proxy-cli user list > list.txt` 得到的文件必须是干净的，
  可直接喂给 `jq` / `awk`。
- **⚠️ 不得改写 ops 的文案**：ops 给的 `OpsChange.message` 与 `OpsError.message` 是**中性事实陈述**，
  本层原样输出。**不得**用 `OpsError.code` 挑文案（那就变成「同一件事在两个入口说两种话」）；要加
  前缀、加建议、挑通道，全在本层，且**只在这一层**。
- **`changed: false` 要当真**（`acl.ts` 的写派发）：幂等 no-op 之后**不许**打「多久生效」那句——
  一个字节都没落盘，承诺一件没发生的事正是本仓最恨的形状。
- **呈现决定留在这一侧**：密码怎么打码、账本怎么排序、组的顺序、字节怎么写成人读的形态、列宽。
  这些进 ops 就等于让数据层替界面做决定，而 HTTP 面与 JSON 面都不这么显示。
- **一份名单进 `renderSections`（小节），不进表格的一格**（`acl.ts` 的 `show` 与 `users.ts` 的
  `showOne`）：整份名单挤进一格时那格宽过终端就会软换行，而「组 / 方向」列只在**第一**视觉行上
  ——绝大多数条目在屏幕上没有主人的名字，而「哪些条目在哪个名单里」正是这两条命令唯一的职责。
  ⚠️ **因此不许加按终端宽度重排**：宽度得问 `process.stdout.columns`，而本层零 `process.*`，
  且「输出在任何地方都长得一样」是 `renderTable` 明确要的性质。牙齿：`tests/unit/admin/cli/acl.test.ts`
  「名单呈现」那组断言的是**行宽上界**（对规模，不对今天这份数据）与**归属相邻**，两次变异实测过。
- **argv 不经 `loadConfig`**：本工具的参数是子命令（`user add alice`），不是配置键。混进那条通路
  只有两种做法，两种都更坏（在未知键闸门前剥掉 ⇒ 自己的参数拼错零信号；把子命令词塞进
  `NON_CONFIG_ENV_KEYS` ⇒ 那是配置键的容忍名单）。理由的完整论证见 `./args.ts` 文件头。
- **三个退出码**：`0` 成功 / `1` 操作失败（ops 的 `OpsError`）/ `2` 用法错（`AdminUsageError`）。
  ⚠️ **只有 `OpsError` 带「失败: 」前缀**：配置校验失败、驱动未注册、IO 异常原样打出来——那些文案
  里点名了键名与已注册项，套一层前缀只会让人再往下找一遍。

## 相关路径

- `src/ops/` — 数据源操作层（本目录**唯一**的数据来源）；见 `src/ops/AGENTS.md`。
- `src/cli-admin.ts` — 组合根（快照宿主来源、`process.exitCode`、shebang）。
- `.env.example` / `cfg/users.json.example.md` — 账号与名单的字段文档（帮助文本之外的字段文档）。

## 相关测试

- `tests/unit/admin/cli/` — 命令解析、账号写族的字段保全、名单写、只读驱动报错、退出码，
  以及覆盖 `admin/` 与 `ops/` **两层**的源码级护栏（零 console / 零 `process.*` / 不 import 代理侧 /
  `argv: []` / `skipFileValidation` / 同一份接线）。
- `tests/unit/ops/` — 同一批操作在**结构化**那一侧的形状与错误分类。
