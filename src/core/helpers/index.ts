/**
 * 代理共享工具层出口（`src/core/helpers/`）。
 *
 * 跨目录引用一律走本文件（`@/core/helpers/index.js`），**不要**深入
 * `core/helpers/` 内部路径：这样目录继续拆分时调用方零改动。
 *
 * 七个职责域，各由一个模块承担，互不相干：
 * - `credentials.ts` 纯凭证原语（零 config、零 IO；单槽记忆 `indexMemo` 住这里）
 * - `target.ts` 纯目标地址解析（零 config、零 IO；`splitAuthority` 与端口边界私有）
 * - `headers.ts` 出站头剥离判据与净化（读 config + users 文件）
 * - `route.ts` 路由判定（读 config + ACL）
 * - `upstream.ts` 上游协议映射 + 上游凭证头（读 config）
 * - `wire.ts` 线缆字节：出站 CONNECT 报文 / 裸 socket 状态行应答 / 写完延时销毁
 * - `predial.ts` 拨号前守卫：自环 + 目标名单 + 拒绝收尾回调
 *
 * 依赖方向（无环）：`credentials` / `target` 是叶子；`wire → target`；
 * `headers → credentials`；`upstream → credentials`；`route → target`；`predial` 独立。
 *
 * 本文件**重导出全部公共面**（与拆分前的 `core/proxy-helpers.ts` 逐符号一致），
 * 层内实现（`indexMemo` / `splitAuthority` / `MIN_PORT` / `MAX_PORT`）刻意不从这里出去。
 */

export {
  buildCredentialIndexes,
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

export {
  isProxyHeaderName,
  isProxyCredentialValue,
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
