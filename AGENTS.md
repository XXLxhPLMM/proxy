# AGENTS.md

## Package manager (mandatory)
- Only `pnpm` (`pnpm@11.24`, Node `>=22.6`). Lockfile `pnpm-lock.yaml`; `package-lock.json`/`yarn.lock` must not exist (ignored via `.gitignore`).
- Use `pnpm install [--frozen-lockfile]` / `pnpm add -D <pkg>` / `pnpm remove`. After `package.json` edits run `pnpm install` to update lockfile.
- Rule source: `.opencode/rules/development-rules.md`, `packageManager` field.

## Commands
```
pnpm build              # node build.mjs: esbuild bundle src/index.ts -> dist/app.js (cjs, node22) + copy .env.example/README/package.json/.env.* to dist
pnpm start              # node --env-file-if-exists=.env --env-file-if-exists=.env.local dist/app.js
pnpm start:dev          # same + .env.development
pnpm start:prod         # same + .env.production
pnpm dev                # build && start:dev
pnpm dev:http|dev:socks|dev:tls  # cross-env PROXY_PROTOCOL=... pnpm start:dev
pnpm lint               # eslint ./src --ext .ts (no-console enforced except src/utils/logger.ts)
pnpm typecheck          # tsc --noEmit (type-check only, no output)
pnpm build:pkg          # pkg -> node22-win/linux/darwin (targets in package.json#pkg)
```

## Initialization flow (critical reading order)

The startup sequence is **not obvious** from filenames — module load order matters:

1. **`src/index.ts`** imports `src/config/loader.js` as **side-effect** — this triggers `initConfig()` immediately at module load (line 226 of loader.ts: `initConfig()` runs at file scope).
2. **`src/config/store.ts`** loads first (imported by loader.ts): singleton `Map<ConfigKey, AppConfig[ConfigKey]>` populated with `defaults` object. All `get()`/`set()`/`getAll()`/`has()` operate on this Map.
3. **`src/config/loader.ts:initConfig()`** (idempotent via `_inited` flag):
   - `loadEnvFiles()`: reads `.env.<NODE_ENV>` → `.env.development` → `.env.production` (deduped by `seen` Set), parses with `dotenv.parse`, **overwrites** `process.env` (env files beat terminal env).
   - `parseStartupArgs()`: parses `process.argv.slice(2)` into `Partial<AppConfig>`, normalizing `--key value` / `--key=value` / `KEY=VALUE` forms.
   - Per-field merge: `cli.x ?? envPick(aliases) ?? default`. The `??` chain means CLI wins if present and valid; invalid CLI values are silently ignored (drop to env/default).
   - Zod schema validation on enums/ranges (`port`, `cacheType`, `proxyProtocol`, `authType`, `logLevel`, `upstreamTimeout`, `proxyMode`, `upstreamPort`, `clusterWorkers`). Failure → throws, blocks startup.
   - Writes all fields to the config Map (store.ts singleton).
4. **`src/index.ts`** checks `require.main === module` → calls `runServer()`.
5. **`src/server/index.ts:runServer()`**:
   - If `clusterWorkers > 1` and not a worker → `runAsMaster()` (fork N workers via `src/server/cluster.ts`).
   - Otherwise → `new ProxyServer().start()`.
6. **`ProxyServer.start()`**: `setupProcessGuards()` → log config snapshot (passwords masked) → `createProxy()` factory (`get("proxyProtocol")` → HttpProxy/HttpsProxy/SocksProxy/TlsProxy) → `proxy.start()` → log running state.
7. **`createProxy()`** in `src/server/index.ts`: reads `get("proxyProtocol")`, constructs protocol-specific proxy with shared `baseOpts` (`port`, `auth`, `upstreamTimeout`, `tls`). Auth created via `createAuthFromConfig()` (reads store directly).

**Key implication for agents**: Any code that runs after `src/index.ts` import can safely call `get()` — config is already fully resolved. But if importing `store.ts` directly in isolation (e.g., unit test), `loader.ts` side-effect hasn't fired; you must call `initConfig()` explicitly or mock it.

