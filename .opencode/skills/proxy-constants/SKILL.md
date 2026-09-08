---
name: proxy-constants
description: Use when working with HTTP/SOCKS constants, status codes, CRLF delimiters, or proxy response messages. Triggers on "constants", "常量", "CRLF", "status code", "状态码", "response", "报文", "HTTP response", "SOCKS", "407", "502", "DOUBLE_CRLF".
---

# Proxy Constants Skill

Use this skill when adding or referencing HTTP/SOCKS magic strings, status codes, or pre-built response messages.

## When to Use

- User needs a status line, header name, or response body — or you are about to hardcode `"HTTP/1.1 407"` / `"\r\n"` / `0x05` inline.
- Do NOT trigger for general config or logging — use `proxy-config` / `proxy-logger`.

## File Location

`src/utils/constants.ts` — zero dependencies, pure value definitions. Centralizes hardcoded strings, status codes, and protocol delimiters so magic values don't scatter across `src/core/`.

## Import Pattern

```typescript
import {
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_407_PROXY_AUTH_REQUIRED,
  CRLF,
  SOCKS5_VERSION,
} from "@/utils/constants.js";
```

## Constants by Category

### Protocol Delimiters

| Constant          | Value       | Usage                 |
| ----------------- | ----------- | --------------------- |
| `CRLF`            | `\r\n`      | HTTP line terminator  |
| `DOUBLE_CRLF`     | `\r\n\r\n`  | Header/body separator |
| `DOUBLE_CRLF_BUF` | Buffer form | Binary operations     |

### HTTP Version & Status Line

| Constant             | Value       |
| -------------------- | ----------- |
| `HTTP_VERSION`       | `HTTP/1.1`  |
| `STATUS_LINE_PREFIX` | `HTTP/1.1 ` |

### Status Reason Phrases

| Constant                        | Value                           |
| ------------------------------- | ------------------------------- |
| `REASON_CONNECTION_ESTABLISHED` | `Connection Established`        |
| `REASON_SWITCHING_PROTOCOLS`    | `Switching Protocols`           |
| `REASON_BAD_REQUEST`            | `Bad Request`                   |
| `REASON_PROXY_AUTH_REQUIRED`    | `Proxy Authentication Required` |
| `REASON_BAD_GATEWAY`            | `Bad Gateway`                   |
| `REASON_GATEWAY_TIMEOUT`        | `Gateway Timeout`               |
| `REASON_INTERNAL_SERVER_ERROR`  | `Internal Server Error`         |

### Status Code Numbers

| Constant                      | Value | Usage                        |
| ----------------------------- | ----- | ---------------------------- |
| `STATUS_SWITCHING_PROTOCOLS`  | 101   | WebSocket upgrade            |
| `STATUS_BAD_REQUEST`          | 400   | Invalid request              |
| `STATUS_PROXY_AUTH_REQUIRED`  | 407   | Auth required                |
| `STATUS_BAD_GATEWAY`          | 502   | Upstream unreachable         |
| `STATUS_GATEWAY_TIMEOUT`      | 504   | Upstream timeout             |
| `STATUS_INTERNAL_ERROR`       | 500   | Server error                 |

### Default Ports

| Constant             | Value | Usage                 |
| -------------------- | ----- | --------------------- |
| `DEFAULT_PORT_HTTP`  | 80    | URL/authority parsing |
| `DEFAULT_PORT_HTTPS` | 443   | URL/authority parsing |

### Response Headers

| Constant                          | Value                          |
| --------------------------------- | ------------------------------ |
| `HEADER_NAME_PROXY_AUTHENTICATE`  | `Proxy-Authenticate`           |
| `HEADER_PROXY_AUTHENTICATE`       | `Basic realm="Proxy"`          |
| `HEADER_NAME_PROXY_AUTHORIZATION` | `Proxy-Authorization`          |
| `HEADER_NAME_PROXY_CONNECTION`    | `Proxy-Connection`             |
| `AUTH_SCHEME_BASIC`               | `Basic ` (with trailing space) |
| `AUTH_SCHEME_BEARER`              | `Bearer ` (with trailing space)|

