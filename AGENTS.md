# AGENTS.md

## Package manager (mandatory)

- Only `pnpm` (`pnpm@11.24`, Node `>=22.6`). Lockfile `pnpm-lock.yaml`; `package-lock.json`/`yarn.lock` must not exist.
- Use `pnpm install [--frozen-lockfile]` / `pnpm add -D <pkg>` / `pnpm remove`. After `package.json` edits run `pnpm install`.

## Commands

```
pnpm build              # esbuild src/index.ts -> dist/app.js (cjs, node22) + copy assets/keys
pnpm build:dev          # same, dev mode (no minify, sourcemap)
pnpm build:watch        # fs.watch src/ -> one-shot node build.mjs per change (see Gotchas)
pnpm build:lib          # tsc + tsc-alias -> lib/ (declarations)
pnpm build:all          # build + build:lib
pnpm build:pkg          # pkg -> node22-win/linux/darwin
pnpm start              # node dist/app.js (reads .env via --env-file-if-exists)
pnpm start:dev          # + .env.development
pnpm start:prod         # + .env.production
pnpm dev                # build:dev && start:dev
pnpm dev:watch          # scripts/dev-server.mjs watches dist/ + .env*, auto-restarts
pnpm dev:hot            # concurrently: build:watch + dev-server.mjs
pnpm lint               # eslint ./src ./tests --ext .ts (no-console except logger.ts)
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run
pnpm test:watch         # vitest watch
pnpm test:coverage      # vitest run --coverage
pnpm test:server -- --port 4000 --size 1MB  # local throughput origin (tests/perf, no build, cluster via --workers)
pnpm test:server:{2k,400k,rand}  # presets: fixed 2KB / fixed 400KB / random 2KB~400KB on :4000
pnpm test:pressure -- --concurrency 1000 --size 200B  # socks4 burst pressurer (tests/perf, peakConn + p50/p99, no build)
pnpm test:pressure:ka  # keep-alive preset: 100 tunnels x 50 reqs (browser-like); override trailing args win
```

## Initialization flow

1. `src/index.ts` side-imports `src/config/loader.js` → `initConfig()` at module load.
2. `src/config/store.ts` singleton `Map<ConfigKey, AppConfig[ConfigKey]>` seeded from `defaults`.
3. `src/config/loader.ts:initConfig()` (idempotent, table-driven via `FIELDS: FieldDef[]`):
   - `useHomeConfig` resolved first (CLI > env) to pick config dir (`~/.proxy` vs `cwd`).
   - `loadEnvFiles()`: low→high `.env.production` → `.env.development` → `.env.<NODE_ENV>` (dedup keeps last), `dotenv.parse` then **overwrites** `process.env`.
   - `parseRawArgv()` normalizes `--key value` / `--key=value` / `KEY=VALUE`; invalid CLI silently dropped, `strict: true` enums throw on invalid env.
   - Zod validates ranges (`port`/`upstreamPort` 1-65535, `upstreamTimeout` >0, `clusterWorkers` 0-1024).
   - Writes to store Map, returns `getAll()`.
4. `src/index.ts` `require.main === module` → `runServer()`.
5. `src/server/index.ts:runServer()` → cluster fork if `clusterWorkers>1` else `new ProxyServer().start()`.
6. `ProxyServer.start()` → `setupProcessGuards()` → log masked config → `createProxy()` (by `proxyProtocol`) → `proxy.start()`.

Any code after `src/index.ts` import can call `get()` safely; isolated `store.ts` imports must call `initConfig()` explicitly.

## Config loading priority & aliases

- **Priority**: CLI args > env-file values > terminal env > defaults.
- **Store**: `src/config/store.ts:config` singleton, typed via `ConfigKey = keyof AppConfig`.
- **Primary env keys** (use these; legacy aliases are still parsed by `loader.ts:FIELDS` but not documented — prefer primary):

