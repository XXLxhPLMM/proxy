# src/store/ — 跨帧状态的形状

本目录回答「会话、输出桶、排队的那条命令长什么样」：`Session` / `Bucket` / `Job` / `WindowKind` 与
`emptyBucket` / `newSession` / `sessionOf` / `sessionSeqOf` / `restoredSessions` / `visibleSessions` /
`LOG_KEEP` / `SCROLL_STEP` / `MESSAGE_TTL_MS` / `MODEL_TIMEOUT_MS` / `EMPTY_PROVIDER` / `FALLBACK_ROWS` /
`RunState`，加上**落盘那份**会话的形状 `SessionRecord`。
**零 IO、零 React、零终端**；⚠️ 说的**不是**「零逻辑」—— 本目录**有**纯函数实现，而且是那些函数在全包
**唯一**的实现（见下面「`emptyBucket` / `newSession` / … 是这里唯一的实现」那一条）。持有这些状态的组件
是 `@/AppState.tsx`。

⚠️ 本目录**只有形状与常量**：真正的状态机（会话清单、台账播种、执行队列、探活）在 `@/AppState.tsx`，
键位与鼠标分派在 `@/hooks/`。

## 层不变量

- ⚠️ **`Session` 持输出桶 + 输入行 + `targetId` 且同生共死**（否则「切到会话 2，看到的是会话 1 那台机器的结果」）；
  ⚠️ **控制面本身不在会话里**，台账是所有会话共享的一份。
- ⚠️ **`SessionRecord` 是「会话」这件事的**唯一**身份定义**，而 `@/services/config` 的 `sessions` 表按它落盘
  （那一边 **type-only** 引本目录，故不成运行期边）。⚠️ **输出桶不在 `SessionRecord` 里**：那是内存里
  `LOG_KEEP` 条的环形缓冲，持久化它等于把几千条渲染行存成审计日志，而它本来就该在会话被关掉时消失。
- ⚠️ **`created_at` 只有新增那一条路会写**，改名与显隐**都不动**它 —— 它是「这个会话有多老」的唯一定义
  （`updatedAt` 答的是「最后一次新增或改名」，而「藏起来」不是「又动了一次」）。
- ⚠️ **落库的接线与启动恢复都已做**（`@/AppState.tsx` 的 `spawnSession` / `closeSession` / `confirmRename` /
  `setSessionShown` 四条 + 一支只跑一次的恢复 effect）：恢复按 `rowid`（= 插入序）读回**全部**会话，
  ⚠️ **先按 `sessionSeqOf` 把发号抬到库里最大的那个下标再谈新建** —— 不抬的话 `/new` 插一个库里已有的
  `id`，而那是一次「会话说出去了却存不进来」的事故（屏上多一项、库里少一行，屏上零解释）。
- ⚠️ **恢复出来的会话桶是空的**（`sessionOf` 一律 `newSession` 起手）：输出桶与输入行从来没有落盘，
  而 `SessionRecord` **没有 `targetId`** —— 故恢复后每个会话都是「未选控制面」，只有**第一个**被台账的
  `selected` 播种（那条播种 effect 只认下标 0）。
- ⚠️ **隐藏的会话也要恢复**（`visible` 落盘、落回 `Session`）：「藏起来」不是「丢掉」，而恢复时若照
  `newSession` 的缺省 `visible: true` 铺开，屏上会凭空冒出一个用户明确藏掉的名字。
- ⚠️ **`visible` 是侧边栏的过滤器**（`visibleSessions` 是**唯一**那一处）：几何的 `sessionCount`、呈现层的
  切片与命中的回查都吃它这一份；而**当前会话不许藏**（藏了就没有一行说得清「我现在打给谁」）。
- ⚠️ **「侧边栏永远有一行」是一条不变量，而它有**两个**执行点**（少一个就破）：
  ① 关会话的闸门数的是 `visibleSessions(sessions).length`（⚠️ **不是** `sessions.length` ——
  3 个会话里藏了 2 个时，按总数关掉那一行 ⇒ 侧边栏空掉**且库里那一行也被删了**，一次真实的数据丢失）；
  ② `restoredSessions` 把「一个都看不见」的库补出**第一行**（照搬 `visible` 就恢复出一个空侧边栏，
  而症状是「键位全都活着，而没有任何东西说得清我在跟谁说话」——**屏上零解释**）。
  两条的牙齿在 `tests/input/session-storage.test.ts`「侧边栏永远有一行」那一档（关与恢复各两条）。
- ⚠️ **`run` 三档**（`idle` / `running` / `done`）：`running` 从**入队**那一刻起置位（队列串行，排在后面的
  会话也在等），`done` 在**切回来看过**时清成 `idle` —— 它是「你还没看」，不是「它跑过了」。
- ⚠️ **每个会话一个全新的桶对象**（共享同一个对象会让 `setState` 的引用判据失灵）；**发号只有一处**
  （`newSession` + 那个序号 ref），`/new` 与菜单里的「新建会话」不许各造一次。
- ⚠️ **`emptyBucket` / `newSession` / `sessionOf` / `sessionSeqOf` 是这里唯一的实现** —— 其余全是类型与常量，
  故本目录的文件头注释上限与普通实现文件一样（6 行），不是 barrel 的 3 行。⚠️ **`id` 的形状只认
  `s<数字>` 这一种**（`sessionSeqOf` 认不出来的贡献 0，而撞 `id` 交给插入那一步去报）。
- ⚠️ **`LOG_KEEP` 是环形缓冲而不是审计日志**：被丢掉的最早一条必须报得出来（`@/lib/failures.ts:droppedHint`）。
- ⚠️ **跨帧状态由 `@/AppState.tsx` 的 `useState` 持有，理由是「全包只有它一个消费者」**，而呈现层
  **一个动作都不许自己存**（`LayoutProps` 里零个函数字段；`src/` 里调 `useState` / `useRef` 的文件恒等于
  `AppState.tsx` 与 `hooks/useTerminalSize.ts` 那一处 —— 牙齿在 `tests/state-owner/state-owner.test.ts`）。
  ⚠️ **要长出第二个持有者之前先问「第二个组件为什么需要跨帧状态」**：多数场合它要的是**呈现形状**，
  而那一层已经有投影（`sessionRows` / `paletteView` / `windowRows` / `menuView` / `notice` / `ghost`）。
- ⚠️ **「只此一次」那两个守卫（`seededRef` / `restoredRef`）是**每次挂载**一份，不是整个进程一份** ——
  `tests/input/session-storage.test.ts` 的「落盘 / 启动恢复 / 侧边栏永远有一行」那几档在**同一个进程里挂载两次以上**
  `App` 并要求「第二次挂载起手就恢复」。⚠️ 模块级（也就是任何全局 store 给的）生命周期会让它们第二次起
  就是「已恢复」，症状是屏上回到起步那一个空会话而**零解释**。
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
`@/commands/index.js`（`Command` 形状）· `@/services/config/index.js`（`sessions` 表的那一边）
`tests/state-owner/state-owner.test.ts`（上面第一条不变量的牙齿）· `tests/store/store.test.ts`（那几个纯函数）