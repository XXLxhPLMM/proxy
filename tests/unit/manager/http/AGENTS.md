# tests/unit/manager/http/ — 控制面传输面契约（`src/manager/{http,routes}/`）八档的判据

本目录只答一件事：**控制面 HTTP 面哪几处不许漂** —— 鉴权 / 路由 / 跨源 / 错误映射 / 请求体上限 /
数据面现读 / 零泄露，加上覆盖 `http/` + `routes/` 两目录的源码级护栏。
机制与层不变量归 `src/manager/AGENTS.md`（「`http/` 的关键事实」那一节）与
`src/manager/http/index.ts` 的文件头；本目录只钉它们的行为面。

## ⚠️ 全仓唯一一个真起端口的单测目录

`../../AGENTS.md` 开头那句「不起监听端口、不拨号」的例外**只有本目录**：控制面 HTTP 契约里有三样东西
**只在真 socket 上存在** —— `writeHead` 之后再 `setHeader` 不生效（所以 `WWW-Authenticate` 必须随同
一次 `writeHead` 写出）、`Content-Length` 与实际字节数的一致性、以及 `req.destroy()` 之后对端看到的
是什么。mock 掉 `node:http` 的档全部测不到，而它们恰好是「错误响应泄露了什么」这条边界的真实观测点。
⚠️ **故 `serve()` / `call()` 不许改成 mock、不许改成不起端口**：那样这三条不变量会一起失去观测点，
而外观上八档照样全绿。

- 每条用例一个 `mkdtemp` 临时目录 + 一个起在 **端口 0** 上的真 server（故端口逐条不同，必须经
  `port` 读，不许硬写）。跨源那一档每个用例**另起一个**独立面（不同白名单要不同的 `CorsPolicy`），
  收面归它自己。
- **`source-guards.test.ts` 一行都不引 `_manager-http.ts`**：那 9 条只读源码文本，起端口对它是纯开销。
- 端口回收靠 `closeAllConnections()` + `close()`（`afterEach` / 跨源档的 `afterEach` 各管各的）。
  ⚠️ 偶发一次 `EADDRINUSE` 就重跑；**两次以上立刻停下报告** —— 那说明并发负载真的上来了，
  而重试只会把它藏起来。

⚠️ **断言面是线上字节，不是零件**：本目录只经 HTTP 往返断言 `http/` 与 `routes/` 的契约，
**不**改调 `statusForOpsError` 之类就了事（那是单元、不是契约 —— 契约的观测点是响应头与响应体）。
三处**刻意**直接断言零件，各有理由：`auth.test.ts` 的 `authorize`（那条判据必须独立于 server 也成立，
否则「它只在装好的 server 里对」这件事没人管）、`routing.test.ts` 与 `acl-entry.test.ts` 的**两份**
入参字符集（HTTP 面上只看得见 400，看不见「哪一个键错了」）、`endpoints.test.ts` 的 `accountPatchFrom`
（形状判据同理）。

## 锁什么（十条不变量，按「错了会怎样」排序）

① **鉴权覆盖每一个方法**（含 `OPTIONS` / `HEAD` / 不存在的动词）。漏一个 = 一扇没锁的门。
   锁点：七种方法 × 三种凭据（无 / 错 / 对）的真值表。
② **未鉴权者拿不到 404 与 405 的区分**。`Allow` 头与「路径不存在」的差别本身就是端点清单。
   锁点：无 token 时不存在的路径与存在但方法错的路径**状态码相同**，且两边都没有 `Allow`。
③ **跨源默认封闭**。白名单为空时一个 `Access-Control-*` 头都不发，且带 `Origin` 的 `OPTIONS`
   仍 401（豁免**只在配了白名单时存在**）。配了白名单后：预检豁免**不鉴权**
   但**绝不进路由表**（存在与不存在的路径返回逐字节相同的 204，端点清单没被重新打开），
   而真实请求**一律**仍需 Bearer token。全部断言锚在**真响应头**上。
④ **状态码只由 `OpsError.code` 决定**。锁点：一个 `code` 被改成表外值、而 `message`
   **逐字像**某个已知分类的错误，必须回 500 且**不回 message**。
⑤ **错误响应不含栈、不含 token 明文**。锁点：故意让一个路由抛带栈的普通 Error，
   断言响应里只有 500 + requestId；以及真实落盘的日志里 token 一个字都不许出现。
   （`GET /api/config` 的四个密钥打码是同一条纪律的读面，牙齿在 `endpoints.test.ts`。）
