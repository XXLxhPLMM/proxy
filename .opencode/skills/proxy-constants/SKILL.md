---
name: proxy-constants
description: Use when working with HTTP constants, status codes, response messages, protocol delimiters, or need to avoid magic strings/numbers. Triggers on "constants", "常量", "CRLF", "status code", "状态码", "response", "报文", "HTTP response".
---

# Proxy Constants Skill

Use this skill when working with HTTP constants, status codes, response messages, or need to avoid magic strings/numbers in the proxy codebase.

## File Location

`src/utils/constants.ts`

## Purpose

- Centralize hardcoded strings, status codes, and protocol delimiters
- Eliminate magic strings/numbers scattered across `core/` layer
- Provide pre-compiled regex for performance
- Zero dependencies, pure value definitions

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
| `REASON_BAD_REQUEST` | `Bad Request` |
| `REASON_PROXY_AUTH_REQUIRED` | `Proxy Authentication Required` |
| `REASON_BAD_GATEWAY` | `Bad Gateway` |
| `REASON_GATEWAY_TIMEOUT` | `Gateway Timeout` |
| `REASON_INTERNAL_SERVER_ERROR` | `Internal Server Error` |

### Status Code Numbers

| Constant | Value | Usage |
|----------|-------|-------|
| `STATUS_BAD_REQUEST` | 400 | Invalid request |
| `STATUS_PROXY_AUTH_REQUIRED` | 407 | Auth required |
| `STATUS_BAD_GATEWAY` | 502 | Upstream unreachable |
| `STATUS_GATEWAY_TIMEOUT` | 504 | Upstream timeout |
| `STATUS_INTERNAL_ERROR` | 500 | Server error |
| `STATUS_FALLBACK_BAD_GATEWAY` | 502 | Fallback |

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
| `HTTP_200_CONNECTION_ESTABLISHED` | Tunnel established |
| `HTTP_400_BAD_REQUEST` | Invalid CONNECT |
| `HTTP_407_PROXY_AUTH_REQUIRED` | Auth failed |
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
| `RE_HTTP_METHOD` | `/^(GET\|POST\|...)\s+(\S+)\s+HTTP\/\d/` | Parse method |
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

### Status Code with Response

```typescript
import {
  STATUS_BAD_REQUEST,
  REASON_BAD_REQUEST,
  BODY_BAD_REQUEST,
  CRLF
} from "../utils/constants.js";

res.writeHead(STATUS_BAD_REQUEST, {
  'Content-Type': 'text/plain'
});
res.end(`${REASON_BAD_REQUEST}${CRLF}${CRLF}${BODY_BAD_REQUEST}`);
```

### Parsing CONNECT Request

```typescript
import { RE_CONNECT } from "../utils/constants.js";

const match = request.url?.match(RE_CONNECT);
if (match) {
  const target = match[1]; // host:port
}
```

### Detect Absolute URL

```typescript
import { RE_ABSOLUTE_URL } from "../utils/constants.js";

if (RE_ABSOLUTE_URL.test(url)) {
  // Absolute URL - forward directly
} else {
  // Relative URL - resolve first
}
```

## Best Practices

### DO: Use Constants

```typescript
// ✅ Correct
import { STATUS_407, CRLF } from "../utils/constants.js";
socket.write(`${STATUS_407}${CRLF}`);

// ❌ Wrong - magic strings
socket.write("HTTP/1.1 407 Proxy Authentication Required\r\n");
```

### DO: Use Pre-compiled Regex

```typescript
// ✅ Correct - regex already compiled
import { RE_CONNECT } from "../utils/constants.js";
const match = url.match(RE_CONNECT);

// ❌ Wrong - recompiling every time
const match = url.match(/^CONNECT\s+(\S+)\s+HTTP\/\d/);
```

### DO: Import Only What You Need

```typescript
// ✅ Correct - tree-shaking friendly
import { HTTP_200_CONNECTION_ESTABLISHED, CRLF } from "../utils/constants.js";

// ❌ Wrong - imports everything
import * as constants from "../utils/constants.js";
```

### DON'T: Duplicate Constants

```typescript
// ❌ Wrong - creates duplicate
const MY_407 = "HTTP/1.1 407 ...";

// ✅ Correct - use existing
import { HTTP_407_PROXY_AUTH_REQUIRED } from "../utils/constants.js";
```

## When to Add New Constants

1. **Hardcoded string in `core/`** → Move to constants.ts
2. **Magic number (status code)** → Add named constant
3. **Repeated response format** → Create complete response constant
4. **Complex regex** → Add pre-compiled version

## Code References

- Main file: `src/utils/constants.ts`
- Used in: `src/core/http-pipe.ts`, `src/core/base.ts`, `src/core/auth.ts`
- Zero dependencies: No imports from other modules