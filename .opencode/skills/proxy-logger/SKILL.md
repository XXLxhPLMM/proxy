---
name: proxy-logger
description: Use when adding or tuning logging, log levels, file persistence, structured log fields, or structured events. Triggers on "logger", "log", "日志", "logging", "debug", "console", "logLevel", "logFileLevel", "LOG_FILE_LEVEL", "logFile", "log-events", "events-log", "jsonl".
---

# Proxy Logger Skill

Use this skill when adding log output, changing log levels, or working with structured events.

## When to Use

- User asks to add `logger.*` calls, change `LOG_LEVEL`/`LOG_FILE`, or define a new `[event-code]`.
- Do NOT trigger for general config — use `proxy-config` for env file mechanics.

## File Location

The logger lives in the **directory** `src/utils/logger/` (was the single file `src/utils/logger.ts`). Cross-directory code imports `@/utils/logger/index.js` only — never a deep path like `@/utils/logger/impl.js`:

| File            | Sole responsibility                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `port.ts`       | minimal `Logger` port + `LogFields` + re-exported `LogLevel` + level tables `ORDER` / `COLOR` (zero deps)   |
| `sanitize.ts`   | `sanitizeLogText` / `renderErrorText` / `isPlainObject` / `splitFields` / `renderFieldValue` / `renderFields` / `stringifyValue` — all text rendering, shared by `impl.ts` and `console.ts` |
| `jsonl.ts`      | persistence IO only: `toHourlyFile` / `persistLine` / `flushPendingWrites` + the module-level in-flight set. **Not exported from the barrel** — it is `impl.ts`'s private disk face |
| `impl.ts`       | `LoggerImpl` + `LoggerOptions` + `createLogger` (the CLI/service entry: console + JSONL)                    |
| `console.ts`    | `createConsoleLogger` (second `Logger` implementation: stdout/stderr, no disk)                            |
| `noop.ts`       | `createNoopLogger`                                                                                        |
| `index.ts`      | the only barrel: `export *` of port / sanitize / impl / console / noop                                     |

`LoggerOptions.config` may bind a `ConfigAccessor`; no logger reads environment variables, host argv, or module-level configuration by itself. There is no module-level logger singleton: CLI/server/core create or receive an explicit instance. ESLint `no-console` still permits direct console calls only inside `src/utils/logger/**`.

**Breaking — the `Logger` class alias is gone**: the historical trailing `export const Logger = LoggerImpl` was deleted (no compat layer). **Type** position uses the minimal `Logger` port; **value** position must spell `LoggerImpl`:

```typescript
// ✗ compile error — Logger is an interface, not a constructor
const log = new Logger({ prefix: "[x]" });
// ✓ correct
import { LoggerImpl, type Logger } from "@/utils/logger/index.js";
const log: Logger = new LoggerImpl({ prefix: "[x]" });
```

In practice most code should call `createLogger(...)` (or `createConsoleLogger` / `createNoopLogger`) and annotate with the `Logger` type.

## Quick Start

