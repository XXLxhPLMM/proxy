# tests/library/

文件与路径说明（目录级说明见 `../AGENTS.md`）。

库消费方视角的包入口公开 API 契约测试。

## 文件

- `entry.test.ts` — 只从包入口（`@b-hole/proxy` 或构建出的 `lib/`）import 的公开面单测：不导出符号清单、import 期零副作用。

## 相关路径

- `../unit/library-entry.test.ts` — 包入口 `@/index.js` 导出面的单测。
- `../unit/`、`../integration/`、`../AGENTS.md`。
- 出口 barrel：`@/index.js`。
