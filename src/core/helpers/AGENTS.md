# src/core/helpers/

文件与路径说明。

## 文件

- `src/core/helpers/credentials.ts` — 纯凭证原语：索引编译与单槽记忆、Basic 令牌解析、内置 HS256 验签、`buildProxyAuthValue`。
- `src/core/helpers/target.ts` — 纯目标地址解析：host 白名单、authority 拆分与拼装、目标三元组。
- `src/core/helpers/self-loop.ts` — 自环判定 `isSelfLoopAddr` 与薄委托 `isSelfLoop`，私有 `canonicalHost`。
- `src/core/helpers/headers.ts` — 出站头剥离判据与净化（`applyOutboundRewrite` / `isProxyHeaderName` / `isStrippableOutboundHeader` / `stripProxyHeaders` / `sanitizeHeaders`）。
- `src/core/helpers/route.ts` — 有效模式与路由判定（`resolveRoute` / `resolveForwardTargets`），含 `RoutePolicy` / `RouteInput` / `DialPlan` 类型。
- `src/core/helpers/upstream.ts` — 上游协议映射与上游 Basic 凭证头。
- `src/core/helpers/wire.ts` — 线缆字节：出站 CONNECT 报文、裸 socket 状态行应答、写完延时销毁。
- `src/core/helpers/predial.ts` — 拨号前守卫 `guardPreDial`：自环、目标名单、拒绝收尾回调。
- `src/core/helpers/index.ts` — 层出口 barrel。

## 路径指引

- 对外唯一出口：`@/core/helpers/index.js`。
- 叶子模块：`src/core/helpers/credentials.ts`、`src/core/helpers/target.ts`、`src/core/helpers/self-loop.ts`、`src/core/helpers/headers.ts`。
- 相关：`src/core/types/proxy.ts`（端口与判定类型，`route.ts` / `predial.ts` 的 type-only 出边）、`src/core/forward/base.ts`（路由策略与 `emitRoute`）、`src/core/forward/upstream/connector/types.ts`、`src/core/server/http.ts`（入站头展示掩码）、`src/core/forward/channel/socks-reader.ts`。
- 相关测试：`tests/unit/core/helpers/`、`tests/unit/core/identity/credential-seam.test.ts`、`tests/unit/runtime/bridge/`、`tests/unit/config/store/accessor.test.ts`、`tests/helpers/source-scan.ts`。
