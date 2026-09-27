# src/config/schema — 字段元数据、解析原语与校验

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `fields.ts` | `FieldDef` 类型 + `FIELDS` 表 + `keysByPhase()` | **只描述字段**，不做校验、不读 env/argv/文件 |
| `parse.ts` | `parseStr` / `parseNum` / `parseEnum` / `toBoolean` | 只做「一个字符串解析成什么标量」，**不认识任何字段名** |
| `validate.ts` | `collectIntRangeErrors` / `resolveFieldEntries` / `assertAuthConfig` | 全部纯函数；`assertAuthConfig` 是 auth 交叉组合校验，**fail-closed** |
| `upstream-url.ts` | `parseUpstreamUrl`（FIELDS 的 parse）+ `applyUpstreamUrl`（写 resolved 表）+ 模块私有 `UPSTREAM_SCHEMES` | 只服务 `UPSTREAM_URL` **这一个字段**的契约；**刻意不进本 barrel** |
| `index.ts` | 本层出口（`FIELDS` / `keysByPhase` / `FieldDef` / 三个校验函数 / `toBoolean`） | `loadConfig` 与 `server/log/config-log` 从这里取 |

**不属于本层**：字段值从哪来（`../sources/`）、配置副本的归一化（`../normalize/`）、`UPSTREAM_URL` 的**编排**（`../normalize/upstream.ts` 只调本层这两个函数，不自己实现拆项）。

## 硬约定

- **零配置依赖、零 IO、零日志、零模块级可变状态**。所有函数是纯函数：`FIELDS` 里的 `path.join` / `defaults` 引用只是纯字面量计算。
- **布尔解析全项目只有 `toBoolean` 一份**（`parse.ts`），禁止再写第二份。
- **缺省端口只有一份**：http/https 的缺省端口引 `@/utils/constants/index.js` 的 `DEFAULT_PORT_HTTP` / `DEFAULT_PORT_HTTPS`，不许内联 80/443。SOCKS 系列**没有**通用缺省端口常量（1080/443 随明文与 TLS 而变），在 `UPSTREAM_SCHEMES` 就地给出。
- **每个 `FIELDS` 行的 `phase` 必填**，且路径字段必须标 `path: true`（路径绝对化的唯一权威就在这里，`utils/tls/` 不得自己 `path.resolve`）。
- **改字段要同步四处**：`../types.ts:AppConfig` → `../store.ts:defaults` → 本目录 `FIELDS` 加一行 → 仓库根 `.env.example` + `tests/setup-env.ts:CONFIG_ENV_KEYS`。后两者有「与 FIELDS 逐项相同」的断言，漏了就表现为「本机红、CI 绿」。
- `upstream-url.ts` 只 type-only 引 `@/core/types/proxy.js:ProxyProtocol`，不引任何值。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

**有断言锁住的裁决一律不写在这里**——它们的结论、否掉了什么、为什么、以及逐字锁点全在
`tests/unit/config-loader.test.ts`（`UPSTREAM_URL` 禁 path/query/hash 与越界端口、
`resolveFieldEntries` 两路分、`assertAuthConfig` fail-closed）与
`tests/unit/quota-config-fields.test.ts`（`QUOTA_LEDGER_DIR` 必须 startup 相位、
`QUOTA_FLUSH_INTERVAL` 的 `0` 启动期 abort）的开头条注释里。**下面五条全是「无牙齿」的**，
所以必须留在这里。

1. **`upstream-url.ts` 住本层但刻意不进 `index.ts` barrel** — 否掉「并入」— 它不是校验原语、是一个字段的契约；`normalize/upstream.ts` 与单测用相对/深路径直引。放进 barrel 会让人误以为「URL 契约 = 一组通用解析原语」，于是第二个字段也去改它。⚠️ **没有任何断言**：`@/config/schema/index.ts` 的导出面从未被逐项枚举（单测走深路径直引只证明「深路径可用」，不证明「barrel 里没有」）。
2. **`UPSTREAM_SCHEMES` 表只加行不改结构** — 否掉「为新协议加一个专门的解析分支」— scheme → protocol/secure/缺省端口的映射是纯数据；一旦出现分支，「哪些协议隐含 secure」就散进代码了。⚠️ **没有任何断言**：加一个 `if (scheme === …)` 分支且保持现有六行行为不变，全仓绿。
3. **`TLS_PASSPHRASE` 刻意不标 `path: true`** — 否掉「它看起来也是文件相关字段」— 它是**口令**不是路径，给它加 `path.join` 绝对化会把一个口令变成一个路径。⚠️ **没有任何断言**：`tests/unit/quota-config-fields.test.ts` 的 `fieldOf()` 护栏只覆盖配额那三个键的全字段，其余 `FIELDS` 行（含 `path` 标志）**从未被遍历断言**。加一个 `path: true` 全仓绿，症状是 `TLS_PASSPHRASE` 被 `path.join(configDir, …)` 改写成一个不存在的路径。
4. **`phase` 必填而非可推导** — 否掉「省略即 runtime」— 省略会退化成「谁在启动期读它」的偶然事实，而 `QUOTA_LEDGER_DIR` 那类字段错标的代价是「看起来生效而实际句柄没换」。⚠️ **这是编译期约束、不是运行期断言**：`FieldDef.phase` 是必填属性（`pnpm typecheck` 兜），但「**每一行都写了**」这件事没有任何遍历断言——`FIELDS` 加一行而 `phase` 能被省略时，配额那几条护栏**不会**变红。
5. **本层只引 `@/utils/constants` 与 core 的 type-only `ProxyProtocol`** — 否掉「为拿缺省端口/协议联合把 core 引成值」— 那会让最底下的字段元数据在 import 期拉起整条 core 链。⚠️ **只锁了一半**：`tests/unit/traffic-ledger.test.ts` 的「`config → core` 的边只允许 `import type`」钉住的是 `config/types.ts` 与 `config/files/users.ts` 两处，**本目录的 `upstream-url.ts` 不在判据范围内**；把 `DEFAULT_PORT_HTTP` 内联成 `80` 也全仓绿。
