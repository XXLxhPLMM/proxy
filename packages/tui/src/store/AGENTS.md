# src/store/ — 跨帧状态的形状

本目录回答「会话、输出桶、排队的那条命令长什么样」：`Session` / `Bucket` / `Job` / `WindowKind` /
`emptyBucket` / `newSession` / `sessionOf` / `sessionSeqOf` / `restoredSessions` / `SEED_SESSION` /
`SidebarEntry` / `LOG_KEEP` / `SCROLL_STEP` / `MESSAGE_TTL_MS` / `MODEL_TIMEOUT_MS` / `EMPTY_PROVIDER` /
`FALLBACK_ROWS` / `RunState`，加上**落盘那份**会话的形状 `SessionRecord`。
**零 IO、零 React、零终端**；⚠️ 说的**不是**「零逻辑」—— 本目录**有**纯函数实现，而且是那些函数在全包
**唯一**的实现（见下面「`emptyBucket` / `newSession` / … 是这里唯一的实现」那一条）。持有这些状态的组件
是 `@/AppState.tsx`。

⚠️ 本目录**只有形状与常量**：真正的状态机（会话清单、台账播种、执行队列、探活）在 `@/AppState.tsx`，
键位与鼠标分派在 `@/hooks/`。

## 层不变量

- ⚠️ **`Session` 持输出桶 + 输入行 + `targetId` 且同生共死**（否则「切到会话 2，看到的是会话 1 那台机器的结果」）；
  ⚠️ **控制面本身不在会话里**，台账是所有会话共享的一份。
- ⚠️ **`SessionRecord` 是「会话」这件事的**唯一**身份定义**，而 `@/services/config` 的 `sessions` 表按它落盘
  （那一边 **type-only** 引本目录，故不成运行期边）。⚠️ **输出桶不在 `SessionRecord` 里**：`messages` 表按
  `(session_id, seq)` 一格一行落，⚠️ **`seq` 恒等于那条 `LogEntry.id`** —— 两者不对齐的话下一次追加就撞主键。
- ⚠️ **「在不在侧边栏上」不是 `Session` / `SessionRecord` 的字段**，它是 {@link SidebarEntry} 那一问
  （`@/services/config` 的 `sidebar_sessions` 表）。⚠️ 判据是**它在那一层有一张自己的表** ——
  一个把它挂回会话身上的实现在本目录连形状都摆不出来。⚠️ **从侧边栏移出 ≠ 删除**：那一张表的行没了，
  `sessions` 与 `messages` 两张表一个字都不动；真删是弹窗里 `Ctrl+D` 的级联。
- ⚠️ **`created_at` 只有新增那一条路会写**，改名与激活**都不动**它 —— 它是「这个会话有多老」的唯一定义
  （`updatedAt` 答的是「最后一次新增或改名」，而「激活进侧边栏」不是「这个会话动了一次」）。
- ⚠️ **落库的接线在 `@/AppState.tsx`**（`spawnSession` / `closeSession` / `confirmRename` 与那几支激活 / 摘下 /
  追加 / 收口的 effect，加一支只跑一次的恢复 effect）：恢复按 `rowid`（= 插入序）读回**全部**会话，
  ⚠️ **先按 `sessionSeqOf` 把发号抬到库里最大的那个下标再谈新建** —— 不抬的话 `/new` 插一个库里已有的
  `id`，而那是一次「会话说出去了却存不进来」的事故（屏上多一项、库里少一行，屏上零解释）。
- ⚠️ **恢复出来的会话是「清单」与「侧边栏」两份答案的合成**：内存里那几行由 `sidebar_sessions` 的 `rowid`
  顺序（= **激活顺序**）排，不在清单上的会话不进侧边栏；当前那一个也由清单答 —— 否则「从侧边栏移出」在
  重开之后等于没做。⚠️ 对话本身走**另一支 effect**（`loadMessages`，判据是 `activeId` 变了），
  ⚠️ **每个会话只读一次**（`loadedMessagesRef` 也是每次挂载一份）—— 重复读会把 `/clear` 之后的空当 bug。
- ⚠️ **`restoredSessions` 只在库里**一个会话都没有**时补出起步那一个**（`SEED_SESSION`），
  而**补的只是内存里那一份**：一个字节都不写回去，故这一趟仍是**纯读**（幂等，跑两遍得到同一份）。
  ⚠️ **有一个就不要造** —— 库里那些是用户自己的，凭空加一行会让侧边栏凭空多出一项。
- ⚠️ **`SEED_SESSION.id` 与 `sessionSeqOf([])` 是耦合的**：那一个物化成内存里那份之后「库里用到的最大下标」是 1，
  而发号器正是在那个数上再加一 ⇒ `/new` 拿到 `s2` 而不是 `s1`。⚠️ 这个常量住在本目录是因为「起手长什么样」
  是形状问题（另一处再放一份，两处就会各自漂成不同的名字）。
