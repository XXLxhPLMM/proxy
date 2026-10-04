# tests/palette/ — `@/commands/palette`（命令面板）的纯函数断言

被测模块在 `@/commands/palette.js`，零 IO、零渲染；面板的**几何**（占哪几行）在
`@/lib/geometry.ts`，**呈现**在 `@/app.tsx`，两者都不在这里。五条不变量分两档：
`rows.test.ts`（①开 / ②列全表 / ③高亮是纯函数）与 `navigate.test.ts`（④补完 / ⑤移动与滚窗）。

**锁什么**：五条不变量 —— ①面板的**开**只有一条判据（整行以 `/` 开头）；②列的是**全表**
而敲出来的东西只定高亮（否则 `↑`/`↓` 走一步就无路可走）；③高亮是**输入行的纯函数**
（界面上没有「高亮在第几行」这个状态，故不存在「输入行 A、高亮 B」那一帧）；④`↑`/`↓`/`Tab`/
鼠标点**共用同一个补全实现**，而它只换**命令名那一段**、形参原样留着；⑤`↑`/`↓`**到头停住**而不循环，
滚窗负责让高亮**始终可见**（循环会让「到头了」这件事永远按不出来）。

## 为什么拆掉哪一处会红

- 「开」的前缀那道闸去掉 → 「不带前缀的行不开面板」那组红（且**没有**别处会红）。
- 列表改成「按敲的东西过滤」→ 「`↓` 能一路走到底」那组红：填完 `/clear` 之后列表塌成一行。
- 高亮改成 `at` 自己累加（不再是纯函数）→ 「高亮跟着输入行走」那组红。
- `paletteFill` 改成替换**整行** → 「形参原样留着」那组红（`/user ad|d alice` 丢掉形参）。
- `paletteFill` 不补那个尾随空格 → 「两段命令名的空格」那组红。
- **命令名那段宽度按「被选中那条名字的前缀」算** → 「`↓` 走过两段命令名的边界」那组红：
  `/user add` 走到 `/user set` 只吃掉 `user`，剩下的 ` add` 变成尾巴（一条命令里夹着一个形参，
  而 `parseLine` 不会因此报错）。
- **命令名不跨空白取** → 同上：`/user add `（名字已敲完）的高亮停在 `/user` 上，
  而屏上那个形状是「按了 `↓` 它不动」。
- `paletteWindow` 换成 `clamp` → 「高亮被顶到视口最后一行时才滚」那组红。
- `paletteStep` 改成循环 → 「到头停住」那组红。

## 变异实测记录（每条都做过，绿 / 红两次输出都在交接说明里）

| # | 变异 | 转红的判据 |
| --- | --- | --- |
| N1 | `parseLine` 的前缀那道闸整段删掉 | `tests/parse/` 的「不带前缀」那一组 + `tests/input/` 的「不带 `/` 回车」 |
| N2 | `complete` 的前缀那道闸删掉 | `tests/complete/`「退格删掉 `/` 之后那一行」 |
| N3 | `complete` 把命令名也接回来 | `tests/complete/candidates.test.ts`「命令名一个候选都不给」那组 |
| N4 | `paletteOpen` 只判「永远开」 | `tests/input/` 里 6 条（空输入行上不该有面板） |
| N5 | 面板按敲的东西过滤 | 四档同时炸（`paletteOf` 的返回形状变了） |
| N6 | 高亮改成累加（不再是纯函数） | `tests/input/` 里 5 条 |
| N7 | `paletteFill` 直接拼 `row.path` | 「不许把前缀写两遍」+ `tests/input/` 里 4 条 |
| N8 | `paletteFill` 只换第一个词 | ④「光标在命令名中间」 |
| N9 | 尾随空格不补 | ④「两段命令名的空格」+ ④「补完的光标」 |
| N10 | `paletteStep` 改成循环 | ⑤「到头停住」 |
| N11 | `paletteWindow` 换成 `clamp` | ⑤「高亮被顶到视口最后一行时才滚」 |
| N12 | 完全相同的那条不优先 | ③「`/user` 高亮到 `/user` 本身」 |
| N13 | `path` 不再是「前缀 + 名字」 | `tests/exec/` 的 `help` 两条 + `tests/input/` 里 3 条 |
| N14 | `submit` 又回显原文 | `tests/input/palette.test.ts`「回显只出现一次」+「解析失败清输入行」 |
| N15 | `exec` 不再统一加回显 | `tests/exec/` 里 5 条（含「每一条命令的第一行都是回显」） |
| N16 | 面板**叠在**结果区下面（两者都画） | `tests/layout/`「面板贴着输入框、结果区仍在它上面」 |
| N17 | 面板的说明那一格不给反底色 | `tests/layout/`「同一段反底色里」 |
| N18 | 名字那一列不封顶 | `tests/layout/`「命令名很长时说明那一列仍然看得见」 |
| N19 | 几何层不看 `paletteCount` | `tests/geometry/` ⑥ 的四组 |
| N20 | 面板第一行骑在上框上 | `tests/geometry/` ⑥「第一行的 y」 |
| N21 | `↑`/`↓` 不归面板 | `tests/input/`「面板开着时不切目标」 |
| N22 | `Tab` 不接受面板的高亮 | `tests/input/`「Tab 接受高亮那一行」 |
| N23 | 幽灵文本不再由面板那份算出 | `tests/input/`「幽灵 = 按 Tab 会插进来什么」 |
| N24 | 瞬时消息里「有哪些命令」那一档回来 | `tests/input/`「底部不再有那条提示栏」 |
| N25 | 状态行左半又写回 `target add` 引导 | 同上 |
| N26 | 鼠标点面板行按候选序回查 | `tests/input/`「滚过之后点某一行」 |
| N27 | 滚轮在面板开着时仍滚结果区 | `tests/input/`「滚轮移动高亮」 |
| N28 | 装不下时不留「共 N 条」 | `tests/input/`「面板装不下时」 |
| N29 | 窗口夹住而不跟着高亮滚 | 同上 |

