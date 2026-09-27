# src/utils/constants/ — 文件与路径说明

协议常量层，四个子文件互不引用、各自自足。

对外唯一出口：`@/utils/constants/index.js`。

## 文件

- `http.ts` — HTTP 报文常量：CRLF、版本、状态码、原因短语、预拼完整响应报文、头名头值、鉴权 scheme 前缀、缺省端口。
- `socks.ts` — SOCKS4/5 全部常量与预置应答 Buffer。
- `limits.ts` — 安全边界上限与白名单：`MAX_TARGET_HOST_BYTES`、`RE_VALID_TARGET_HOST`、`MAX_STATUS_LINE_BYTES`、`RE_LOG_CONTROL_CHARS`。
- `regex.ts` — 其余预编译正则：`RE_ABSOLUTE_URL`、`RE_HTTP_STATUS_LINE`、`RE_FORWARDED_FOR`、`RE_QUOTE_GLOBAL`、base64 三枚、引号剥除三枚、`RE_DIGITS`、`RE_ANSI_ESCAPE`。
- `index.ts` — 目录 barrel。

## 相关路径

- 缺省端口的引用方 — `src/config/schema/upstream-url.ts`
- 507 响应的写出点 — `src/core/forward/channel/http.ts`
- 常量值的第一手说明 — 各文件头的 `@fileoverview`
