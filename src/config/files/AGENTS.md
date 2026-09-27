# src/config/files — 磁盘配置资源（users.json / acl.json）

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `users.ts` | `AuthAccount`（含可选 `acl` / `quota`）+ `validateAuthUsers` + `readAuthUsersAsync`（启动期）+ `loadAuthUsers` / `loadUserPolicy` / `loadUserQuota`（热加载面） | 只取数据与形状校验，**不做判定** |
| `acl.ts` | `AclConfig` / `AclList` / `validateAcl` / `readAclAsync` / `loadAcl` / `hasConfiguredAcl` | 同上；`hasConfiguredAcl` 是「配了访问控制」的**文件事实**判定 |
| `event-log.ts` | `createJsonFileEventHandler(logger)` / `logJsonFileEvent` | 把 `readJsonCached` 的 `error`/`missing`/`recovered`/`reloaded` 渲染成日志 |
| `rules/` | 名单**条目语法**层（`ip.ts` / `host.ts`） | 零配置依赖、零 IO → [`rules/AGENTS.md`](./rules/AGENTS.md) |

**不属于本层**：请求期名单判定（`src/core/access-control.ts`）、配额计量与耗尽判定（`src/core/traffic/`）、条目语法的定义（本层只调用 `rules/` 的 `parseIpRule` / `parseHostRule`）。

## 硬约定

- **只取数据与形状校验，判定一律在 `src/core/access-control.ts`**。顶层形状校验（未知键拒绝、类型）是本层的；「什么算合法条目」归 `rules/`，「命中了怎么办」归 core。
- **绝不另开一个 `readJsonCached` 调用点**。两个文件都走既有的 `loadXxx` 路径（缓存键 `label + path`、1s stat 节流、坏内容保留上一份有效值）。另开会造出两份节流缓存、两份解析、两套坏文件处理并互相污染同一缓存键——护栏是**源码级断言**（`users.ts` / `acl.ts` 全文 `readJsonCached(` 恰好一处），且已变异测试验证过（给 `loadUserQuota` 另开一个 → 源码断言与「一次内容变更只报一次 `reloaded`」那条行为用例同时红）。护栏 `tests/unit/acl-configured.test.ts`。
- **条目合法性一律经 `rules/` 的 `parseIpRule` / `parseHostRule`**；任一条目非法 → 整组非法 → 启动期 abort。**不在本目录写第二套条目解析**。
- **两个可选顶层键（`acl` / `quota`）的 `ACCOUNT_KEYS` 白名单必须同步**——新增可选字段不加进去，所有带该字段的文件会被「未知顶层键」判非法。**账号产物不写 `acl: undefined` / `quota: undefined` 键**。
- `event-log.ts` **不持有任何 logger 单例**，logger 由调用方显式注入。
- `cfg/users.json` / `cfg/acl.json` 已被 `.gitignore` 忽略，仓库只提交 `*.example`。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

**有断言锁住的裁决一律不写在这里**——它们的结论、否掉了什么、为什么、以及逐字锁点分布在：
`tests/unit/auth-users.test.ts`（账号级 `acl` 只允许 `target` 一个组、其余键整组非法；
条目合法性只经 `rules/host.ts:parseHostRule`；`acl` 对凭证索引不可见）、
`tests/unit/user-quota.test.ts`（`quota.window` 只认 `day`/`month`；缺省 `month` 的归一在消费侧；
无速率字段；`quota` 与 `acl` 各自独立决定整份文件是否作废；`acl` 与 `quota` 对凭证索引都不可见；
热路径零分配）、
`tests/unit/acl-configured.test.ts`（「读失败 → false」是刻意取舍、且**同时**断言那条可见信号确实响了；
`readJsonCached` 恰好一处调用点）、
`tests/unit/json-file.test.ts`（1s stat 节流；`maxBytes` 上限不采用该内容；
**只有 `ENOENT`/`ENOTDIR`/非普通文件算 missing**，其它 stat 错误保留上一份有效值并发 `error`；
事件去重状态按 `onEvent` 回调隔离）。要查「那条断言锁什么」，去那个文件的头注释。

1. **`quota` 逐项说明写进 `cfg/users.json.example.md`，不写进 `users.json.example`** — 否掉「给示例文件加注释」— `users.json` 是 `JSON.parse` 的输入，**任何注释都会让整份文件解析失败 → 启动 abort**；示例文件必须保持逐字可 `cp`。⚠️ **没有任何断言**：`cfg/users.json.example` 逐字可解析这件事从未被跑过（`tests/unit/pack-contents.test.ts` 只在白名单里登记该路径的存在，不解析它）。往示例文件里加一行 `// 注释`，全仓绿，**而真实部署会启动 abort**。
2. **`hasConfiguredAcl` 三组名单逐个列举，而不是遍历键** — 否掉「`Object.values` 遍历」— 判据要**读得出每组各自是什么**；遍历在「将来加了第四组」时会静默把新组算进去，而那需要一次**显式的语义裁决**（新组算不算「配了访问控制」？它的缺席是不是也是取消防护？）。`upstream` **算在内**——它同样写在 `acl.json` 里、同样会因 `access` 被覆盖而不生效。⚠️ **没有任何断言**：`tests/unit/acl-configured.test.ts` 的真值表逐组给了正反例，但**改成 `Object.values(acl).some(...)` 之后那十几格全部照样通过**——「三组各自的真值」被钉住了，「**枚举**还是**遍历**」这个实现选择一个都没钉。它靠同档第 3 组那条源码级断言**间接**兜住读取路径（判据只经 `loadAcl`、零 `fs.`），但枚举方式本身测不出来。
3. **`hasConfiguredAcl(config, onFileEvent?)` 只收配置访问器与文件状态观察面，不收 `logger` / `events`**（与 `runtime/services.ts:hasConfiguredQuota` 同款签名）— 否掉「顺手注入 `logger`/`events`」— 它是一份纯判定，不观察也不发布，注入即多余；第二个形参是文件状态观察面，**与 `loadAcl` 同一份**，用于发 `config.file-error` 事件（`tests/unit/acl-configured.test.ts` 的三处调用都传了它）。⚠️ **没有任何断言**：测试锁住的是行为面，「不收 `logger` / `events`」这条签名约束本身没有断言。
4. **两条读取路径的「missing」判据刻意不同**：热路径 `readJsonCached` 只有 `ENOENT`/`ENOTDIR`/非普通文件算 missing，其它 stat 错误判 `stat-error` → 保留上一份有效值并发 `error`；启动期直读 `readAuthUsersAsync` / `readAclAsync` **只认 `ENOENT`**，其余任何读失败（含 `ENOTDIR`、路径是目录）都产出一个 `error` → `loadConfig()` abort — 否掉「统一成一个判据」— 两条的**共同后果**相同且都是安全方向：绝不会把一份读不到的文件静默当成「空配置」，故 ACL 不可能因权限/形状问题静默变成全放行。⚠️ **只锁了一半**：`tests/unit/json-file.test.ts` 的 `EACCES` 那两档钉住的是**热路径**那一半；**启动期那一半没有任何断言**——`tests/unit/auth-users.test.ts` 的 `readAuthUsersAsync` 用例只覆盖「未知组 → `error`」与「缺失 → `exists=false` 无 `error`」，**没有一格把路径指向一个目录**（`ENOTDIR` 那条分支从未被跑过）。