```typescript
import { ConfigStore, configAccessorFromStore, createLogger } from "@b-hole/proxy";

const store = new ConfigStore({
  logLevel: "info",
  logFileLevel: "info",
  logFile: "log",
});
const log = createLogger({ config: configAccessorFromStore(store) });

log.info("Server started on port 3000");
log.debug("Request received:", request.url);
log.warn("Slow response detected");
log.error("Connection failed:", error.message);

// Structured fields: last arg as a plain object → k=v on console, top-level keys in JSONL
log.info("[forward]", { client, target, method, user });

// Child loggers inherit the bound accessor, file path, color, and explicit level overrides.
const child = log.child("Auth"); // prefix: [proxy:Auth]
child.info("Tunnel established");
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

- Console: explicit `LoggerOptions.level` / `log.setLevel()` → bound accessor `logLevel` → fixed `error`.
- File: explicit `LoggerOptions.fileLevel` / `log.setFileLevel()` → bound accessor `logFileLevel` → fixed `info`.
- Persistence path: explicit `LoggerOptions.file` / `log.setFile()` → bound accessor `logFile` → disabled when empty.

The logger never consults env aliases or a module-level store. `LOG_LEVEL`, `LOG_FILE_LEVEL`, and `LOG_FILE` affect a logger only after a CLI/config load has placed those resolved values behind its bound `ConfigAccessor`. A plain `createLogger()` therefore has console `error`, file threshold `info`, and no persistence path.

## Configuration

```env
LOG_LEVEL=info            # console: debug | info | warn | error | silent (default error)
LOG_FILE_LEVEL=debug      # file:    debug | info | warn | error | silent (default info)
LOG_FILE=log              # persist to log/YYYY-MM-DD-HH.jsonl (hourly rotation, JSONL)
```

Typical split: `LOG_LEVEL=error` (quiet terminal) + `LOG_FILE_LEVEL=info` (full evidence on disk), or `LOG_LEVEL=debug` + `LOG_FILE_LEVEL=silent` to debug in-terminal without touching disk.

`LOG_FILE` is the only env name for the path (no aliases); a bare dir (`log`) or file path (`log/app.log`) both resolve to hourly files in that directory via `src/utils/logger/jsonl.ts:toHourlyFile` (which emits `YYYY-MM-DD-HH.jsonl`). That module is **not** re-exported by the barrel, so the naming rule is documented/implementation detail — callers only ever pass a base path. The CLI obtains these values through `loadConfig`, then binds them with `createLogger({ config: context.accessor })`. Directories are auto-created; write errors are silently ignored; an empty resolved `logFile` disables persistence entirely while the console gate still applies. For a library that never loads env files, pass `file`/`fileLevel` directly or bind a caller-owned accessor.

## Structured fields (JSONL)

- **Field detection**: if the **last** call argument is a plain object (prototype `Object.prototype` or `null`, which naturally excludes `Error`/`Array`/`Buffer`/`Date`/class instances), it is treated as structured fields.
- **Error rendering**: an `Error` argument in `msg` (and an `Error` field value on the console channel) renders as readable single-line text `name: message [code=...] [first stack frame]` — `JSON.stringify(new Error("x"))` would only yield `{}` and silently drop the 502 cause (ECONNREFUSED / TLS verification failure). The console `msg` channel is intentionally unchanged: a raw `Error` is still passed to `console.*` as-is so native stacks stay readable. Field detection is unaffected — `Error` is still not a fields object.
- **Console** (human-readable, unchanged style): `<ISO> <LEVEL> <prefix> <msg> k=v k=v`. Values: string → `sanitizeLogText`, number/bool → `String`, else compact JSON.
- **One rendering implementation, two callers**: field detection (`splitFields`), `k=v` rendering (`renderFields`) and non-field serialization (`stringifyValue`) live once in `sanitize.ts` and are shared by `LoggerImpl.fmt` and `createConsoleLogger` — the historical module-level `renderPortableFields` / `formatPortableArgs` duplicates are gone. The **one** intentional difference: `LoggerImpl.fmt` passes non-string arguments (including `Error`) through to `console.*` untouched to keep native stacks readable, while `createConsoleLogger` funnels them through `stringifyValue` (hence `renderErrorText`).
- **File** (JSONL, one JSON object per line):

  ```json
  {
    "ts": "2026-09-20T14:03:11.201Z",
    "level": "info",
    "pid": 1234,
    "prefix": "[proxy]",
    "msg": "[forward]",
    "client": "1.2.3.4",
    "target": "example.com:80",
    "method": "GET",
    "user": "alice"
  }
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