- ⚠️ **`run` 三档**（`idle` / `running` / `done`）：`running` 从**入队**那一刻起置位（队列串行，排在后面的
  会话也在等），`done` 在**切回来看过**时清成 `idle` —— 它是「你还没看」，不是「它跑过了」。
  ⚠️ **三档在屏上三副样子**（`@/theme/impl.ts:runMarkOf` 的真值表）：`idle` 是**一个空格** + `idle` 档，
  `running` 是 `⠋` + `accent` 档，`done` 是 **`●` + `ok` 档（绿）** —— ⚠️ 「跑完了」与「还在跑」屏上分得开，
  而 `idle` 那一格**恒存在**（字形是空格而不是空串），所以两帧的列位一样、名字不会跳。
- ⚠️ **每个会话一个全新的桶对象**（共享同一个对象会让 `setState` 的引用判据失灵）；**发号只有一处**
  （`newSession` + 那个序号 ref），`/new` 与菜单里的「新建会话」不许各造一次。
- ⚠️ **`emptyBucket` / `newSession` / `sessionOf` / `sessionSeqOf` / `restoredSessions` 是这里唯一的实现** ——
  其余全是类型与常量，故本目录的文件头注释上限与普通实现文件一样（6 行），不是 barrel 的 3 行。⚠️ **`id` 的形状只认
  `s<数字>` 这一种**（`sessionSeqOf` 认不出来的贡献 0，而撞 `id` 交给插入那一步去报）。
- ⚠️ **`LOG_KEEP` 是环形缓冲而不是审计日志**：被丢掉的最早一条必须报得出来（`@/lib/failures.ts:droppedHint`）。
- ⚠️ **跨帧状态由 `@/AppState.tsx` 的 `useState` 持有，理由是「全包只有它一个消费者」**，而呈现层
  **一个动作都不许自己存**（`LayoutProps` 里零个函数字段；`src/` 里调 `useState` / `useRef` 的文件恒等于
  `AppState.tsx` 与 `hooks/useTerminalSize.ts` 那一处 —— 牙齿在 `tests/state-owner/state-owner.test.ts`）。
  ⚠️ **要长出第二个持有者之前先问「第二个组件为什么需要跨帧状态」**：多数场合它要的是**呈现形状**，
  而那一层已经有投影（`sessionRows` / `paletteView` / `windowRows` / `menuView` / `notice` / `ghost`）。
  ⚠️ **这里的 `windowRows` 是状态层自己那份投影**（视图模型：一行是「谁」+「它有没有在侧边栏上」+「改名框开没开」），
  与几何层那个**同名不同物**（`Geometry.windowRows`：`windowSlots` 里 `kind === "row"` 的那些矩形）**是两个东西** ——
  ⚠️ 改其中一个不许顺手改文档里的另一个，两边各自的不变量分别住在 `src/lib/AGENTS.md` 与本目录这一条。
- ⚠️ **「只此一次」那三个守卫（`seededRef` / `restoredRef` / `loadedMessagesRef`）是**每次挂载**一份，
  不是整个进程一份** —— `tests/input/session-storage.test.ts` 的「落盘 / 启动恢复 / 对话读回来 /
  侧边栏永远有一行」那几档在**同一个进程里挂载两次以上** `App` 并要求「第二次挂载起手就恢复」。
  ⚠️ 模块级（也就是任何全局 store 给的）生命周期会让它们第二次起就是「已恢复」，症状是屏上回到起步那一个
  空会话而**零解释**。
- ⚠️ **落盘那一侧的格子要有一份在 `setState` 回调之外的镜像**（`AppState.tsx:entriesRef`）：同一帧里两次
  `push`（`/batch` 扇出、`sayToModel`）拿到的 `prev` 是同一个 ⇒ `seq` 发成同一个数 ⇒ `appendMessages` 撞
  `(session_id, seq)` ⇒ **整批静默丢**。⚠️ 渲染读的那份仍在 `Session.bucket`，两者**必须同值**。
- ⚠️ **键位分派整条重写的代价无法量化**：那些断言对**静默抢键**大面积失明 —— 把 `useHotkeys.ts` 里的
  `Ctrl+N` / `Ctrl+P` / `←` / `→` / `Home` / `End` / `PageUp` / `PageDown` 与窗口里的 `↑` `↓` `Tab` 全删掉，
  再让菜单吞掉背后那一层的每一个键，`pnpm test:tui` **一条都不红**（变异记录在
  `tests/input/AGENTS.md` 文件头那张表里）。⚠️ 而断言喂键时每两个之间都隔 ≥30ms，故「闭包读上一帧 vs store
  读最新」那个分叉窗口**没有任何断言站在里面**。
  ⚠️ 真要搬，按「谁读它」把状态分成**响应式 / 命令式 / 一次性守卫**三组再动手，且一次搬完 ——
  搬一半等于同一个事实有两处真相源；动手之前先把上面那几族键位补上断言。
- ⚠️ **`InputPatch` / `EditActive` / `CaretActive` / `FillActive` 是三个写入口的形状**，键位与鼠标共用它们 ——
  分成两套就造出「一个入口清了行、另一个没清」。

## 相关

`@/AppState.tsx`（唯一装配方）· `@/hooks/index.js`（三个写入口的调用方）· `@/lib/log/index.js`（`LogEntry` 形状）
`@/commands/index.js`（`Command` 形状）· `@/services/config/index.js`（`sessions` / `sidebar_sessions` /
`messages` 三张表的那一边）
`tests/state-owner/state-owner.test.ts`（上面第一条不变量的牙齿）· `tests/store/store.test.ts`（那几个纯函数）