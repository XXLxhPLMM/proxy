# src/admin/ — 管理命令层

`proxy-cli` 的执行面。进程那一侧在 `src/cli-admin.ts`（组合根），与 `src/cli.ts` 逐字对称。

## 文件

- `index.ts` — 目录 barrel + `runAdminCli` 编排（解析 → 解析配置 → 派发 → 退出码）。
- `args.ts` — 命令树与 argv 解析（**纯函数、零 IO**）；`AdminUsageError`（退出码 2）。
- `context.ts` — 配置 → 三份数据源的装配（`AdminSources`）、读面「坏内容即拒」的三件事。
- `users.ts` — `user` 子命令。
- `acl.ts` — `acl` 子命令。
- `usage.ts` — `usage show`（**只读**）。
- `config.ts` — `config show`（此刻操作哪三份数据）。
- `out.ts` — `AdminIo` 写入面、`AdminError`（退出码 1）、三个退出码、表格与字节格式化。

## 层不变量

- **绝不启动代理**：本层不 import `@/core` / `@/runtime` / `@/server`。它向下只用 `@/config`（折接线）、
  `@/datasource`（解析驱动）、`@/utils`。理由与 `src/datasource` 的「零 `@/config` 依赖」同源但结论
  相反：那边是不许认识配置端口，这边是**没有理由持有任何代理侧的东西**。
- **argv 不经 `loadConfig`**：本工具的参数是子命令（`user add alice`），不是配置键。混进那条通路
  只有两种做法，两种都更坏（在未知键闸门前剥掉 ⇒ 自己的参数拼错零信号；把子命令词塞进
  `NON_CONFIG_ENV_KEYS` ⇒ 那是配置键的容忍名单）。配置只来自 env 与 env 文件，且 env 文件候选用的是
  **同一个** `defaultEnvFileNames`。
- **`loadConfig` 传 `skipFileValidation: true`**：那轮强校验是为「服务能不能起来」服务的，而
  「加第一个账号」在 `AUTH_ENABLED=true` + `basic` + 空表时恰好是**启动中止**——照搬它会让工具在最需要
  时拒绝服务。代价是本层**必须**自己做该做的校验，且判据全部取自数据源层，**绝不自己再判一遍形状**。
- **零 `console` / 零 `process.*`**：三个写入面经 `AdminIo` 注入。命令层因此能在单测里直接断言输出，
  捕获 `console` 是一种会漏（异步交错、格式化被重定向）的间接做法。
- **成功提示走 stderr**（`AdminIo.changed`）：`proxy-cli user list > list.txt` 得到的文件必须是干净的，
  可直接喂给 `jq` / `awk`。
- **读面「坏内容即拒」**（`context.ts` 的三个 `*OrFail`）：数据源层的读语义是「坏内容 → 保留上一份 /
  空表 + 一个 `error`」。**对代理那是对的**（判据永不因手滑失效），**对要写数据的工具是错的**——在
  「我读到的其实是空表」这个前提上 `put`，结果就是**把整份真配置清空**。
- **账号写只有一个入口**：`user add` 遇已存在的账号**直接拒绝**（底层 `put` 是整条替换，让 `add` 静默
  成功等于「我以为在新建」变成「我顺手清掉了他的配额与有效期」）；`set` / `disable` / `enable` /
  `passwd` 一律**读-改-整条写回**，未指定字段逐字保留。
- **只读驱动明确报错**：`AclSource.write` 是**可选成员**（只读名单驱动缺省），`requireAclWrite` 据此
  报错退出，**绝不静默成功**。

## 未做（是「不变量」，不是「没来得及」）

- **`usage` 没有任何写操作**。判定读的是代理进程内镜像，合并用 `max(本进程值, 账本值)`；从第二个
  进程删账本里的行对运行中的代理**永不生效**，而命令退出码会是 0。完整推导见 `usage.ts` 文件头。
- **不提供字段级的账号改写接口**。`AccountSource` 只有整条替换一个出口，在它之上发明
  `patch(field, value)` 会让「哪些字段可 patch」在每个后端各写一遍，而单列 `UPDATE` 出来的记录
  **未必还过 `validateAuthUsers`** —— 那正是「写得进去、读不出来」的来源。

## 相关路径

- `src/cli-admin.ts` — 组合根（快照宿主来源、`process.exitCode`、shebang）。
- `src/datasource/users/index.ts` — 账号表（`list` / `put` / `delete`）。
- `src/datasource/acl/index.ts` — 名单（`read` + 可选 `write`）。
- `src/datasource/quota/index.ts` — 账本（`UsageSourceController.open/close` + `onSnapshot`）。
- `src/config/account-locator.ts` / `src/config/acl-locator.ts` — 「哪个键装哪个驱动」的唯一一份。
- `src/utils/json-file/write.ts` — 整份重写的原子原语（账号表与名单共用同一份）。
- `.env.example` / `cfg/users.json.example.md` — 账号与名单的字段文档。

## 相关测试

- `tests/unit/admin-cli.test.ts` — 命令解析、账号写族的字段保全、名单写、只读驱动报错、退出码。