## Config loading priority & aliases
- **Priority**: CLI args > env file values (overwritten into `process.env`) > terminal env > hardcoded defaults.
- **Store**: `src/config/store.ts:config` singleton Map. All keys typed via `ConfigKey = keyof AppConfig`.
- **Env aliases** (loader.ts handles all, first-match wins):
  - `PROXY_PROTOCOL`: `PROXY_TYPE`, `PROXY_SERVICE_TYPE`
  - `AUTH_ENABLED`: `APP_USE_AUTH`, `USE_AUTH`, `AUTH_SWITCH`
  - `JWT_SECRET`: `PROXY_SECRET`, `JWT_KEY`, `JWTSECRET`
  - `LOG_LEVEL`: `LOGLEVEL`
  - `LOG_FILE`: `LOGFILE`, `LOG_PATH`
  - `AUTH_LOGGING`: `AUTH_LOG`, `LOG_AUTH`
  - `CACHE_TYPE`: `CACHETYPE`
  - `UPSTREAM_TIMEOUT`: `PROXY_TIMEOUT`, `TIMEOUT`
  - `TLS_KEY`: `TLS_KEY_PATH`, `SSL_KEY`; `TLS_CERT`: `TLS_CERT_PATH`, `SSL_CERT`; `TLS_CA`: `TLS_CA_PATH`, `SSL_CA`
  - `TLS_PASSPHRASE`: `TLS_KEY_PASS`, `SSL_PASSPHRASE`, `PASSPHRASE`
  - Upstream host/port: `REMOTE_HOST`/`PROXY_TARGET_HOST`/`TARGET_HOST`, etc.
  - `PROXY_MODE`: `MODE`, `RUN_MODE`
  - `CLUSTER_WORKERS`: `WORKERS`
- Adding new config: add field to `AppConfig` + `defaults` in store.ts, add merge+validation in loader.ts, add CLI aliases in `parseStartupArgs()`. Keep `src/core/types.ts:ProxyProtocol` and `store.ts:ProxyProtocol` in sync.

## Architecture
- **Entrypoint**: `src/index.ts` — dual role: library export (`ProxyServer`/`runServer`/config getters) and CLI entry (`require.main` → `runServer()`).
- **Config layer**: `src/config/store.ts` (singleton Map, zero IO) + `src/config/loader.ts` (env parsing, CLI parsing, zod validation, side-effect init).
- **Server layer**: `src/server/index.ts` (ProxyServer orchestrator) + `src/server/cluster.ts` (multi-worker fork) + `src/server/http.ts`/`https.ts`/`socks.ts`/`tls.ts` (protocol-specific server wrappers).
- **Core layer**: `src/core/types.ts` (ProxyProtocol, ProxyCore, ProxyOptions, ProxyStats, LifecycleState) → `src/core/base.ts` (BaseProxy: lifecycle state machine, `startListening`/`stopServer`/`authorize` helpers) → `src/core/http-server.ts` (HttpServer wrapper with request/connect/error hooks) + `src/core/http-pipe.ts` (forwardHttp/forwardTunnel, reads `proxyMode` from store for target resolution) → `src/core/auth.ts` (Auth class + TokenExtractor chain: Header > Cookie > URL).
- **Utils**: `src/utils/logger.ts` (singleton, zero-dep, reads logLevel/logFile from store), `process-guards.ts` (uncaughtException/unhandledRejection/warning → log only), `cache.ts`/`mq.ts`, `cert.ts`/`ip.ts`/`proxy-helpers.ts`, `constants.ts` (HTTP response strings, precompiled regex).
- **Build**: `build.mjs` (esbuild bundle `src/index.ts` → `dist/app.js`, CJS, node22, `@`→`src` alias, copies assets + `keys/`). `dist/` is gitignored.

