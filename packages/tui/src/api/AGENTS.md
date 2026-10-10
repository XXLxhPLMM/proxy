# src/api/ — 控制面 HTTP **契约**（本包对线上契约的**全部**声明）

本目录回答「**对面说了什么**」与「怎么把它要过来」：有哪些端点、每个端点回什么 JSON、逐字段的判据是什么，
以及那一次 axios 请求怎么发。⚠️ **拨号在这一层**（`transport/send.ts`），而端点函数自己 axios —— 地址与 token 是
**函数参数**（`ManagerTarget` 那三格普通数据，形状住 `@/lib/request/transport.js`），不是某个「客户端对象」。

这是全包**最脆**的一个目录，因为它手抄着别人机器上那个进程的契约 —— 所以这里的每条纪律都在回答同一个问题：
**「对面变了」怎么变成一句看得见的话，而不是一片空白。**（为什么弱耦合见 `packages/tui/AGENTS.md`）

## 文件

- `{status,config,users,acl,usage}/` — **按服务端模块分目录**，各镜像根仓 `src/manager/routes/` 下的同名文件。
  每目录两文件：`schema.ts`（**验证 + 类型**：zod schema 与 `z.infer` 推出的响应体类型、写面入参接口同住）
  与 `client.ts`（**接口**：一个端点一个函数，`(method, path)` 字面量内联在 `sendDecoded` 那一行）。
  ⚠️ **判据与函数分文件但不出目录** —— 读一个端点最多打开同一个目录下的两个文件。
- `transport/send.ts` — **唯一**那条出口：那一次 `axios.request`、失败三档的翻译、以及 `parseBody`
  （收窄 + 把 zod 的失败翻成一句人话）。请求的形状（`ManagerTarget` / `Method` / `RequestSpec` /
  `Response`）是纯类型，住 `@/lib/request/transport.js`，这里转出以便端点函数只引一处。
- `change/schema.ts` — 写面**共用**的判据（账号写与名单写回的是同一个形状）。
- `error/schema.ts` — `WireCode` 闭合集 + `ErrorBodyWire`（文档）+ `WIRE_CODES` 与错误体的**宽松**读法
  `readErrorBody`（不是错误形状时只给 `null`，不硬解）。⚠️ **响应体类型不在这里**。
- `index.ts` — 目录 barrel，**只转发**。
- `AGENTS.md` — 本文件。

## 相关路径

- `@/lib/request/transport.js` — 请求的形状（`ManagerTarget` / `Method` / `RequestSpec` / `Response`，纯类型）；
  `@/lib/request/errors.js` — 失败三档的词汇（`TuiError.shape` / `.wire` / `.transport`）；
  `@/lib/request/http.js` — 地址归一、userinfo 抹除与 `:username` 代入。
- 根仓 `src/manager/routes/*.ts` — 端点集合的另一侧真值；`src/manager/http/{auth,respond,router}.ts` 是请求头、
  失败码与路径判据的出处；`src/ops/{error,report}.ts` 是 `WireCode` 前五档与 `DataRef` / `StatusData` 的镜像来源。

## 相关测试

- 根仓 `tests/unit/manager/tui-contract.test.ts` — 路径集合那一半（**递归现列** `src/api/`，不是手写清单）。

## 相关

本目录只引 `@/lib/request/` 的三个叶子 `errors` / `http` / `transport`（该目录没有 barrel）。
