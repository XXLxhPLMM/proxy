/**
 * @fileoverview 协议常量层出口。
 *
 * 本目录按职责拆成四块，互不越界、互不依赖（每个文件自足，无跨文件符号引用）：
 * | 文件         | 只负责                                                                 |
 * | ------------ | ------------------------------------------------------------------------ |
 * | `http.ts`    | CRLF/版本/状态码/原因短语/头名头值/鉴权 scheme + 预拼完整响应报文         |
 * | `socks.ts`   | SOCKS4/5 协议字节、预置应答 Buffer、固定长度字段字节数                    |
 * | `limits.ts`  | 目标主机白名单与长度上限、响应头缓冲上限、日志控制字符净化                 |
 * | `regex.ts`   | 全部预编译正则                                                            |
 *
 * 跨目录引用一律走本文件（`@/utils/constants/index.js`），**不要**深入
 * `utils/constants/` 内部路径：这样目录继续拆分时调用方零改动。层内互用相对路径
 * （`./http.js` 等），**禁止自引 barrel**（本目录内部不得出现
 * `@/utils/constants/index.js`），避免循环依赖。
 *
 * 出口面 = 被外部引用过的符号；仅供同文件派生预拼报文的中间量
 * （状态行前缀、`Connection Established` / `Gateway Timeout` 原因短语）刻意不导出。
 * 本目录只出纯值，**不含任何函数**——鉴权头拼装在 `core/helpers` 侧，不属于常量层。
 */

export * from "./http.js";
export * from "./socks.js";
export * from "./limits.js";
export * from "./regex.js";
