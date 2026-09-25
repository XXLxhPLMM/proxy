---
name: proxy-config
description: Use when configuring proxy settings, environment variables, CLI arguments, or store/loadConfig/FIELDS internals. Triggers on "config", "配置", "env", "environment", "settings", "环境变量", "cli", "命令行参数", "upstream", "store", "loadConfig", "FIELDS", "users.json", "acl.json".
---

# Proxy Configuration Skill

Use this skill when working with proxy configuration, explicit configuration sources, CLI arguments, or table-driven configuration loading.

## When to Use

- User edits `.env.*`, runs `pnpm start -- --port`, asks about defaults, or adds a new `AppConfig` field.
- Do NOT trigger for generic logging/auth questions — use `proxy-logger` / `proxy-auth` instead.

## Configuration Priority

1. Explicit `argv` (highest priority) — `--port 3000` / `--port=3000` / `PORT=3000`
2. Explicit `env` source (including a terminal snapshot supplied by the CLI) — an explicitly present key always wins over every env file, even when its value is `undefined`
3. Explicit `envFiles`, in input order — later files override earlier files
4. `FIELDS.def(configDir)` and hardcoded `defaults` (lowest)

`src/config/load.ts:loadConfig` is the only configuration-loading entry. It never reads the host environment or argv, and it never discovers env files by itself:

- Omitted `env`, `envFiles`, and `argv` mean empty inputs, not “use the host process”.
- `envFiles` contains explicit paths only. Relative paths resolve against the final `configDir`; absolute paths are used as-is. Missing files are skipped; other read errors reject the load.
- `readEnvFiles()` copies the explicit env source, then reads files in order, so later files replace earlier file values while explicit env keys remain authoritative.
- `process.env` is never read or written by the configuration modules. `src/cli.ts` is the separate host boundary: it snapshots the process environment/argv and passes those snapshots as explicit `env`/`argv` to `loadConfig`.
- The CLI helper `defaultEnvFileNames()` generates raw candidates in low→high precedence order `.env.production` → `.env.development` → `.env.<NODE_ENV>`, with the later candidate winning. Duplicate names are removed keeping the last occurrence, so `NODE_ENV=production` actually reads `.env.development` then `.env.production`. The CLI passes the resulting names explicitly. `.env` and `.env.local` are not auto-loaded, but a custom caller may pass any explicit path.

## Load Design (table-driven)

`src/config/fields.ts` is the sole owner of `FIELDS: FieldDef[]` and every field’s env name:

```typescript
field({ key: "port", env: "PORT", parse: parseNum, int: { min: 1, max: 65535 }, phase: "startup" }),
field({ key: "logLevel", env: "LOG_LEVEL", parse: parseEnum(LOG_LEVELS), phase: "runtime" }),
field({ key: "logFileLevel", env: "LOG_FILE_LEVEL", parse: parseEnum(LOG_LEVELS), phase: "runtime" }),
field({ key: "logFile", env: "LOG_FILE", parse: parseStr, def: (dir) => path.join(dir, "log"), phase: "runtime" }),
field({ key: "authUsersFile", env: "AUTH_USERS_FILE", parse: parseStr, def: (dir) => path.join(dir, "cfg/users.json"), phase: "runtime" }),
field({ key: "aclFile", env: "ACL_FILE", parse: parseStr, def: (dir) => path.join(dir, "cfg/acl.json"), phase: "runtime" }),
```

