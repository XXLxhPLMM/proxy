# src/utils/sqlite/

SQLite 驱动层：端口 + 两档实现的分流。

## 层不变量

**本节只列不变式，理由留在各文件的头注释里。**

- **账本只认 `driver.ts` 的四个方法**（`exec` / `run` / `get` / `all`），不认任何具体实现。刻意**不暴露通用 SQL 执行器**：那会把 SQL 文本散落到调用方，于是「这张表长什么样」就有多个真相源。
- **分流判据是「`require("node:sqlite")` 成不成」，不是任何版本号比较**：`node:sqlite` 有**两个**边界（**22.5** 出生、**22.13** 免 flag），22.5–22.12 上它「存在但要 flag」，16/18/20 上压根不存在，两段的 `require` 结局相同（`ERR_UNKNOWN_BUILTIN_MODULE`）。`major >= 22` 会在 22.0–22.12 上选错档然后崩；写成 `major/minor` 双条件也只是把两件独立的事揉进一个数字，下次 Node 动任一边界它就悄悄过期。
- **内置档必须惰性 require**：`createRequire(...)` 在调用点现取。静态 `import` 会让 esbuild 产物在文件**顶层** require 它，Node 16 一加载就炸——而那段代码在 Node 16 上永远跑不到。
- **两档都开 `busy_timeout`**（WASM 档是无 WAL 下唯一能让并发写退让重试的东西；内置档真 WAL 仍然写与写互斥）。
- **本目录是叶子层**：只允许 `@/utils/sqlite/*` 内部互引 + `@/config/index.js` 的 type-only 引用。

## 文件

- `types.ts` — `SqlValue`（闭合值域：`string | number | null`）。
- `driver.ts` — 端口 `SqliteDriver`（五个同步方法）、`OpenSqliteDriver`（开库函数）、`SqliteDriverChoice`（开库 + `kind` 标签）、`SqliteDriverKind`。
- `open.ts` — 两档实现（`openBuiltin` / `openWasm`）与 `openSqliteDriver(prefer?)` 的分流。
- `index.ts` — 目录 barrel。

## 构建链责任（不是本目录的）

`node-sqlite3-wasm` 用 `__dirname + "/"` 定位 `node-sqlite3-wasm.wasm`，而 esbuild 打成单文件后 `__dirname` 就是 `dist/`。故 `build.mjs` 必须把那份 `.wasm` 拷到与 `app.js` **同级**，`package.json` 的 `files` 与 `pkg.assets` 各收一份。**缺了它：Node 22.13+ 一切正常（走内置档），Node 16–22.12 在第一次真正记账时才炸。**

## 相关路径

- `src/datasource/quota/sqlite-source.ts` — 唯一的消费者（经 `@/utils/sqlite/index.js` 取驱动）。
- `tests/unit/usage-source.test.ts` — 两档各跑一遍的断言（含 WASM 档在 Node 22 上的显式分流）。