- **Direct file persist**: `fs.promises.appendFile` per call (no batching), all of it in `jsonl.ts`; each in-flight append is registered in a **module-level** set in `jsonl.ts` shared by all `LoggerImpl` instances (including children), and `await log.flush()` waits for them via `Promise.allSettled`. Writes are eager, but explicit `process.exit()` can truncate them — flush first in graceful stop/fatal/cluster paths.
- **Control-character escaping**: every string argument is sanitized by `sanitizeLogText()` (`sanitize.ts`) on **both** channels (`\n`/`\r`/`\t` → `\\n`/`\\r`/`\\t`, other C0 + DEL → `\\xHH`). Client-controlled bytes cannot forge extra log entries or inject terminal escape sequences; structured fields are additionally escaped by `JSON.stringify`.
- **Restrictive permissions**: the log directory is created `0o700` and hourly files `0o600` (independent of umask) — the log carries auth audit lines and forwarding targets.
- **Never throws**: `LoggerImpl` serializes each non-string argument with guarded `JSON.stringify`; cycles/BigInt fall back to `String(a)`, and functions/Symbols/undefined are handled without escaping the logger. `persist()` and the console channel are independently guarded, so invalid paths or pathological values are dropped without breaking the caller.
- **Process identity**: every JSONL row includes the current `pid`; cluster lifecycle/event composition may add explicit pid text. The logger does not maintain a separate master/worker singleton.
- **File output is JSONL**: console color codes never reach disk.
- **`log.infoSync(...)`**: bypasses async persistence and writes stdout synchronously; the console gate still applies.
- **`log.raw(...)`**: no timestamp/level/prefix and no persistence. `printBanner(logger, noColor?)` requires this logger-shaped capability explicitly.
- **`log.file(level, ...)`**: file channel only, regardless of `fileLevel`; it never touches the console and uses the same structured JSONL pipeline.
- **`log.both(level, ...)`**: both channels with both gates bypassed; console and file retain the same rendering/schema/sanitization rules.
- **`log.notice(level, ...)`**: lifecycle/config notification — console bypasses the level threshold (except `silent`), while file honors `fileLevel`; used for startup/cluster summaries. JSON hot-load events instead call the explicitly supplied logger’s `warn`/`info` through `createJsonFileEventHandler`. The file reader absolutizes relative paths before caching; only `ENOENT`/`ENOTDIR`/non-regular files are missing, while `EACCES` and other stat/read errors keep the last valid value and emit an error instead of silently allowing ACL traffic.
- **`log.setLevel(...)` / `log.setFileLevel(...)` / `log.setFile(...)`**: per-instance overrides; they do not mutate the bound accessor or another logger. `child()` inherits explicit overrides and the same bound accessor.
- **Color**: auto-enabled only when `process.stdout.isTTY`; set `color: false` to force plain.

## Best Practices

- Create or receive an explicit `Logger` and use it; never add bare `console.*` in `src/`. In library code prefer root exports `createNoopLogger()`, `createConsoleLogger()`, or `createLogger()`; in server composition, reuse the injected instance and derive children with `log.child("Module")`.
- Core modules do not print protocol facts directly. Emit the existing pipe/auth/server event and let the explicitly injected server logger render it. Utility code that genuinely owns diagnostics (for example certificate-load failure) receives a logger parameter.
- Rely on `sanitizeLogText()` for wire data: pass the raw value instead of pre-formatting multi-line strings; if a whole object dump is needed, JSON is preferred (already escaped).
- Pass **query dimensions as structured fields**, not baked into `msg`: keep `msg` as the stable `[event-code]`/text and put `client`/`target`/`user`/`method` in the trailing object so `jq` can select on them.
- Structured events first: `src/core/log-events.ts` — same semantics share one stable `[event-code]` (`target-unresolved` / `loop-detected` / `upstream-refused` / `upstream-error` / `upstream-timeout` / `bad-request` / `ip-denied` / `target-denied` / `tls-client-error`); add a new event there instead of hand-writing an unrelated warning. It was `src/server/log/events-log.ts`; `src/server/log/` now contains only `config-log.ts`. Event codes deliberately do **not** live in `utils/logger/` — the logger is a rendering port with no domain vocabulary.
- Do not assume a function argument is lazy: `log.debug(() => huge)` does not invoke it. Guard expensive construction with `logLevel` yourself, precompute a bounded summary, or omit it.
- Flush before an explicit exit: a normal event-loop drain completes pending appends, but `process.exit()` can truncate them; `await log.flush()` drains the shared in-flight set. Force-exit paths deliberately skip the wait.

## Code References

