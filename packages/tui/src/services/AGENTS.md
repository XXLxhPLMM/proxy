# src/services/ — 本包会动手的那一半

本机这一侧的运行环境：`config/`（本机台账：一份 SQLite 库里的台账、provider 清单与会话）、
`warnings.ts`（宿主告警面）、`terminal/`（会往 stdout 写控制序列的那一半）。
`index.ts` 只转发 `warnings.ts`；`config/` 与 `terminal/` 各有自己的 barrel。

⚠️ **控制面的拨号不在本目录** —— 它住在 `@/api`（端点函数自己 axios，见那个目录的 `AGENTS.md`）。
本目录给拨号递过去的只是**三格普通数据**（`ManagerTarget`：`baseUrl` / `token` / `timeoutMs`），
而 `config/connect.ts:targetOf` 是台账 → 那三格的**唯一**转换点。

## 相关

`@/api/index.js`（上游：契约 + 拨号 + `ManagerTarget`）· `@/lib/errors.js` / `@/lib/http.js`（纯变换）·
根仓 `src/manager/http/*`（请求头与失败码的出处）
`tests/client/`（对**真 `http.Server`** 的端到端契约）· `tests/ledger/`（台账的成败语义）·
`tests/sqlite/`（驱动 / pragma / schema 版本 / 权限 / 会话落库）· `tests/warnings/warnings.test.ts`（告警过滤器）·
`tests/mouse/` · `tests/screen/screen.test.ts`