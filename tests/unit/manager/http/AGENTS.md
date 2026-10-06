# tests/unit/manager/http/ — 控制面传输面契约（`src/manager/{http,routes}/`）八档的判据

本目录只答一件事：**控制面 HTTP 面哪几处不许漂** —— 鉴权 / 路由 / 跨源 / 错误映射 / 请求体上限 /
数据面现读 / 零泄露，加上覆盖 `http/` + `routes/` 两目录的源码级护栏。

## ⚠️ 全仓唯一一个真起端口的单测目录

`../../AGENTS.md` 开头那句「不起监听端口、不拨号」的例外**只有本目录**：控制面 HTTP 契约里有三样东西
**只在真 socket 上存在** —— `writeHead` 之后再 `setHeader` 不生效（所以 `WWW-Authenticate` 必须随同
一次 `writeHead` 写出）、`Content-Length` 与实际字节数的一致性、以及 `req.destroy()` 之后对端看到的
是什么。mock 掉 `node:http` 的档全部测不到，而它们恰好是「错误响应泄露了什么」这条边界的真实观测点。

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
