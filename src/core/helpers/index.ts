/**
 * 代理共享工具层出口（`src/core/helpers/`）。
 *
 * 跨目录引用一律走本文件（`@/core/helpers/index.js`），**不要**深入
 * `core/helpers/` 内部路径：这样目录继续拆分时调用方零改动。
 *
 * 八个职责域，各由一个模块承担，互不相干：
 * - `credentials.ts` 纯凭证原语（零 config、零 IO；单槽记忆 `indexMemo` 住这里）
 * - `target.ts` 纯目标地址解析（零 config、零 IO；`splitAuthority` 与端口边界私有）
 * - `self-loop.ts` 自环判定（零 config、零 IO；归一链与 ACL 名单共用一份）
 * - `headers.ts` 出站头剥离与净化（**零 config**：凭证判据转交 `IdentityProvider` 端口）
 * - `route.ts` 路由判定（**零 config**：结论取自 `AccessControl` 端口）
 * - `upstream.ts` 上游协议映射 + 上游凭证头（读 config）
 * - `wire.ts` 线缆字节：出站 CONNECT 报文 / 裸 socket 状态行应答 / 写完延时销毁
 * - `predial.ts` 拨号前守卫：自环（读 config）+ 目标名单（`AccessControl` 端口）+ 拒绝收尾回调
 *
 * 依赖方向（无环）：`credentials` / `target` / `self-loop` / `headers` 是叶子；
 * `wire → target`；`upstream → credentials`；`route` 与 `predial` 对策略层**只 type-only**
 * （引 `@/core/types/proxy.js` 的端口类型，运行期零依赖边——`helpers/` 不反向依赖策略层）；
 * `predial → self-loop`。
 *
 * 本文件**重导出全部公共面**，层内实现（`indexMemo` / `splitAuthority` / `canonicalHost` /
 * `WILDCARD_HOSTS` / `LOOPBACK_HOSTS` / `MIN_PORT` / `MAX_PORT`）与任何**策略层**实现
 * 刻意不从这里出去。
 */

export {
  buildCredentialIndexes,
  buildProxyAuthValue,
  credentialIndexesFor,
  encodeBasicCredentials,
  extractBasicUser,
  isJwtShape,
  matchBasicCredential,
  matchUidCredential,
  verifyHs256Jwt,
} from "./credentials.js";
export type { ProxyCredentialIndexes } from "./credentials.js";

export {
  absoluteFormAuthority,
  formatAuthority,
  isValidTargetHost,
  parseAuthority,
  parseTargetParts,
} from "./target.js";
export type { TargetParts } from "./target.js";

export { isSelfLoopAddr } from "./self-loop.js";

export {
  isProxyHeaderName,
  isStrippableOutboundHeader,
  sanitizeHeaders,
  stripProxyHeaders,
} from "./headers.js";

export { resolveForwardTargets, resolveRoute } from "./route.js";
export type { ForwardTargets, RouteDecision } from "./route.js";

export {
  isSocksProto,
  isTlsUpstreamProto,
  socksVersionOf,
  upstreamAuthHeaderLine,
  upstreamAuthValue,
} from "./upstream.js";

export { buildConnectRequest, httpReplyFor, writeReplyAndClose } from "./wire.js";

export { guardPreDial, isSelfLoop } from "./predial.js";
export type { PreDialOptions } from "./predial.js";