- `env`: the single name shared by parsed CLI input and explicit env lookup.
- `parse`: returns `undefined` for invalid values. Any explicitly supplied invalid value rejects the load — booleans included, so `AUTH_ENABLED=treu` errors instead of quietly becoming `false`.
- `phase` (required): `startup` values are captured into immutable runtime/server options and changing the store later requires a new runtime/process; `runtime` values are read again by request paths or each logger call and may be changed with the owning `ConfigStore.set()`. `UPSTREAM_URL` and its six endpoint components are startup: changing any requires rebuilding the runtime, while the URL override warning remains. `keysByPhase()` exposes both groups, `ConfigContext.startupKeys` records the startup group, and `logConfig(context, logger)` prints the current split. `useHomeConfig` is startup-only because it selects `configDir` before env files are read.
- `int`: `{ min, max }` integer bounds, checked by `collectIntRangeErrors()` after table resolution. `loadConfig()` and `parseStartupArgs()` share this helper, so bad CLI/env bounds fail before the target store is changed.
- `def` / `path`: `def` is a fallback or `(configDir) => path.join(...)`; every path-valued field is marked `path: true` so load, context creation, and pure-memory runtime normalize relative values through the same FIELDS-driven helper. `configDir` is `~/.proxy` when CLI/explicit env selects `useHomeConfig`, otherwise explicit `cwd` or `process.cwd()`. A `USE_HOME_CONFIG` value inside an env file cannot relocate the file that would have to be read first. Pure-memory `createProxyRuntime({ config, configDir })` resolves every path field at construction; an omitted `configDir` is only a convenience default captured from the current `process.cwd()`, and later `process.chdir()` does not move existing paths.
- Parsed CLI input, env-file merging, store commits, and `ConfigContext` source metadata all derive from this table — never duplicate the field schema.
- `fields.ts:resolveFieldEntries(source)` walks `FIELDS`, parses each supplied raw value, and returns `{ resolved, bad }`. `loadConfig()` applies CLI > merged env, then fills `def`/`defaults`; `parseStartupArgs()` parses only explicit argv keys. Do not add a third parsing loop.
- Boolean parsing has exactly one implementation: `config-helpers.ts:toBoolean`, used by `fields.ts` and by `load.ts` for the early `USE_HOME_CONFIG` decision. Never copy it locally.

## Validation & Guardrails

- **No silent fallback**: an invalid explicit CLI/env value rejects with `配置校验失败: ...`; invalid bounds reject with `配置校验失败: ... 越界`.
- **JSON config files (fail-closed by default)**: before committing configuration, `loadConfig()` directly reads and validates `AUTH_USERS_FILE` and `ACL_FILE` via `readAuthUsersAsync()` / `readAclAsync()`. Illegal content rejects with `配置校验失败: AUTH_USERS_FILE=<path> ...` / `ACL_FILE=<path> ...`. Only the paths enter the store; runtime values remain hot-loadable through their cached readers.
- **Cross-field auth (fail-closed)**: `assertAuthConfig({ authEnabled, authType, accountCount, jwtSecret })` rejects when auth is enabled with `{basic, uid}` plus an empty account table, with `none`, or with JWT plus an empty secret.
- **`skipFileValidation`**: defaults to `false`. When `true`, both JSON files are not read and `assertAuthConfig` is skipped as well; the caller then owns validation of that combination.
- **Atomic commit**: all parsing, range, env-file, JSON, and cross-field checks finish before one `store.merge(resolved)`. A rejected call leaves a supplied store unchanged rather than half-written.
- **Successful result**: `loadConfig()` returns a `ConfigContext` containing the target `store`, a live single-key `accessor`, a frozen load-time `config` snapshot, `configDir`, source-key/path metadata, `startupKeys`, and non-fatal warnings. The public `createConfigContext({ store, configDir, ... })` factory is object-only and requires `configDir`; it has no positional overload or implicit cwd fallback. When `startupKeys` is omitted, the factory defaults to the complete startup set; explicitly supplied keys must be known and unique. Importing the package or the load module does not load configuration, start a server, or touch host state.

## JSON Config Files (hot-load)

`cfg/users.json` (`AUTH_USERS_FILE`) and `cfg/acl.json` (`ACL_FILE`) are **runtime-hot-loaded** through `src/utils/json-file.ts:readJsonCached`:

