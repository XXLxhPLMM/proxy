# src/manager/ — 文件与路径说明

控制面：**HTTP 传输**（`http/`）+ **资源端点**（`routes/`）+ **装配**（`control-plane.ts`）三块。
后两块**互不引用**：`control-plane.ts` 同时用前两块，其余文件互不知晓。

控制面与数据面**同进程**（`src/cli.ts` 在 `MANAGER_ENABLED=true` 时调本目录的装配），共享同一份
`loadConfig` 快照 —— 本目录零 `node:child_process`、零 `node:cluster`、零信号处理。

## 文件

- `control-plane.ts` — 装配点 `startControlPlane`：配置 → 数据源 → 路由表 → 真 `listen`，
  产出一个可关的句柄。**未启用返回 `null` 且零副作用**。`EADDRINUSE` 换一条含修法的文案再抛。
- `http/index.ts` — 传输层出口（barrel）。
- `http/auth.ts` — `Authorization: Bearer <token>` 的**唯一**判据。**空 token 恒 401**；
  比的是 SHA-256 摘要（`timingSafeEqual` 长度不等会抛，且原串长度是可二分的时序信号）。
- `http/router.ts` — 方法 + 路径段匹配（`:name` 占满一整段，`decodeURIComponent` 在这里做）；
  404 / 405 / 400 三态分开。
- `http/respond.ts` — JSON 输出 + **`OpsError.code` → 状态码查表** + 栈绝不出响应。
- `http/server.ts` — `node:http` 装配（**零框架依赖**）：鉴权在**路由之前**、请求体上限、
  CORS 头一个都不发。
- `routes/index.ts` — 端点表与路由表装配（barrel + `managerRoutes`）。
- `routes/{status,config,users,acl,usage}.ts` — 各资源端点，**一切数据操作经
  `@/ops/index.js`**；数据面活状态经 `status.ts` 的**注入的现读口**进来。
- `routes/input.ts` — 入参的**形状**判据（JSON 对象、未知键、长度上限，以及**两份**字符白名单：
  username 与 acl entry 各一份，理由见该文件头「两份字符集」）。
- `routes/patch.ts` — JSON 请求体 → `@/ops` 的 `AccountPatch` 词汇。

## 层不变量

- **`http/` 与 `routes/` 零 `console` / 零 `process.*`**：诊断走注入的 `LoggerImpl`。
  牙齿：`tests/unit/manager-http.test.ts` 的源码级护栏（列目录，新增文件自动入扫描）。
- **不 import `@/admin/*`**：那边是 `proxy-cli` 的终端呈现，与本层不是同一个传输面。
- **零 `node:child_process`、零 `node:cluster`**：本目录管的是**数据与只读事实**，一个字节的
  进程编排都不做。数据面归谁管由组合根回答（`ManagerRouteDeps.dataPlane` 那个现读口）。
- **`control-plane.ts` 零 `process.*`、零信号处理**：停机次序归 `src/cli.ts`（组合根），
  信号归 `ProcessPolicy`（`src/server/process.ts`）。本目录只提供一个 `close()`。
- **入参的形状判据归路由层，语义判据归 ops**：路由判「这是不是一个 JSON 对象 / 键名在不在
  白名单 / 这个字符串有没有危险字符与路径语义」；ops 判「这个组合是不是合法账号 / 这条名单
  语法对不对 / 账号存不存在」。各写一份就是「两处对不上」的原料。
- ⚠️ **但「危险字符」对 username 与 acl entry 是两份判据，不许合并**：username 进的是数据源的
  **位置**词汇，字符集极窄（`[A-Za-z0-9._-]`，HTTP 面不表达路径分隔符）；acl entry 进的是**名单
  文档的语法**，字符集逐字符对齐 `parseIpRule` / `parseHostRule` 接受的形态（多出 `/` `:` `*`
  `[` `]` `%`）。判据比语法窄一寸就会造出「`GET /api/acl` 读得到、而 `POST` / `DELETE` 一律 400」
  的条目——运维只能回去手改文件。牙齿：`tests/unit/manager-http.test.ts` 的「跨层对齐 ①②」
  （形态从 ops 的 `syntaxHint` 与数据层原语**现取**，不手抄）。
- **`changed: false` 是 200**：幂等 no-op 不是失败（那是「用户达到了目的」），也不是
  「已改」（一个字节都没落盘）。

## 关键事实（都是实测或架构结论，别按直觉改）

