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
| `failures.ts` | 一次失败 → 一行字（+ 瞬时提示） |
| `index.ts` | barrel，只转发 |

## 层不变量

- ⚠️ **输入行有两道闸，顺序是先认领再入状态**：`isMouseReport`（`use-keyboard.ts`）认领终端报文，`printableOnly`（`input-line.ts`）剔 C0 与 `DEL` —— **少任何一道都不成立**（前者不认粘贴进来的 `U+000D`，后者挡不住已被 Ink 摘掉 `ESC` 的报文）。
- ⚠️ **下标一律是 UTF-16 code unit**：`input-line.ts` / `@/view/geometry.ts:caretFromWrappedPoint` / `complete.ts` / `CaretRow` 四处必须逐字一致，否则插入符偏一个字。
- ⚠️ **`Session` 持输出桶 + 输入行 + `targetId` 且同生共死**（否则「切到会话 2，看到的是会话 1 那台机器的结果」）；⚠️ **控制面本身不在会话里**，台账是所有会话共享的。
- ⚠️ **`readLedger` 抛错时不清内存里上一份好的**，`ledgerError` 显示在输入区中间那行 —— 当成空台账，下一次写就会拿它覆盖掉存着凭据的那份。
- ⚠️ **命令排队、一条一条跑**：`app.tsx:pump` 在 `finally` 里回调自己就是串行化的全部实现，并发跑两次命令时一个 `clear-log` 会抹掉另一条刚落地半秒的结果。

## 相关

`@/view/index.js`（唯一上游） · `@/exec/index.js`（`exec()` 与 `Effect`，本层只按 `Effect` 反应） · `@/ledger/index.js` · `@/terminal/index.js`（只订阅，生命周期归组合根）
`tests/input.test.ts`（喂进去的鼠标报告一个字都不许进输入行 + 面板整条交互） · `tests/layout.test.ts` · ⚠️ 本目录零纯逻辑单测，理由见 `app.tsx` 文件头
