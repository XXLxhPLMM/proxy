---
name: proxy-config
description: Use when configuring proxy settings, environment variables, CLI arguments, or understanding config loading. Triggers on "config", "配置", "env", "environment", "settings", "环境变量".
---

# Proxy Configuration Skill

Use this skill when working with proxy configuration, environment variables, or CLI arguments.

## Configuration Priority

1. CLI arguments (highest priority)
2. Environment file values (overwritten into `process.env`; `.env.<NODE_ENV>` > `.env.development` > `.env.production`)
3. Terminal environment variables
4. Hardcoded defaults (lowest priority)

## Loader Design (table-driven)

`src/config/loader.ts` describes every field exactly once in `FIELDS: FieldDef[]`:

```typescript
field({ key: "port", aliases: ["PORT"], parse: parseNum, def: 3000 }),
field({ key: "logLevel", aliases: ["LOG_LEVEL", "LOGLEVEL"], parse: parseEnum([...]), strict: true, def: "info" }),
field({ key: "logFile", aliases: ["LOG_FILE", ...], parse: parseStr, def: (dir) => path.join(dir, "log") }),
```

- `aliases`: shared by CLI (`--port` / `PORT=`) and env lookup, first-match wins.
- `parse`: returns `undefined` for invalid values. Invalid **CLI** values are silently dropped (fall through to env/default). `strict: true` (enums) makes invalid **env** values throw and block startup.
- `def`: fallback, or a function receiving the config dir (`~/.proxy` when `useHomeConfig`, else cwd) for path fields.
- CLI parsing, env merge, `config.set` writes, and the returned snapshot are all generated from this table — never hand-duplicate field logic elsewhere.

## Configuration Files

| File | Purpose |
|------|---------|
| `.env` | Base environment variables |
| `.env.development` | Development-specific settings |
| `.env.production` | Production-specific settings |
| `.env.local` | Local overrides (gitignored) |

## Environment Variable Aliases

Multiple env names map to the same config key (first-match wins):

| Config Key | Aliases |
|------------|---------|
| `PROXY_PROTOCOL` | `PROXY_TYPE`, `PROXY_SERVICE_TYPE` |
| `AUTH_ENABLED` | `APP_USE_AUTH`, `USE_AUTH`, `AUTH_SWITCH` |
| `JWT_SECRET` | `PROXY_SECRET`, `JWT_KEY`, `JWTSECRET` |
| `LOG_LEVEL` | `LOGLEVEL` |
| `LOG_FILE` | `LOGFILE`, `LOG_PATH` |
| `AUTH_LOGGING` | `AUTH_LOG`, `LOG_AUTH` |
| `CACHE_TYPE` | `CACHETYPE` |
| `UPSTREAM_TIMEOUT` | `PROXY_TIMEOUT`, `TIMEOUT` |
| `TLS_KEY` | `TLS_KEY_PATH`, `SSL_KEY` |
| `TLS_CERT` | `TLS_CERT_PATH`, `SSL_CERT` |
| `TLS_CA` | `TLS_CA_PATH`, `SSL_CA` |
| `TLS_PASSPHRASE` | `TLS_KEY_PASS`, `SSL_PASSPHRASE`, `PASSPHRASE` |
| `PROXY_MODE` | `MODE`, `RUN_MODE` |
| `CLUSTER_WORKERS` | `WORKERS` |
| `USE_HOME_CONFIG` | `HOME_CONFIG`, `GLOBAL_CONFIG` |
| `HOST` | — (listen IP, default `0.0.0.0`) |

## CLI Arguments

```bash
pnpm start -- --port 3000              # Set port
pnpm start -- --auth-enabled true      # Enable auth
pnpm start -- --proxy-protocol http    # Set protocol
pnpm start -- --log-level debug        # Set log level
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
AUTH_TYPE= basic
AUTH_USERNAME=admin
AUTH_PASSWORD=secret
```

### TLS Proxy

```env
PORT=3443
PROXY_PROTOCOL=tls
TLS_KEY=./keys/server.key
TLS_CERT=./keys/server.cert
TLS_CA=./keys/ca.cert
```

### Cluster Mode

```env
CLUSTER_WORKERS=4
```

## Config Store

Configuration is stored in a singleton Map at `src/config/store.ts`. Access via:

```typescript
import { get, set, has } from './config/store.js';

const port = get('port');
const protocol = get('proxyProtocol');
```

## Adding New Config

1. Add field to `AppConfig` in `src/config/store.ts`
2. Add default value in `defaults` object
3. Add ONE row to `FIELDS` in `src/config/loader.ts` (`{ key, aliases, parse, def }`; `strict: true` for enums) — CLI/env/write/snapshot all derive from it automatically
4. Update this skill documentation