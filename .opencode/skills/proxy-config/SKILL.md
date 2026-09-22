---
name: proxy-config
description: Use when configuring proxy settings, environment variables, CLI arguments, or store/loader internals. Triggers on "config", "配置", "env", "environment", "settings", "环境变量", "cli", "命令行参数", "upstream", "store", "loader", "FIELDS", "users.json", "acl.json".
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
field({ key: "logLevel", env: "LOG_LEVEL", parse: parseEnum(LOG_LEVELS), phase: "runtime" }),
field({ key: "logFileLevel", env: "LOG_FILE_LEVEL", parse: parseEnum(LOG_LEVELS), phase: "runtime" }),
field({ key: "logFile", env: "LOG_FILE", parse: parseStr, def: (dir) => path.join(dir, "log"), phase: "runtime" }),
field({ key: "authUsersFile", env: "AUTH_USERS_FILE", parse: parseStr, def: (dir) => path.join(dir, "cfg/users.json"), phase: "runtime" }),
field({ key: "aclFile", env: "ACL_FILE", parse: parseStr, def: (dir) => path.join(dir, "cfg/acl.json"), phase: "runtime" }),
```

- `env`: the single name shared by CLI (`--port` → `PORT`) and env lookup.
- `parse`: returns `undefined` for invalid values, which always aborts startup — an explicitly supplied CLI **or** env value is never silently discarded. Booleans are strict too, so `AUTH_ENABLED=treu` errors instead of quietly becoming `false`.
- `phase` (required): `startup` means the value is read once by `ProxyServer.start()` into `ProxyOptions` (`proxyProtocol`/`host`/`port`/`tls*`/`clusterWorkers`) and changing it needs a restart; `runtime` means it is re-read per request or per log call and can be hot-changed via `set()`. `logConfig()` logs the startup list at startup and `keysByPhase()` exposes it. `useHomeConfig` is `startup` too — it only picks the config dir (env-file directory and path defaults) during init, so runtime changes are meaningless.
- `int`: `{ min, max }` integer bounds, checked by `collectIntRangeErrors()` right after the table loop (out-of-range aborts startup). `parseStartupArgs()` reuses the **same** helper, so `--port 70000` / `PORT=0` also throw `越界` before any store write.
- `def`: fallback or ` (configDir) => path.join(dir, ...)` for path fields (`~/.proxy` when `useHomeConfig` else `cwd`). `authUsersFile` / `aclFile` use this to default into the config dir.
- CLI parsing, env merge, `config.set` writes, and returned snapshot all derive from this table — never duplicate logic.
- The per-field parse loop itself is shared: `fields.ts:resolveFieldEntries(source)` walks `FIELDS`, parses each explicitly-supplied value and returns `{ resolved, bad }`. Both `initConfig()` (source = CLI ?? env, then adds `def`/`defaults` fallback) and `parseStartupArgs()` (source = parsed argv, explicit keys only) call it, then do their own post-processing (range check, error throw) — do not re-write a third loop.
- Boolean parsing has exactly **one** implementation: `config-helpers.ts:toBoolean` (imported by `fields.ts` for the `parse: toBoolean` rows, and by `loader.ts` for the early `USE_HOME_CONFIG` look-up). Never add a local copy — drift would make the same env value resolve differently at config-dir-time vs store-write-time.

## Validation & Guardrails

- **No silent fallback**: any explicitly supplied CLI/env value that fails to parse aborts startup (`配置校验失败: ...`) — booleans included (`AUTH_ENABLED=treu` errors).
- **Int bounds**: checked in both `initConfig()` and `parseStartupArgs()` via the shared `collectIntRangeErrors()`.
- **JSON config files (fail-closed at startup)**: `initConfig()` force-reads + validates `AUTH_USERS_FILE` and `ACL_FILE` before the store write (`readAuthUsers({ force, path })` / `readAcl({ force, path })`). Illegal content aborts startup (`配置校验失败: AUTH_USERS_FILE=<path> ...` / `ACL_FILE=<path> ...`). Only the **paths** are stored; values stay in the `json-file` cache and remain hot-loadable.
- **Cross-field auth (fail-closed)**: `assertAuthConfig({ authEnabled, authType, accountCount, jwtSecret })` (exported, unit-testable) throws `配置校验失败: ...` when `authEnabled` is true and any of: `authType` ∈ `{basic, uid}` with `accountCount === 0` (an empty `users.json` would otherwise be a silent "reject everything" — the message points at `AUTH_USERS_FILE`); `authType === "none"` (auth enabled without a method = everything is allowed — a self-contradictory config; disable auth with `authEnabled=false` instead); `authType === "jwt"` with an empty `jwtSecret`. Runs in the same stage as the parse/range checks, **before** the store write.
- **`_inited` after success**: `initConfig()`'s idempotency flag is set only after all validation passes and the store is written, so a first failing call throws (and a retry re-runs and throws again) instead of silently returning defaults.

## JSON Config Files (hot-load)

`cfg/users.json` (`AUTH_USERS_FILE`) and `cfg/acl.json` (`ACL_FILE`) are **runtime-hot-loaded** through `src/utils/json-file.ts:readJsonCached`:

- **mtime/size throttled stat**: at most one `stat` per file per `maxAgeMs` (default `1000` ms), so an edit takes effect within ~1s and **without restart**. `maxBytes` default `1MiB`.
- **Bad content is not adopted**: a JSON/schema error keeps the **last good snapshot** and logs a dedup'd `logger.warn` (`[config] ... 读取失败: ...（沿用上一份有效配置）`); on recovery it logs an `info`. Reads never throw.
- **Missing file = empty config** (not an error): ACL blocks nothing, account table is empty (and, with auth on, that is caught by `assertAuthConfig` at startup).

## CLI Arguments

```bash
pnpm start -- --port 3000              # --key value
pnpm start -- --proxy-protocol=socks5  # --key=value
pnpm start -- PORT=3000                # KEY=VALUE form
pnpm start -- --auth-enabled           # bare flag → "true"
```

`KEY=VALUE` splits on the **first** `=`, so values may contain `=` (`JWT_SECRET=Zm9v==` → full `Zm9v==`), matching the `--key=value` path.

## Environment Variable Names

One name per field — there is no alias table. The `env` of every field lives in `src/config/loader.ts:FIELDS`. A removed or unknown name simply is not matched (CLI keys normalise the same way, so `--proxy-type` no longer resolves; `AUTH_USERNAME` / `AUTH_PASSWORD` were removed in favour of `AUTH_USERS_FILE`).

Protocol enum (both `proxyProtocol` and `upstreamProtocol`): `http | https | socks4 | socks5 | sockss4 | sockss5` (see `src/config/store.ts:ProxyProtocol`).

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
AUTH_USERS_FILE=./cfg/users.json
```

