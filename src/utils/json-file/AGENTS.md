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

## 层不变量

- **写只有一份，且刻意不做成「增量」**：`writeJsonAtomic(file, value)` 收的是**磁盘形态**
  （未归一化的 `unknown`），落盘前**不校验**——校验归各数据源，而它们用的正是读侧那同一个
  `validateAuthUsers` / `validateAcl`，故「落盘 = 校验过的字节」这条性质对每个后端都成立。
  账号表（`AccountSource.put` / `delete`）与名单（`AclSource.write`）各抄一份的后果是
  「A 档的原子性比 B 档强一点」这种没人能一眼看出的漂移。
- **原子性的真实边界（别把它当事务）**：POSIX 的 `rename` 对同目录原子；Windows 不能覆盖已存在的
  目标，故先 `rmSync` 再 `rename`，那两步之间有一个极短的「文件不存在」窗口（读侧把缺失当合法
  状态）。**并发写会互相覆盖**——读-改-写不是事务。完整论证见 `write.ts` 文件头。
- **骨架物化（`writeSkeletonIfMissing`）刻意不在本层**：骨架内容是**业务知识**（缺失 = 空表 vs
  缺失 = 还没建表，两种含义不同），而「怎么把一段文本原子地放上磁盘」不是。它在
  `@/datasource/ensure-target.ts`。

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
