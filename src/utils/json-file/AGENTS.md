# src/utils/json-file — JSON 配置热加载读取层

跨目录只引 `@/utils/json-file/index.js`；层内相对引用，**禁止自引 barrel**（目录内部不得出现 `@/utils/json-file/index.js`）。

**本目录是全仓职责划分与判定面收口的范式样板**，其它目录拆分层出口时照抄。

## 职责表

| 文件               | 只负责                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `types.ts`         | 公共类型契约（`JsonFileEvent`/`JsonFileEventType`/`JsonFileOptions`/`JsonFileRead`），零运行时值              |
| `cache.ts`         | 跨调用共享的缓存（`caches`/`missingEntry`/缓存键）+ **16 条上限**、插入序淘汰                              |
| `subscriber.ts`    | per-subscriber 去重状态 + `ALLOWED_TRANSITIONS` + **全目录唯一的「要不要报事件」判定点** `notifyTransition`（另出 `TransitionContext`/`TransitionSnapshot`/`transitionContext`） |
| `probe.ts`         | stat 三态分类（`ok`/`missing`/`stat-error`）+ **目录唯一的错误文案口径** `errorMessage` 与 `isMissingStatError` |
| `read-validate.ts` | 读文件 + 大小上限 + parse + 形状校验，不抛                                                                     |
| `json-file.ts`     | **只做编排**：probe → 节流 → 未变更 → 读取 → 落缓存 → 通知；体内不得出现任何事件判定                         |
| `index.ts`         | 目录出口，只出 `readJsonCached`（1 个值）+ 4 个公共类型                                                      |

## 判定面必须集中

**新增判定面时改 `ALLOWED_TRANSITIONS` 表，不要在 `json-file.ts` 里加 if。** 五个判定面各自声明允许触发哪几种迁移：

| 判定面     | 允许的迁移                    | 语义                                       |
| ---------- | ----------------------------- | ------------------------------------------ |
| `throttled`| `missing` / `error`           | 节流命中：没 stat，只补发尚未上报过的        |
| `stat-error`| `error`                      | 状态不可观测（`EACCES` 等），**绝不伪装成 missing** |
| `missing`  | `missing`                     | 文件消失 / 非普通文件                       |
| `unchanged`| `error` / `recovered`        | 复用旧值，只需补状态                        |
| `read`     | `error` / `recovered` / `reloaded` | 真读了内容，走完整状态机               |

## 错误边界（安全相关，改动前务必读完）

- **只有 `ENOENT`/`ENOTDIR`/非普通文件算 missing**。其它 stat 错误（如 `EACCES`）必须保留上一份有效值并报 `error`——**绝不能让 ACL 因权限错误静默全放行**。`stat-error` 是独立判定面就是为此。
- 已加载文件「存在 → 缺失」必须报 `missing`，否则 ACL 静默变全放行没人知道；此时**不带** `mtimeMs`/`size`（无版本可报）。
- 坏内容（parse/形状校验失败）同样保留上一份有效值。
- `error` 一律按**真值**判定，不要写成 `if (err)` 之外的花样（`onEvent` 可能传空串语义）。

## 缓存与订阅

- **缓存键 = label + path**。相对路径进入缓存前先绝对化（缓存键契约要求「label + 绝对路径」；这是本目录允许自己做绝对化的**唯一**理由——别拿它当第二个权威去改别处的路径基准）。
- 事件去重状态按 **onEvent 回调**隔离（同一份文件被两个回调订阅，各自独立判重）。
- **缓存上限 16 条，淘汰是「插入序 + 写时刷新年龄」，不是真 LRU**：`putCache` 先 `delete` 再 `set` 刷新年龄，超限按 `keys()` 顺序踢最旧的——即「最久没被更新过」，**没有访问时间记账**。想加 touch-on-get 会悄悄改变语义，别加。

## 调用顺序硬约束

- **`putCache` 必须在 notify 之后**：事件载荷里的 `mtimeMs`/`size` 来自读到的内容，先落缓存会让订阅方回调里再读到新值而与事件对不上。
- 事件带不带 `mtimeMs`/`size` 由 `current.exists` 决定。
- 回调抛错被吞，**读取路径绝不抛**。

## 零日志

`readJsonCached` **不依赖 logger**（本目录零日志）。事件呈现由调用方显式注入：runtime 用 `createJsonFileEventHandler(runtime.logger)` 造回调再传给 users/ACL 读取；`config/files/event-log.ts` 只接受 logger 参数，不抓全局 logger。

## 护栏

`tests/unit/json-file.test.ts`（17 例）覆盖 label+path 缓存隔离、多个回调各自收到 error/recovered、同回调去重、missing/reloaded 判定与上述错误边界。**断言不得改动，只许改 import 路径**。
