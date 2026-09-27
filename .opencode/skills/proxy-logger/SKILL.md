---
name: proxy-logger
description: Use when adding or tuning logging, log levels, file persistence, structured log fields, or structured events. Triggers on "logger", "log", "日志", "logging", "debug", "console", "logLevel", "logFileLevel", "LOG_FILE_LEVEL", "logFile", "log-events", "events-log", "jsonl".
---

# Proxy Logger Skill

Use this skill when adding log output, changing log levels, or working with structured events.

> **本文件是路由表：日志怎么配、字段长什么样。** 分册不会被自动加载：命中下面路由表哪一行，再读那**一个**分册。

## 分册索引（按需加载，**不要预先全读**）

| 分册 | 什么时候读它 |
|---|---|
| [`fields.md`](./fields.md) | 要写日志解析器、按字段过滤 JSONL、或查某个事件码落盘后有哪些字段时 |
| [`practices.md`](./practices.md) | 调日志性能、决定该打哪一级、或想看完整能力清单时 |
| [`library.md`](./library.md) | 在库代码里注入 `Logger`（或用 `createNoopLogger()` 静音）、不想让库擅自选默认 logger 时 |
| [`references.md`](./references.md) | 只想知道「这个概念落在哪个文件哪一行」时查这一份，不要通读 |

## When to Use

- User asks to add `logger.*` calls, change `LOG_LEVEL`/`LOG_FILE`, or define a new `[event-code]`.
- Do NOT trigger for general config — use `proxy-config` for env file mechanics.

## File Location

The logger lives in the **directory** `src/utils/logger/`. Cross-directory code imports `@/utils/logger/index.js` only — never a deep path like `@/utils/logger/impl.js` (`src/utils/logger/AGENTS.md` is that directory's contract + router):

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

**The `Logger` port is type-only — there is no value named `Logger`**: the barrel exports no such binding (this project has no compat layer; do not add an alias). **Type** position uses the minimal `Logger` port; **value** position must spell `LoggerImpl`:

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
