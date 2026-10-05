# tests/unit/manager/config/ — 管理面五个配置键的配置层判据

本目录只答一件事：**磁盘上那份配置能不能被读成一份「控制面存在时必然是安全的」配置**——
键名与相位契约、两条交叉校验（端口撞车 / 空 token）、CORS 白名单的**启动期**语法、
启动快照的脱敏，以及未知键闸门认得这五个键。

机制与层不变量归 `src/config/AGENTS.md`、`src/config/schema/AGENTS.md` 与
`src/server/log/AGENTS.md`；控制面那一族的其余判据在 `../AGENTS.md` 与 `../http/`。

## 这个面等价于主机上的 root shell —— 所以 fail-closed 由**配置层自己**保证

它能改配置、重启进程、增删账号。故「它存在时必须是安全的」**不留给将来那个 HTTP 面去兜**：
等 HTTP 面写出来再补校验，中间那段时间里 `MANAGER_ENABLED=true` + 空 token 就是一扇没锁的门。

## 五条目录级不变量（每条都跨两档以上，所以住在这里）

① **五个键全是 `startup` 相位** —— 否掉的是「标 runtime 让热改生效」：启动期读一次之后就再没有
   读取点，热改一个没人读的键只会给出「改了却什么都没发生」的错觉。锁点：`keysByPhase().startup`
   逐个含五键、`.runtime` 一个都不含。牙齿：`fields.test.ts`。
② **判据一律不看 `managerEnabled`**（撞车 / 越界 / CORS 语法三条同族）—— 否则那次 `EADDRINUSE`
   发生在数据面已经在服务之后，运维看到的是一次运行期崩溃而不是一条配置错误；而藏到启用那天再炸，
   他会归因成「我今天开了个开关结果进程起不来」。**「配错了」的暴露时机越早越好**。
   牙齿：`port.test.ts` 的「`enabled=false` 时撞车照样 abort」+ 越界那组的 describe 标题 ·
   `cors.test.ts` 的「判据**不看** `managerEnabled`」。
③ **报错必须逐字给出修法**：点名那个键 **且** 给一条可抄的修法。`不能为空/不合法` 等于让运维去猜
   该填什么，而配置面本该在启动期就说完话。⚠️ 缺一即红：撞车要给两个键名 + `EADDRINUSE` +
   「空闲端口」，空 token 要给 `MANAGER_TOKEN=<随机串>` 与 `MANAGER_ENABLED=false`，
   越界要给 `MANAGER_PORT=<raw> 越界`，CORS 要给一条完整示例 + 三条最易踩形态各点名一次。
   牙齿：`port` / `token` / `cors` 三档各一组「报错逐字」。
④ **每条 fail-closed 都要配一条正向对照组**（判据不是「永远报错」）：两端口不同时正常加载 / 给了
   token 就放行 / 合法 origin 放行 / 缺省形态加载得出来。⚠️ 少了它们，一个恒抛的实现全绿。
⑤ **只经 `loadConfig` 这一个入口测**（`_manager-config.ts:load`），临时目录一律经 `withTmpDir`
   —— 绝不碰仓库根的 `.env.development` 与 `cfg/`。`skipFileValidation` 是刻意开的：它避开启动期
   JSON 强校验（账号表 / 名单那两层归 `../../config/` 与 `../../datasource/`），与本目录判据无关。
   ⚠️ 需要读 `envFiles` 或需要传 `store` 的那几条**直接调 `loadConfig`**，不要给 `load` 加参数 ——
   多一个入口就多一份「这一条到底走了哪条通路」的含糊。

## 防假绿的位置

- **两个通道都要测**：纯函数档（`assertManagerConfig` 直接构造入参）与 `loadConfig` 档（真经一遍
  加载）。只测前者的话，「`assertManagerConfig` 根本没被接线调用」是恒绿；只测后者的话，报错文案
  与纯函数那条的差异看不见。`cors` / `token` / `port` 三档各两侧都有牙齿。
- **脱敏断言覆盖**整份落盘**而不是某一个字段**：只断言 `managerToken === "***"` 的话，把掩码改成
  `""`（等于不脱敏）照样过。同一份快照里的**非密字段**另有对照组，否则「什么都没打」也能满足。
  ⚠️ 走真实 logger 落盘（控制台静音、落盘放行到 debug），不是内存里某个中间对象。
  牙齿：`snapshot.test.ts`。
- **未知键闸门两条来源各钉一次**（argv 与 env 文件），因为闸门管的是两个「显式用户意图」来源，
  而 `process.env` 里的未知键**刻意不失败**。另配一条「真名不报错」—— 闸门不是「拒绝一切」的反面。
- **缺省端口不得撞车要单钉一条**：判据不看 `enabled` ⇒ 把 `defaults.managerPort` 改成
  `defaults.port` 会让**每次**启动都失败，而任何只测了显式配置的用例都不会红。
  牙齿：`fields.test.ts` 的「两个 listener 的缺省端口不得互相撞车」。
- **「刻意不给」的两处各有对照组**：`managerHost.int` 为 `undefined`（不拦 `0.0.0.0`，那是合法部署
  选择）与 `managerToken.def` 为 `undefined`（空串就是「没配」，由 validate 在启用时拦）。
  对照组是同文件里确有给 `def` 的字段（`aclFile`）—— 少了它上面两条恒真。
