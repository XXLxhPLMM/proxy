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

### The one allowed outgoing edge: `config → core`, `import type` only

Dependency direction is one-way `core → config`, yet this directory has **three** reverse `import type` edges (erased at compile time, so no runtime dependency edge and no cycle is possible):

| Where | core symbol | Why the edge is legitimate |
| --- | --- | --- |
| `types.ts:14` | `ProxyProtocol` from `@/core/types/proxy.js` | `AppConfig.proxyProtocol`/`upstreamProtocol` must share **one** literal union with core. Copying it leaves the config layer on a stale union once core adds a protocol, and `createProxy` then only explodes at runtime |
| `schema/upstream-url.ts:41` | the same union (value type of `UPSTREAM_SCHEMES`) | the second consumer of that union |
| `files/users.ts:38` | `QuotaWindow` from `@/core/traffic/index.js` | `UserQuota.window` must share one definition with the ledger's window-key maths, or "the value validation accepts" and "the value that computes a window" drift apart |

**This is recorded in `src/config/AGENTS.md` — the side that *looks* like the violator.** A violation is always noticed from the *upstream* end of the dependency, so half the story would leave the other half believing `config → core` is simply a bug and **copying a literal union** (which is the actual accident). Three criteria, **all** required: ① `import type`, not `import` (compile-time erasure); ② go through a **barrel** (`@/core/traffic/index.js`), never a deep path; ③ the symbol must be the **single source of a contract** (a protocol union, a window literal set) and **never behaviour or judgement** — judgement and IO never flow backwards into config (`files/users.ts` only provides data; "is it over" lives in `core/traffic/memory.ts`). Runtime (value) imports are forbidden: the traffic barrel is full of value exports, so that edge **must** stay `import type`. Guard: `tests/unit/traffic-ledger.test.ts` ("config → core 的边只允许 import type").

## Module Layout

`src/config/` is layered by responsibility; dependencies are strictly one-way, bottom to top:

