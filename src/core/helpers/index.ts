/**
 * 代理共享工具层出口（`src/core/helpers/`）。
 *
 * 跨目录引用一律走本文件（`@/core/helpers/index.js`），**不要**深入
 * `core/helpers/` 内部路径：这样目录继续拆分时调用方零改动。
 *
 * 八个职责域各由一个模块承担（逐文件职责与依赖见 `AGENTS.md`「路径说明」表）。
 * 依赖方向无环：`credentials` / `target` / `self-loop` / `headers` 是叶子；`wire → target`；
 * `upstream → credentials`；`predial → self-loop`；`route` 与 `predial` 对策略层**只 type-only**
 * （引 `@/core/types/proxy.js` 的端口类型，运行期零依赖边——`helpers/` 不反向依赖策略层）。
 *
 * 本文件**重导出全部公共面**（`RoutePolicy` / `RouteInput` / `DialPlan` 三个策略型类型**刻意
 * 不出去**，理由见 `AGENTS.md` 路径说明末段），层内实现（`indexMemo` / `splitAuthority` /
 * `canonicalHost` / `WILDCARD_HOSTS` / `LOOPBACK_HOSTS` / `MIN_PORT` / `MAX_PORT`）与任何
 * **策略层**实现刻意不从这里出去。
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
