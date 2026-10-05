# src/core/types/

文件与路径说明。

## 文件

- `src/core/types/proxy.ts` — 类型单一来源：`ProxyOptions` / `ProxyStats` / 生命周期类型 / `ProxyForwardKind` / 三个端口与判定输入输出类型 / `PipeEvent` 判别联合 / 身份域类型。
- `src/core/types/identity.ts` — 身份域类型转发出口（`IdentityRequestLike` / `IdentityContext` / `IdentityResult` / `IdentityProvider` / `IdentityOptions` / `AuthAccount` / `ProxyAuthEvent`）。
- `src/core/types/pipe.ts` — `PipeEvent` / `PipeEventSink` 转发出口。

## 路径指引

- 本目录无 `index.ts`。
- 公共事件表 `AppEventMap` 位于 `src/core/events/types.ts`。
- `proxy.ts` 的 `import type` 出边：`src/core/log-events.ts`、`src/core/context.ts`、`src/core/forward/upstream/connector/index.ts`；入边：`src/core/forward/upstream/connector/registry.ts`。
- 端口声明与内置实现：`IdentityProvider` 声明于 `proxy.ts`（经 `identity.ts` 转发）、实现 `src/core/identity/factory.ts` 与 `src/core/identity/modes.ts`；`AccessControl` 声明于 `proxy.ts`、实现 `src/core/access-control.ts`；`ConnectorSource` 声明于 `src/core/forward/upstream/connector/types.ts`、实现 `src/core/forward/upstream/connector/registry.ts`。
- `CoreServices` 位于本目录；`RuntimeServices` 位于 `src/runtime/types.ts`；默认实现装配 `src/runtime/services.ts`。
- 相关测试：`tests/unit/core/access-control/`、`tests/unit/core/identity/credential-seam.test.ts` + `tests/unit/core/identity/own-credential.test.ts`、`tests/unit/core/request-scope/allocation.test.ts`、`tests/unit/config/store/accessor.test.ts`、`tests/unit/config/store/instance.test.ts`、`tests/unit/core/dead-optionality.test.ts`。
