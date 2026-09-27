# src/core/identity/

文件与路径说明。

## 文件

- `src/core/identity/token.ts` — `TokenIdentityBase` 抽象骨架，承载取凭证、脱敏、审计发事件、结果判定的同形部分。
- `src/core/identity/modes.ts` — 四个模式插件工厂 `basicIdentity` / `uidIdentity` / `jwtIdentity` / `noneIdentity`。
- `src/core/identity/file-account.ts` — `FileAccountIdentity`，账号表驱动的身份实现。
- `src/core/identity/factory.ts` — 配置驱动门面 `createIdentityFromConfig`、低层直构 `createIdentity`、内置 HS256 校验 `defaultJwtVerify`、快照缓存 `liveSnapshots`。

## 路径指引

- 本目录无 `index.ts`；对外出口为 `src/core/identity.ts`。
- 相关：`src/core/types/identity.ts`（身份域类型）、`src/core/helpers/credentials.ts`（凭证索引与 HS256 验签原语）、`src/config/files/users.ts`（账号表与配额字段读面）、`src/core/server/socks-session.ts`（鉴权握手阶段）、`src/core/server/base.ts`（`authorize` 与 `auth.decided` 发布）。
- 相关测试：`tests/unit/identity.test.ts`、`tests/unit/identity-credential-seam.test.ts`、`tests/unit/identity-snapshot-memo.test.ts`、`tests/unit/inbound-dispatch.test.ts`、`tests/unit/forward-directory-layout.test.ts`。
