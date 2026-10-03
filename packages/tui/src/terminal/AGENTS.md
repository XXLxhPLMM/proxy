# src/terminal/ — 终端协议（会往 stdout 写控制序列的那一半）

SGR 鼠标上报（`mouse.ts`）与全屏接管（`screen.ts`）。**零 Ink、零 React、零 `process.*`**（宿主对象由
`cli.tsx` 注入）。**不做**坐标算术 —— 命中测试归 `@/view/geometry.ts`。对外唯一出口 `@/terminal/index.js`。

## 文件

- `mouse.ts` — 上报开关的字节、SGR 解析（`parseSgr` / `isMouseReport`）、探活换算（**只测量不改动**）、
  事件源 `createMouseSource`。
- `screen.ts` — 光标显隐与进入/退出的成对序列（`enterFullScreen` / `chainRestores`）。
- `index.ts` — barrel，**只转发**。

## 层不变量

- ⚠️ **`?1049` 归 Ink**：本模块一条都不许碰它 —— 重写会让备用屏幕栈错位且**零报错**（牙齿在
  `tests/screen.test.ts`，源码级断言本模块无 `1049` 字面量）。
- ⚠️ **每条发出的序列都要有配对的撤销，收尾幂等**：到达收尾有三条路径（`finally` /
  `process.once("exit")` / `waitUntilExit`）；`chainRestores` 跑完全部撤销并**重抛第一个错**。
- ⚠️ **Ink 没有鼠标，本包自己挂 `data`**：Ink 交给 `useInput` 之前已摘掉那个 `ESC`，故到这里**全是可打印
  字符** —— `isMouseReport` 必须与 `parseSgr` **同源**，认领在 `@/app/input-line.js` **入状态之前**。
- **`rest` 永不重新注回 stdin**；上报**开起来就不许悄悄关**（开了终端就不选择不粘贴），只在退出时关一次。

## 相关路径 / 测试

- `@/ui/index.js` — **不共用**判据（那边纯排版函数）；`@/view/geometry.ts` — 矩形与命中（下游）。
- `@/app/use-mouse.ts` — 事件源的唯一订阅方。
- `tests/mouse.test.ts` — 纯函数那一半（分片到达 / 非鼠标字节透传 / 探活 / 同源）。
- `tests/screen.test.ts` + `tests/input.test.ts` — 序列成对且收尾幂等 / 「Ink 交给 `useInput` 的是什么」。