| Primary Key         | Description |
| ------------------- | ----------- |
| `HOST`              | listen IP, default `0.0.0.0` |
| `PORT`              | listen port |
| `PROXY_PROTOCOL`    | `http`\|`https`\|`socks4`\|`socks5`\|`sockss4`\|`sockss5` |
| `PROXY_MODE`        | `server`\|`client` |
| `AUTH_ENABLED`      | `true`/`false` |
| `AUTH_TYPE`         | `none`\|`basic`\|`jwt` |
| `AUTH_USERNAME` / `AUTH_PASSWORD` / `JWT_SECRET` | credentials |
| `AUTH_LOGGING`      | `true`/`false` |
| `LOG_LEVEL`         | `debug`\|`info`\|`warn`\|`error`\|`silent` |
| `LOG_FILE`          | dir or file path → hourly `YYYY-MM-DD-HH.log` |
| `CACHE_TYPE`        | `memory`\|`redis` |
| `UPSTREAM_TIMEOUT`  | ms, default 10000 |
| `TLS_KEY` / `TLS_CERT` / `TLS_CA` / `TLS_PASSPHRASE` | TLS paths |
| `UPSTREAM_URL`      | `scheme://[user:pass@]host[:port]` — overrides granular upstream fields |
| `UPSTREAM_HOST` / `UPSTREAM_PORT` / `UPSTREAM_SECURE` / `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD` / `UPSTREAM_CA` / `UPSTREAM_INSECURE` / `UPSTREAM_PROTOCOL` | granular upstream |
| `CLUSTER_WORKERS`   | 0 (=CPU cores) .. 1024 |
| `USE_HOME_CONFIG`   | `true` → `~/.proxy/` |

Full alias list is the single source of truth in `src/config/loader.ts:FIELDS` — do not duplicate a second table elsewhere.

- Adding new config: add field to `AppConfig` + `defaults` in `store.ts`, then ONE row to `FIELDS` in `loader.ts` (`{ key, aliases, parse, strict?, def }`). Keep `src/core/types/proxy.ts:ProxyProtocol` and `store.ts:ProxyProtocol` in sync.

## Architecture

- **Entrypoint**: `src/index.ts` (library exports + CLI `runServer()`).
- **Config**: `store.ts` (Map, zero IO) + `loader.ts` (table-driven, side-effect init).
- **Server**: `src/server/index.ts` (ProxyServer, central log via proxy events) + `cluster.ts` (fork) + `http.ts`/`https.ts`/`socks.ts`/`tls.ts` (protocol wrappers) + `server/log/` (structured `[event-code]` + masked config snapshot).
- **Core**: `core/types/` (ProxyProtocol, ProxyEventMap, Auth types) → `core/server/base.ts` (BaseProxy lifecycle + `authorize`) + `core/server/transport.ts`/`http.ts`/`https.ts` (HttpTransport) + `core/forward/` (http/tunnel/websocket/shared + `connectors/` net/tls + `upstream/` http/https + `tunnel/` direct/http/https/tls) + `core/auth.ts` + `core/proxy-helpers.ts`.
- **Utils**: `logger.ts` / `process-guards.ts` / `cert.ts` / `ip.ts` / `constants.ts` / `upstream-url.ts`.
- **Tests**: `tests/setup.ts` (clears vite `MODE`) + `tests/unit/` + `tests/integration/http-proxy*.test.ts` (real HttpProxy on free ports; set `host`/`port`/`proxyMode` in store before `new HttpProxy()`). `tests/manual/proxy-node-test-*.mjs` (bare-socket clients) + `tests/perf/` (`http-test-server.mjs` local throughput origin on `:4000` via `pnpm test:server:{2k,400k,rand}` + `socks4-pressure.mjs` burst pressurer via `pnpm test:pressure`, no build). `vitest.config.ts` (`@`→`src`, `pool:forks`).
- **Build**: `build.mjs` (esbuild bundle + `gen-banner.mjs` + asset copy). `dist/`/`lib/` gitignored.

