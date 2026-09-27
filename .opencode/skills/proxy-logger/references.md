# 代码索引（file:line）

> **按需分册**：skill 只自动加载 `SKILL.md`（读它的 frontmatter 决定要不要用），同目录的 `*.md` 分册**不会**被自动灌进上下文。
> **什么时候读**：只想知道「这个概念落在哪个文件哪一行」时查这一份，不要通读

## Code References

- Minimal port: `src/utils/logger/port.ts:Logger`; full implementation: `src/utils/logger/impl.ts:LoggerImpl`; shared text layer: `src/utils/logger/sanitize.ts`; private disk layer: `src/utils/logger/jsonl.ts`. Cross-directory imports go through the barrel `@/utils/logger/index.js`.
- **Construct with `new LoggerImpl({...})`, annotate with `Logger`** — there is no value named `Logger` to construct (see File Location).
- Public factories: `createLogger({ config, level, fileLevel, file, prefix, color })`, `createNoopLogger()`, `createConsoleLogger({ level })`.
- Hourly file naming: `src/utils/logger/jsonl.ts:toHourlyFile` (→ `YYYY-MM-DD-HH.jsonl`); same file owns `persistLine` and `flushPendingWrites`, and is intentionally absent from the barrel.
- Structured event rendering: `src/core/log-events.ts` (`EventLog` accepts the minimal `Logger` shape; it also re-exports the `Logger` type for event modules). It lives in `core`, not in the logger directory, so the dependency reads `core/log-events → utils/logger` and never backwards.
- JSON hot-load rendering: `src/config/files/event-log.ts:createJsonFileEventHandler(logger)` / `logJsonFileEvent(event, logger)`; no hidden logger dependency. Runtime stop/restart only removes and re-establishes its own file event subscriptions; an external `EventHub` and host subscriptions remain untouched.
- CLI composition: `src/cli.ts` creates `createLogger({ config: context.accessor })`; `ProxyServer` and cluster functions receive and pass that instance; `ProxyServer` creates an equivalent bound logger itself only when one is not injected.
- Runtime/core injection: `createProxyRuntime({ logger })` defaults to noop and packs the chosen logger into `ProxyOptions.ctx` (`CoreContext = { config, logger, events }`); `BaseProxy` reads it back through its `this.log` getter and does **no** defaulting of its own.
- Banner: `src/server/banner.ts:printBanner(logger, noColor?)` takes the logger and color policy explicitly, then calls `logger.raw(...)`. (It is under `server/`, not `utils/` — it is process-level composition.)
- No module-level `logger`, `globalLogger`, or `getLogger` export remains; every consumer receives a `Logger`, `LoggerImpl`, or a `create*` factory result explicitly.
- ESLint `no-console` allowlist is `src/utils/logger/**/*.ts`.
