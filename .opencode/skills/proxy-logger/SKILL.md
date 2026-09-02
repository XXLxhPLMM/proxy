---
name: proxy-logger
description: Use when working with logging, debugging output, log levels, file persistence, or need to add logging to code. Triggers on "logger", "log", "日志", "logging", "debug", "console".
---

# Proxy Logger Skill

Use this skill when working with logging, adding log output, or debugging in the proxy codebase.

## File Location

`src/utils/logger.ts`

## Purpose

- Centralized logging for the entire process
- Unified format: timestamp + level + process tag + prefix + message
- Level filtering based on config
- Optional file persistence with hourly rotation
- Async write queue with setImmediate batching

## Quick Start

### Import

```typescript
import { logger, getLogger } from "../utils/logger.js";
```

### Basic Usage

```typescript
import { logger } from "../utils/logger.js";

logger.info("Server started on port 3000");
logger.debug("Request received:", request.url);
logger.warn("Slow response detected");
logger.error("Connection failed:", error.message);
```

### Create Prefixed Logger

```typescript
import { getLogger } from "../utils/logger.js";

const log = getLogger("[HttpProxy]");
log.info("Tunnel established");
log.debug("Forwarding to upstream");
```

## Log Levels

| Level | Value | Usage |
|-------|-------|-------|
| `debug` | 0 | Detailed debug info |
| `info` | 1 | General operations |
| `warn` | 2 | Warnings |
| `error` | 3 | Errors |
| `silent` | 4 | No output |

Level filtering: Only messages at or above current level are output.

## Configuration

### Environment Variables

```env
LOG_LEVEL=debug          # Set log level
LOG_FILE=log             # Enable file persistence
LOGFILE=log/app.log      # Alternative file path
LOG_PATH=log             # Alternative file path
```

### Config Store

```typescript
import { get } from "../config/store.js";

const level = get("logLevel");   // "debug" | "info" | "warn" | "error" | "silent"
const file = get("logFile");     // File path or directory
```

## Features

### Lazy Evaluation

When first argument is a function, it's only evaluated if level is enabled:

```typescript
// Expensive operation only runs if debug is enabled
logger.debug(() => JSON.stringify(largeObject));
```

### Process Tags

Output includes process info in cluster mode:
- Single process: `[pid:12345]`
- Master: `[master:12345]`
- Worker: `[worker:12346]`

### File Persistence

When `LOG_FILE` is configured:
- Logs written to `log/YYYY-MM-DD-HH.log` (hourly rotation)
- Auto-creates directory if needed
- Errors silently ignored (non-blocking)

### Sync Output

For shutdown scenarios requiring guaranteed output:

```typescript
logger.infoSync("Shutting down...");
```

### Raw Output

No timestamp/level/prefix, for banner output:

```typescript
logger.raw("=== Server Status ===");
```

## Child Loggers

Create prefixed loggers that inherit settings:

```typescript
const parent = getLogger("[Proxy]");
const child = parent.child("Http");
// Output: 2026-01-01T00:00:00.000Z INFO [pid:12345][Proxy:Http] message
```

## Runtime Control

### Change Level

```typescript
logger.setLevel("debug");
```

### Change File

```typescript
logger.setFile("logs/custom.log");
```

### Flush Before Exit

```typescript
// Prevents log loss on shutdown
await logger.flush();
process.exit(0);
```

## Usage Examples

### Request Logging

```typescript
import { getLogger } from "../utils/logger.js";

const log = getLogger("[Request]");

function handleRequest(req, res) {
  log.info(`${req.method} ${req.url}`);
  // ... handle request
  log.debug(`Response sent: ${res.statusCode}`);
}
```

### Error Handling

```typescript
import { logger } from "../utils/logger.js";

try {
  await connectToUpstream();
} catch (err) {
  logger.error("Upstream connection failed:", err.message);
  logger.debug(() => ({ error: err, stack: err.stack }));
}
```

### Performance Logging

```typescript
import { logger } from "../utils/logger.js";

const start = Date.now();
// ... operation
const duration = Date.now() - start;

if (duration > 1000) {
  logger.warn(`Slow operation: ${duration}ms`);
}
```

### Conditional Debug

```typescript
import { logger } from "../utils/logger.js";

// Only stringify if debug enabled
logger.debug(() => ({
  method: req.method,
  url: req.url,
  headers: req.headers,
  body: req.body
}));
```

## Best Practices

### DO: Use Prefixed Loggers

```typescript
// ✅ Correct - easy to grep
const log = getLogger("[HttpProxy]");
log.info("Tunnel established");

// ❌ Wrong - hard to filter
console.log("Tunnel established");
```

### DO: Use Lazy Evaluation for Expensive Operations

```typescript
// ✅ Correct - only evaluates if debug enabled
logger.debug(() => JSON.stringify(hugeObject));

// ❌ Wrong - always evaluates
logger.debug(JSON.stringify(hugeObject));
```

### DON'T: Use console.* Directly

```typescript
// ❌ Wrong - bypasses level filtering and file persistence
console.log("Something happened");
console.error("Error:", err);

// ✅ Correct - proper logging
logger.info("Something happened");
logger.error("Error:", err);
```

### DON'T: Forget to Flush on Exit

```typescript
// ✅ Correct - prevents log loss
process.on("SIGTERM", async () => {
  await logger.flush();
  process.exit(0);
});
```

## Code References

- Logger class: `src/utils/logger.ts:Logger`
- Global singleton: `src/utils/logger.ts:logger`
- Factory function: `src/utils/logger.ts:getLogger`
- Used in: All `src/` modules (enforced by ESLint `no-console` rule)