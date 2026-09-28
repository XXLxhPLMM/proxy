# src/core/identity/

文件与路径说明。

## 层不变量

以下几条已逐条核过（`src/core/identity/**` 内零反例）。**本节只列不变式，理由留在各文件的头注释里。**

- **凭证判据归插件，本目录零配置读取**：四个实现都**不 import `@/config/index.js`**，判据读**自己的** `enabled` / `type` / `jwtSecret` / 账号索引。身份一旦可插值，凭证形态就由插件决定（自定义头名、HMAC 摘要、云网关签名…），继续从 config 猜**必然失配**——而失配的方向不是「剥多了」，是**代理自己的凭证被原样转发给目标站**。
  牙齿：`tests/unit/identity-credential-seam.test.ts`。
- **`isEnabled` 是「本实例会不会拒绝任何人」的唯一开关**：消费方**只读它一个字段**，绝不许自己再判一次 `kind !== "none"`——`kind` 是插件可自定的字符串，core 无权替插件回答这个问题。牙齿：`tests/unit/inbound-dispatch.test.ts`。
- **本目录零日志、零文件 IO**：审计一律经 `IdentityContext.onAuthEvent` 上抛，落盘在 runtime 层（`src/runtime/event-log.ts:bindProxyEventLogs`）。
- **异常即拒绝**：`identify` 的 `.catch(() => undefined)` 放在**骨架**（`token.ts`）而不是各插件的 `match()` 里——「插件实现不可信」是端口级事实，自定义插件同样适用。
- **账号有效期只在「凭证命中之后」判，且账号表只交给账号表驱动的模式**：判定在 `token.ts:TokenIdentityBase.identify`（`FileAccountIdentity` 因此只在 `type` 为 `basic` / `uid` 时把账号表递给基类，`jwt` / `none` 刻意不递）。**绝不许把过期账号从凭证索引里剔除**——索引同时供出站剥离判据使用，剔除会让它的凭证被原样转发给目标站。牙齿：`tests/unit/identity.test.ts`（含「过期账号凭证仍被 `isOwnCredential` 认出」这条安全断言与 jwt 不生效那条行为断言）。

## 文件

- `src/core/identity/token.ts` — `TokenIdentityBase` 抽象骨架，承载取凭证、脱敏、审计发事件、结果判定的同形部分。
- `src/core/identity/modes.ts` — 四个模式插件工厂 `basicIdentity` / `uidIdentity` / `jwtIdentity` / `noneIdentity`。
- `src/core/identity/file-account.ts` — `FileAccountIdentity`，账号表驱动的身份实现。
- `src/core/identity/factory.ts` — 配置驱动门面 `createIdentityFromConfig`、低层直构 `createIdentity`、内置 HS256 校验 `defaultJwtVerify`、快照缓存 `liveSnapshots`。

## 路径指引

- 本目录无 `index.ts`；对外出口为 `src/core/identity.ts`。
- 相关：`src/core/types/identity.ts`（身份域类型）、`src/core/helpers/credentials.ts`（凭证索引与 HS256 验签原语）、`src/config/files/users.ts`（账号表与配额字段读面）、`src/core/server/socks-session.ts`（鉴权握手阶段）、`src/core/server/base.ts`（`authorize` 与 `auth.decided` 发布）。
- 相关测试：`tests/unit/identity.test.ts`、`tests/unit/identity-credential-seam.test.ts`、`tests/unit/identity-snapshot-memo.test.ts`、`tests/unit/inbound-dispatch.test.ts`、`tests/unit/forward-directory-layout.test.ts`。