- **没有「重启进程」这一类端点，startup 相位配置的生效路径只有「重启进程」一条。**
  控制面与数据面同进程，而进程归宿主；自己重启自己只有「退出」（那是宿主的权限）或
  「原地重载」（而 `ProxyServer.stop()` 把 `shuttingDown` 置位后永不复位，同一对象的第二次
  `stop()` 会静默 no-op）。「哪些键属于 startup」由 `GET /api/config` 的 `restartRequired`
  逐键给出。
- **`GET /api/status` 的数据面状态是真值，不是推断。** 本进程就是代理进程，所以它能回答
  「端口在不在监听」。cluster master 是唯一的例外：端口由 worker 进程持有，此时
  `mode: "master"` + `running: false`（**必须**如实，不能谎报在监听）。判据经
  `ManagerRouteDeps.dataPlane` 注入，`routes/` 因此与代理实现无关。
- **数据流向一个字都没改**：账号 / 名单 / 账本仍然是**文件**，由数据源的 mtime 节流热加载生效。
  控制面写文件、代理读文件，同一个真相源。⚠️ **别把它改成「写内存」**：那会造出第二份真相
  （PUT 写内存 / GET 读文件 → 紧接着的 GET 报旧值，而下一次 mtime 热加载会把内存那份冲掉）。
- **`MANAGER_ENABLED=false` 是「没有这个面」，不是一个「关着的面」**：`startControlPlane`
  返回 `null`、零副作用、不打日志、不改退出码。而空 token 的 fail-closed **一点没松** ——
  `assertManagerConfig` 在 `loadConfig` 阶段就中止（`src/config/schema/validate.ts`），
  `control-plane.ts` 里那道空串判据是「闸门被移除」的兜底，不是第二道闸门。

## `http/` 的关键事实

- **鉴权先于路由，且覆盖每一个方法**（含 `OPTIONS` / `HEAD` / 不存在的动词）。否则未鉴权的
  调用者能区分「路径不存在」（404）与「方法不对」（405 + `Allow`），而那条区分本身**就是一张
  端点清单**。
- **请求行不经 `new URL()` 归一**：那会把 `..` **解掉**（一次静默的路径改写，且让「穿越」被
  URL 解析器悄悄处理掉）。只按第一个 `?` 手工切，交给逐段比对。
- **路径参数在 decode 之后才判**：未解码时 `%2e%2e%2f` 与 `../` 无法区分。
- **上限是字节数不是字段数**：`Content-Length` 不可信（客户端可以不发、也可以撒谎），
  「反序列化后有几个字段」判得太晚（内存已被吃掉）。超限后**停止缓存**（内存有界），
  在响应写完之后再关连接 —— 提前 `destroy()` 会让客户端只看到 `socket hang up`。
- **不发任何 CORS 头**：控制面没有跨源需求，而「不发」在浏览器那侧的效果是任何页面都读不到
  响应。别把它「补全」。
- **错误响应绝不含栈**：`OpsError` 的 message 是中性事实陈述，原样透传；`code` 表外 / 缺失
  的 `OpsError` 与非 `OpsError` 一样降级成「500 + requestId + 固定文案」，细节只进 logger。
  「code 表外就不回 message」是刻意的：`code` 是我们对那条文案所属类别的唯一背书。

## 相关路径

- 组合根 — `src/cli.ts` → `dist/app.js`（`proxy`），与 `src/cli-admin.ts`（`proxy-cli`）两个组合根
- 数据面活状态的判据 — `src/server/index.ts:DataPlaneOwner`（`runServer` 填、`control-plane` 现读）
- 停机次序与信号 — `src/cli.ts` / `src/server/process.ts`
- 数据操作 — `@/ops/index.js`（**本层的唯一数据来源**）
- 四个配置项 — `src/config/{types,store}.ts`、`src/config/schema/validate.ts`、
  `src/config/context.ts:ConfigSourceMetadata`（`fileOrigins` 是「某键来自哪个 env 文件」的
  **唯一**真相源）
- 启动快照脱敏清单 — `src/server/log/config-log.ts`（与 `@/ops/report.ts` 的
  `CONFIG_SECRET_KEYS` 是**同一条判据**，两份漂了的后果是一处打码一处明文）

## 相关测试

- `tests/unit/manager-http.test.ts` — 真 `http.Server` 监听端口 0：鉴权真值表、404/405、
  路径穿越、body 上限、`OpsError.code` 映射（含「code 缺失时不许猜 message」）、
  响应与日志的零泄露、`/api/status` 的数据面状态**现读**（含 master 模式那档）、以及覆盖
  `http/` + `routes/` 的源码级护栏（含变异实测）。
