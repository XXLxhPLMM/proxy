# 库 / 注入模式

> **按需分册**：skill 只自动加载 `SKILL.md`（读它的 frontmatter 决定要不要用），同目录的 `*.md` 分册**不会**被自动灌进上下文。
> **什么时候读**：在库代码里注入 `Logger`（或用 `createNoopLogger()` 静音）、不想让库擅自选默认 logger 时

## Library / injection mode

- `Logger` is the minimal replaceable logging port. Its four level methods keep the `...args: unknown[]` shape so errors, extras, and trailing plain-object fields remain compatible; `flush?()` is optional and only promises to drain persistence.
- `createNoopLogger()` is the runtime/core default: all four methods do nothing and `flush()` resolves immediately. It does not read config, create files, start timers, register process events, or write stdout/stderr.
- `createConsoleLogger({ level })` is an opt-in console implementation: the level comes only from the argument (default `error`), with no accessor/env reads, file persistence, timers, or process listeners. `debug`/`info` go to stdout, `warn`/`error` to stderr; trailing structured fields render as `k=v`. It reuses `sanitize.ts` for formatting, so an `Error` argument is collapsed to readable single-line text (unlike `LoggerImpl`, which keeps the raw `Error` for native stacks).
- `createLogger({ config: context.accessor })` is the full console+JSONL implementation for a service that wants live config-bound gates. The accessor is read on every output, so runtime changes apply without rebuilding the logger; explicit `level`/`fileLevel`/`file` options take precedence for that instance. A pure-memory runtime's `configDir` is captured and its path fields are absolutized at construction, so later `process.chdir()` does not move log/file subscriptions.
- Library callers inject `createNoopLogger()`, `createConsoleLogger()`, `createLogger(...)`, or their own `Logger` test double. They should not import the internal fixed-default helpers merely to obtain a configured logger.
- CLI/server code follows the same dependency-injection rule: `src/cli.ts` creates the bound logger and passes it via `runServer(context, { logger, noColor, assembly })` — all three go through the `RunServerOptions` object (which also carries `processPolicy` / `services` / `connectors` / `assembly`). `ProxyServer` passes the same instance into `createProxyRuntime({ context, logger })`. Nothing selects a CLI logger through module state.
- JSON file events receive the same service logger explicitly. `createProxyRuntime` builds `createJsonFileEventHandler(this.logger)` and passes the resulting callback into default auth/ACL services.
- There is no hidden fallback logger: the only `?? createNoopLogger()` in the project lives in `createProxyRuntime()`; omitting the runtime/server `logger` option creates a config-bound instance only where documented, and core has no logger field of its own to omit.
