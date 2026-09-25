# src/utils/constants — 协议常量

跨目录只引 `@/utils/constants/index.js`；层内相对引用，**禁止自引 barrel**（目录内部不得出现 `@/utils/constants/index.js`）。

## 职责表

| 文件        | 只负责                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `http.ts`   | CRLF / HTTP 版本 / 状态码 / 原因短语 / 预拼完整响应报文 / 头名头值 / 鉴权 scheme 前缀 / 缺省端口                 |
| `socks.ts`  | SOCKS4/5 全部常量与预置应答 Buffer                                                                             |
| `limits.ts` | 安全边界上限与白名单：`MAX_TARGET_HOST_BYTES`、目标主机字符集 `RE_VALID_TARGET_HOST`、`MAX_STATUS_LINE_BYTES`、日志控制字符 `RE_LOG_CONTROL_CHARS` |
| `regex.ts`  | 其余全部预编译正则（`RE_ABSOLUTE_URL`/`RE_HTTP_STATUS_LINE`/`RE_FORWARDED_FOR`/`RE_QUOTE_GLOBAL`/base64 三枚/引号剥除三枚/`RE_DIGITS`/`RE_ANSI_ESCAPE`） |

**四个子文件互不引用**，各自自足。跨文件需要共享的值请放回对应域或提升到调用点，不要造第三条依赖。

## 硬规则

- **零函数**：本目录只出纯值。需要拼字符串的函数不属这里——`buildProxyAuthValue`（拼 `Proxy-Authorization` 头值）已搬到 `@/core/helpers/credentials.ts`，调用方经 barrel 引 `@/core/helpers/index.js`。
- **禁止内联魔数**：连 `^\d+$` 这种也必须走 `RE_DIGITS`，常量是唯一的数值/正则真相源。
- **禁止导出仅内部使用的值**：只在预拼报文模板里用到的 `STATUS_LINE_PREFIX`、`REASON_CONNECTION_ESTABLISHED`、`REASON_GATEWAY_TIMEOUT` 是模块私有。新增常量前先确认外部确有引用再 `export`。
- **缺省端口只有一份**：`DEFAULT_PORT_HTTP`/`DEFAULT_PORT_HTTPS`。`@/config/schema/upstream-url.js` 的 scheme 表必须引它们，不许再写第二份 http/https 缺省端口。**仅限 http/https**——SOCKS 系列的缺省端口随明文/TLS 而变（1080 / 443），语义不同，就地给出。

## 两条容易踩的边界

- **`limits.ts` 里可以有正则**：归属看**用途**不是形态。`RE_VALID_TARGET_HOST` 是安全边界白名单（限制目标主机字符集），`RE_LOG_CONTROL_CHARS` 是日志净化判据——它们是「上限/白名单」这一族，只是恰好以正则表达。`regex.ts` 负责的是「协议解析用的预编译正则」这一族。
- **`RE_ANSI_ESCAPE` 与 `RE_LOG_CONTROL_CHARS` 上方的 `// eslint-disable-next-line no-control-regex` 必须保留**，否则 lint 报错。

## 已删除的零引用死值（勿复活）

`BODY_BAD_REQUEST`、`HTTP_101_SWITCHING_PROTOCOLS`（101 由上游回给客户端，代理从不写裸 101 串）、`HTTP_500_INTERNAL_ERROR`、`SOCKS5_METHOD_REJECT`（已被 `SOCKS5_AUTH_REJECT` 取代）、`SOCKS5_REP_FAILURE`、`build407Response()`（包常量的空壳且无人调用），以及级联死的 `STATUS_INTERNAL_ERROR`/`REASON_INTERNAL_SERVER_ERROR`。

## 预拼报文的写法

`HTTP_200/400/403/407/502/504` 等是**已拼好的完整报文**（状态行 + 头 + 空行 + body），直接 write socket，零分配。改措辞要连带确认调用方是否依赖固定长度或特定换行——本目录统一 CRLF。
