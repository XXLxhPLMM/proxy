# src/store/ — 跨帧状态的形状

本目录回答「会话、输出桶、排队的那条命令长什么样」：`Session` / `Bucket` / `Job` / `WindowKind` 与
`emptyBucket` / `newSession` / `LOG_KEEP` / `SCROLL_STEP` / `MESSAGE_TTL_MS` / `FALLBACK_ROWS`。**零逻辑、零 React、
零终端**；持有这些状态的组件是 `@/AppState.tsx`。

⚠️ 本目录**只有形状与常量**：真正的状态机（会话清单、台账播种、执行队列、探活）在 `@/AppState.tsx`，
键位与鼠标分派在 `@/hooks/`。

## 层不变量

- ⚠️ **`Session` 持输出桶 + 输入行 + `targetId` 且同生共死**（否则「切到会话 2，看到的是会话 1 那台机器的结果」）；
  ⚠️ **控制面本身不在会话里**，台账是所有会话共享的一份。
- ⚠️ **每个会话一个全新的桶对象**（共享同一个对象会让 `setState` 的引用判据失灵）；**发号只有一处**
  （`newSession` + 那个序号 ref），`/new` 与侧边栏空白处右键不许各造一次。
- ⚠️ **`emptyBucket` / `newSession` 是这里唯一的实现** —— 其余全是类型与常量，故本目录的文件头注释上限与
  普通实现文件一样（6 行），不是 barrel 的 3 行。
- ⚠️ **`LOG_KEEP` 是环形缓冲而不是审计日志**：被丢掉的最早一条必须报得出来（`@/lib/failures.ts:droppedHint`）。
- ⚠️ **`InputPatch` / `EditActive` / `CaretActive` / `FillActive` 是三个写入口的形状**，键位与鼠标共用它们 ——
  分成两套就造出「一个入口清了行、另一个没清」。

## 相关

`@/AppState.tsx`（唯一装配方）· `@/hooks/index.js`（三个写入口的调用方）· `@/lib/log/index.js`（`LogEntry` 形状）
`@/commands/index.js`（`Command` 形状）