⑥ **路径穿越**：`%2e%2e%2f` 与 `../` 在路由层不可区分，真正的判别发生在 decode 之后。
   锁点：`GET /api/users/..%2F..%2Fetc` 回 400 且账号表一个字节都没变。
   ⚠️ 这条有**两个观测面**：URL 那一半在 `routing.test.ts`，**字符集**那一半
   （username 与名单条目**两份**判据不许合并）在 `acl-entry.test.ts`。
⑦ **幂等 no-op 是 200 + `changed: false`**，不是 4xx、也不是「已改」。
⑧ **`add` 撞名是 409**（不是覆盖、不是静默成功），且原密码逐字保留。
⑨ **只读名单驱动是 501**（请求合法，是部署侧永久缺能力）。
⑩ **`/api/status` 的数据面状态必须是现读的真值**。锁点：改判据后紧跟着的那次请求就看到
    新值；且本进程还没有数据面时必须报 `mode: "inactive"` + `running: false` + 端口 null
    而不是谎报在监听。

## 文件（⚠️ 不变量编号 ↔ 位置对照）

- `auth.test.ts` — **① + ②**。七种方法 × 三种凭据的真值表、`WWW-Authenticate` 随同一次 `writeHead`
  写出、未鉴权者拿不到 404 / 405 的区分，以及空 token 的服务恒 401（HTTP 层那侧兜底，
  配置层的闸门在 `../config/token.test.ts`）。外加 `authorize` 那个纯函数零件的直接断言。
- `cors.test.ts` — **③**。缺省零 `Access-Control-*` 头、逐 origin 放行、预检**不进路由表**、
  豁免**不放宽鉴权**、`parseCorsPolicy` 的语法、白名单整串相等与垃圾条目 fail-closed。
  每个用例一个独立面（`serveCors`），收面归本档。
- `routing.test.ts` — **⑥ 的 URL 一半 + 三态路由**。404 / 405 + `Allow` / 400 各一格、
  尾斜杠不是另一个端点、decode 之后才判穿越，以及**没有 `POST /api/restart` 且 `routes/` 里不留
  任何 restart 残留**。
- `acl-entry.test.ts` — **⑥ 的字符集一半**。名单条目字符集与数据层语法**逐字符对齐**
  （跨层对齐 ①：形态现取自 `parseIpRule` / `parseHostRule`；②：现取自 ops 的 `syntaxHint`），
  且与 username 那份判据**不合并**（变异实测 ⑤）。
- `errors.test.ts` — **④ + ⑤ + ⑨ + 请求体上限**。状态码查表（含「code 缺失 / 表外时**不许**猜
  message 文本」）、`already-exists ⇒ 409`、只读驱动 501、响应与落盘日志的零泄露
  （栈 / 内部路径 / token）、每个响应带 `Cache-Control: no-store`。
  `logText()` 与那条内部路径探针只它用，故住在这里。
- `endpoints.test.ts` — **⑦ + ⑧ 的读面 + 配置面与写族**。`GET /api/config` 的逐键相位 / 打码 /
  `fileOrigin`（三份清单不许漂）、`/api/users` 的写族与「密码只写」、`/api/acl` 的加-移与幂等 no-op、
  `/api/usage` 的 lagMs 与「不能清账」那句限定，以及 `accountPatchFrom` 的未知键 / 类型判据。
- `status.test.ts` — **⑩**。本进程事实 + 数据面活状态 + 数据源事实，数据面现读，`inactive`
  那档不谎报在监听，并带上「inactive 时本进程还没有数据面」那句限定。
- `source-guards.test.ts` — 覆盖 `http/` + `routes/` 两目录的源码级五条（零 console / 零 `process.*` /
  不 import `@/admin/*` / 零 `child_process` / 数据面一律经 `@/ops/index.js`）
  + 变异实测 ①~④。
- `_manager-http.ts` — 临时目录、注入的 logger、真 server 与 `call()`。收件门槛是
  「**两个以上档真用到**」：只被一档用到的（`logText`、`INTERNAL_SECRET_PATH`、`serveCors`、
  `DATA_LAYER_FORMS` / `classFromSource` / `syntaxHintExamples`）一律留在那一档。
- `AGENTS.md` — 本文件。

## 防假绿的位置

