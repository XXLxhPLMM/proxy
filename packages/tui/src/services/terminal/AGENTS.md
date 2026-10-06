# src/services/terminal/ — 终端协议（会往 stdout 写控制序列的那一半）

SGR 鼠标上报（`mouse.ts`）与收尾的合成（`screen.ts`）。**零 Ink、零 React、零 `process.*`**（宿主对象由
`cli.tsx` 注入）。**不做**坐标算术 —— 命中测试归 `@/lib/geometry.js`。对外唯一出口 `@/services/terminal/index.js`。

## 文件

- `mouse.ts` — 上报开关的字节、SGR 解析（`parseSgr` / `isMouseReport`）、探活换算（**只测量不改动**）、
  事件源 `createMouseSource`。⚠️ **本目录唯一发控制序列的模块**（开启三条与关闭三条都在这边）。
- `screen.ts` — 收尾的结构：`ScreenRestore` 与 `chainRestores`（把若干个收尾合成一个）。
  ⚠️ **它一个字的控制序列都不发**。
- `index.ts` — barrel，**只转发**。

## ⚠️ **右键的可用性归终端管，本模块无能为力**

- **上报的字节一样，但终端未必转发**：`1000`/`1003` + `1006` 开着时 SGR 模式**会**把 `b = 2`（右键按下）
  报上来，而 `@/hooks/useMouse.ts` 把它分派成「关掉那一项 / 在侧边栏空白处新开一个会话」。
- ⚠️ **Windows Terminal / 一批终端在右键时弹出自己的菜单、并且根本不发报告**：那一层在本模块**之下**
  （它管的是字节怎么发，管不了字节发不发），故本包**不能**把右键当成「到处都能用」的入口 ——
  会话的新建与关闭因此各有**第二条路**（`/new` 与 `Ctrl+X`，理由见 `@/hooks/useMouse.ts` 文件头）。
- ⚠️ **同理，中键也留给终端**（粘贴），而 `drag` 只在拖宽期间归本包（理由见文件头）。
- ⚠️ **人工验收必须盯这一条**（见 `packages/tui/AGENTS.md` 末尾那一节）：`tests/input/mouse-protocol.test.ts` 那一份
  假 TTY 档**证明不了**「右键在你的终端里真的会到」—— 它把字节喂进 stdin，而真终端可能压根不发。

## 相关路径 / 测试

- `@/lib/index.js` — **不共用**判据（那边纯排版函数）；`@/lib/geometry.js` — 矩形与命中（下游）。
- `@/hooks/useMouse.ts` — 事件源的唯一订阅方。
- `tests/mouse/` — 纯函数那一半（分片到达 / 非鼠标字节透传 / 探活 / 同源）。
- `tests/screen/screen.test.ts` + `tests/input/mouse-protocol.test.ts` — 链式收尾的契约 + 「这一族字节的 owner
  唯一」的字面量判据 / 「Ink 交给 `useInput` 的是什么」。
