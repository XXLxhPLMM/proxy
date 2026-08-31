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
pnpm build:pkg          # pkg -> node22-win/linux/darwin (targets in package.json#pkg)
```

## Env & config loading
- Executable truth: `package.json` scripts use `node --env-file-if-exists`; `src/config/loader.ts:loadEnvFiles` re-reads same files with `dotenv.parse` and **overwrites** `process.env` so priority is `CLI (--port/--proxy-protocol etc) > env file > terminal env > defaults`.
- Store is singleton Map `src/config/store.ts:config` (`port/cacheType/proxyProtocol/authEnabled/authType/authUsername/authPassword/jwtSecret/logLevel/logFile`), accessed via `get<K>(key)/set/getAll` — types enforce `ConfigKey`.
- Env aliases handled in loader: `PROXY_PROTOCOL` primary (`PROXY_TYPE`/`PROXY_SERVICE_TYPE`), `AUTH_ENABLED` (`APP_USE_AUTH`/`USE_AUTH`/`AUTH_SWITCH`), `JWT_SECRET` (`PROXY_SECRET`/`JWT_KEY`), `LOG_LEVEL` (`LOGLEVEL`), `LOG_FILE` (`LOGFILE`/`LOG_PATH`). Add new config there + `store.ts:ProxyProtocol`/`AppConfig`/`defaults`.
- `src/core/types.ts:ProxyProtocol` and `store.ts:ProxyProtocol` must stay in sync.

## Architecture
- Entrypoint: `src/index.ts` (`createProxy` factory on `get("proxyProtocol")` -> `HttpProxy`; `https/socks/tls` currently placeholder throws). Imports `src/config/loader.js` for side-effect init.
- Core: `src/core/types.ts` (ProxyProtocol dual semantics: client handshake + server listener), `base.ts` (normalize `port:3000`/`host:0.0.0.0`, `auth: new Auth({enabled:false})`, `markStarted/markStopped`, `authorize`), `http.ts` (`http.Server` + `connect` Duplex, `forwardHttp`/`forwardTunnel`/`resolveTargetUrl`), `auth.ts` (single `Auth implements AuthProvider` + `TokenExtractor` composite `Header > Cookie(proxy-authorization) > URL`, `createAuthFromConfig()` does direct `import {get} from "../config/store.js"` — no dynamic import).
- Utils: `src/utils/logger.ts` (singleton, zero-dep), `cache.ts`/`mq.ts`.
- Build: `tsconfig.json` `module:CommonJS` but bundle via esbuild; alias `@ -> src` (baseUrl `src`). `dist/` is gitignored, regenerated.

## Logger & process guards
- All runtime `src/` code must use `src/utils/logger.ts` (`logger`/`getLogger(prefix)`) not `console.*` — enforced by `.eslintrc.js: no-console` with override only for `logger.ts`/`build.mjs`/`scripts/**/*.mjs`.
- Logger reads `get("logLevel")` || `LOG_LEVEL` and `get("logFile")` || `LOG_FILE`; file persist via `fs.appendFileSync` (creates dir). Control via `LOG_LEVEL=debug|info|warn|error|silent` and `LOG_FILE=logs/app.log`.
- `src/index.ts:setupProcessGuards` traps `uncaughtException`/`unhandledRejection`/`warning` (log, don't exit); `run().catch` special-cases `EADDRINUSE` as `NodeJS.ErrnoException & {port?:number}` to suggest `netstat -ano | findstr :<port>`.

## Service startup (user-owned)
- Agent must **never** `node dist/app.js` / `pnpm start` / `taskkill` / `netstat` auto-start/kill the proxy. If a check needs a running proxy, prompt user: `请先执行 pnpm dev (或 pnpm start -- --port <port>) 启动`.

## Gotchas
- `http.Server` `connect` event socket is `Duplex` (from `node:stream`), not `net.Socket` — type as `Duplex`.
- Empty `README.md`; `opencode.jsonc` loads `AGENTS.md` + `.opencode/rules/**/*.md`. Check `.opencode/rules/development-rules.md` before scripting.
- `pnpm lint` currently has pre-existing `quotes`/`no-empty` errors outside scope; `no-console` must stay green.
- `build.mjs` asset copy skips missing files; `.env.local`/`*.local` ignored per `.gitignore`.
