# src/services/ — 本包会动手的那一半

本机这一侧的运行环境：`config/`（本机台账：一份 SQLite 库里的台账、provider 清单与会话）、
`warnings.ts`（宿主告警面）。
`index.ts` 只转发 `warnings.ts`；`config/` 有自己的 barrel。

⚠️ **控制面的拨号不在本目录** —— 它住在 `@/api/transport/send.ts`（端点函数自己 axios，见那个目录的 `AGENTS.md`）。
本目录给拨号递过去的只是**三格普通数据**（`ManagerTarget`：`baseUrl` / `token` / `timeoutMs`，形状住 `@/lib/request/transport.js`），
而 `config/connect.ts:targetOf` 是台账 → 那三格的**唯一**转换点。

## 相关

`@/api/index.js`（上游：契约 + 拨号 + `ManagerTarget` 转出）· `@/lib/request/errors.js` / `@/lib/request/http.js`（纯变换）·
根仓 `src/manager/http/*`（请求头与失败码的出处）