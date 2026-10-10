# src/ — 控制面契约与请求形状（重构空白期）

⚠️ **重构期**：本目录目前只剩两块 —— `api/`（控制面 HTTP 契约 + 拨号）与 `lib/`（零 IO 纯函数层：
`request/` 三个请求叶子 + `model-id.ts` 模型键）。入口 `cli.tsx` 与其余各层待重建；在那之前 `pnpm build` 必然失败（`build.mjs` 的入口仍是 `src/cli.tsx`）。

| 路径 | 答什么 |
|---|---|
| `api/` | 控制面 HTTP **契约 + 拨号**：按服务端模块分目录（`schema.ts` 管验证与类型，`client.ts` 管接口，一个端点一个函数）/ **唯一**那条 `axios.request`（`transport/send.ts`）/ 响应体类型（`z.infer` 从 schema 推）。⚠️ 地址与 token 是**函数参数**（`ManagerTarget` 三格普通数据，形状住 `lib/request/transport.ts`），没有「客户端对象」这一层 |
| `lib/request/` | 请求那一圈的三个纯叶子：失败词汇（`errors.ts`，`TuiError` 三档）/ 地址变换（`http.ts`：归一、抹 userinfo、`:username` 代入）/ 请求形状（`transport.ts`，纯类型）。⚠️ `api/` 只许引这三个叶子，禁引任何 barrel（成环） |
| `lib/model-id.ts` | `provider/model` 模型键的词汇：类型 `ModelId` + 切分 `splitModelId` / 判形 `isModelId`。⚠️ 按**第一个** `/` 切（`model` 自己可含 `/`，如 openrouter 的 `anthropic/claude-x`） |

⚠️ **本文件的写法**：推导不写（能从代码与测试名重新推出来的，写在这里只会腐烂）；`⚠️` 只标真禁忌。

## 相关

`src/api/AGENTS.md`（契约的逐文件纪律）· `packages/tui/AGENTS.md`（包这一层的不变量）· 根仓 `src/manager/routes/`（端点集合的另一侧真值）