## Logger & process guards
- All runtime `src/` code must use `src/utils/logger.ts` (`logger`/`getLogger(prefix)`) not `console.*` — enforced by `.eslintrc.js: no-console` with override only for `logger.ts`/`build.mjs`/`scripts/**/*.mjs`.
- Logger reads `get("logLevel")` and `get("logFile")` from store; file persist via `fs.promises.appendFile` (creates dir, hourly rotation: `log/YYYY-MM-DD-HH.log`). Async write queue with `setImmediate` batching; call `logger.flush()` before exit to prevent log loss.
- `setupProcessGuards()` in `src/utils/process-guards.ts`: traps `uncaughtException`/`unhandledRejection`/`warning` (log, don't exit). Idempotent via `globalThis.__proxyGuardsInstalled` flag. Called once by `ProxyServer.start()`.
- `EADDRINUSE` handled specially in `src/index.ts`: suggests `netstat -ano | findstr :<port>` and `pnpm start -- --port <next>`.

## Service startup (user-owned)
- Agent must **never** `node dist/app.js` / `pnpm start` / `taskkill` / `netstat` auto-start/kill the proxy. If a check needs a running proxy, prompt user: `请先执行 pnpm dev (或 pnpm start -- --port <port>) 启动`.

## Lifecycle state machine (BaseProxy)
- States: `idle` → `starting` → `running` → `stopping` → `stopped` (re-entrant to `starting`). Error at any step → `error` state.
- Template method: `start()` calls `onBeforeStart()` → `doStart()` (subclass) → `markStarted()` → `setState("running")` → `onStarted()`. `stop()` is symmetric.
- `start()`/`stop()` are idempotent: already running/stopped returns immediately.
- `server` field is `http.Server | tls.Server | net.Server | null` — subclasses manage their own server instance.

## Auth system
- `createAuthFromConfig()` reads `authEnabled/authType/authUsername/authPassword/jwtSecret` from store (no dynamic import).
- `Auth.authenticate(ctx)` is fully async; exceptions caught by `BaseProxy.authorize()` → treated as denial (returns false).
- Token extraction chain (`CompositeTokenExtractor`): `HeaderTokenExtractor` (Proxy-Authorization/Authorization) → `CookieTokenExtractor` (7 cookie key aliases) → `UrlTokenExtractor` (?token etc).
- Basic auth: precomputes `expectedB64` and `expectedPlain` at construction time for O(1) comparison.
- JWT: requires external `jwtVerify` injection (AuthOptions) — placeholder throws if not provided.
- Auth logging controlled by `get("authLogging")` / `AUTH_LOGGING` env; false → silent allow/deny.

## Gotchas
- `http.Server` `connect` event socket is `Duplex` (from `node:stream`), not `net.Socket` — type as `Duplex` everywhere (base.ts, http-pipe.ts, auth.ts).
- Empty `README.md`; `opencode.jsonc` loads `AGENTS.md` + `.opencode/rules/**/*.md`. Check `.opencode/rules/development-rules.md` before scripting.
- `pnpm lint` currently has pre-existing `quotes`/`no-empty` errors outside scope; `no-console` must stay green.
- `build.mjs` asset copy skips missing files; `.env.local`/`*.local` ignored per `.gitignore`. Windows + Node22 + esbuild@0.25 may cause STATUS_STACK_BUFFER_OVERRUN; `process.exit(0)` after non-watch build to mitigate.
- `tsconfig.json` has `module:CommonJS` but actual build is via esbuild (CJS output). Path aliases (`@/*`) configured in both tsconfig and esbuild.
- `postinstall` script (`scripts/patch-pkg-fetch.mjs`) runs after `pnpm install` — may patch pkg-fetch binaries.
- `upstreamTimeout` default is `10000` (10s); used for both HTTP request timeout and tunnel socket timeout. Cluster worker shutdown grace period = `upstreamTimeout + 5000`.
- `proxyMode` field (`server`|`client`) changes target resolution in `http-pipe.ts`: server mode reads from request URL/Host, client mode uses `upstreamHost`/`upstreamPort` config.
