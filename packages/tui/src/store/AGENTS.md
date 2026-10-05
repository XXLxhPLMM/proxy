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
- ⚠️ **`run` 三档**（`idle` / `running` / `done`）与 **`seen` 是两个字段**：`run` 只答「**跑没跑完**」，
  `running` 从**入队**那一刻起置位（队列串行，排在后面的会话也在等），而「跑完了你还没看」归 {@link Session.seen}。
  ⚠️ 屏上那枚「完成」记号的**判据是 `run === "done" && !seen`** —— 而它是 `@/theme/impl.ts:runMarkOf`
  那个**两参**换算的活（呈现层只把 `run` 与 `seen` 两格一起递进去），本目录只给那两个格子。
  ⚠️ 契约那一侧两格都在（`SessionRow.run` / `SessionRow.seen`，归 `@/components/types.ts`），
  而**呈现层不许自己判**「这一格是不是那个待确认的」。
  ⚠️ 合成一格的话「切回来看过一眼」就把「跑完了」一起清了，于是下一次跑完再没有记号。
  ⚠️ **置 `seen = true` 只有两个落点**：① `activeId` 变成那个会话（`@/AppState.tsx` 那个 effect，
  它顺带覆盖「在 `/sessions` 弹窗里**点**它」，因为那一点就是激活它）；② 那个会话上的一条命令
  **结果落进你此刻正看着的那一个桶**时。⚠️ ② 判据是**落进当前那个桶**而不是「提交那一刻」——
  提交就置位的话「在别的会话里跑、跑完了你还没看」那一格永远亮不起来。
  ⚠️ **在弹窗里 `↑` `↓` 挪高亮不算**：它只挪 `at`，而挪高亮就把记号清掉的话，
  那枚「要你去看」的提示会随着指针扫过而永久消失。
  ⚠️ **`run` 三档一个字都不许删**（`@/theme/impl.ts:runMarkOf` 的 `Record<RunState, RunMark>` 靠它）：
  `idle` 是**一个空格** + `idle` 档，`running` 是 `⠋` + `accent` 档，`done` 是 **`●` + `ok` 档（绿）** ——
  `idle` 那一格**恒存在**（字形是空格而不是空串），所以两帧的列位一样、名字不会跳。
  ⚠️ 而「跑完了而你已经看过」那一份**不是第四档**：它复用 `idle` 的那一个空格 + `idle` 档 ——
  另造一个字形就等于在「已看」与「从没有过记号」之间多出一个屏上说不清的区别。
- ⚠️ **`SessionRecord` 一律不带 `seen` / `modelRef` / `reasoning`**：前两个是**纯内存**（前者是这一次的注意力，
  落盘的话重开进程就凭空多一堆绿点；后者与推理强度归 `@/services/config` 那两张列**单独一查**，
  而会话的**身份定义**就是那四列 —— 模型选择是另一组事实，混进去就没法单独改）。
  ⚠️ 于是 `newSession` 给的那几个缺省**只在内存这一侧**成立，读回来的形状由 `@/AppState.tsx` 现读现填。
- ⚠️ **`WindowState` 是判别联合**（`null` 或六种内容），不是 `boolean` 也不是一个档名：一个窗口一次只开一种内容，
  而每种要的格子不同（清单要 `at` 与 `pending`、模型列表要 `filter` / `picked` / `busy`）
  ⇒ 合成「一个 `kind` + 全可选字段」就是那份形状的谎话（`undefined` 会分出「忘了传」与「没开」）。
  ⚠️ **`pending` 是「待确认删除的那一个 id」**（两次 `Ctrl+D` 里已经按过一次的那一次），而换 `at` / 按 `Esc` /
  任何非删除键都清掉它 —— 判据是「这一格还等着第二次确认吗」，与「它被删了吗」无关。
  ⚠️ **它在每一档清单上都有**：删除走两段 `Ctrl+D` 的每一档（`sessions` / `targets` / `users` /
  `providers` / `provider-models` / `models`）都挂着它，而它住在跨帧状态这一侧时「哪一个 id 在等第二次」
  才只有**一个**持有者 —— 分成两处就造出「关窗重开、那一格还在等」与「换个弹窗回来、它跟着走了」两种
  说不清的屏上事实。⚠️ 屏上那一格由**行模型**回答（`ListRow.pending` / `SessionListRow.pending` /
  `ModelCheckRow.pending`，都归 `@/components/types.ts`），故**视图那一侧一个 `pending` 都不许有**
  （两边各有一个 ⇒ 「窗态说在等、那一行却不是警告色」）。牙齿：`tests/contract/contract.test.ts`
  「每一档清单的**窗态**上都挂着 `pending`」（逐档现取键集，带正向对照）+ `tests/store/store.test.ts`
  「**每一档清单都能挂着「待确认删除」**」。
