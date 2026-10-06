# tests/unit/manager/config/ — 管理面五个配置键的配置层判据

本目录只答一件事：**磁盘上那份配置能不能被读成一份「控制面存在时必然是安全的」配置**——
键名与相位契约、两条交叉校验（端口撞车 / 空 token）、CORS 白名单的**启动期**语法、
启动快照的脱敏，以及未知键闸门认得这五个键。

控制面那一族的其余判据在 `../AGENTS.md` 与 `../http/`。

## 这个面等价于主机上的 root shell —— 所以 fail-closed 由**配置层自己**保证

它能改配置、重启进程、增删账号。故「它存在时必须是安全的」**不留给将来那个 HTTP 面去兜**：
等 HTTP 面写出来再补校验，中间那段时间里 `MANAGER_ENABLED=true` + 空 token 就是一扇没锁的门。

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