- **`_manager-config.ts` 与带公网 host 字面量的 origin 清单必须留在本目录**：零外网扫描的
  `SCAN_DIRS` 排除 `tests/helpers/` 而 `walk()` 收目录下**全部** `.ts`，搬进去等于那部分覆盖
  **静默消失**而两条下界断言照样绿。**可见的重复优于看不见的失效。**
- ⚠️ **本目录不走 `__dirname`**：`../../../helpers/source-scan.ts` 已导出 `REPO_ROOT` / `TESTS_DIR` /
  `SRC_DIR`，层数只许出现在那一处。少一个 `..` 抛 `ENOENT`（自己暴露），
  **多一个 `..` 枚举到空集则恒绿** —— 后者只会静静地不再判任何东西。

## 零外网白名单

`cors.test.ts` 的 origin 字面量（`a.com` / `b.com` / `ops.example.com` …）带公网 host，
它们只被 `assertManagerConfig` 的正则与 `toThrow` 的报错匹配读走 —— 判据是纯函数入参，
本目录零建链点。白名单条目在本目录的那一片是
`../../../helpers/public-hosts/unit-manager.ts`（⚠️ **属主是 `tests/unit/manager/` 整片**，
条目按目标目录分片，`config/cors` 那一条的 `file:` 值由 `manager/` 的属主改，见 `../AGENTS.md`）。

## 文件（⚠️ 不变量编号 ↔ 位置对照）

- `fields.test.ts` — **① ④ ⑤**：五键的 env 名逐个点名 · 全 `startup` 相位 · `managerPort` 整数范围与
  两条「刻意不给」的对照组 · 五条缺省值 · **缺省端口不得撞车** · 不给 `MANAGER_*` 时读到的就是那套缺省 ·
  env / argv 两个来源的解析（kebab 与 `KEY=VALUE` 等价、含 `=` 的 token、argv 优先于 env）。
- `port.test.ts` — **② ③ ④**：撞车那条点名两个键 + `EADDRINUSE` + 「空闲端口」；`enabled=false` 时
  照样 abort；两个 `0` 不算冲突（`listen(0)` 的系统分配语义，绕开 `loadConfig` 的 library 调用方能拿到
  `0`）；越界 / 非数字 / 小数各自 abort，且**非法值不半写 store**（既有原子落库契约）。
- `cors.test.ts` — **② ③**：`MANAGER_CORS_ORIGINS` 的**启动期**语法判据（锁的是「不 fail-fast 的代价」：
  一个永不命中的白名单与「没配」在浏览器那侧的**症状完全一样**）。⚠️ 判据**只有这一份**，在
  `src/config/schema/validate.ts`（`CORS_ORIGINS_SHAPE`）—— 运行期的 `parseCorsPolicy` 不重复语法
  校验，它天然 fail-closed（见 `../http/cors.test.ts`）。
- `token.test.ts` — **③ ④**：`MANAGER_ENABLED=true` + 空 token → abort 且报错逐字给修法；显式空串
  同样被拒（`MANAGER_TOKEN=` 与「不配」是同一个事实）；关着时空 token 合法；纯函数档逐条覆盖
  （撞车与空 token 是**两条独立判据**，谁先命中都不放行）。
- `snapshot.test.ts` — **⑤**：启动快照脱敏（走真实 logger 落盘，明文一个字都不许出现 + 非密字段对照组
  + 与 `jwtSecret` / `tlsPassphrase` 同档）+ 未知键闸门认得 `MANAGER_*`（argv 与 env 文件两个来源
  + 真名不报错的反面）+ `--use-home-config` 不放宽 `managerHost`（它换的是配置目录，不是谁能连上来）。
- `_manager-config.ts` — 五档共用的四个前导：`TOKEN`（明文 canary）/ `withTmpDir` / `load` /
  `rejectionMessage`。⚠️ 只放**两个以上档真用到**的：只被一档用到的 `fieldOf`（`fields`）与
  `logConfigRecords`（`snapshot`）留在那一档的文件头。
- `AGENTS.md` — 本文件。

## 相关路径

- `../../../../src/config/schema/validate.ts` — `assertManagerConfig` 的三条交叉校验与
  `CORS_ORIGINS_SHAPE`。
- `../../../../src/config/schema/index.ts` — `FIELDS` / `defaults` / `keysByPhase` / `ConfigKey` 的出口。
- `../../../../src/config/index.ts` — `loadConfig` / `ConfigStore`（唯一的加载入口）。
- `../../../../src/server/log/config-log.ts` — `logConfig` 那条 `=== config ===` 记录与脱敏。
- `../../../../src/manager/control-plane.ts` — 消费这五个键的装配点（判据在 `../control-plane.test.ts`）。
- `../../../../src/manager/routes/` — 端点表（本目录不测它，见 `../tui-contract.test.ts`）。
- `../../../helpers/source-scan.ts` — 源码级断言的文本面 + `REPO_ROOT` / `TESTS_DIR` / `SRC_DIR`。
- `../../config/` — 配置的其余四族判据（loader / store / auth-users / unknown-keys 的通用层）。
- `../AGENTS.md`、`../../AGENTS.md`、`../../../AGENTS.md`。