- ⚠️ **五种表单不在这个联合里**：它们的字段表从**四格到一格**不等（提供商五格、控制面四格、账号三到四格、
  改密码一格、改显示名一格），而一个 `draft` 格子只表达得了其中一种 ⇒ 表单住状态层的局部 `FormState`，
  屏上走 `ModalView["provider-form"]` 的 `fields`（长度由状态层给）。⚠️ 于是 `ModalView` 的判别值是
  **本目录那一侧的超集**，而多出来的那一档**逐字列得出**（例外表在 `tests/contract/contract.test.ts`
  与 `ModalView` 那个声明的文件头上各一份）—— ⚠️ 例外**不许悄悄删**：放行一个已删的例外与点名一个已删的
  符号一样会让判据恒绿。
- ⚠️ **`filter` 与 `picked` 互不影响，而保存写的是 `picked` 减去被显式删掉的那些**：过滤框只管**屏上画哪几行**，
  被滤掉的行**仍在勾里**。⚠️ 反过来（保存时按「屏上看得见的」重建勾选）的话，打一个过滤词再按 `Esc`，
  那个提供商**整份模型清单被清空** —— 而屏上零解释：用户只是筛了显示。
  ⚠️ **`busy` 只是「正在从 `/models` 端点拉取」那一档**，它不锁清单（拉回来的是全选，用户仍可改勾选）。
- ⚠️ **`Ctrl+P` 改密码是**单独一份表单**，而密码那一格逐字保留、一个字符都不打码**：它就是待发出去的那一个，
  打码了就发不出去；而永不打码也不违反「凭据不上屏」—— 那一格画的是**用户刚敲进去的**，屏上不会有它落盘后的样子。
- ⚠️ **每个会话一个全新的桶对象**（共享同一个对象会让 `setState` 的引用判据失灵）；**发号只有一处**
  （`newSession` + 那个序号 ref），`/new` 与菜单里的「新建会话」不许各造一次。
- ⚠️ **`emptyBucket` / `newSession` / `sessionOf` / `sessionSeqOf` / `restoredSessions` 是这里唯一的实现** ——
  其余全是类型与常量，故本目录的文件头注释上限与普通实现文件一样（6 行），不是 barrel 的 3 行。⚠️ **`id` 的形状只认
  `s<数字>` 这一种**（`sessionSeqOf` 认不出来的贡献 0，而撞 `id` 交给插入那一步去报）。
- ⚠️ **新会话字段的缺省值只在 `newSession` 给一次**（`sessionOf` 与 `restoredSessions` 都经它）：三处各写一遍缺省的话，
  重开进程恢复出来的会话就与新建的那些**不是同一份形状** —— 症状是「重启之后那一行绿点没了」而不是任何一条报错。
  牙齿：`tests/store/store.test.ts`「三处给的是同一份缺省」那一档（判据是**键集**，故多一格少一格都会红）。
- ⚠️ **`INPUT_HISTORY` 与 `REASONING_CYCLE` 是「上限」与「循环序」两个数，各只有一份**：
  `REASONING_CYCLE` **就是** `REASONING_EFFORTS` 那个数组对象（不是另一份抄的）—— 两处各抄一份循环序就会各自漂，
  而漂了的症状是「界面上循环切了一档、出网的却是另一档」。⚠️ 溢出从**最早**那一条丢（最新恒在末尾）。