Accounts live in that file (`[{ "username": "admin", "password": "secret" }, ...]`); copy `cfg/users.json.example` to start. An empty table with `basic`/`uid` aborts startup.

### Access Control

```env
ACL_FILE=./cfg/acl.json
```

See `src/config/AGENTS.md` → 访问控制 for the `clientIp` / `target` schema and semantics. Both lists are judged against **what the client asked for**; the upstream address (`UPSTREAM_*`) is never subject to them — in `client` mode a whitelist only needs the sites you allow, not the upstream.

### TLS Proxy

```env
PORT=3443
PROXY_PROTOCOL=https
TLS_KEY=./keys/server.key
TLS_CERT=./keys/server.crt
# Optional: client-certificate CA. Empty = server-only TLS. Set = mTLS enforced
# (clients must present a cert signed by it; an unreadable file aborts startup).
# TLS_CA=./keys/ca.crt
```

- `TLS_CA` is the **mTLS switch** for `https` / `sockss4` / `sockss5`: set → `requestCert + rejectUnauthorized`; empty (default) → no client cert is requested. It must be **empty by default** — `keys/` is a repo-committed test PKI (private keys included).
- mTLS rejections and other TLS handshake failures are logged as `[tls-client-error]` (warn) with `code` / `authorizationError`.
- Repo test PKI for mTLS: server `keys/server.crt`, CA `keys/ca.crt`, client `keys/client.crt` + `keys/client.key`.

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
- `UPSTREAM_CA` **defaults to empty** = system trust store. When set, the file is passed as `ca` and **replaces** the system store (only that CA is trusted) — leave it empty for public HTTPS upstreams, set it only for self-signed ones. Read via `src/utils/cert.ts:readUpstreamCa` (shared by `core/forward/http.ts` + `core/forward/dial.ts`, non-regular files return `undefined` instead of throwing EISDIR)
- IPv6 literal hosts are accepted (`socks5://[::1]:1080`) and stored **without** brackets (`upstreamHost === "::1"`), since `net.connect`/DNS reject the bracketed form
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
3. Update the `src/config/AGENTS.md` env-key table if user-facing
