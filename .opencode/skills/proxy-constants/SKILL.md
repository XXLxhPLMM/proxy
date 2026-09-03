---
name: proxy-constants
description: Use when working with HTTP constants, status codes, response messages, protocol delimiters, or need to avoid magic strings/numbers. Triggers on "constants", "常量", "CRLF", "status code", "状态码", "response", "报文", "HTTP response".
---

# Proxy Constants Skill

Use this skill when working with HTTP constants, status codes, response messages, or need to avoid magic strings/numbers in the proxy codebase.

## File Location

`src/utils/constants.ts` — zero dependencies, pure value definitions. Centralizes
hardcoded strings, status codes, and protocol delimiters so magic values don't
scatter across the `core/` layer.

## Import Pattern

```typescript
import {
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_407_PROXY_AUTH_REQUIRED,
  CRLF,
  RE_CONNECT
} from "../utils/constants.js";
```

## Constants by Category

### Protocol Delimiters

| Constant | Value | Usage |
|----------|-------|-------|
| `CRLF` | `\r\n` | HTTP line terminator |
| `DOUBLE_CRLF` | `\r\n\r\n` | Header/body separator |
| `DOUBLE_CRLF_BUF` | Buffer form | Binary operations |

### HTTP Version & Status Line

| Constant | Value |
|----------|-------|
| `HTTP_VERSION` | `HTTP/1.1` |
| `STATUS_LINE_PREFIX` | `HTTP/1.1 ` |

### Status Reason Phrases

| Constant | Value |
|----------|-------|
| `REASON_CONNECTION_ESTABLISHED` | `Connection Established` |
| `REASON_SWITCHING_PROTOCOLS` | `Switching Protocols` |
| `REASON_BAD_REQUEST` | `Bad Request` |
| `REASON_PROXY_AUTH_REQUIRED` | `Proxy Authentication Required` |
| `REASON_BAD_GATEWAY` | `Bad Gateway` |
| `REASON_GATEWAY_TIMEOUT` | `Gateway Timeout` |
| `REASON_INTERNAL_SERVER_ERROR` | `Internal Server Error` |

### Status Code Numbers

| Constant | Value | Usage |
|----------|-------|-------|
| `STATUS_SWITCHING_PROTOCOLS` | 101 | Protocol upgrade (WebSocket) |
| `STATUS_BAD_REQUEST` | 400 | Invalid request |
| `STATUS_PROXY_AUTH_REQUIRED` | 407 | Auth required |
| `STATUS_BAD_GATEWAY` | 502 | Upstream unreachable |
| `STATUS_GATEWAY_TIMEOUT` | 504 | Upstream timeout |
| `STATUS_INTERNAL_ERROR` | 500 | Server error |
| `STATUS_FALLBACK_BAD_GATEWAY` | 502 | Fallback |

### Default Ports

| Constant | Value | Usage |
|----------|-------|-------|
| `DEFAULT_PORT_HTTP` | 80 | URL/authority parsing |
| `DEFAULT_PORT_HTTPS` | 443 | URL/authority parsing |

### Response Headers

| Constant | Value |
|----------|-------|
| `HEADER_NAME_PROXY_AUTHENTICATE` | `Proxy-Authenticate` |
| `HEADER_PROXY_AUTHENTICATE` | `Basic realm="Proxy"` |

### Response Bodies

| Constant | Value |
|----------|-------|
| `BODY_BAD_REQUEST` | `Bad Request: invalid target URL` |
| `BODY_PROXY_ERROR` | `Proxy Error` |

### Complete Response Messages

| Constant | Purpose |
|----------|---------|
| `HTTP_101_SWITCHING_PROTOCOLS` | Protocol upgrade success |
| `HTTP_200_CONNECTION_ESTABLISHED` | Tunnel established |
| `HTTP_400_BAD_REQUEST` | Invalid CONNECT |
| `HTTP_407_PROXY_AUTH_REQUIRED` | Auth failed (includes `Proxy-Authenticate` header) |
| `HTTP_504_GATEWAY_TIMEOUT` | Upstream timeout |
| `HTTP_502_BAD_GATEWAY` | Upstream unreachable |
| `HTTP_500_INTERNAL_ERROR` | Internal error |

### Helper Functions

```typescript
build407Response(): string  // Returns HTTP_407_PROXY_AUTH_REQUIRED
```

### Pre-compiled Regex

| Constant | Pattern | Usage |
|----------|---------|-------|
| `RE_HTTP_STATUS` | `/HTTP\/\d\.\d\s+(\d+)/` | Parse status code |
| `RE_CONNECT` | `/^CONNECT\s+(\S+)\s+HTTP\/\d/` | Parse CONNECT |
| `RE_HTTP_METHOD` | `/^(GET\|POST\|PUT\|DELETE\|HEAD\|OPTIONS\|PATCH\|TRACE)\s+(\S+)\s+HTTP\/\d/` | Parse method |
| `RE_ABSOLUTE_URL` | `/^https?:\/\//i` | Detect absolute URL |

## Usage Examples

### Sending Tunnel Response

```typescript
import { HTTP_200_CONNECTION_ESTABLISHED } from "../utils/constants.js";

// Direct socket write
socket.write(HTTP_200_CONNECTION_ESTABLISHED);
```

### Auth Failure Response

```typescript
import {
  HTTP_407_PROXY_AUTH_REQUIRED,
  build407Response
} from "../utils/constants.js";

// Option 1: Use constant directly
socket.write(HTTP_407_PROXY_AUTH_REQUIRED);

// Option 2: Use helper function
socket.write(build407Response());
```

### Parsing CONNECT Request

```typescript
import { RE_CONNECT } from "../utils/constants.js";

const match = request.url?.match(RE_CONNECT);
if (match) {
  const target = match[1]; // host:port
}
```

## Best Practices

- **Use constants, not magic strings**: `socket.write(HTTP_407_PROXY_AUTH_REQUIRED)`,
  never a hand-typed `"HTTP/1.1 407 ..."` line.
- **Use pre-compiled regex**: `url.match(RE_CONNECT)`, never re-declare the
  literal inline.
- **Import only what you need**: named imports, not `import * as constants`.
- **Don't duplicate**: need a new response? Compose it from the base fragments
  (`STATUS_LINE_PREFIX` + status + reason + `DOUBLE_CRLF`) in `constants.ts`,
  don't hand-build it at the call site.

## When to Add New Constants

1. **Hardcoded string in `core/`** → Move to constants.ts
2. **Magic number (status code)** → Add named constant
3. **Repeated response format** → Create complete response constant
4. **Complex regex** → Add pre-compiled version

## Code References

- Main file: `src/utils/constants.ts`
- Used in: `src/core/http-pipe.ts`, `src/core/base.ts`, `src/core/auth.ts`
- Zero dependencies: No imports from other modules
