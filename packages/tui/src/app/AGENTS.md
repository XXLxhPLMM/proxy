# src/app/ — 应用状态层

本包**唯一**持有跨帧状态、**唯一**把「一次动作」翻成「若干次 `setState`」的地方。它不认识控制面数据的
任何一个字段（那在 `@/exec/rows.js`），也不画任何东西（那在 `@/view/`）。

| 文件 | 答什么 |
|---|---|
| `app.tsx` | 跨帧状态、台账/探活/执行/面板/窗口的回调、呈现模型装配、渲染 |
| `state.ts` | 状态形状与常量：`Session` / `Bucket` / `Job` / `WindowKind` |
| `input-line.ts` | 输入串与插入符的**纯**函数（零 React，可脱离界面断言） |
| `use-keyboard.ts` | 键位分派 —— 本包唯一挂 `useInput` 的文件 |
| `use-mouse.ts` | 鼠标订阅与分派 —— 本包唯一挂 `mouse.onMouse` 的文件 |
| `use-terminal-size.ts` | 终端宽高：初值 + `resize` —— 本包唯一挂 `resize` 的文件 |
| `failures.ts` | 一次失败 → 一行字（+ 瞬时提示） |
| `index.ts` | barrel，只转发 |

## 层不变量

- ⚠️ **三个订阅口各只有一处**：`useInput`（`use-keyboard.ts`）/ `mouse.onMouse`（`use-mouse.ts`）/ `resize`（`use-terminal-size.ts`）—— 多挂一处的后果不是「多一次重绘」，是「这份输入/这份宽高从哪来」有了第二个答案。
- ⚠️ **`columns` / `rows` 两个 props 只是初值**，而屏上用的是**当前值**：凡是喂 `geometry()` 与喂 `<Layout>` 的都读 `useTerminalSize()` 的返回值。拿 props 算 = 「Ink 已按新尺寸重排、本层还按旧尺寸算」的两份几何。⚠️ 其余那一串（`viewportRef` / `top` / `paletteViewportRows`）全从 `geometry()` 派生，于是改一次窗口大小走的是**同一条**路径。
- ⚠️ **不用 Ink 的 `useWindowSize`**：它自带一份兜底（`terminal-size` 再 80×24），会把组合根那份快照在第一次 resize 之前旁路掉 —— 推导写在 `./use-terminal-size.ts` 文件头。
- ⚠️ **输入行有两道闸，顺序是先认领再入状态**：`isMouseReport`（`use-keyboard.ts`）认领终端报文，`printableOnly`（`input-line.ts`）剔 C0 与 `DEL` —— **少任何一道都不成立**（前者不认粘贴进来的 `U+000D`，后者挡不住已被 Ink 摘掉 `ESC` 的报文）。
- ⚠️ **下标一律是 UTF-16 code unit**：`input-line.ts` / `@/view/geometry.ts:caretFromWrappedPoint` / `complete.ts` / `CaretRow` 四处必须逐字一致，否则插入符偏一个字。
- ⚠️ **`Session` 持输出桶 + 输入行 + `targetId` 且同生共死**（否则「切到会话 2，看到的是会话 1 那台机器的结果」）；⚠️ **控制面本身不在会话里**，台账是所有会话共享的。
- ⚠️ **`readLedger` 抛错时不清内存里上一份好的**，`ledgerError` 显示在输入区中间那行 —— 当成空台账，下一次写就会拿它覆盖掉存着凭据的那份。
- ⚠️ **命令排队、一条一条跑**：`app.tsx:pump` 在 `finally` 里回调自己就是串行化的全部实现，并发跑两次命令时一个 `clear-log` 会抹掉另一条刚落地半秒的结果。
- ⚠️ **侧边栏那一列有四个动作，而每一条路都必须有第二条**：`Ctrl+X` 关当前会话 / 右键某一项关掉它 /
  点那一枚 `✕` 关掉它 / 右键空白处新开一个。⚠️ 鼠标那两路**不是**键位那一路的替代品，而是它必须有的
  并列入口 —— 理由与模态窗口的「`Esc` + 点右上角那枚 `esc`」同源：只留鼠标那一条的话，鼠标不可用的
  终端上根本关不掉会话。
- ⚠️ **`sessionsTop` 是「窗口停在哪」的唯一一份**，而「当前会话必须在窗口里」由 `revealSession` 维持；
  几何层**故意只夹不推**（否则「用滚轮翻看别的会话」会在下一帧被拽回当前会话，滚轮就成了死路）。
  ⚠️ 而**关掉一个会话时窗口不要乱跳**：`closeSession` 只在「被关的那一项在窗口**之上**」时上移一格。
- ⚠️ **探活结果的新旧靠 `probeSeq` 序号判**（`app.tsx:reprobe` 每次 +1，回来时序号仍匹配的那次才写回）—— **不是** effect 清理标志：那拦不住已在飞的请求。

## 相关

`@/view/index.js`（唯一上游） · `@/exec/index.js`（`exec()` 与 `Effect`，本层只按 `Effect` 反应） · `@/ledger/index.js` · `@/terminal/index.js`（只订阅，生命周期归组合根）
`tests/input.test.ts`（喂进去的鼠标报告一个字都不许进输入行 + 面板整条交互 + **改窗口大小那一档**） · `tests/layout.test.ts` · ⚠️ 本目录零纯逻辑单测，理由见 `app.tsx` 文件头
