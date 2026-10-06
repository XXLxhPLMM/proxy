# src/utils/sqlite/

SQLite 驱动层：端口 + 两档实现的分流。

## 文件

- `types.ts` — `SqlValue`（闭合值域：`string | number | null`）。
- `driver.ts` — 端口 `SqliteDriver`（五个同步方法）、`OpenSqliteDriver`（开库函数）、`SqliteDriverChoice`（开库 + `kind` 标签）、`SqliteDriverKind`。
- `open.ts` — 两档实现（`openBuiltin` / `openWasm`）与 `openSqliteDriver(prefer?)` 的分流。
- `index.ts` — 目录 barrel。

## 构建链责任（不是本目录的）

`node-sqlite3-wasm` 用 `__dirname + "/"` 定位 `node-sqlite3-wasm.wasm`，而 esbuild 打成单文件后 `__dirname` 就是 `dist/`。故 `build.mjs` 必须把那份 `.wasm` 拷到与 `app.js` **同级**，`package.json` 的 `files` 与 `pkg.assets` 各收一份。**缺了它：Node 22.13+ 一切正常（走内置档），Node 16–22.12 在第一次真正记账时才炸。**

## 相关路径

- `src/datasource/quota/sqlite-source.ts` — 唯一的消费者（经 `@/utils/sqlite/index.js` 取驱动）。
- `tests/unit/datasource/quota/sqlite/driver-split.test.ts` — 两档各跑一遍的断言（含 WASM 档在 Node 22 上的显式分流）。