- ⚠️ **那六条源码级断言天生怕空**：`sourceFiles("manager/http", "manager/routes")` 路径写错、
  或某个子目录被整体搬走，它们就会在空集上通过。故第一条就是「扫描面非空且含两个子目录的出口」。
  **列目录而不是手写文件名清单**是这里唯一的牙齿来源：手写那份一旦漏了新文件，后果是
  **静默少判一条**（新文件里的 `console.` 照样能跑，而护栏看起来在生效）。
- ⚠️ **变异实测的五条**（根 `AGENTS.md`「写护栏时」是硬要求）：把 `authorize` 的调用从路由**之前**
  挪到路由**之后**、把 `sendFailure` 的 500 分支改成回 message、把 username 的字符集放宽、
  把响应里的 token 回出来、从名单字符集里摘掉 `/`。每一条都实测过「被防住的行为重新出现时会红」。
  **判据锚点全部是今天仍存在的形状**（函数调用 / import / 赋值 / 从源码现取的正则字面量），
  没有一个锚在已删除的符号名上 —— 后者在符号被改名后会恒真，伪装成护栏在生效。
- **跨源那组是行为锚**：断言的是响应头上某个头**在 / 不在**（那是被防住的行为今天的形状），
  不是「源码里不许出现某个符号名」。
- ⚠️ **「两个面逐项相同」的比对面逐出了 `date` 与 `content-length`**（`cors.test.ts` 的
  `stableHeaders`）：这两个头的值是**时钟**的函数而不是跨源判据的函数 —— `date` 由 `node:http`
  自动加（秒级），`content-length` 是响应体字节数而 `/api/status` 的 `process.uptimeMs`
  **每次请求现算**（位数一变它就差一字节）。留着它们比，那条断言测的就是「两次往返有没有跨过
  时钟边界」，偶尔红而与跨源毫无关系。**逐出的集合是断言契约的一部分**：其余每一个头
  （含全部 `Access-Control-*` 与 `Vary`）仍必须逐项相同。
- **「没有 restart 端点」那条是双向的**：`POST /api/restart` 回 404 **且** `routes/` 里逐文件
  扫不出任何 restart 实现 —— 后者防的是「删了端点、留了实现」。（⚠️ 这条断言锚在
  `/api\/restart|restartRoute/` 这段**今天仍可能出现的文本**上，不是锚在某个已删符号名上。）
- **扫描面不许靠 `__dirname`**：`../../../helpers/source-scan.ts` 已导出 `REPO_ROOT` /
  `TESTS_DIR` / `SRC_DIR`，层数只许出现在那一处。少一个 `..` 抛 `ENOENT`（自己暴露），
  **多一个 `..` 枚举到空集则恒绿** —— 后者只会静静地不再判任何东西。
  ⚠️ 本目录的 `.ts` **零 `__dirname`**：`grep -rn "__dirname" --include="*.ts" tests/unit/manager/`
  必须为空（文档里提到这个词不算）。
- **共用 fixture 里的 `.invalid` 不许换成真 host**：`UPSTREAM_URL` 的
  `http://user1:pw1@upstream.invalid:8080` 落在零外网扫描器的 `RESERVED_TLDS` 内（不判公网），
  换成真 host 就等于给那道护栏开一个洞，而 `/api/config` 的 userinfo 打码断言依赖它。

## 相关路径

- `../../../../src/manager/http/index.ts` — 被测面（`auth` / `cors` / `router` / `respond` / `server`
  五个零件 + 那个 barrel）。
- `../../../../src/manager/routes/` — 端点表与入参形状判据（`input.ts` 的**两份**字符白名单、
  `patch.ts` 的 JSON 收窄）；这一层的一切数据操作经 `@/ops/index.js`。
- `../../../../src/manager/control-plane.ts` — 装配点（真 `listen` 的那一面在 `../control-plane.test.ts`）。
- `../../../../src/server/log/config-log.ts` — 启动快照脱敏清单（与 `/api/config` 的打码清单
  **是同一条判据**，两份漂了的后果是一处打码一处明文；牙齿在 `endpoints.test.ts`）。
- `../../../helpers/source-scan.ts` — 源码级断言的公共文本面（`codeOnly` / `codeOf` /
  `sourceFiles` / `SRC_DIR`）。
- `../../../helpers/public-hosts/unit-manager.ts` — `tests/unit/manager/` 整片的零外网白名单
  （归 `../` 那一组维护；本目录三档有公网 host 字面量：`acl-entry` 与 `cors` 两档）。
- `../AGENTS.md`、`../../AGENTS.md`、`../../../../AGENTS.md`。
