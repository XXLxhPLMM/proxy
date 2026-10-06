# src/utils/json-file/ — 文件型配置读写层

对外唯一出口：`@/utils/json-file/index.js`（两个读取入口 `readJsonCached` / `readCachedSource`
+ 一个写原语 `writeJsonAtomic` + 四态事件的默认渲染 `createJsonFileEventHandler` /
`logJsonFileEvent` + 4 个公共类型）。

## 文件

- `types.ts` — 公共类型契约 `JsonFileEvent` / `JsonFileEventType` / `JsonFileOptions` / `JsonFileRead`。
- `cache.ts` — 跨调用共享缓存 `caches` / `missingEntry` 与缓存键（label + path）。
- `subscriber.ts` — per-subscriber 去重状态、`ALLOWED_TRANSITIONS` 迁移表、`notifyTransition`。
- `probe.ts` — stat 三态分类（`ok` / `missing` / `stat-error`）与 `errorMessage` / `isMissingStatError`。
- `read-validate.ts` — 读文件、大小上限、parse 与形状校验。
- `write.ts` — **整份重写的原子原语**（`.tmp` + `rename`）：账号表与名单两个 json 后端共用这一份。
- `json-file.ts` — 编排：probe → 节流 → 未变更 → 读取 → 落缓存 → 通知。
- `event-log.ts` — 四态事件的默认渲染（`createJsonFileEventHandler` / `logJsonFileEvent`）。不持有全局 logger，调用方显式传入；事件如何呈现由组合层决定。
- `index.ts` — 目录 barrel。

## 相关路径

- 读取方 — `@/datasource/users/json-source.ts`、`@/datasource/acl/json-source.ts`
- 写入方 — 同上两个文件（`AccountSource.put` / `delete` 与 `AclSource.write`）
- 事件回调注入 — `event-log.ts` 的 `createJsonFileEventHandler`（消费方 `src/runtime/runtime.ts`、`src/core/identity/factory.ts`）
- 类型引用方 — `src/core/` 下的 `acl-memo.ts`、`identity/factory.ts`、`traffic/memory.ts`

## 相关测试

- `tests/unit/utils/json-file/read.test.ts`
- `tests/unit/utils/json-file/event-rendering.test.ts`
- `tests/unit/datasource/acl/driver-registry.test.ts`（写路径「先校验后落盘」的次序）
- `tests/unit/datasource/users/store-equivalence.test.ts`（账号表写族）