| Module                  | Sole responsibility                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`              | field contract only (`AppConfig`, `ConfigKey`, `AuthType`, `LogLevel`, `CacheType`, `ConfigChangeListener`) — pure types, no runtime values |
| `store.ts`              | `defaults` seed + the one `ConfigStore` state (zero IO)                                                                                     |
| `schema/parse.ts`       | scalar parsers (`parseStr`/`parseNum`/`parseEnum`/`toBoolean`); knows no field names                                                        |
| `schema/fields.ts`      | `FieldDef` + `FIELDS` + `keysByPhase()`; describes fields, validates nothing                                                                |
| `schema/upstream-url.ts`| `parseUpstreamUrl` + `applyUpstreamUrl` and the **module-private** `UPSTREAM_SCHEMES` table (do not import it) — the only URL parse/split primitives (was `src/utils/upstream-url.ts`) |
| `schema/validate.ts`    | `resolveFieldEntries` / `collectIntRangeErrors` / `assertAuthConfig`                                                                        |
| `sources/config-dir.ts` | `getConfigDir` + `HOME_CONFIG_KEY`                                                                                                          |
| `sources/env-files.ts`  | `defaultEnvFileNames` (names only) + `readEnvFiles` (ordered reads)                                                                         |
| `sources/argv.ts`       | `parseRawArgv` normalisation                                                                                                                |
| `normalize/paths.ts`    | `resolveConfigPaths` (FIELDS `path` rows → absolute)                                                                                        |
| `normalize/upstream.ts` | `applyUpstreamUrlToConfig` — applies an already-parsed URL and reports the override warning (split primitives live in `schema/upstream-url.ts`) |
| `normalize/prepare.ts`  | `prepareRuntimeConfig` / `prepareRuntimeConfigStore`                                                                                        |
| `context.ts`            | `ConfigAccessor` read port + frozen `ConfigContext` + `createConfigContext`                                                                 |
| `files/users.ts`        | account table read/validate (data only) + the **optional per-user `acl` list** (`UserPolicy`, read via the zero-allocation `loadUserPolicy`; entries validated via `./rules/index.js`, read path shared with `loadAuthUsers`; **request-time enforcement lives in `core/access-control.ts`**) + the **optional per-user `quota`** (`UserQuota`, read via the zero-allocation `loadUserQuota`; **`window` (`day`\|`month`, default `month`) since 5b-1**; **metering and the exhausted-verdict live in `core/traffic/`, not here**; the per-field walkthrough lives in **`cfg/users.json.example.md`**, not in `users.json.example` — `users.json` is `JSON.parse` input, so **any comment makes the whole file unparseable → startup abort**) |
| `files/acl.ts`          | ACL read/validate (data only — request-time decisions are **not** here); validates entries via `./rules/index.js` |
| `files/rules/ip.ts`     | **entry rule layer** — `normalizeIp` / `ipv6BytesToString` / `ipToString` / `parseIpRule` / `compileIpRules` / `ipMatches` + `IpFamily`/`IpValue`/`IpRule` types (pure, zero IO, zero config) |
| `files/rules/host.ts`   | **entry rule layer** — `normalizeHost` / `parseHostRule` / `compileHostRules` / `hostMatches` + `HostRule`/`HostMatcher` types (no DNS) |
| `files/rules/index.ts`  | the rules barrel — and the **only** public exit for list primitives (deliberately *not* re-exported from `@/config/index.js`) |
| `files/event-log.ts`    | render `readJsonCached` events through an explicitly supplied logger                                                                        |
| `presets.ts`            | named `Partial<AppConfig>` bundles                                                                                                          |
| `load.ts`               | the only async loader, and the only IO orchestrator                                                                                         |
| `index.ts`              | the only public barrel                                                                                                                      |

- **Import rule**: cross-directory code imports `@/config/index.js` only — the single sanctioned exception is the ACL rules barrel `@/config/files/rules/index.js`. Never write `@/config/store.js` or `@/config/files/users.js`; a layout change must not ripple to callers. Inside `config/`, use relative paths and never self-import the barrel.
- **ACL is three layers, pick the right one**:
  1. **entry syntax / rules** — `src/config/files/rules/` (`ip.ts` + `host.ts`): can a string be an IP/CIDR/domain/`*.domain` rule, and how does it match. Came from the deleted `src/utils/ip-list.ts` / `src/utils/host-list.ts`; **exported names and signatures are unchanged**, only the owner moved.
  2. **read file + structure validation** — `src/config/files/acl.ts`: JSON shape, the three group keys, hot-load lifecycle.
  3. **request-time decision** — `src/core/access-control.ts`: `checkClientIp` / `checkTargetHost` / `checkUpstreamRoute` plus the per-accessor compiled cache.

  Change list *semantics* in layer 3, *file format* in layer 2, *entry grammar* in layer 1. `acl.ts` imports the rules via same-directory relative `./rules/index.js`; core imports them as `@/config/files/rules/index.js` (the one sanctioned second exit — list primitives serve the decision layer, not the configuration API, so they stay out of `@/config/index.js`).
- **Behaviour was deliberately not relaxed in the move**: `normalizeIp` still strips brackets only when the value both starts with `[` **and** ends with `]`, so `[::1]:443` in `acl.json` is still **invalid** (fail-closed). Text normalisation primitives (`stripIpBrackets` / `stripZone` / `stripTrailingDot` / `lowerTrim`) are shared from the new leaf module `@/utils/host-text.js`.
- **Request-time ACL decisions are not config** (see the three layers above): config never decides, core never parses a file.
- **There is no second argv entry**: `parseRawArgv` in `sources/argv.ts` is the only argv normaliser and `loadConfig` the only consumer. The former `parseStartupArgs()` helper was deleted (zero production callers, it duplicated the loader's parse path); assert argv behaviour through `loadConfig({ argv })`.

## Load Design (table-driven)

`src/config/schema/fields.ts` is the sole owner of `FIELDS: FieldDef[]` and every field’s env name:

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
- `phase` (required): `startup` values are captured into immutable runtime/server options and changing the store later requires a new runtime/process; `runtime` values are read again by request paths or each logger call and may be changed with the owning `ConfigStore.set()`. `UPSTREAM_URL` and its six endpoint components are startup: changing any requires rebuilding the runtime, while the URL override warning remains. `keysByPhase()` exposes both groups, `ConfigContext.startupKeys` records the startup group, and `logConfig(context, logger)` prints the current split. `useHomeConfig` is startup-only because it selects `configDir` before env files are read. `QUOTA_LEDGER_DIR` is startup for the same class of reason (an open handle cannot be re-pointed); `QUOTA_RESET_HOUR` / `QUOTA_FLUSH_INTERVAL` are runtime and are read live.
- `int`: `{ min, max }` integer bounds, checked by `collectIntRangeErrors()` (in `src/config/schema/validate.ts`) after table resolution, so bad CLI/env bounds fail before the target store is changed.
- `def` / `path`: `def` is a fallback or `(configDir) => path.join(...)`; every path-valued field is marked `path: true` so load, context creation, and pure-memory runtime normalize relative values through the same FIELDS-driven helper. `configDir` is `~/.proxy` when CLI/explicit env selects `useHomeConfig`, otherwise explicit `cwd` or `process.cwd()`. A `USE_HOME_CONFIG` value inside an env file cannot relocate the file that would have to be read first. Pure-memory `createProxyRuntime({ config, configDir })` resolves every path field at construction; an omitted `configDir` is only a convenience default captured from the current `process.cwd()`, and later `process.chdir()` does not move existing paths.
- Parsed CLI input, env-file merging, store commits, and `ConfigContext` source metadata all derive from this table — never duplicate the field schema.
- `src/config/schema/validate.ts:resolveFieldEntries(source)` walks `FIELDS`, parses each supplied raw value, and returns `{ resolved, bad }`. `loadConfig()` applies CLI > merged env, then fills `def`/`defaults`. Do not add a second parsing loop.
- Boolean parsing has exactly one implementation: `src/config/schema/parse.ts:toBoolean`, used by `schema/fields.ts` and by `load.ts` for the early `USE_HOME_CONFIG` decision. Never copy it locally.
- `parseStr` / `parseNum` / `parseEnum` / `toBoolean` live in `src/config/schema/parse.ts` and know no field names; `FIELDS` rows reference them. Adding a new scalar kind means adding it there, never inline in a field row.

## Validation & Guardrails

- **No silent fallback**: an invalid explicit CLI/env value rejects with `配置校验失败: ...`; invalid bounds reject with `配置校验失败: ... 越界`.
- **JSON config files (fail-closed by default)**: before committing configuration, `loadConfig()` directly reads and validates `AUTH_USERS_FILE` and `ACL_FILE` via `readAuthUsersAsync()` / `readAclAsync()`. Illegal content rejects with `配置校验失败: AUTH_USERS_FILE=<path> ...` / `ACL_FILE=<path> ...`. Only the paths enter the store; runtime values remain hot-loadable through their cached readers.
- **Cross-field auth (fail-closed)**: `assertAuthConfig({ authEnabled, authType, accountCount, jwtSecret })` rejects when auth is enabled with `{basic, uid}` plus an empty account table, with `none`, or with JWT plus an empty secret.
- **`skipFileValidation`**: defaults to `false`. When `true`, both JSON files are not read and `assertAuthConfig` is skipped as well; the caller then owns validation of that combination.
- **Atomic commit**: all parsing, range, env-file, JSON, and cross-field checks finish before one `store.merge(resolved)`. A rejected call leaves a supplied store unchanged rather than half-written.
- **Successful result**: `loadConfig()` returns a `ConfigContext` containing the target `store`, a live single-key `accessor`, a frozen load-time `config` snapshot, an absolute `configDir`, source-key/path metadata, the complete `startupKeys`, and non-fatal warnings. The public `createConfigContext({ store, configDir, sources?, warnings? })` factory is object-only and requires `configDir`; it has no positional overload or implicit cwd fallback, and `startupKeys` is not an input. Importing the package or the load module does not load configuration, start a server, or touch host state.

## JSON Config Files (hot-load)

`cfg/users.json` (`AUTH_USERS_FILE`) and `cfg/acl.json` (`ACL_FILE`) are **runtime-hot-loaded** through `src/utils/json-file/index.ts:readJsonCached`:

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

One name per field — there is no alias table. The `env` of every field lives in `src/config/schema/fields.ts:FIELDS`. A removed or unknown name simply is not matched (CLI keys normalise the same way, so `--proxy-type` no longer resolves; `AUTH_USERNAME` / `AUTH_PASSWORD` were removed in favour of `AUTH_USERS_FILE`).

Protocol enum (both `proxyProtocol` and `upstreamProtocol`): `http | https | socks4 | socks5 | sockss4 | sockss5` (see `src/core/types/proxy.ts:ProxyProtocol`; `src/config/types.ts` only consumes it).

## Default Values

Lowest-priority fallbacks — primitive defaults live in `src/config/store.ts:defaults`; `src/config/schema/fields.ts:FIELDS` remains the sole field/env/phase table, and its `def(configDir)` rows resolve path defaults during `loadConfig()`. Full table, in `FIELDS` order:

| Env Key             | Default                       | Phase   | Notes                                                                                                                       |
| ------------------- | ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `HOST`              | `0.0.0.0`                     | startup | all interfaces (container/multi-NIC friendly)                                                                               |
| `PORT`              | `3000`                        | startup | int `1..65535`                                                                                                              |
| `CACHE_TYPE`        | `memory`                      | runtime | `memory` \| `redis`                                                                                                         |
| `PROXY_PROTOCOL`    | `http`                        | startup | `http\|https\|socks4\|socks5\|sockss4\|sockss5`                                                                             |
| `AUTH_ENABLED`      | `false`                       | runtime | auth off                                                                                                                    |
| `AUTH_TYPE`         | `none`                        | runtime | `none\|basic\|jwt\|uid`                                                                                                     |
| `AUTH_USERS_FILE`   | `<configDir>/cfg/users.json`  | runtime | store seed `cfg/users.json`, resolved by `def`                                                                              |
| `JWT_SECRET`        | `""` (empty)                  | runtime | required when `AUTH_ENABLED=true` + `AUTH_TYPE=jwt`                                                                         |
| `AUTH_LOGGING`      | `true`                        | runtime |                                                                                                                             |
| `ACL_FILE`          | `<configDir>/cfg/acl.json`    | runtime | store seed `cfg/acl.json`, resolved by `def`; missing file = all 3 groups empty (block nothing; client mode → all upstream) |
| `QUOTA_LEDGER_DIR`  | `<configDir>/cfg/quota`      | **startup** | per-user quota **ledger** directory. Startup is mandatory: changing it at runtime leaves already-open append handles pointing at the old file, so the change is a no-op. Rebuild the runtime. **Consumed since 5b-2** by `core/traffic/ledger.ts:JsonlTrafficLedger` as `<dir>/worker-<slot>.jsonl` (`slot` is a **stable ordinal** — `"0"` for single process/library, `1..N` for cluster workers, injected by `server/cluster.ts` via `PROXY_WORKER_SLOT` on fork; never a PID). **The directory is only created when some user has a non-all-zero `quota`** (zero-cost tier) |
| `QUOTA_RESET_HOUR`  | `0`                          | runtime | int `0..23`, **local timezone**: with `window=day` and `3`, `01:00` still counts as the previous day. Read per access — hot changes take effect immediately. Out of range (`-1`/`24`) aborts startup. **Judgement and on-disk recovery share the very same closure** (both in `runtime/services.ts`), so the two can never compute different windows. Library callers bypass `loadConfig` (`ConfigStore` is zero-validation), so out-of-domain values are **clamped to `[0,23]`** by `core/traffic/window.ts:clampShiftHours` — a malformed `NaN-NaN-NaN` key would otherwise end up inside the ledger and take part in recovery |
| `QUOTA_FLUSH_INTERVAL` | `5000` ms                 | runtime | int `min 1`; quota delta flush interval. **Consumed since 5b-2** by `core/traffic/flush-loop.ts:startFlushLoop` — a self-rescheduling `setTimeout` (the **only** timer in the whole traffic slice) that re-reads the interval每轮, so a hot change takes effect on the next tick, and `unref()`s so it never pins the process. `0`/negative aborts startup (`0` does not mean "disable flushing") and the value is clamped to ≥1ms at use time (0 would become a `setTimeout(fn, 0)` busy loop). **Graceful shutdown always flushes regardless of this interval** — a large value plus repeated Ctrl+C still cannot buy extra quota |
| `LOG_LEVEL`         | `error`                       | runtime | console: `debug\|info\|warn\|error\|silent`                                                                                 |
| `LOG_FILE_LEVEL`    | `info`                        | runtime | file level, independent from `LOG_LEVEL`                                                                                    |
| `LOG_FILE`          | `<configDir>/log`             | runtime | dir **or** file path → hourly JSONL                                                                                         |
| `UPSTREAM_TIMEOUT`  | `10000` ms                    | runtime | int `min 1`; also the cluster shutdown-grace base                                                                           |
| `TLS_KEY`           | `<configDir>/keys/server.key` | startup | self-signed placeholder shipped in `keys/`                                                                                  |
| `TLS_CERT`          | `<configDir>/keys/server.crt` | startup |                                                                                                                             |
| `TLS_CA`            | `""` (empty)                  | startup | **no default file** — empty = server-only TLS, set = mTLS enforced                                                          |
| `TLS_PASSPHRASE`    | `""` (empty)                  | startup |                                                                                                                             |
| `UPSTREAM_URL`      | `""` (empty)                  | startup | empty = use the granular `UPSTREAM_*` fields; changing it requires a rebuilt runtime                                        |
| `UPSTREAM_HOST`     | `127.0.0.1`                   | startup |                                                                                                                             |
| `UPSTREAM_PORT`     | `3000`                        | startup | int `1..65535`                                                                                                              |
| `UPSTREAM_SECURE`   | `false`                       | startup |                                                                                                                             |
| `UPSTREAM_USERNAME` | `""` (empty)                  | startup |                                                                                                                             |
| `UPSTREAM_PASSWORD` | `""` (empty)                  | startup |                                                                                                                             |
| `UPSTREAM_CA`       | `""` (empty)                  | runtime | **empty = system trust store**; set = _replaces_ it                                                                         |
| `UPSTREAM_INSECURE` | `false`                       | runtime | skip upstream cert verification                                                                                             |
| `UPSTREAM_PROTOCOL` | `http`                        | startup | same enum as `PROXY_PROTOCOL`                                                                                               |
| `PROXY_MODE`        | `server`                      | runtime | `server` \| `client`                                                                                                        |
| `CLUSTER_WORKERS`   | `1`                           | startup | int `0..1024`; `0` = CPU-core count, `1` = no fork                                                                          |
| `USE_HOME_CONFIG`   | `false`                       | startup | `false` = config dir is `cwd`, `true` = `~/.proxy/`                                                                         |

- Path fields (`AUTH_USERS_FILE` / `ACL_FILE` / `QUOTA_LEDGER_DIR` / `LOG_FILE` / `TLS_KEY` / `TLS_CERT` / `TLS_CA` / `UPSTREAM_CA`) have relative seeds in `defaults` (`cfg/users.json`, …). A raw `ConfigStore` therefore starts with those relative values; `loadConfig()` and `createConfigContext` resolve all path fields against the final `configDir`, so the live store contains absolute paths. `configDir` is `~/.proxy` when CLI/explicit env selects `useHomeConfig`, otherwise explicit `cwd` or `process.cwd()`. **`TLS_PASSPHRASE` is deliberately NOT a path field** — it is a secret, not a filesystem location, so it carries no `path: true` and must never be `path.join`-ed against `configDir`. The eight fields above are the complete set; anything else marked `path: true` is a bug.
- `PROXY_WORKER_SLOT` is deliberately **not** in `FIELDS`: it is a cluster-assigned slot ordinal, not a configuration key (it does not enter `ConfigStore`, does not go through `loadConfig`, and is not printed by `logConfig`). Putting it in `FIELDS` would break both the "`CONFIG_ENV_KEYS` is identical to `FIELDS`" assertion and "FIELDS is the single source of env names". Its only writer is the `cluster.fork()` in `server/cluster.ts`; its only consumer is `core/traffic/ledger.ts:normalizeSlot` — the slot is **spliced into a file path**, so anything that is not `1..9999` digits is refused as a **path-traversal surface** and falls back to `"0"`. The full chain (CLI env snapshot → `runServer(…, workerSlot)` → `ProxyServer.trafficWorkerSlot` → `createProxyRuntime({ trafficWorkerSlot })` → `buildDefaultServices` → ledger) and the reason `core/**`/`runtime/**` never read `process.env` are in `src/core/AGENTS.md`.
- `QUOTA_LEDGER_DIR` is the one path field that is **startup** rather than runtime-hot: an open ledger handle cannot be re-pointed, so a live `store.set()` on it would look like it worked while the process keeps writing the old file. Guard: `tests/unit/quota-config-fields.test.ts` (FIELDS row + `keysByPhase()`) and `tests/unit/proxy-runtime.test.ts` ("traffic-quota config split by phase" — asserts `config.restart-required` vs `config.changed` through a real runtime).
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

Each account may carry an **optional** `acl` with a single `target` group — same entry grammar as the global `acl.json` `target` list (IP / CIDR / domain / `*.domain`, no ports, no DNS):

```jsonc
[{ "username": "alice", "password": "pw1" },
 { "username": "bob",   "password": "pw2",
   "acl": { "target": { "whitelist": ["*.corp.com"], "blacklist": ["ads.io"] } } }]
```

Old `[{username,password}]` files stay valid. **Only `target` is accepted** — `clientIp` / `upstream` / any unknown key makes the entry **invalid** (startup abort): the client-IP decision runs *before* authentication (`clientIp → auth → target ACL → route`), so a per-user source-IP limit cannot be decided there, and `upstream` is a routing list orthogonal to identity. One bad entry invalidates the entry (same fail-closed semantics as the global ACL). Entry legality is judged **only** via `rules/host.ts:parseHostRule` — `users.ts` has no second parser. `loadUserPolicy(username, config, onFileEvent?)` reads one user's policy through the **same** `readAuthUsers` → `readJsonCached` path (one throttle cache, one parse, one bad-file policy) and returns it deeply frozen. `acl` is invisible to the credential indexes — never enters `basic`/`uidUsers`, changes no comparison.

**It is enforced (Phase 4b).** `core/access-control.ts:checkTargetHost(host, config, user?)` judges two lists: `allow ⇔ global target allows ∧ this user's target allows`. **Global first, and a global rejection short-circuits** (a personal list may only be stricter, never looser); when both refuse, the reported one is **`source:"global"`** (the global list is the authoritative layer — operators should see their own global config problem first). No user / no `acl` / both lists empty → the personal layer is **neutral (allow)**. A personal list never affects the `clientIp` group (no identity before auth) nor the `upstream` routing group. `reason` stays exactly `whitelist|blacklist`; the layer is reported separately in `source` (`access.target-denied` payload and the `[target-denied]` log line both carry it) so an operator can tell whether to edit `acl.json` or `users.json`. Hot reload is the same as the account table (edit the file, ≤1s, no restart). `loadUserPolicy` is on the **per-request** path, so it allocates nothing while the policy snapshot is unchanged (indexed loop + freeze results memoized by source object identity → two consecutive calls return the **same object identity**).

#### Per-user traffic quota — `quota` (Phase 5a read side, 5b-1 adds the window, 5b-2 adds the on-disk ledger)

```jsonc
[{ "username": "alice", "password": "pw1" },
 { "username": "carol", "password": "pw3",
   "quota": { "bytesUp": 1073741824, "bytesDown": 21474836480, "bytesTotal": 53687091200, "window": "month" } }]
```

`quota` is **optional**, and so is each of its four sub-fields. **All missing or all zero = that user is unlimited** (0 means "this cap does not apply"). Every byte field must be a **non-negative safe integer**; a negative / fractional / string / boolean value, or any unknown sub-key (`rateBps`, `maxConnections`, `concurrency`, … — those are deliberately out of scope), makes the whole group **invalid → startup abort**. `quota` and `acl` are validated **independently**: when one is valid and the other is not, the **whole file is rejected** (fail-closed) rather than silently dropping the bad one — a half-dropped field is exactly the "I configured it and it silently did nothing" failure mode.

**`window` is Phase 5b-1: only the two calendar windows `day` / `month` are accepted, and the default is `month`.** Anything else (`"week"`, `"hour"`, `"rolling"`, a different case such as `"DAY"`, a non-string) makes the whole group **invalid → startup abort** — accepting a value we silently treat as `month` is the worst failure mode ("configured, but not in effect"). **Why no rolling window** (`100GB within 30 days`): ① **explanation cost** — an operator looking at "98GB / 100GB used" cannot answer "why am I refused now", and a quota is something operators must be able to explain; ② **aggregation cost** — a rolling window cannot be one scalar, judgement must sum across several historical windows, which does not fit the ledger's lazy model (no timers, no background task); ③ the project is still in design, so we **do not reserve placeholder values** — shipping `window: "rolling"` that behaves like a calendar window is exactly the failure mode above. If it is ever needed, the ledger shape (sliding queue + on-disk format) must be designed together with it.

**The `month` default is normalised on the consumption side** (`core/traffic/window.ts:quotaWindow`), not in the file layer: the normalised product only echoes what is on disk, so a missing `window` **writes no key at all** (writing it would put a value the operator never configured into the product and break the "old files produce byte-identical output" invariant). `QUOTA_KEYS` is a **closed set that includes `window`** — forgetting it makes every file that carries a window illegal via the "unknown sub-key" rule; there is a dedicated assertion plus a mutation test for that (removing `window` → 6 red).

Window key computation (`windowKey(nowMs, window, shiftHours)`), the lazy "rolling *is* clearing" ledger invariant, and the deliberate DST approximation are documented in `src/core/traffic/window.ts`; the guard is `tests/unit/traffic-window.test.ts`.

**`ACCOUNT_KEYS = {username, password, acl, quota}`** — forgetting `quota` here makes *every* file that carries one illegal via the "unknown top-level key" rule. That is the single easiest thing to miss when adding an optional field; there is a dedicated assertion plus a mutation test for it.

`loadUserQuota(username, config, onFileEvent?)` is **structurally identical to `loadUserPolicy`**: same `readAuthUsers` → `readJsonCached` path (one throttle cache, one parse, one bad-file policy — a second reader would create two caches and two divergent views of the same key), so hot reload is verbatim identical (1s stat throttle, a bad file keeps the last good value, missing = empty). It allocates nothing while the quota snapshot is unchanged (indexed loop + a frozen copy memoized by source object identity, so two consecutive calls return the **same object identity**). `quota` is invisible to the credential indexes, exactly like `acl`.

**Judgement is not here.** `core/traffic/memory.ts:MemoryTrafficAccount.consume` decides "is it over", in the fixed order `bytesUp` → `bytesDown` → `bytesTotal`, rejecting if **any** is breached, and **exactly hitting a cap is still allowed** (`bytesTotal: 100` lets the user transfer 100 bytes; byte 101 is refused). Reading the quota from disk on every `consume` call is fine because it rides the same 1s-throttled cache. `quota` is also **not** a rate limiter: there is deliberately **no** `rateBps` field — see `core/traffic/meter.ts` for why shaping bytes in user space is the wrong tool.

**With auth disabled, quotas do not apply at all** (no identity → no ownership → nothing to attribute bytes to) and startup emits a `[quota-inert]` warn when a real (non-all-zero) quota is configured. Enforcement is a **hard cut**, never "refuse new requests, leave existing ones" — a long-lived tunnel would otherwise never trip the check.

#### Quota ledger (Phase 5b-2) — usage survives a restart

Usage is persisted to `<QUOTA_LEDGER_DIR>/worker-<slot>.jsonl`: **one JSON delta per line**, `{ ts, u, d, b }` (timestamp / username / `"up"|"down"` / bytes). **Only deltas are ever written; absolute values are summed on read** — writing absolutes makes "whoever wrote last" the single source of truth, so two interleaved flushes overwrite each other and a crash leaves absolutes that cannot be reconciled against the deltas already appended.

Three things an operator must know:

1. **Without a non-all-zero `quota` the ledger does not exist at all**: no directory, no file handle, no background timer. The judgement is a **file fact** (`hasConfiguredQuota`), and it is the *same* function the `[quota-inert]` warning uses — two copies would eventually disagree ("the warning says not configured, the ledger says configured").
2. **Write failures never stop the service** — in-memory counting continues, the verdict keeps working, un-persisted deltas accumulate for the next retry, and one `[quota-ledger-error]` **error**-level line is emitted. Failing outright would mean "disk full → the whole proxy dies" (an enhancement must not be able to take down the data plane); failing silently would leave you believing quotas are persisted until a restart loses them. **Do not restart when you see that line** — a restart drops the queued deltas; fix the file/directory permissions instead.
3. **The ledger is compacted at startup and whenever it grows past 8MiB** (default threshold). Compaction sums by `(user, windowKey)` and **drops entries from expired windows**, which is what bounds the on-disk half of the "unbounded `jwt` `sub` growth" limitation (28 subs over 28 days compress to a 0-line file, and those slots never come back into memory on restart). Compaction never runs while an append handle is open (on Windows that is `EPERM`), uses `.tmp` + `rename` (so an interrupted compaction leaves the original byte-identical), and is **idempotent** because surviving entries keep their own `max ts` rather than being stamped with "now".

### Access Control

```env
ACL_FILE=./cfg/acl.json
```

See `src/config/AGENTS.md` → 访问控制 for the `clientIp` / `target` / `upstream` schema and semantics. Code side, the feature is three layers: entry grammar/rules in `src/config/files/rules/` (`ip.ts` / `host.ts`, pure), file read + structure validation in `src/config/files/acl.ts`, request-time judgement in `src/core/access-control.ts`. All three groups are judged against **what the client asked for**; the upstream address (`UPSTREAM_*`) is never subject to them — in `client` mode a `target` whitelist only needs the sites you allow, not the upstream.

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
- mTLS rejections and other TLS handshake failures are logged as `[tls-client-error]` (warn) with `code` / `authorizationError`. That alarm is **not** in `utils/`: it is `src/core/server/tls-alarm.ts:bindTlsClientError` (shared by `core/server/https.ts:doStart` and TLS SOCKS' `onListenerReady`), because translating a core handshake fact into a log line must not make `utils` depend on `core`.
- Repo test PKI for mTLS: server `keys/server.crt`, CA `keys/ca.crt`, client `keys/client.crt` + `keys/client.key`.
- **Certificate reads** go through the `src/utils/tls/` directory, cross-directory via `@/utils/tls/index.js` only: `certs.ts` (`loadCerts` + three types), `server-options.ts` (`requiresClientCert` / `tlsServerOptions`), `upstream.ts` (`readUpstreamCa` / `upstreamTlsOptions`). This replaced the old single `src/utils/cert.ts`.
- **Relative certificate paths resolve against `configDir` — that is the only answer.** `tlsKey` / `tlsCert` / `tlsCa` / `upstreamCa` are all marked `path: true` in `FIELDS`, so `resolveConfigPaths` absolutizes them against the final `configDir` during `loadConfig` / `createConfigContext` / pure-memory runtime construction. `loadCerts` performs **no** path resolution of its own any more (the old cwd-based `resolvePath` helper is deleted) and hands the given path straight to `readFileSync`; it only throws when the material is missing or unreadable.

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

- Scheme whitelist: `http` / `https` / `socks4` / `socks5` / `sockss4` / `sockss5` (case-insensitive; validated by `src/config/schema/upstream-url.ts:parseUpstreamUrl`, whose module-private `UPSTREAM_SCHEMES` table also owns the per-scheme default port). The file moved from `src/utils/upstream-url.ts` — a config field's parse/split belongs to the config layer, not to `utils`. `schema/fields.ts` imports it as `./upstream-url.js`, `normalize/upstream.ts` as `../schema/upstream-url.js`.
- Default port by scheme: `http:80` / `https:443` / `socks4, socks5:1080` / `sockss4, sockss5:443`. The http/https defaults are **not** hardcoded twice — they come from `DEFAULT_PORT_HTTP` / `DEFAULT_PORT_HTTPS` in `@/utils/constants/index.js`.
- Validation (strict — blocks startup): bad scheme, empty host, any path/query/hash, port 1-65535 outside range
- Derived fields: `upstreamProtocol/Secure/Host/Port/Username/Password` via `applyUpstreamUrl`; `UPSTREAM_CA` / `UPSTREAM_INSECURE` stay independent
- `UPSTREAM_CA` **defaults to empty** = system trust store. When set, the file is passed as `ca` and **replaces** the system store (only that CA is trusted) — leave it empty for public HTTPS upstreams, set it only for self-signed ones. Read via `src/utils/tls/upstream.ts:readUpstreamCa` (exported as `@/utils/tls/index.js`), whose **only** caller is `upstreamTlsOptions(host, config)`; non-regular files return `undefined` instead of throwing EISDIR. The paired builder is **`upstreamTlsOptions(host, config)` — two parameters, host first** (it pins SNI/cert verification to the dial target: `servername` is blanked for IP literals per RFC 6066, `rejectUnauthorized` is `!upstreamInsecure`, `ca` comes from `readUpstreamCa`). Its **sole consumer is `core/forward/dial.ts:dialTls`** — since Phase 2b-2a the TLS negotiation moved wholesale into the connector layer, so `core/forward/http.ts` no longer calls it (calling it there would negotiate TLS twice). Both require the owning `ConfigAccessor`.
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

`ConfigAccessor` intentionally exposes only typed `get()`. Consumers read configuration; the owning `ConfigStore` performs writes. `loadConfig` and the package entry are import-safe, and the CLI composition root loads configuration before calling `runServer(context, logger, noColor, workerSlot)` — the fourth argument is the quota-ledger worker slot ordinal taken from the same env snapshot (omit it for single-process/library mode, which normalizes to `"0"`).

## Adding New Config

1. Add the field to `AppConfig` in `src/config/types.ts`, and its primitive default to `defaults` in `src/config/store.ts`
2. Add ONE row to `FIELDS` in `src/config/schema/fields.ts` — `{ key, env, parse, phase }` are required; add `int: { min, max }` for bounded integers and `path: true` for path fields
3. Update the `src/config/AGENTS.md` env-key table if user-facing

## Library-mode configuration

- `ConfigStore` is the configuration state contract. `new ConfigStore(initial?: Partial<AppConfig>)` seeds every key from `defaults` and applies the supplied patch. `get`, `set`, `getAll`, `has`, `merge`, and `onChange` all operate on that instance; snapshots are shallow copies, and change listeners receive only keys whose values actually changed.
- `loadConfig({ env, envFiles, argv, cwd, store, skipFileValidation })` is the only async loading API. It accepts explicit sources, uses `FIELDS` for parsing/validation, normalizes explicit relative path fields against the final `configDir`, optionally writes into the supplied `ConfigStore` (or creates one), and returns a `ConfigContext` only after every enabled validation succeeds. Rejection leaves the supplied store unchanged.
- `ConfigContext.store` is the live owner, `ConfigContext.accessor` is its single-key read port, and `ConfigContext.config` is a frozen load-time snapshot. `sources`, `startupKeys`, `configDir`, and `warnings` describe the successful load without copying sensitive values into source metadata. Manual contexts must use the object factory; `startupKeys` is not an input and always comes from the complete FIELDS startup set.
- The `config.loaded` payload key is **`source`** (computed by `src/runtime/runtime.ts:sourceName(context)`), selected by first match in `argv` > `environment` > `env-files` > `memory`; mixed inputs report only the highest-priority class.
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