- **mtime/size throttled stat**: at most one `stat` per file per `maxAgeMs` (default `1000` ms), so an edit takes effect within ~1s and **without restart**. Relative paths are made absolute before entering the cache. `maxBytes` default `1MiB`.
- **Bad content is not adopted**: a JSON/schema error keeps the **last good snapshot**. Other stat errors such as `EACCES` also keep the last good snapshot (or use the fallback when no history exists) and emit an error; only `ENOENT`, `ENOTDIR`, and non-regular files count as missing. `readJsonCached` itself never logs — it emits edge-triggered `error` / `missing` / `recovered` / `reloaded` events through `onEvent`. The composition layer supplies `createJsonFileEventHandler(logger)` (or passes the same callback into `loadAuthUsers` / ACL binding), so a bad edit or permission error becomes an explicit warn line and recovery becomes info. Reads never throw.
- **True missing file = empty config** (only `ENOENT`, `ENOTDIR`, or a non-regular file; not a file-read error): ACL = all three groups empty (blocks nothing; client mode routes everything upstream), and the account table is empty. A permission/stat error must not silently turn ACL into allow-all. With file validation enabled, `loadConfig` then applies `assertAuthConfig` before committing.

## CLI Arguments

```bash
pnpm start -- --port 3000              # --key value
pnpm start -- --proxy-protocol=socks5  # --key=value
pnpm start -- PORT=3000                # KEY=VALUE form
pnpm start -- --auth-enabled           # bare flag → "true"
```

`KEY=VALUE` splits on the **first** `=`, so values may contain `=` (`JWT_SECRET=Zm9v==` → full `Zm9v==`), matching the `--key=value` path. The CLI snapshots these argv values and passes them explicitly to `loadConfig`; importing the CLI or package does not parse them.

## Environment Variable Names

One name per field — there is no alias table. The `env` of every field lives in `src/config/fields.ts:FIELDS`. A removed or unknown name simply is not matched (CLI keys normalise the same way, so `--proxy-type` no longer resolves; `AUTH_USERNAME` / `AUTH_PASSWORD` were removed in favour of `AUTH_USERS_FILE`).

Protocol enum (both `proxyProtocol` and `upstreamProtocol`): `http | https | socks4 | socks5 | sockss4 | sockss5` (see `src/config/store.ts:ProxyProtocol`).

## Default Values

Lowest-priority fallbacks — primitive defaults live in `src/config/store.ts:defaults`; `src/config/fields.ts:FIELDS` remains the sole field/env/phase table, and its `def(configDir)` rows resolve path defaults during `loadConfig()`. Full table, in `FIELDS` order:

| Env Key | Default | Phase | Notes |
| --- | --- | --- | --- |
| `HOST` | `0.0.0.0` | startup | all interfaces (container/multi-NIC friendly) |
| `PORT` | `3000` | startup | int `1..65535` |
| `CACHE_TYPE` | `memory` | runtime | `memory` \| `redis` |
| `PROXY_PROTOCOL` | `http` | startup | `http\|https\|socks4\|socks5\|sockss4\|sockss5` |
| `AUTH_ENABLED` | `false` | runtime | auth off |
| `AUTH_TYPE` | `none` | runtime | `none\|basic\|jwt\|uid` |
| `AUTH_USERS_FILE` | `<configDir>/cfg/users.json` | runtime | store seed `cfg/users.json`, resolved by `def` |
| `JWT_SECRET` | `""` (empty) | runtime | required when `AUTH_ENABLED=true` + `AUTH_TYPE=jwt` |
| `AUTH_LOGGING` | `true` | runtime | |
| `ACL_FILE` | `<configDir>/cfg/acl.json` | runtime | store seed `cfg/acl.json`, resolved by `def`; missing file = all 3 groups empty (block nothing; client mode → all upstream) |
| `LOG_LEVEL` | `error` | runtime | console: `debug\|info\|warn\|error\|silent` |
| `LOG_FILE_LEVEL` | `info` | runtime | file level, independent from `LOG_LEVEL` |
| `LOG_FILE` | `<configDir>/log` | runtime | dir **or** file path → hourly JSONL |
| `UPSTREAM_TIMEOUT` | `10000` ms | runtime | int `min 1`; also the cluster shutdown-grace base |
| `TLS_KEY` | `<configDir>/keys/server.key` | startup | self-signed placeholder shipped in `keys/` |
| `TLS_CERT` | `<configDir>/keys/server.crt` | startup | |
| `TLS_CA` | `""` (empty) | startup | **no default file** — empty = server-only TLS, set = mTLS enforced |
| `TLS_PASSPHRASE` | `""` (empty) | startup | |
| `UPSTREAM_URL` | `""` (empty) | startup | empty = use the granular `UPSTREAM_*` fields; changing it requires a rebuilt runtime |
| `UPSTREAM_HOST` | `127.0.0.1` | startup | |
| `UPSTREAM_PORT` | `3000` | startup | int `1..65535` |
| `UPSTREAM_SECURE` | `false` | startup | |
| `UPSTREAM_USERNAME` | `""` (empty) | startup | |
| `UPSTREAM_PASSWORD` | `""` (empty) | startup | |
| `UPSTREAM_CA` | `""` (empty) | runtime | **empty = system trust store**; set = *replaces* it |
| `UPSTREAM_INSECURE` | `false` | runtime | skip upstream cert verification |
| `UPSTREAM_PROTOCOL` | `http` | startup | same enum as `PROXY_PROTOCOL` |
| `PROXY_MODE` | `server` | runtime | `server` \| `client` |
| `CLUSTER_WORKERS` | `1` | startup | int `0..1024`; `0` = CPU-core count, `1` = no fork |
| `USE_HOME_CONFIG` | `false` | startup | `false` = config dir is `cwd`, `true` = `~/.proxy/` |