### Response Bodies

| Constant           | Value                             |
| ------------------ | --------------------------------- |
| `BODY_BAD_REQUEST` | `Bad Request: invalid target URL` |

### Complete Response Messages

| Constant                          | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `HTTP_101_SWITCHING_PROTOCOLS`    | WebSocket upgrade                                  |
| `HTTP_200_CONNECTION_ESTABLISHED` | CONNECT tunnel established                         |
| `HTTP_400_BAD_REQUEST`            | Invalid CONNECT                                    |
| `HTTP_407_PROXY_AUTH_REQUIRED`    | Auth failed (includes `Proxy-Authenticate` header) |
| `HTTP_504_GATEWAY_TIMEOUT`        | Upstream timeout                                   |
| `HTTP_502_BAD_GATEWAY`            | Upstream unreachable                               |
| `HTTP_500_INTERNAL_ERROR`         | Internal error                                     |

### SOCKS Protocol Constants

| Constant                | Value / Bytes                          | Usage                              |
| ----------------------- | -------------------------------------- | ---------------------------------- |
| `SOCKS5_VERSION`        | `0x05`                                 | SOCKS5 VER field                   |
| `SOCKS4_VERSION`        | `0x04`                                 | SOCKS4 VN field                    |
| `SOCKS5_NO_AUTH`        | `Buffer [0x05, 0x00]`                  | No-auth selection response         |
| `SOCKS5_HANDSHAKE_REQ`  | `Buffer [0x05, 0x01, 0x00]`            | Client handshake template          |
| `SOCKS5_AUTH_REJECT`    | `Buffer [0x05, 0xFF]`                  | No acceptable method               |
| `SOCKS5_REPLY_SUCCESS`  | `Buffer [0x05,0x00,0x00,0x01,0...]`    | Success (IPv4 zero BND)            |
| `SOCKS5_REPLY_FAILURE`  | `Buffer [0x05,0x01,0x00,0x01,0...]`    | General failure                    |
| `SOCKS4_REPLY_SUCCESS`  | `Buffer [0x00,0x5A,0...]`              | SOCKS4 success (port/IP zero)      |
| `SOCKS4_REPLY_FAILURE`  | `Buffer [0x00,0x5B,0...]`              | SOCKS4 failure                     |

### Helper Functions

```typescript
build407Response(): string  // Returns HTTP_407_PROXY_AUTH_REQUIRED
buildProxyAuthValue(credentialsB64: string): string  // Returns `Basic <base64>`
```

### Pre-compiled Regex

| Constant          | Pattern           | Usage               |
| ----------------- | ----------------- | ------------------- |
| `RE_ABSOLUTE_URL` | `/^https?:\/\//i` | Detect absolute URL |

## Best Practices

- Use constants, not magic strings: `socket.write(HTTP_407_PROXY_AUTH_REQUIRED)` never hand-typed `"HTTP/1.1 407 ..."`.
- Use pre-compiled regex: `RE_ABSOLUTE_URL` not inline literal.
- Import only what you need: named imports, not `import * as constants`.
- Need a new response? Compose from `STATUS_LINE_PREFIX` + status + reason + `DOUBLE_CRLF` in `constants.ts`, don't build at call site.

## When to Add New Constants

1. Hardcoded string in `src/core/` → move to `constants.ts`
2. Magic number (status code) → add named constant
3. Repeated response format → create complete response constant
4. Complex regex → add pre-compiled version

## Code References

- Main file: `src/utils/constants.ts`
- Used in: `src/core/server/http.ts`, `src/core/server/base.ts`, `src/core/auth.ts`, `src/core/forward/*`, `src/core/forward/tunnel/*`
- Zero dependencies: no imports from other modules
