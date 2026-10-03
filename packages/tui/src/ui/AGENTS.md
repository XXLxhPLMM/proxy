# src/ui/ — 排版与着色的判据（纯函数，零 IO）

主题、格式化、列宽三份判据，外加引导屏那块标记的素材。**零 Ink 组件、零 `process.*`、零 IO** —— 它们能被
单测逐字断言正因如此。对外唯一出口 `@/ui/index.js`。

| 文件 | 答什么 |
|---|---|
| `theme.ts` | 色调 token + 两张主题表（`themeOf` / `toneColor`）、探活结果 → 呈现档（`connectionStateOf` / `connectionMark`）、`toastMark` |
| `format.ts` | `bytes` / `duration` / `uptime` / `percent` / `isoOrNull` / `onOff` / `dash`，测宽与截断（`widthOf` / `ellipsis` / `fitTo` / `padToWidth`）、`maskToken` |
| `columns.ts` | 列宽规划（`planColumns`）：已裁剪、已补齐的单元格 + 一个 `truncated` 标志 |
| `logo.tsx` | 引导屏那块**标记的素材**（`LOGO` 六行渐变 + `LOGO_TAG` / `LOGO_WIDTH` / `LOGO_ROWS`），⚠️ **零 React**，`.tsx` 只是历史遗留的扩展名 |
| `index.ts` | barrel，只转发 |

## 层不变量

- ⚠️ **输出必须逐字唯一**：两个不同的事实**不许**渲染成同一个东西 —— 一个「连接失败」与一个「从来没试过」长得一样，操作者就分不出「卡住了」与「还没开始」。
- ⚠️ **换算只许在这里做**（字节 → 人话、时间 → 相对、token → 掩码），组件只把它们摆出去，否则同一个值在两处被换算成两个样子。
- ⚠️ **`truncated` 不许被调用方忽略**：`fitTo` 先判「裁不裁得下」再裁并如实带出那个标志 —— 静默截断的表格比明着截断的表格危险得多。
- ⚠️ **底色五档排成两条链**（`theme.ts` 的判据，不是审美）：平时只有 `surface` < `hover`；
  **遮罩开着时**（浅 veil + 深卡片）`panel` < `panelHot` < `hover` < `surface` < `scrim` ——
  卡片最深、遮罩最亮，中间那两档只为了让侧边栏的列边界与悬停仍读得出来。
  ⚠️ **改任何一档的 hex 之前先看那两条链**：遮罩比背景深的话得到的是「背后暗了一块」，
  而那一层仍然完全可读（**不是**遮罩）。
- ⚠️ **遮罩态的前景**七档**全等**（`VEIL_TEXT`）：「基本只能看到后面一点」在终端里只有一种实现 ——
  前景与遮罩几乎同色。逐档调淡看着精细，实际是「七档都还读得出来」。
- ⚠️ **`themeOf` 入参是对象**而不是两个 `boolean`：写反了在类型上合法，而症状是「遮罩开着却整屏正常亮」。
- **列宽从右往左让**（右列先缩）；⚠️ **宁丢列不丢字**；声明了固定宽度的列**是一个承诺**，不许被悄悄改窄。
- ⚠️ **艺术字不许用花体字 / 阴影字 / emoji**（缺字形时终端画出来是一排豆腐块）：那一条**仍然成立**，而
  ⚠️ **它不是「只许纯 ASCII」** —— 引导屏那块标记（`logo.tsx` 的 `LOGO`）刻意用了 `█` 与 box-drawing。
  推翻那半条的两条理由都写在 `logo.tsx` 文件头：同一套字形已经由 Ink 的 `borderStyle` 画在**每一块框**
  上、也被服务端 banner 用着（风险早就在这个产品里承担过了），而用户要的**就是**服务端启动画面那个样子。
  ⚠️ 代价不藏：那些字形在 East Asian Width = **Ambiguous** 的终端里是两列，整块标记会宽出一倍并折断 ——
  缓解是「**放不下就不画**」由几何层判，而人工验收要盯住（见 `packages/tui/AGENTS.md` 末尾那一节）。
  ⚠️ 故这一条现在的判据是「**逐行等宽 + 放不下不画**」，不是「字符集」——判据写在尺寸上，落在素材上是。

## 相关

`@/view/components/`（组件只从这里取「怎么排、怎么上色」） · `@/log/index.js`（`fitTo` / `padToWidth` 是那里的折行与对齐判据） · `@/terminal/index.js`（**同层但不同类**：那边往 stdout 写控制序列、要成对撤销）
`tests/format.test.ts`（边界值：负数抛 `RangeError` / `percent(_, 0)` 不产 `NaN` / 打码） · `tests/columns.test.ts`（行宽永不超过总宽 / 按显示宽度算 / 裁剪置 `truncated`）