- Path fields (`AUTH_USERS_FILE` / `ACL_FILE` / `LOG_FILE` / `TLS_KEY` / `TLS_CERT` / `TLS_CA` / `UPSTREAM_CA`) have relative seeds in `defaults` (`cfg/users.json`, …). A raw `ConfigStore` therefore starts with those relative values; `loadConfig()` and `createConfigContext` resolve all path fields against the final `configDir`, so the live store contains absolute paths. `configDir` is `~/.proxy` when CLI/explicit env selects `useHomeConfig`, otherwise explicit `cwd` or `process.cwd()`.
- `TLS_KEY` / `TLS_CERT` / `TLS_CA` / `TLS_PASSPHRASE` only matter for `https` / `sockss4` / `sockss5`.
- Never add a default without adding it in **both** places (`store.ts:defaults` + a `def` in `FIELDS` for path fields), and mirror the user-facing ones into the `src/config/AGENTS.md` env table.

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

See `src/config/AGENTS.md` → 访问控制 for the `clientIp` / `target` / `upstream` schema and semantics. All three groups are judged against **what the client asked for**; the upstream address (`UPSTREAM_*`) is never subject to them — in `client` mode a `target` whitelist only needs the sites you allow, not the upstream.

The third group `upstream` is a **routing** list (action = direct connection, blacklist beats whitelist; go upstream ⇔ hit whitelist ∧ miss blacklist, otherwise direct) and is effective **only with `PROXY_MODE=client`** — `server` mode ignores it, and both-empty keeps the go-upstream default of the old behavior. It never allows/denies: routing is judged **after** `target`, so it cannot waive a `target` denial; client mode logs one `[route]` line per allowed request (`target`, `route=direct|upstream`, plus `reason=blacklist|whitelist` when direct). Both functions require the owning `ConfigAccessor`: `checkUpstreamRoute(host, config)` / `resolveRoute(dest, config)`.

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

`UPSTREAM_URL` and its six endpoint components are **startup** fields. `loadConfig` and the pure-memory runtime share the same strict validation and component-derivation entry; parsing/derivation completes before any store commit, so an invalid URL cannot half-write the target. Changing the URL or any derived endpoint requires rebuilding the runtime (or restarting the process), not a request-path reparse. When it overrides explicitly supplied granular fields, the non-fatal warning remains in the context.

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

`src/config/store.ts` defines instance-owned `ConfigStore`; it has no module-level configuration Map and performs no IO:

```typescript
import { ConfigStore, configAccessorFromStore } from "@b-hole/proxy";

const store = new ConfigStore({ port: 9101, proxyMode: "client" });
store.set("host", "127.0.0.1");

const accessor = configAccessorFromStore(store);
console.log(accessor.get("proxyMode")); // "client"
```