- ⚠️ **输入历史是**跨会话共享**的一份，而入历史的判据是「提交过」**：分会话各存一份的话，切一次会话就把
  「我刚才那一句是什么」清掉 —— 而「这一行算哪台会话的」屏上答不出来。
  ⚠️ 而**提交时才入**（不是每次改动就入）：敲了一半又删掉的那一串若进了历史，`↑` 会把它原样填回来，
  于是操作者删掉过的东西又出现在输入行上。
- ⚠️ **本目录零运行期 import**（一律 `import type` 与 barrel 的 `export … from`；牙齿：
  `tests/state-owner/state-owner.test.ts` 判据 2，它按「import 语句那一行不是 `import type`」判形）。
  ⚠️ **推理强度那四档与它们的缺省档定义在这里**（`ReasoningEffort` / `REASONING_EFFORTS` /
  `DEFAULT_REASONING_EFFORT`）而 `@/services/config/types.ts` **反过来从本目录转出**：它是
  {@link Session.reasoning} 那一格的取值闭集，而**那一格的缺省必须与 `newSession` 同住一处** ——
  定义放在别的层时本目录就得**运行期**去拿一个值，形状层于是不再是形状层。
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
  再让菜单吞掉背后那一层的每一个键，`pnpm test:tui` **一条都不红**。⚠️ 而断言喂键时每两个之间都隔 ≥30ms，
  故「闭包读上一帧 vs store 读最新」那个分叉窗口**没有任何断言站在里面**。
  ⚠️ 真要搬，按「谁读它」把状态分成**响应式 / 命令式 / 一次性守卫**三组再动手，且一次搬完 ——
  搬一半等于同一个事实有两处真相源；动手之前先把上面那几族键位补上断言。
- ⚠️ **`InputPatch` / `EditActive` / `CaretActive` / `FillActive` 是三个写入口的形状**，键位与鼠标共用它们 ——
  分成两套就造出「一个入口清了行、另一个没清」。
  ⚠️ **它们都带 `anchor`**（选区锚点）：不带的话选区只在一个入口里有，而退格 / 删除 / 提交要把整段选区吃掉 ——
  那一段的两端都要知道。⚠️ **`CaretActive` 交回 `{ cursor, anchor }` 两格**而不只是一个数：不带 Shift 的
  `←` `→` `Home` `End` 要**清空选区**，而那个「清空」就是 `anchor` 变 `null`；只交回一个下标的话，
  按完 `→` 选区还留在屏上（然后下一次打字把整段吃掉，而用户没选过它）。
- ⚠️ **`ProviderDraft.apiKey` 是「编辑中的草稿」**：从屏上读回来的那一份恒是掩码，而**留空 = 不改这一项**
  （不是「改成空」）—— 落盘后永不回显真值，真值只在持有清单的那一处内存里。
  ⚠️ **凭据那一格照样画插入符**：它是一个真文本框（敲进去就换掉那一项），而留空时它恒是空串 ——
  **光标停在一个空格里正是「这一格能敲、敲了才改」的屏上答案**；不画的话那一格与只读的一格长得一样，
  操作者只会以为它坏了。⚠️ 而 `ProviderDraft` **只表达提供商那一种表单**（五格），另外四种字段表不同 ——
  屏上那一格是 `FieldCell`（带 `cursor`，归 `@/components/types.ts`），不读 `ProviderDraft`。

## 相关

`@/AppState.tsx`（唯一装配方）· `@/hooks/index.js`（三个写入口的调用方）· `@/lib/log/index.js`（`LogEntry` 形状）
`@/commands/index.js`（`Command` 形状）· `@/services/config/index.js`（`sessions` / `sidebar_sessions` /
`messages` 三张表的那一边，⚠️ 它从本目录**转出**四档与缺省）
`tests/state-owner/state-owner.test.ts`（判据 2 的牙齿）· `tests/store/store.test.ts`（那几个纯函数与
`WindowState` 的形状）· `tests/contract/contract.test.ts`（`ModalView` 与 `WindowState` 的判别值关系）