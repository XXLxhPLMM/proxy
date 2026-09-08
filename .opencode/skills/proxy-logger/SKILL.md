---
name: proxy-logger
description: Use when adding or tuning logging, log levels, file persistence, or structured events. Triggers on "logger", "log", "日志", "logging", "debug", "console", "logLevel", "logFile", "events-log".
---

# Proxy Logger Skill

Use this skill when adding log output, changing log levels, or working with structured events.

## When to Use

- User asks to add `logger.*` calls, change `LOG_LEVEL`/`LOG_FILE`, or define a new `[event-code]`.
- Do NOT trigger for general config — use `proxy-config` for env file mechanics.

## File Location

`src/utils/logger.ts` — singleton. Depends only on `src/config/store.ts` for `logLevel`/`logFile` (plus `node:fs`/`node:path`). Enforced by ESLint `no-console`: all runtime `src/` code must use this logger, never `console.*` directly.

## Quick Start

```typescript
import { logger, getLogger } from "@/utils/logger.js";

logger.info("Server started on port 3000");
logger.debug("Request received:", request.url);
logger.warn("Slow response detected");
logger.error("Connection failed:", error.message);

// Prefixed logger — inherit via child() for nesting
const log = getLogger("[HttpProxy]");
log.info("Tunnel established");
const child = log.child("Auth"); // prefix: [proxy:Auth]
```

## Log Levels

| Level    | Value | Usage               |
| -------- | ----- | ------------------- |
| `debug`  | 0     | Detailed debug info |
| `info`   | 1     | General operations  |
| `warn`   | 2     | Warnings            |
| `error`  | 3     | Errors              |
| `silent` | 4     | No output           |

Effective level: `forcedLevel` (via `logger.setLevel`) → `get("logLevel")` from store → `process.env.LOG_LEVEL` fallback → `info`. Only `LOG_LEVEL` is checked directly; `LOGLEVEL` alias is resolved via store.

## Configuration

```env
LOG_LEVEL=debug          # debug | info | warn | error | silent
LOG_FILE=log             # persist to log/YYYY-MM-DD-HH.log (hourly rotation)
```

`LOG_FILE`/`LOGFILE`/`LOG_PATH` aliases are equivalent in store; a bare dir (`log`) or file path (`log/app.log`) both resolve to hourly files in that directory via `src/utils/logger.ts:toHourlyFile`. Store keys `logLevel`/`logFile` override env. Directories are auto-created; write errors are silently ignored.

## Features

- **Direct file persist**: `fs.promises.appendFile` per call (no `setImmediate` batching). Call `await logger.flush()` is currently a no-op kept for compatibility — file writes are fire-and-forget.
- **Process tags**: `[pid:12345]` single process, `[master:12345]` / `[worker:12346]` in cluster mode.
- **File output is plain**: color stripped via `plain()` — console colors (`COLOR`) never hit disk.
- **`logger.infoSync(msg)`**: bypasses async persist, writes `stdout` synchronously — for startup/shutdown paths.
- **`logger.raw(msg)`**: no timestamp/level/prefix, not persisted — for banner output (`src/utils/banner.ts`).
- **`logger.setLevel("debug")` / `logger.setFile("logs/custom.log")`**: runtime overrides without touching global store.
- **Color**: auto-enabled only when `process.stdout.isTTY`; set `color: false` to force plain.

## Best Practices

- Use `getLogger("[Module]")`, never bare `console.log`.
- Structured events first: `src/server/log/events-log.ts` — same semantics share one stable `[event-code]` (`target-unresolved` / `loop-detected` / `upstream-refused` / `bad-request` / `client-timeout` / `upstream-timeout`); add a new event there instead of hand-writing `log.warn("...")`.
- Expensive args: prefer `logger.debug(() => JSON.stringify(huge))` only if level check is done inside `debug()` — currently `debug()` already guards via `enabled()`, so lazy form is optional but safe.
- Flush on exit is no longer required (no queue), but keep `await logger.flush()` for forward compat.

## Code References

- Logger class: `src/utils/logger.ts:Logger`
- Structured events: `src/server/log/events-log.ts` (`EventLog` minimal interface — `Logger` fits structurally)
- Global singleton: `src/utils/logger.ts:logger`
- Factory: `src/utils/logger.ts:getLogger`
- Enforced in: all `src/` modules (ESLint `no-console` allowlist: `src/utils/logger.ts` only)