`ConfigAccessor` intentionally exposes only typed `get()`. Consumers read configuration; the owning `ConfigStore` performs writes. `loadConfig` and the package entry are import-safe, and the CLI composition root loads configuration before calling `runServer(context, logger, noColor)`.

## Adding New Config

1. Add field to `AppConfig` + `defaults` in `src/config/store.ts`
2. Add ONE row to `FIELDS` in `src/config/fields.ts` — `{ key, env, parse, phase }` are required; add `int: { min, max }` for bounded integers
3. Update the `src/config/AGENTS.md` env-key table if user-facing

## Library-mode configuration

- `ConfigStore` is the configuration state contract. `new ConfigStore(initial?: Partial<AppConfig>)` seeds every key from `defaults` and applies the supplied patch. `get`, `set`, `getAll`, `has`, `merge`, and `onChange` all operate on that instance; snapshots are shallow copies, and change listeners receive only keys whose values actually changed.
- `loadConfig({ env, envFiles, argv, cwd, store, skipFileValidation })` is the only async loading API. It accepts explicit sources, uses `FIELDS` for parsing/validation, normalizes explicit relative path fields against the final `configDir`, optionally writes into the supplied `ConfigStore` (or creates one), and returns a `ConfigContext` only after every enabled validation succeeds. Rejection leaves the supplied store unchanged.
- `ConfigContext.store` is the live owner, `ConfigContext.accessor` is its single-key read port, and `ConfigContext.config` is a frozen load-time snapshot. `sources`, `startupKeys`, `configDir`, and `warnings` describe the successful load without copying sensitive values into source metadata. Manual contexts must use the object factory; `startupKeys` is not an input and always comes from the complete FIELDS startup set.
- The `config.loaded` `sourceName` is selected by first match in `argv` > `environment` > `env-files` > `memory`; mixed inputs report only the highest-priority class.
- A pure-memory runtime owns a private store created from its `config` patch. It accepts `configDir`; all path fields are made absolute at construction, and an omitted `configDir` captures `process.cwd()` only as a convenience default. Its public configuration read port is `runtime.context.accessor`:

  ```typescript
  import { createProxyRuntime } from "@b-hole/proxy";

  const runtime = createProxyRuntime({
    config: { port: 9101, proxyMode: "client" },
    configDir: "/srv/proxy",
  });

  console.log(runtime.context.accessor.get("proxyMode")); // "client"
  runtime.context.store.set("proxyMode", "server");
  ```

- Context mode shares the exact live `ConfigStore` returned by `loadConfig` with runtime/core consumers:

  ```typescript
  import { createProxyRuntime, loadConfig } from "@b-hole/proxy";

  const context = await loadConfig({
    env: { PORT: "9200", PROXY_PROTOCOL: "socks5" },
    envFiles: [".env.local"],
    argv: [],
    cwd: process.cwd(),
    skipFileValidation: true,
  });

  const runtime = createProxyRuntime({ context });
  console.log(context.accessor.get("port")); // 9200
  console.log(runtime.context.accessor.get("proxyMode")); // "server"
  ```

- Runtime startup fields (including `UPSTREAM_URL`) are frozen into the runtime view; later store changes publish `config.restart-required` instead of silently changing the current listener/TLS/upstream setup. Rebuild the runtime to apply them. `runtime.options`, `runtime.services`, and the derived accessor are read-only frozen views; write live runtime values through `runtime.context.store`.
- `start()` / `stop()` are idempotent, but each `start()` re-establishes the bridge, store, and ACL-file subscriptions. Thus `start→stop→start` and `stop-before-start` followed by `start()` both restore the full event/hot-load path. An external `EventHub` remains host-owned and is never cleared by runtime.
- Multiple runtimes sharing a `ConfigContext` intentionally share that store; separate contexts or pure-memory runtimes remain isolated.
- Neither loading nor logger creation mutates `process.env`. Host environment values exist in a loaded context only when the host application (for this repository, `src/cli.ts`) explicitly snapshots and passes them.
