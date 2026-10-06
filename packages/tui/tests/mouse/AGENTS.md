# tests/mouse/ — `@/services/terminal/mouse` 的断言

两档：**报文怎么读成事件**（`parseSgr` / `isMouseReport`）与**上报有没有生效**（探活换算 + 事件源接线）。
两档都**不碰真终端** —— fake stdin / fake stdout 全在内存里。

## 文件

- `parse.test.ts` — 上报开关序列的对称性、`parseSgr`（分片 / 一个 chunk 多条 / 坐标 / 滚轮 /
  非鼠标字节透传）、`isMouseReport`（Ink 交到 `useInput` 面前那一串的认领）。
- `source.test.ts` — `mouseSupportOf` 四档换算 + `createMouseSource` 的挂摘、开闭上报与幂等。
- `AGENTS.md` — 本文件。

⚠️ **③（命中测试的半开区间）不在本目录**：命中测试归 `@/lib/geometry.js`（`mouse.ts` 不做坐标算术），
断言在 `tests/geometry/hit-test.test.ts`。列在这里是因为它与 ④ 的坐标换算是同一件事的两端。

## 为什么拆掉哪一处会红

（每条都做过变异实测；harness 见交接说明，9 条全部按预期转红）

- 残留缓冲那行改成 `pending = parsed.pending` → 反了 → ① 转红（**不是**恒红：单 chunk 那组仍绿，
  故「多 chunk 顺序」与「分片」必须是**两个**独立断言）。
- `events` 只取第一条 / 顺序反了 → ② 转红。
- 坐标不减一 / 滚轮按 release 判 → ④ 转红。
- `mouseSupportOf` 把 `silent` 与 `idle` 合并 → ⑤ 转红。
- `isMouseReport` 恒 `false` → ⑥ 里 8 条一起转红（含 `tests/input/mouse-protocol.test.ts` 那四档真渲染）。
- 只认**带 ESC** 的原串（漏掉 Ink 砍掉 ESC 之后的那一半）→ ⑥ 的「两种形态」那条转红，
  而 `parseSgr` 那一半仍绿 —— 故**两种形态必须是两条断言**，不是同一条里的一个循环。
- 「必须以 `ESC[<` 开头」那道闸删掉 → ⑥ 的「像但不是」那条转红，**且** `tests/input/mouse-protocol.test.ts` 的
  「反向自检」「`[` 打得进去」「移动不引起重绘」三条一起转红（那时连 `a` 都成半条报告了）。
  ⚠️ 后者才是「判据不许过宽」的真证据 —— 纯函数那条只判了返回值。
- 「长度必须超过前缀本身」那道闸删掉 → 只有 ⑥ 的「只有前缀」那条转红（`[<` 被当成报告，
  而 `[` 仍不是 —— 故**那一个形状要单独钉**，它与上一条不是同一道闸）。
- 「整段消费完」那道闸删掉 → ⑥ 的「带尾巴的不认」转红。
- 「分片未到齐」那道闸删掉 → ⑥ 的「半条」那条转红。
- `foreign` 那一档不再放过 → ⑥ 的「像但不是」那条转红。
- 判据换成 `startsWith("[<")`（**第二份**形状，不再走 `scanSgr`）→ 同样转红，而
  `parseSgr` 那一侧全绿 —— 这条量的是「同源」这条要求本身。
- ⚠️ 另有一条变异**实测是绿的**，故它**不是**变异：把闸门挪到 `printableOnly` 之后仍然对，
  因为报文里唯一的 C0 字节（ESC）早就被 Ink 拿走，`printableOnly` 原样放过。
  「闸门放在 `useInput` 最前面」是**可读性**要求（它必须在任何判据之前），不是正确性要求 ——
  别把它当正确性断言写进注释里。

## ⚠️ 这一档跑不到的一半

「薄壳」那一半（`createMouseSource` 的挂监听 / 开闭上报 / 探活）也在这两档里，但**只用内存里的
fake stdin / fake stdout**：它们不发一个真字节。故「真终端退出后干不干净」与「真终端真的会回
鼠标序列」仍需一次手动验证，不在单测射程内；序列的对称性另由 `tests/screen/screen.test.ts` 钉。

## 相关路径 / 测试

- `@/services/terminal/mouse.js` — 被断言的模块；`@/hooks/useMouse.ts` — 事件源的唯一订阅方；
  `@/lib/input-line.ts` — 认领 `isMouseReport` 的那一步（必须在入状态之前）。
- `tests/screen/screen.test.ts` — 光标显隐与进入/退出的成对序列、收尾幂等。
- `tests/input/mouse-protocol.test.ts` — 假 TTY 真渲染那一半（`?1003h` 开着时移动一次鼠标的屏上后果）。
- `tests/geometry/hit-test.test.ts` — ③ 的断言。
