# src/store/ — 跨帧状态的形状

本目录回答「会话、输出桶、排队的那条命令、弹窗此刻是什么长什么样」：`Session` / `Bucket` / `Job` /
`WindowState` / `ProviderDraft` / `emptyBucket` / `newSession` / `sessionOf` / `sessionSeqOf` /
`restoredSessions` / `SEED_SESSION` / `SidebarEntry` / `LOG_KEEP` / `SCROLL_STEP` / `MESSAGE_TTL_MS` /
`MODEL_TIMEOUT_MS` / `INPUT_HISTORY` / `REASONING_EFFORTS` / `DEFAULT_REASONING_EFFORT` /
`REASONING_CYCLE` / `FALLBACK_ROWS` / `RunState` / `ReasoningEffort`，
加上**落盘那份**会话的形状 `SessionRecord`。
**零 IO、零 React、零终端**；⚠️ 说的**不是**「零逻辑」—— 本目录**有**纯函数实现，而且是那些函数在全包
**唯一**的实现（见下面「`emptyBucket` / `newSession` / … 是这里唯一的实现」那一条）。持有这些状态的组件
是 `@/AppState.tsx`。

⚠️ 本目录**只有形状与常量**：真正的状态机（会话清单、台账播种、执行队列、探活）在 `@/AppState.tsx`，
键位与鼠标分派在 `@/hooks/`。

## 相关

`@/AppState.tsx`（唯一装配方）· `@/hooks/index.js`（三个写入口的调用方）· `@/lib/log/index.js`（`LogEntry` 形状）
`@/commands/index.js`（`Command` 形状）· `@/services/config/index.js`（`sessions` / `sidebar_sessions` /
`messages` 三张表的那一边，⚠️ 它从本目录**转出**四档与缺省）
`tests/state-owner/state-owner.test.ts`（判据 2 的牙齿）· `tests/store/store.test.ts`（那几个纯函数与
`WindowState` 的形状）· `tests/contract/contract.test.ts`（`ModalView` 与 `WindowState` 的判别值关系）