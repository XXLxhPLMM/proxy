---
name: proxy-config
description: Use when configuring proxy settings, environment variables, CLI arguments, or store/loader internals. Triggers on "config", "配置", "env", "environment", "settings", "环境变量", "cli", "命令行参数", "upstream", "store", "loader", "FIELDS".
---

# Proxy Configuration Skill

Use this skill when working with proxy configuration, environment variables, CLI arguments, or the table-driven loader.

## When to Use

- User edits `.env.*`, runs `pnpm start -- --port`, asks about defaults, or adds a new `AppConfig` field.
- Do NOT trigger for generic logging/auth questions — use `proxy-logger` / `proxy-auth` instead.

## Configuration Priority

1. CLI arguments (highest priority) — `--port 3000` / `--port=3000` / `PORT=3000`
2. Terminal environment variables — never overwritten by env files, so a launch-command value (`cross-env PROXY_PROTOCOL=http pnpm start`) always wins
3. Env-file values — order low→high: `.env.production` → `.env.development` → `.env.<NODE_ENV>`, later file wins (see `src/config/loader.ts:loadEnvFiles`)
4. Hardcoded defaults in `src/config/store.ts:defaults` (lowest)

> `.env` and `.env.local` are NOT loaded by `loader.ts` — only the 3 candidates above.

## Loader Design (table-driven)

`src/config/loader.ts` describes every field exactly once in `FIELDS: FieldDef[]`:

```typescript
field({ key: "port", env: "PORT", parse: parseNum, int: { min: 1, max: 65535 }, phase: "startup" }),
field({ key: "logLevel", env: "LOG_LEVEL", parse: parseEnum([...]), phase: "runtime" }),
field({ key: "logFile", env: "LOG_FILE", parse: parseStr, def: (dir) => path.join(dir, "log"), phase: "runtime" }),
```

- `env`: the single name shared by CLI (`--port` → `PORT`) and env lookup.
- `parse`: returns `undefined` for invalid values, which always aborts startup — an explicitly supplied CLI **or** env value is never silently discarded. Booleans are strict too, so `AUTH_ENABLED=treu` errors instead of quietly becoming `false`.
- `phase` (required): `startup` means the value is read once by `ProxyServer.start()` into `ProxyOptions` (`proxyProtocol`/`host`/`port`/`tls*`/`clusterWorkers`) and changing it needs a restart; `runtime` means it is re-read per request or per log call and can be hot-changed via `set()`. `logConfig()` logs the startup list at startup and `keysByPhase()` exposes it.
- `int`: `{ min, max }` integer bounds, checked right after the table loop (out-of-range aborts startup).
- `def`: fallback or ` (configDir) => path.join(dir, ...)` for path fields (`~/.proxy` when `useHomeConfig` else `cwd`).
- CLI parsing, env merge, `config.set` writes, and returned snapshot all derive from this table — never duplicate logic.

## Environment Variable Names

One name per field — there is no alias table. The `env` of every field lives in `src/config/loader.ts:FIELDS`. A removed or unknown name simply is not matched (CLI keys normalise the same way, so `--proxy-type` no longer resolves).

Protocol enum (both `proxyProtocol` and `upstreamProtocol`): `http | https | socks4 | socks5 | sockss4 | sockss5` (see `src/config/store.ts:ProxyProtocol`).

## CLI Arguments

```bash
pnpm start -- --port 3000              # --key value
pnpm start -- --proxy-protocol=socks5  # --key=value
pnpm start -- PORT=3000                # KEY=VALUE form
pnpm start -- --auth-enabled           # bare flag → "true"
```

## Common Configurations

### Basic HTTP Proxy

```env
PORT=3000
PROXY_PROTOCOL=http
AUTH_ENABLED=false
```

### Authenticated Proxy

```env
PORT=3000
AUTH_ENABLED=true
AUTH_TYPE=basic
AUTH_USERNAME=admin
AUTH_PASSWORD=secret
```

### TLS Proxy

```env
PORT=3443
PROXY_PROTOCOL=https
TLS_KEY=./keys/server.key
TLS_CERT=./keys/server.crt
TLS_CA=./keys/ca.crt
```

### Cluster Mode

```env
CLUSTER_WORKERS=4
```

## Upstream URL (UPSTREAM_URL)

Standard endpoint form, overrides granular `UPSTREAM_*` fields when set:

```env
UPSTREAM_URL=https://user:pass@proxy.example.com:8443
UPSTREAM_URL=socks5://proxy.example.com
UPSTREAM_URL=sockss5://proxy.example.com:1080
```

- Scheme whitelist: `http` / `https` / `socks4` / `socks5` / `sockss4` / `sockss5` (case-insensitive; validated by `src/utils/upstream-url.ts:parseUpstreamUrl`)
- Default port by scheme: `http:80` / `https:443` / `socks4, socks5:1080` / `sockss4, sockss5:443`
- Validation (strict — blocks startup): bad scheme, empty host, any path/query/hash, port 1-65535 outside range
- Derived fields: `upstreamProtocol/Secure/Host/Port/Username/Password` via `applyUpstreamUrl`; `UPSTREAM_CA` / `UPSTREAM_INSECURE` stay independent
- Snapshot logging masks userinfo (`//***@`)

## Config Store

Singleton Map at `src/config/store.ts`. Access via:

```typescript
import { get, set, has } from "./config/store.js";
const port = get("port");
```

`initConfig()` is auto-run at import of `src/config/loader.ts`; in tests mock or call `initConfig()` explicitly.

## Adding New Config

1. Add field to `AppConfig` + `defaults` in `src/config/store.ts`
2. Add ONE row to `FIELDS` in `src/config/loader.ts` — `{ key, env, parse, phase }` are required; add `int: { min, max }` for bounded integers
3. Update the `AGENTS.md` env-key table if user-facing