## 面板改成「浮在输入框上方」那一轮的变异（二十二条）

| # | 变异 | 转红的判据 |
| --- | --- | --- |
| M1 | 面板的上限不封顶（占满整块结果区） | `tests/geometry/input-frame.test.ts`「不超过内容行 × 40%」 |
| M2 | 上限给「至少一行」的兜底（矮屏上超过 40%） | 同上（`rows=8` 那一档） |
| M3 | 那一条「装不下」说明行**算在上限之外** | 同上 +「说明行算在上限之内」 |
| M4 | 面板**不贴输入框**（离它一格） | ⑥「最后一行候选的下缘 == 输入框的上缘」 |
| M5 | 结果区**不扣**面板占掉的行 | ⑥「结果文本 + 面板 = 内容高度」 |
| M6 | 侧边栏每项**不铺满整列** | `tests/geometry/`「横跨整列」+ `tests/layout/`「铺满整列」 |
| M7 | 侧边栏**第一项不从第 0 行起** | `tests/geometry/`「没有框：第一项从第 0 行起」 |
| M8 | 结果区内容宽度**多扣一列** | `tests/geometry/block-layout.test.ts`「一个列都不多扣」 |
| M9 | 输入区**框里那 3 行**改成 2 行 | `tests/geometry/` 的首尾相接那几组 |
| M10 | 侧边栏**把框加回来** | `tests/layout/`「整屏只有输入框有框」 |
| M11 | 主区**把框加回来** | 同上 |
| M12 | 侧边栏**标题行加回来** | `tests/layout/`「侧边栏没有标题行」 |
| M13 | 去掉 hover 那一项 `<Box>` 上的底色 | `tests/layout/` ②「hover 铺满整列」 |
| M14 | 选中项的**名字不给「选中」色** | `tests/layout/selection.test.ts` ②「选中的那一项」 |
| M15 | 选中项**给一层反底色**（两个通道混在一起） | 同上（底色那一半） |
| M16 | hover 的底色**取列那一条** | `tests/layout/` ② + `tests/input/` 的 hover 三条 |
| M17 | `Output` 的高度回到「结果文本 + 1」 | 🟢 **实测仍绿** —— 见下面那条证明 |
| M18 | 面板那几行**不按几何的高度画** | `tests/geometry/input-frame.test.ts`「面板开着时输入区整块还在屏上」 |
| M19 | `move` 报告**不再换 hover** | `tests/input/mouse-protocol.test.ts`「指到侧边栏那一项」 |
| M20 | hover **不跟着指针离开而清掉** | `tests/input/`「划到主区回到列那一条」 |
| M21 | 命令名**不跨空白**取 | 本档「`↓` 走过两段命令名的边界」 |
| M22 | 换掉的宽度回到「被选中那条名字的前缀」 | 同上 |

⚠️ **两条「不是变异的变异」**（实测是绿的，故它们**不是**这条护栏在生效的证据）：
- 把 `complete` 的 `cursor < lead` 判据删掉 —— 那一半被「`startsWith`」**同时**挡着，
  单独删它没有可观测后果（真正的牙齿是 N2 与 N3 的组合）。
- **M17 是可证明的等价变异**：`outputRows = max(0, outputBlockRows - 1)`，故 `outputBlockRows ≥ 1`
  时 `outputRows + 1 === outputBlockRows` 逐字相等；而 `outputBlockRows === 0` 时那个恒等式
  让「多画的一行滚动提示」正好落在结果区**本来就有的**那一行空位里（结果是**不溢出**）。
  它真正被挡住的地方是 ⑥ 的恒等式「`outputBlockRows + 面板 === 内容行数`」—— 那条一旦破，
  这一行就无处安放。

⚠️ 早先那条「面板画在结果区前面 → 真渲染看不见」也已作废：面板现在**自己占行**，两者
画在同一列里依次排下去，`flexDirection` 的先后**看得见**（N16 就是靠它转红的）。

## 本档测不到的一半

⚠️ 本档**测不到**的是面板占哪几行：那是 `@/lib/geometry.ts` 的算术
（`packages/tui/tests/geometry/`）与 `@/app.tsx` 的呈现
（`packages/tui/tests/layout/`）各一半，而两者读的是**同一个** `paletteCount`。

## 相关

`@/commands/palette.js` · `@/commands/parse.js`（`COMMAND_SPECS`）
`tests/palette/rows.test.ts` · `tests/palette/navigate.test.ts`
`tests/geometry/` · `tests/layout/`（面板占哪几行 / 画在哪）