- Minimal port: `src/utils/logger/port.ts:Logger`; full implementation: `src/utils/logger/impl.ts:LoggerImpl`; shared text layer: `src/utils/logger/sanitize.ts`; private disk layer: `src/utils/logger/jsonl.ts`. Cross-directory imports go through the barrel `@/utils/logger/index.js`.
- **Construct with `new LoggerImpl({...})`, annotate with `Logger`** — the `Logger` class-constructor alias no longer exists (see File Location).
- Public factories: `createLogger({ config, level, fileLevel, file, prefix, color })`, `createNoopLogger()`, `createConsoleLogger({ level })`.
- Hourly file naming: `src/utils/logger/jsonl.ts:toHourlyFile` (→ `YYYY-MM-DD-HH.jsonl`); same file owns `persistLine` and `flushPendingWrites`, and is intentionally absent from the barrel.
- Structured event rendering: `src/core/log-events.ts` (`EventLog` accepts the minimal `Logger` shape; it also re-exports the `Logger` type for event modules). It lives in `core`, not in the logger directory, so the dependency reads `core/log-events → utils/logger` and never backwards.
- JSON hot-load rendering: `src/config/files/event-log.ts:createJsonFileEventHandler(logger)` / `logJsonFileEvent(event, logger)`; no hidden logger dependency. Runtime stop/restart only removes and re-establishes its own file event subscriptions; an external `EventHub` and host subscriptions remain untouched.
- CLI composition: `src/cli.ts` creates `createLogger({ config: context.accessor })`; `ProxyServer` and cluster functions receive and pass that instance; `ProxyServer` creates an equivalent bound logger itself only when one is not injected.
- Runtime/core injection: `createProxyRuntime({ logger })` defaults to noop and passes the chosen logger into `ProxyOptions`; `BaseProxy` also defaults a missing `ProxyOptions.logger` to noop.
- Banner: `src/server/banner.ts:printBanner(logger, noColor?)` takes the logger and color policy explicitly, then calls `logger.raw(...)`. (It is under `server/`, not `utils/` — it is process-level composition.)
- No module-level `logger`, `globalLogger`, or `getLogger` export remains; every consumer receives a `Logger`, `LoggerImpl`, or a `create*` factory result explicitly.
- ESLint `no-console` allowlist is `src/utils/logger/**/*.ts`.

## Library / injection mode

- `Logger` is the minimal replaceable logging port. Its four level methods keep the `...args: unknown[]` shape so errors, extras, and trailing plain-object fields remain compatible; `flush?()` is optional and only promises to drain persistence.
- `createNoopLogger()` is the runtime/core default: all four methods do nothing and `flush()` resolves immediately. It does not read config, create files, start timers, register process events, or write stdout/stderr.
- `createConsoleLogger({ level })` is an opt-in console implementation: the level comes only from the argument (default `error`), with no accessor/env reads, file persistence, timers, or process listeners. `debug`/`info` go to stdout, `warn`/`error` to stderr; trailing structured fields render as `k=v`. It reuses `sanitize.ts` for formatting, so an `Error` argument is collapsed to readable single-line text (unlike `LoggerImpl`, which keeps the raw `Error` for native stacks).
- `createLogger({ config: context.accessor })` is the full console+JSONL implementation for a service that wants live config-bound gates. The accessor is read on every output, so runtime changes apply without rebuilding the logger; explicit `level`/`fileLevel`/`file` options take precedence for that instance. A pure-memory runtime's `configDir` is captured and its path fields are absolutized at construction, so later `process.chdir()` does not move log/file subscriptions.
- Library callers inject `createNoopLogger()`, `createConsoleLogger()`, `createLogger(...)`, or their own `Logger` test double. They should not import the internal fixed-default helpers merely to obtain a configured logger.
- CLI/server code follows the same dependency-injection rule: `src/cli.ts` creates the bound logger, passes it to `runServer(context, logger, noColor)`, and `ProxyServer` passes the same instance into `createProxyRuntime({ context, logger })`. Nothing selects a CLI logger through module state.
- JSON file events receive the same service logger explicitly. `createProxyRuntime` builds `createJsonFileEventHandler(this.logger)` and passes the resulting callback into default auth/ACL services.
- There is no hidden fallback logger: omitting `ProxyOptions.logger` produces noop, while omitting the runtime/server `logger` option creates a config-bound instance only where documented.
