---
name: proxy-logger
description: Use when working with logging, debugging output, log levels, file persistence, or need to add logging to code. Triggers on "logger", "log", "日志", "logging", "debug", "console".
---

# Proxy Logger Skill

Use this skill when working with logging, adding log output, or debugging in the proxy codebase.

## File Location

`src/utils/logger.ts` — singleton, zero dependencies (console + fs only).
Enforced by ESLint `no-console`: all runtime `src/` code must use this logger,
never `console.*` directly.

## Quick Start

```typescript
import { logger, getLogger } from "../utils/logger.js";

logger.info("Server started on port 3000");
logger.debug("Request received:", request.url);
logger.warn("Slow response detected");
logger.error("Connection failed:", error.message);

// Prefixed logger (easy to grep) — inherit via child() for nesting
const log = getLogger("[HttpProxy]");       // logger.child("[HttpProxy]")
log.info("Tunnel established");
const child = log.child("Auth");            // prefix: [HttpProxy:Auth]
```

## Log Levels

| Level | Value | Usage |
|-------|-------|-------|
| `debug` | 0 | Detailed debug info |
| `info` | 1 | General operations |
| `warn` | 2 | Warnings |
| `error` | 3 | Errors |
| `silent` | 4 | No output |

Only messages at or above the current level are output. Effective level:
per-instance forced level → store `logLevel` → `LOG_LEVEL`/`LOGLEVEL` env → `info`.

## Configuration

```env
LOG_LEVEL=debug          # Set log level
LOG_FILE=log             # Persist to log/YYYY-MM-DD-HH.log (hourly rotation)
```

`LOG_FILE`/`LOGFILE`/`LOG_PATH` are equivalent; a bare dir (`log`) or a file
path (`log/app.log`) both resolve to hourly files in that directory. Store keys
`logLevel`/`logFile` override env. Directories are auto-created; write errors
are silently ignored (non-blocking).

## Features

- **Async write queue** (`setImmediate` batching): console + file writes merge
  into one task per log call, executed in order. Call `await logger.flush()`
  before exit or logs are lost.
- **Lazy evaluation**: first arg as function evaluates only if the level is
  enabled — `logger.debug(() => JSON.stringify(hugeObject))`.
- **Process tags**: `[pid:12345]` single, `[master:12345]` / `[worker:12346]`
  in cluster mode.
- **File output is plain**: color stripped automatically when persisting.
- **`logger.infoSync(msg)`**: bypasses the queue, writes stdout directly — for
  shutdown paths that must be seen.
- **`logger.raw(msg)`**: no timestamp/level/prefix, not persisted — for banner output.
- **Runtime control**: `logger.setLevel("debug")`,
  `logger.setFile("logs/custom.log")` (both override global config).

## Best Practices

- **Prefixed loggers**: `getLogger("[HttpProxy]")`, never bare `console.log`.
- **Structured events first**: `src/utils/log-events.ts` — same semantics share one stable
  `[event-code]` format (`target-unresolved` / `loop-detected` / `upstream-refused` /
  `bad-request` / `client-timeout`+`client-error` / `upstream-timeout`+`upstream-error`);
  add a new event there instead of hand-writing `log.warn("...")` at call sites.
  Debug tracing with unique context stays inline.
- **Lazy expensive args**: `logger.debug(() => ...)` instead of pre-stringifying.
- **Flush on exit**: `process.on("SIGTERM", async () => { await logger.flush(); process.exit(0); })`.

## Code References

- Logger class: `src/utils/logger.ts:Logger`
- Structured events: `src/utils/log-events.ts` (`EventLog` minimal interface — Logger fits structurally)
- Global singleton: `src/utils/logger.ts:logger`
- Factory function: `src/utils/logger.ts:getLogger`
- Used in: All `src/` modules (enforced by ESLint `no-console` rule)
