---
name: proxy-logger
description: Use when adding or tuning logging, log levels, file persistence, structured log fields, or structured events. Triggers on "logger", "log", "日志", "logging", "debug", "console", "logLevel", "logFileLevel", "LOG_FILE_LEVEL", "logFile", "events-log", "jsonl".
---

# Proxy Logger Skill

Use this skill when adding log output, changing log levels, or working with structured events.

## When to Use

- User asks to add `logger.*` calls, change `LOG_LEVEL`/`LOG_FILE`, or define a new `[event-code]`.
- Do NOT trigger for general config — use `proxy-config` for env file mechanics.

## File Location

`src/utils/logger.ts` — singleton. Depends only on `src/config/store.ts` for `logLevel`/`logFileLevel`/`logFile` (plus `node:fs`/`node:path`). Enforced by ESLint `no-console`: all runtime `src/` code must use this logger, never `console.*` directly.

## Quick Start

```typescript
import { logger, getLogger } from "@/utils/logger.js";

logger.info("Server started on port 3000");
logger.debug("Request received:", request.url);
logger.warn("Slow response detected");
logger.error("Connection failed:", error.message);

// Structured fields: last arg as a plain object → k=v on console, top-level keys in the JSONL file
logger.info("[forward]", { client, target, method, user });

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

Console and file levels are **independent gates** — `emit()` checks each channel separately, so one can print while the other stays silent (`silent` mutes a channel entirely):

- Console: `forcedLevel` (via `logger.setLevel`) → `get("logLevel")` → `process.env.LOG_LEVEL` → `error`
- File: `forcedFileLevel` (via `logger.setFileLevel`) → `get("logFileLevel")` → `process.env.LOG_FILE_LEVEL` → `info`

Only `LOG_LEVEL` / `LOG_FILE_LEVEL` are checked directly (no aliases); store values win over env.

## Configuration

```env
LOG_LEVEL=info            # console: debug | info | warn | error | silent (default error)
LOG_FILE_LEVEL=debug      # file:    debug | info | warn | error | silent (default info)
LOG_FILE=log              # persist to log/YYYY-MM-DD-HH.jsonl (hourly rotation, JSONL)
```

Typical split: `LOG_LEVEL=error` (quiet terminal) + `LOG_FILE_LEVEL=info` (full evidence on disk), or `LOG_LEVEL=debug` + `LOG_FILE_LEVEL=silent` to debug in-terminal without touching disk.

`LOG_FILE` is the only env name for the path (no aliases); a bare dir (`log`) or file path (`log/app.log`) both resolve to hourly files in that directory via `src/utils/logger.ts:toHourlyFile` (which emits `YYYY-MM-DD-HH.jsonl`). Store keys `logLevel`/`logFileLevel`/`logFile` override env. Directories are auto-created; write errors are silently ignored; an empty `LOG_FILE` disables persistence entirely (the console gate still applies).

## Structured fields (JSONL)

- **Field detection**: if the **last** call argument is a plain object (prototype `Object.prototype` or `null`, which naturally excludes `Error`/`Array`/`Buffer`/`Date`/class instances), it is treated as structured fields.
- **Error rendering**: an `Error` argument in `msg` (and an `Error` field value on the console channel) renders as readable single-line text `name: message [code=...] [first stack frame]` — `JSON.stringify(new Error("x"))` would only yield `{}` and silently drop the 502 cause (ECONNREFUSED / TLS verification failure). The console `msg` channel is intentionally unchanged: a raw `Error` is still passed to `console.*` as-is so native stacks stay readable. Field detection is unaffected — `Error` is still not a fields object.
- **Console** (human-readable, unchanged style): `<ISO> <LEVEL> <prefix> <msg> k=v k=v`. Values: string → `sanitizeLogText`, number/bool → `String`, else compact JSON.
- **File** (JSONL, one JSON object per line):

  ```json
  {"ts":"2026-09-20T14:03:11.201Z","level":"info","pid":1234,"prefix":"[proxy]","msg":"[forward]","client":"1.2.3.4","target":"example.com:80","method":"GET","user":"alice"}
  ```

  Merge order is `{ ...fields, ts, level, pid, prefix, msg }` — **reserved keys `ts`/`level`/`pid`/`prefix`/`msg` win**, so a same-named field is ignored. `JSON.stringify` handles control-char escaping, so one call stays exactly one line.
- **Query it** with `jq` (the whole point of JSONL):

  ```bash
  jq -r 'select(.user=="alice") | .msg, .target' log/*.jsonl
  jq -r 'select(.msg=="[auth] deny") | .client' log/*.jsonl | sort | uniq -c
  jq 'select(.level=="warn")' log/*.jsonl
  ```

- Log lines carrying a `user` field: auth `allow`, `[forward]`, socks lines, and per-request `pipe` events (the username from `AuthResult` is injected into the request's sink). ACL denials add `[ip-denied]` / `[target-denied]` (warn).

## Features

- **Direct file persist**: `fs.promises.appendFile` per call (no batching); each in-flight append is registered in a module-level set shared by all instances (including `child()`), and `await logger.flush()` waits for them all via `Promise.allSettled`. Writes are eager, but an explicit `process.exit()` truncates in-flight appends — `flush()` first (`ProxyServer.stop()`, CLI fatal paths, cluster master exits do).
- **Control-character escaping**: every string argument is sanitized by `sanitizeLogText()` on **both** channels (`\n`/`\r`/`\t` → `\\n`/`\\r`/`\\t`, other C0 + DEL → `\\xHH`). Client-controlled bytes (SOCKS domain/USERID, `Host`, `X-Forwarded-For`, credentials) therefore cannot forge extra log entries or inject terminal escape sequences — one log call is always exactly one line (structured fields are escaped by `JSON.stringify`).
- **Restrictive permissions**: the log directory is created `0o700` and hourly files `0o600` (independent of umask) — the log carries `[auth]` audit lines and forwarding targets.
- **Never throws**: `logger.*` is guaranteed not to throw at the call site. `plain()` serializes each non-string arg with a guarded `JSON.stringify` — a cycle/BigInt that makes it throw falls back to `String(a)`, and a `function`/`Symbol`/`undefined` (where `JSON.stringify` returns `undefined` without throwing) also falls back to `String(a)`. `persist()` wraps its whole body in `try/catch` and the console channel is individually guarded, so circular objects, BigInt, Symbol, functions, or an invalid `LOG_FILE` path are logged (or dropped) without ever breaking the caller.
- **Process tags**: `[pid:12345]` single process, `[master:12345]` / `[worker:12346]` in cluster mode.
- **File output is plain text / JSON**: color stripped via `plain()` — console colors (`COLOR`) never hit disk; the file form is JSONL (see above).
- **`logger.infoSync(msg)`**: bypasses async persist, writes `stdout` synchronously (console gate still applies) — for startup/shutdown paths.
- **`logger.raw(msg)`**: no timestamp/level/prefix, not persisted — for banner output (`src/utils/banner.ts`).
- **`logger.file(level, ...)`**: file channel only — persists at the given level regardless of `fileLevel`, never touches the console (disk mirror of `raw()`); its in-flight write is covered by `flush()`.
- **`logger.both(level, ...)`**: both channels with level gates ignored — console gets the normal `<ISO> <LEVEL> <prefix> <msg> k=v` rendering, the file gets the exact same JSONL pipeline as `info`/`warn` (identical schema, reserved keys, sanitization, hourly rotation); in-flight write covered by `flush()`.
- **`logger.notice(level, ...)`**: lifecycle/config notification — console bypasses the level threshold (hard-muted by `silent`), file honors `fileLevel`; used for the startup summary, cluster lifecycle lines, and ACL/users hot-reload notices.
- **`logger.setLevel("debug")` / `logger.setFileLevel("debug")` / `logger.setFile("logs")`**: runtime overrides (console level / file level / file path) without touching the global store; `child()` inherits both forced levels.
- **Color**: auto-enabled only when `process.stdout.isTTY`; set `color: false` to force plain.

## Best Practices

- Use `getLogger("[Module]")`, never bare `console.log`.
- Rely on `sanitizeLogText()` for wire data: pass the raw value (it is escaped for you) instead of pre-formatting multi-line strings; if a whole object dump is needed, JSON is preferred (already escaped).
- Pass **query dimensions as structured fields**, not baked into `msg`: keep `msg` as the stable `[event-code]`/text and put `client`/`target`/`user`/`method` in the trailing object so `jq` can select on them.
- Structured events first: `src/server/log/events-log.ts` — same semantics share one stable `[event-code]` (`target-unresolved` / `loop-detected` / `upstream-refused` / `bad-request` / `client-timeout` / `upstream-timeout` / `ip-denied` / `target-denied`); add a new event there instead of hand-writing `log.warn("...")`.
- Expensive args: prefer `logger.debug(() => JSON.stringify(huge))` only if level check is done inside `debug()` — currently `debug()` already guards via `enabled()`, so lazy form is optional but safe.
- Flush before an explicit exit: a normal event-loop drain already completes pending appends, but `process.exit()` does not — `await logger.flush()` drains the shared in-flight set; force-exit paths (second signal, shutdown grace timeout) deliberately skip it.

## Code References

- Logger class: `src/utils/logger.ts:Logger`
- Hourly file naming: `src/utils/logger.ts:toHourlyFile` (→ `YYYY-MM-DD-HH.jsonl`)
- Structured events: `src/server/log/events-log.ts` (`EventLog` minimal interface — `Logger` fits structurally)
- Global singleton: `src/utils/logger.ts:logger`
- Factory: `src/utils/logger.ts:getLogger`
- Enforced in: all `src/` modules (ESLint `no-console` allowlist: `src/utils/logger.ts` only)
