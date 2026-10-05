# src/config/normalize/ — 文件与路径说明

- `record.ts` — 泛型配置对象到可按键索引 record 的收窄（`asRecord`）。
- `paths.ts` — 按 `FIELDS` 的 `path` 标记做相对路径绝对化（`resolveConfigPaths`）。
- `upstream.ts` — `UPSTREAM_URL` 拆项的编排入口（`applyUpstreamUrlToConfig`）与覆盖 warning 列表。
- `prepare.ts` — 纯内存 runtime 装配：副本产出与按变化字段回写 store（`prepareRuntimeConfig` / `prepareRuntimeConfigStore`）。
- `index.ts` — 本层出口：`resolveConfigPaths`、`applyUpstreamUrlToConfig`、`prepareRuntimeConfig`、`prepareRuntimeConfigStore`。

对外出口路径：`@/config/index.js` 从本层转出 `prepareRuntimeConfigStore` 与 `PreparedRuntimeConfig`。

相关路径：`../schema/upstream-url.ts`（拆项实现）、`../schema/fields.ts`（`FIELDS` 表）、`../load.ts` 与 `../context.ts`（编排调用方）。

相关测试：`tests/unit/config/loader/`、`tests/unit/config/store/instance.test.ts`。
