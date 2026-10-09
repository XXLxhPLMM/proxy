# src/domains/ — 域 hook（AppState 拆出来的逻辑）

App 只剩组合：每个域 hook 读自己的 zustand slice，跨域只读别家 store，不互引。
调用方（App）按 sessions → ledger → window → text → exec → view 顺序接线，deps 显式注入。

| 文件 | 管什么 |
|---|---|
| `cells.ts` | 纯函数：菜单文案、槽位、分组、行模型装配、表单字段表 |
| `sessions.ts` | 会话清单、桶、滚动、恢复、播种 |
| `ledger.ts` | 台账读盘、探活、targets/current |
| `window.ts` | 弹窗、表单、删除、侧边栏列、模型选项；外加四个原始 setter 出口（text 域经 store 直读，App 不再中转） |
| `text.ts` | 三个写入口、命令面板；`historyAtRef`/`textDragRef` 由调用方传入（与 exec 共用） |
| `exec.ts` | 命令队列、副作用、模型那一圈；queue/busy 住 `useExecStore`，`pumpRef`/`applyEffectRef` 留内部打破回调成环 |
| `view.ts` | 纯推导：侧边栏行、弹窗视图、几何、一屏 `Layout` props、`useHotkeys`/`useMouse` 接线参数；唯一 store 写是 viewport 同步 |

测试挂载前 reset 全部 slice（`tests/input/_shared.ts:mount`），单例不在用例间漏状态。
