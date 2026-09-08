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
2. Env-file values (overwrite `process.env`; order low→high: `.env.production` → `.env.development` → `.env.<NODE_ENV>`, see `src/config/loader.ts:loadEnvFiles`)
3. Terminal environment variables
4. Hardcoded defaults in `src/config/store.ts:defaults` (lowest)

> `.env` and `.env.local` are NOT loaded by `loader.ts` — only the 3 candidates above.

## Loader Design (table-driven)

`src/config/loader.ts` describes every field exactly once in `FIELDS: FieldDef[]`:

```typescript
field({ key: "port", aliases: ["PORT"], parse: parseNum, def: 3000 }),
field({ key: "logLevel", aliases: ["LOG_LEVEL", "LOGLEVEL"], parse: parseEnum([...]), strict: true, def: "info" }),
field({ key: "logFile", aliases: ["LOG_FILE", ...], parse: parseStr, def: (dir) => path.join(dir, "log") }),
```

- `aliases`: shared by CLI (`--port` → `PORT`) and env lookup, first-match wins.
- `parse`: returns `undefined` for invalid values. Invalid **CLI** values are silently dropped (fall through). `strict: true` (enums + `upstreamUrl`) makes invalid **env** values throw and block startup.
- `def`: fallback or ` (configDir) => path.join(dir, ...)` for path fields (`~/.proxy` when `useHomeConfig` else `cwd`).
- CLI parsing, env merge, `config.set` writes, and returned snapshot all derive from this table — never duplicate logic.

## Environment Variable Aliases

First-match wins. Full list lives in `src/config/loader.ts:FIELDS` (do not copy-paste stale tables):

| Config Key         | Aliases (first wins)                                    |
| ------------------ | ------------------------------------------------------- |
| `PROXY_PROTOCOL`   | `PROXY_TYPE`, `PROXY_SERVICE_TYPE`                      |
| `AUTH_ENABLED`     | `APP_USE_AUTH`, `USE_AUTH`, `AUTH_SWITCH`               |
| `JWT_SECRET`       | `PROXY_SECRET`, `JWT_KEY`, `JWTSECRET`                  |
| `LOG_LEVEL`        | `LOGLEVEL`                                              |
| `LOG_FILE`         | `LOGFILE`, `LOG_PATH`                                   |
| `AUTH_LOGGING`     | `AUTH_LOG`, `LOG_AUTH`                                  |
| `CACHE_TYPE`       | `CACHETYPE`                                             |
| `UPSTREAM_TIMEOUT` | `PROXY_TIMEOUT`, `TIMEOUT`                              |
| `TLS_KEY`          | `TLS_KEY_PATH`, `SSL_KEY`                               |
| `TLS_CERT`         | `TLS_CERT_PATH`, `SSL_CERT`                             |
| `TLS_CA`           | `TLS_CA_PATH`, `SSL_CA`                                 |
| `TLS_PASSPHRASE`   | `TLS_KEY_PASS`, `SSL_PASSPHRASE`, `PASSPHRASE`          |
| `UPSTREAM_URL`     | `REMOTE_URL` — standard URL, overrides granular fields  |
| `UPSTREAM_HOST`    | `REMOTE_HOST`, `PROXY_TARGET_HOST`, `TARGET_HOST`       |
| `UPSTREAM_PORT`    | `REMOTE_PORT`, `PROXY_TARGET_PORT`, `TARGET_PORT`       |
| `UPSTREAM_SECURE`  | `REMOTE_SECURE`, `PROXY_TARGET_SECURE`, `TARGET_SECURE` |
| `UPSTREAM_USERNAME`| `REMOTE_USERNAME`, `PROXY_TARGET_USERNAME`              |
| `UPSTREAM_PASSWORD`| `REMOTE_PASSWORD`, `PROXY_TARGET_PASSWORD`              |
| `UPSTREAM_CA`      | `REMOTE_CA`, `PROXY_TARGET_CA`                          |
| `UPSTREAM_INSECURE`| `REMOTE_INSECURE`, `PROXY_TARGET_INSECURE`             |
| `UPSTREAM_PROTOCOL`| `REMOTE_PROTOCOL`, `PROXY_UPSTREAM_PROTOCOL`, `UPSTREAM_TYPE` |
| `AUTH_TYPE`        | `AUTHTYPE`                                              |
| `PROXY_MODE`       | `MODE`, `RUN_MODE` (vite collision — see Gotchas)       |
| `CLUSTER_WORKERS`  | `WORKERS`                                               |
| `USE_HOME_CONFIG`  | `HOME_CONFIG`, `GLOBAL_CONFIG`                          |
| `HOST`             | — (no alias, CLI `--host`)                              |

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

Standard endpoint form, overrides granular `UPSTREAM_*`/`REMOTE_*` fields when set:

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
2. Add ONE row to `FIELDS` in `src/config/loader.ts` (`{ key, aliases, parse, def }`; `strict: true` for enums)
3. Zod range check in `loader.ts:schema` if numeric (port 1-65535, etc.)
4. Update `AGENTS.md` aliases table if user-facing
