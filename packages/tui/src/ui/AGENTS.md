# src/ui/ — 排版与着色的判据（纯函数，零 IO）

主题、格式化、列宽三份判据，外加引导屏那两串常量。**零 Ink 组件、零 `process.*`、零 IO** —— 它们能被
单测逐字断言正因如此。对外唯一出口 `@/ui/index.js`。

| 文件 | 答什么 |
|---|---|
| `theme.ts` | 色调 token + 两张主题表（`themeOf` / `toneColor`）、探活结果 → 呈现档（`connectionStateOf` / `connectionMark`）、`toastMark` |
| `format.ts` | `bytes` / `duration` / `uptime` / `percent` / `isoOrNull` / `onOff` / `dash`，测宽与截断（`widthOf` / `ellipsis` / `fitTo` / `padToWidth`）、`maskToken` |
| `columns.ts` | 列宽规划（`planColumns`）：已裁剪、已补齐的单元格 + 一个 `truncated` 标志 |
| `logo.tsx` | 引导屏那两串常量（`BANNER` / `TAGLINE`），⚠️ **零 React**，`.tsx` 只是历史遗留的扩展名 |
| `index.ts` | barrel，只转发 |

## 层不变量

- ⚠️ **输出必须逐字唯一**：两个不同的事实**不许**渲染成同一个东西 —— 一个「连接失败」与一个「从来没试过」长得一样，操作者就分不出「卡住了」与「还没开始」。
- ⚠️ **换算只许在这里做**（字节 → 人话、时间 → 相对、token → 掩码），组件只把它们摆出去，否则同一个值在两处被换算成两个样子。
- ⚠️ **`truncated` 不许被调用方忽略**：`fitTo` 先判「裁不裁得下」再裁并如实带出那个标志 —— 静默截断的表格比明着截断的表格危险得多。
- **列宽从右往左让**（右列先缩）；⚠️ **宁丢列不丢字**；声明了固定宽度的列**是一个承诺**，不许被悄悄改窄。
- ⚠️ **艺术字只许纯 ASCII**：花体字 / 阴影字 / emoji 缺字形时终端画出来是一排豆腐块（`borderStyle` 的框线与状态字形不在此列）。

## 相关

`@/view/components/`（组件只从这里取「怎么排、怎么上色」） · `@/log/index.js`（`fitTo` / `padToWidth` 是那里的折行与对齐判据） · `@/terminal/index.js`（**同层但不同类**：那边往 stdout 写控制序列、要成对撤销）
`tests/format.test.ts`（边界值：负数抛 `RangeError` / `percent(_, 0)` 不产 `NaN` / 打码） · `tests/columns.test.ts`（行宽永不超过总宽 / 按显示宽度算 / 裁剪置 `truncated`）