## Logger & process guards

- All `src/` code must use `src/utils/logger.ts` (`logger`/`getLogger(prefix)`) not `console.*` (ESLint `no-console`).
- Logger reads `get("logLevel")`/`get("logFile")`; file persist via `fs.promises.appendFile` (creates dir, hourly rotation). Direct writes, no queue; `logger.flush()` is currently no-op.
- `setupProcessGuards()` traps `uncaughtException`/`unhandledRejection`/`warning` (log only, don't exit). Called once by `ProxyServer.start()`.
- `EADDRINUSE` in `src/index.ts` suggests `pnpm start -- --port <next>`.

## Service startup (user-owned)

- Agent must **never** `node dist/app.js` / `pnpm start` / `taskkill` auto-start/kill. Prompt user: `请先执行 pnpm dev (或 pnpm start -- --port <port>) 启动`.

## Lifecycle state machine (BaseProxy)

- States: `idle` → `starting` → `running` → `stopping` → `stopped` (re-entrant to `starting`), error → `error`.
- `start()`/`stop()` are idempotent and template-method driven (`onBeforeStart` → `doStart` → `markStarted`).

## Auth system

- `createAuthFromConfig()` reads store (`authEnabled/authType/authUsername/authPassword/jwtSecret`).
- `Auth.authenticate(ctx)` async; exceptions → deny via `BaseProxy.authorize()`.
- Token: `Proxy-Authorization` preferred, `Authorization` fallback (RFC 7235); Basic precomputes `expectedB64` for O(1).
- JWT requires `jwtVerify` injection or throws.
- `Auth` zero-log; audit via `AuthContext.onAuthEvent` → proxy `auth` event → `ProxyServer` logs `[auth]`.

## Gotchas

- `http.Server` `connect` socket is `Duplex` (not `net.Socket`) — type as `Duplex` everywhere.
- Windows + Node22 + esbuild: `STATUS_STACK_BUFFER_OVERRUN (3221226505)` on exit even after artifacts written; `build:watch` uses one-shot child + `dist/app.js` mtime check, never loads esbuild in watcher. `node --watch` has same crash — use `scripts/dev-server.mjs`.
- `tsconfig.json` `module:CommonJS` but build is esbuild CJS; `@/*` alias in both. `skipLibCheck:true` required.
- `proxyMode` aliases `MODE`/`RUN_MODE` collide with vite (`MODE=test|development|production`): `tests/setup.ts` clears them before loader init.
- `upstreamTimeout` default `10000` (also cluster shutdown grace = `upstreamTimeout + 5000`).
- `proxyMode` `server` vs `client` switches `resolveHttpTarget` (server reads URL/Host, client uses `upstreamHost`/`upstreamPort`).

## 项目阶段（破坏性变更政策）

- 当前设计/开发阶段未投入使用：允许破坏性变更（删/重命名/改签名），无需兼容旧 API/配置；改动只需同步 `AGENTS.md` 与测试。

## Agent workflow

- 完整功能后跑一次 `pnpm build` 验证；`dev:watch` 只监听 `dist/` 重启，不触发构建。
- 服务由用户手动启动，Agent 只改代码 + `pnpm build`。

## AGENTS.md 同步规则

当涉及以下变更时，必须同步更新本文件：

- 项目结构变化：新增/删除/移动 `src/` 或 `scripts/` 下模块
- 文件内容大改：函数签名、类结构、关键逻辑
- 新增配置项：`AppConfig`/`defaults` 新增字段
- 新增命令：`package.json` scripts 新增

## Skill 同步规则

当修改以下文件时，必须同步更新对应 skill（`.opencode/skills/*/SKILL.md`）：

- `src/core/auth.ts` → `proxy-auth`
- `src/config/store.ts` / `src/config/loader.ts` → `proxy-config`
- `src/utils/constants.ts` → `proxy-constants`
- `src/utils/logger.ts` → `proxy-logger`
