# src/manager/ — 文件与路径说明

manager 控制面：**进程监管**（`supervisor.ts`）+ **HTTP 传输**（`http/`）+ **资源端点**
（`routes/`）三块。三块**互不引用**：`supervisor.ts` 零 HTTP、零路由；`http/` 零 `child_process`、
零数据；`routes/` 零 `node:http` 的概念（只经 `http/` 的 `Route` / `RequestContext`）。

## 文件

- `supervisor.ts` — 子进程监管者 `createSupervisor` / `resolveAppJsPath`。spawn 一个
  `dist/app.js` → 盯 `exit` 事件 → 优雅停机 → 重启。**零 HTTP 概念、零 console**：
  它管的是一个**进程**，不是一个 HTTP 服务；输出走注入的 `logger`。
- `http/index.ts` — 传输层出口（barrel）。
- `http/auth.ts` — `Authorization: Bearer <token>` 的**唯一**判据。**空 token 恒 401**；
  比的是 SHA-256 摘要（`timingSafeEqual` 长度不等会抛，且原串长度是可二分的时序信号）。
- `http/router.ts` — 方法 + 路径段匹配（`:name` 占满一整段，`decodeURIComponent` 在这里做）；
  404 / 405 / 400 三态分开。
- `http/respond.ts` — JSON 输出 + **`OpsError.code` → 状态码查表** + 栈绝不出响应。
- `http/server.ts` — `node:http` 装配（**零框架依赖**）：鉴权在**路由之前**、请求体上限、
  CORS 头一个都不发。
- `routes/index.ts` — 端点表与路由表装配（barrel + `managerRoutes`）。
- `routes/{status,config,users,acl,usage,restart}.ts` — 各资源端点，**一切数据操作经
  `@/ops/index.js`**；只有 `restart` 经 `../supervisor.ts`。
- `routes/input.ts` — 入参的**形状**判据（JSON 对象、未知键、长度上限，以及**两份**字符白名单：
  username 与 acl entry 各一份，理由见该文件头「两份字符集」）。
- `routes/patch.ts` — JSON 请求体 → `@/ops` 的 `AccountPatch` 词汇。

## 层不变量

- **`http/` 与 `routes/` 零 `console` / 零 `process.*`**：诊断走注入的 `LoggerImpl`。
  牙齿：`tests/unit/manager-http.test.ts` 的源码级护栏（列目录，新增文件自动入扫描）。
- **不 import `@/admin/*`**：那边是 `proxy-cli` 的终端呈现，与本层不是同一个传输面。
- **不 import `node:child_process`**（除 `supervisor.ts` 外）：进程监管只经 `../supervisor.ts`。
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

## `supervisor.ts` 的关键事实（都是实测，别按直觉改）

- **它只管 `app.js` 这一个直接子进程**，不管 cluster workers。workers 由 `app.js` 自己管
  （IPC，见 `src/server/cluster.ts`）。本层要保证的是**整棵进程树**死透。
- **`ok: true` 不等于服务健康**。`app.js` 只有 cluster worker 才发 IPC `ready`，
  单进程模式没有任何 ready 信号，本层又用 `stdio: "inherit"` 拿不到子进程 stdout。
  故 `ok:true` 的含义是「旧的确认退出 + 新的被 OS 接受 + 过了 settle 窗口还活着」。
  `settleMs` 只用来抓**启动即崩**，不表示任何健康检查。
  ⚠️ **`routes/restart.ts` 必须把这句话逐字带进响应**：控制面是本仓唯一能把这句话藏起来的地方。
- **`env` 原样透传**：子进程走 `loadConfig` 读宿主 env，加减一个键都会让
  「manager 看到的配置」与「proxy 看到的配置」漂移。
- **win32 上没有「请求子进程排空」这条通道**（实测：`child.kill` 是 `TerminateProcess`，
  子进程的信号处理器不执行）。故 `stop()` 的宽限窗口用于**不打断已在进行的排空**，
  而 `restart()` 没有信号可发、等下去只是白等 —— win32 上它直接强杀并如实 warn。
- **强杀带 `/T`（树杀）不是为了本机效果**：实测本机**不带** `/T` 时非 detached 的子孙也会随
  父进程一并消失（与父进程同处一个作业），而那个连带机制未查明、不可移植、不作契约依赖。
- **`stop()` 幂等靠复用同一个在飞 Promise**，不是「已停过」旗标；测试锁的就是这个形状。
- **并发 `restart()` 被拒绝**（返回 `{ok:false}`），不排队。

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

- 组合根 — `src/cli-manager.ts` → `dist/manager.js`（`proxy-manager`），与 `src/cli.ts` /
  `src/cli-admin.ts` 三个组合根各管一个进程
- 被监管的进程 — `src/cli.ts` → `dist/app.js`
- 子进程自己的 cluster / 信号策略 — `src/server/{cluster,process}.ts`
- 数据操作 — `@/ops/index.js`（**本层的唯一数据来源**）
- 产物布局（`dist/app.js` 的推导依据）— `build.mjs`
- 控制面四个配置项 — `src/config/{types,store}.ts`、`src/config/schema/validate.ts`、
  `src/config/context.ts:ConfigSourceMetadata`（`fileOrigins` 是「某键来自哪个 env 文件」的
  **唯一**真相源）
- 启动快照脱敏清单 — `src/server/log/config-log.ts`（与 `@/ops/report.ts` 的
  `CONFIG_SECRET_KEYS` 是**同一条判据**，两份漂了的后果是一处打码一处明文）

## 相关测试

- `tests/unit/supervisor.test.ts` — 假子进程（`node -e`）锁记账与幂等；真实 `dist/app.js`
  的端到端（含 cluster workers 死透）是一次性手工脚本，不进 CI。
- `tests/unit/manager-http.test.ts` — 真 `http.Server` 监听端口 0：鉴权真值表、404/405、
  路径穿越、body 上限、`OpsError.code` 映射（含「code 缺失时不许猜 message」）、
  响应与日志的零泄露，以及覆盖 `http/` + `routes/` 的源码级护栏（含 12 档变异实测）。
