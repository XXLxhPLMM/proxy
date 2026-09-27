# src/utils/json-file/ — 文件与路径说明

JSON 配置热加载读取层。

对外唯一出口：`@/utils/json-file/index.js`（`readJsonCached` + 4 个公共类型）。

## 文件

- `types.ts` — 公共类型契约 `JsonFileEvent` / `JsonFileEventType` / `JsonFileOptions` / `JsonFileRead`。
- `cache.ts` — 跨调用共享缓存 `caches` / `missingEntry` 与缓存键（label + path）。
- `subscriber.ts` — per-subscriber 去重状态、`ALLOWED_TRANSITIONS` 迁移表、`notifyTransition`。
- `probe.ts` — stat 三态分类（`ok` / `missing` / `stat-error`）与 `errorMessage` / `isMissingStatError`。
- `read-validate.ts` — 读文件、大小上限、parse 与形状校验。
- `json-file.ts` — 编排：probe → 节流 → 未变更 → 读取 → 落缓存 → 通知。
- `index.ts` — 目录 barrel。

## 相关路径

- 读取方 — `src/config/files/users.ts`、`src/config/files/acl.ts`
- 事件回调注入 — `src/config/files/event-log.ts` 的 `createJsonFileEventHandler`
- 类型引用方 — `src/core/` 下的 `access-control.ts`、`identity/factory.ts`、`traffic/memory.ts`

## 相关测试

- `tests/unit/json-file.test.ts`
- `tests/unit/json-file-log.test.ts`
