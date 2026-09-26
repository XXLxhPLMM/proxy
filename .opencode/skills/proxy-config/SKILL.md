---
name: proxy-config
description: Use when configuring proxy settings, environment variables, CLI arguments, or scope/loader internals. Triggers on "config", "配置", "env", "environment", "settings", "环境变量", "cli", "命令行参数", "upstream", "scope", "loader", "FIELDS", "users.json", "acl.json".
---

# Proxy Configuration Skill

Use this skill when working with proxy configuration, environment variables, CLI arguments, or the table-driven loader.

## When to Use

- User edits `.env.*`, runs `pnpm start -- --port`, asks about defaults, or adds a new `AppConfig` field.
- Do NOT trigger for generic logging/auth questions — use `proxy-logger` / `proxy-auth` instead.

## Configuration Priority

1. CLI arguments (highest priority) — `--port 3000` / `--port=3000` / `PORT=3000`
2. Terminal environment variables — never overwritten by env files, so a launch-command value (`cross-env PROXY_PROTOCOL=http pnpm start`) always wins
3. Env-file values — order low→high: `.env.production` → `.env.development` → `.env.<NODE_ENV>`, later file wins (see `src/config/source/env-file.ts:loadEnvFiles`)
4. Preset values — `PRESET` selects a named low-priority configuration layer
5. Hardcoded defaults in `src/config/defaults.ts:defaults` (lowest)

> `.env` and `.env.local` are NOT loaded by `source/env-file.ts` — only the 3 candidates above.

## Presets

`PRESET` 选择 `src/config/presets.ts` 中的命名配置片段。Preset 是 `FIELDS` 默认回退层的一部分：默认值低于 preset，preset 低于所有显式 env/CLI 值；preset 写入后仍必须经过范围、JSON 文件和跨字段鉴权校验。未知 preset 直接按配置错误 abort，不动态加载插件。

### Field Table Design (table-driven)

`src/config/schema/fields.ts` describes every field exactly once in `FIELDS: FieldDef[]`:

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
- `phase` (required): `startup` means the value is read once by `ProxyServer.start()` into `ProxyOptions` (`proxyProtocol`/`host`/`port`/`tls*`/`clusterWorkers`) and changing it needs a restart; `runtime` means it is re-read per request or per log call and should be hot-changed through the transactional `instance.reload(patch)` (`ConfigProvider.reload` → `prepareRuntimeConfig` + `scope.commit`; there is **no** low-level `set()` that bypasses candidate validation). `logConfig()` logs the startup list at startup and `keysByPhase()` exposes it. `useHomeConfig` is `startup` too — it only picks the config dir (env-file directory and path defaults) during init, so runtime changes are meaningless.
- `int`: `{ min, max }` integer bounds, checked by `collectIntRangeErrors()` right after the table loop (out-of-range aborts startup). `parseStartupArgs()` reuses the **same** helper, so `--port 70000` / `PORT=0` also throw `越界` before any candidate is accepted.
- `def`: fallback or ` (configDir) => path.join(dir, ...)` for path fields (`~/.proxy` when `useHomeConfig` else `cwd`). `authUsersFile` / `aclFile` use this to default into the config dir.
- CLI parsing, env merge, candidate validation, and the returned scope all derive from this table — never duplicate logic; batch writes go through `ConfigScope.commit()`.
- The per-field parse loop itself is shared: `schema/validate.ts:resolveFieldEntries(source)` walks `FIELDS`, parses each explicitly-supplied value and returns `{ resolved, bad }`. `initConfig()` (source = CLI ?? env, then adds `def`/`defaults` fallback), `parseStartupArgs()` (source = parsed argv, explicit keys only), and runtime candidate validation all use the same field definitions/parsers — do not re-write a third loop.
- Boolean parsing has exactly **one** implementation: `schema/field.ts:parseBoolean` (imported by `schema/fields.ts` for the `parse: parseBoolean` rows, and by `load.ts` for the early `USE_HOME_CONFIG` look-up). Never add a local copy — drift would make the same env value resolve differently at config-dir-time vs candidate-construction-time.

## Runtime Reload & Resources

- `instance.reload(patch)` (`ConfigProvider.reload`) is the only runtime configuration mutation path. It never re-reads env, CLI, `.env` files, or presets; a patch containing any startup-phase field is rejected as a whole.
- The loader builds a complete candidate from `scope.getAll()`, reuses the FIELDS parsers/range checks/URL derivation/auth cross-field guard, and force-validates the candidate users/ACL paths. Only `scope.commit()` writes the complete Map, so a failed reload leaves the old values in place.
- There is **no** reload/refresh queue and **no** `config/reloaded` event any more: candidate construction through `commit()` has no `await` in between, so concurrent reloads cannot lose an update, and the only notification is the returned `ConfigReloadResult` (`{ changed }`). Empty or value-equivalent reloads return `changed: []` **without** committing. Failures are reported by throwing, not by a `lastFailure` field.
- `refreshConfigResource("authUsers"|"acl", path)` force-pulls the existing reader path and returns only safe path/existence/version/outcome/error metadata. `path` is required and must come from the caller's own scope. It does not add a watcher and never returns users, ACL entries, passwords, tokens, raw `Error`, or `cause`.
- Resource events are pull notifications: the cache is committed before the event, and consumers read the current value on demand. The bus is framework-free; `subscribeConfigResourceEvents` returns an idempotent disposer (the only way to unsubscribe) and isolates subscriber errors; `resources/notice.ts` remains the only resource notice sink.

## Preset Runtime Boundary

- Preset selection is startup-only. `reload()` cannot change `preset` or dynamically load the catalog's plugin names, and **no preset event exists any more** (the `preset/applied` event went away with the deleted `PresetService`).
- The catalog's `plugins` field is metadata only. It is not a dynamic loading instruction, and no code reads it.

## Validation & Guardrails

- **No silent fallback**: any explicitly supplied CLI/env value that fails to parse aborts startup (`配置校验失败: ...`) — booleans included (`AUTH_ENABLED=treu` errors).
- **Int bounds**: checked in both `initConfig()` and `parseStartupArgs()` via the shared `collectIntRangeErrors()`.
- **JSON config files (fail-closed at startup)**: `initConfig()` force-reads + validates `AUTH_USERS_FILE` and `ACL_FILE` before the scope is created (`readAuthUsers({ force, path })` / `readAcl({ force, path })`, `path` taken from the just-resolved fields). Illegal content aborts startup (`配置校验失败: AUTH_USERS_FILE=<path> ...` / `ACL_FILE=<path> ...`). Only the **paths** live in the scope; values stay in the `json-file` cache and remain hot-loadable.
- **Cross-field auth (fail-closed)**: `assertAuthConfig({ authEnabled, authType, accountCount, jwtSecret })` (exported, unit-testable) throws `配置校验失败: ...` when `authEnabled` is true and any of: `authType` ∈ `{basic, uid}` with `accountCount === 0` (an empty `users.json` would otherwise be a silent "reject everything" — the message points at `AUTH_USERS_FILE`); `authType === "none"` (auth enabled without a method = everything is allowed — a self-contradictory config; disable auth with `authEnabled=false` instead); `authType === "jwt"` with an empty `jwtSecret`. Runs in the same stage as the parse/range checks, **before** the scope is created.
- **No idempotency flag**: `initConfig()` has no `_inited` bit. Every call builds and returns a brand-new `ConfigScope`; a failing call throws and produces no scope at all, so a retry re-runs the whole chain (re-loading `.env` files is safe — terminal env is never overwritten).

## JSON Config Files (hot-load)

`cfg/users.json` (`AUTH_USERS_FILE`) and `cfg/acl.json` (`ACL_FILE`) are **runtime-hot-loaded** through `src/utils/file/json.ts:readJsonCached`:

- **mtime/size throttled stat**: at most one `stat` per file per `maxAgeMs` (default `1000` ms), so an edit takes effect within ~1s and **without restart**. `maxBytes` default `1MiB`.
- **Bad content is not adopted**: a JSON/schema error keeps the **last good snapshot**. `readJsonCached` itself never logs — it emits an edge-triggered `error` event via `opts.onEvent`; the per-instance subscription `src/config/resources/notice.ts:subscribeConfigNotices` (installed by `src/instance.ts`, fed by the `resources/acl/reader.ts` / `resources/users/reader.ts` bridges) turns it into a dedup'd `logger.notice("warn", ...)` (`[config] ... 读取失败: ...（沿用上一份有效配置）`); on recovery the event is `recovered` → `info`. Reads never throw.
- **Missing file = empty config** (not an error): ACL = all three groups empty (blocks nothing; client mode routes everything upstream), account table is empty (and, with auth on, that is caught by `assertAuthConfig` at startup).

## CLI Arguments

```bash
pnpm start -- --port 3000              # --key value
pnpm start -- --proxy-protocol=socks5  # --key=value
pnpm start -- PORT=3000                # KEY=VALUE form
pnpm start -- --auth-enabled           # bare flag → "true"
```

`KEY=VALUE` splits on the **first** `=`, so values may contain `=` (`JWT_SECRET=Zm9v==` → full `Zm9v==`), matching the `--key=value` path.

## Environment Variable Names

One name per field — there is no alias table. The `env` of every field lives in `src/config/schema/fields.ts:FIELDS`. A removed or unknown name simply is not matched (CLI keys normalise the same way, so `--proxy-type` no longer resolves; `AUTH_USERNAME` / `AUTH_PASSWORD` were removed in favour of `AUTH_USERS_FILE`).

Protocol enum (both `proxyProtocol` and `upstreamProtocol`): `http | https | socks4 | socks5 | sockss4 | sockss5` (see `src/config/types.ts:ProxyProtocol`).

## Default Values

Lowest-priority fallbacks — source of truth is `src/config/defaults.ts:defaults`, path fields get a `FIELDS.def(configDir)` pass in `initConfig()` (see below). Full table, in `FIELDS` order:

| Env Key             | Default                       | Phase   | Notes                                                                                                                       |
| ------------------- | ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `HOST`              | `0.0.0.0`                     | startup | all interfaces (container/multi-NIC friendly)                                                                               |
| `PORT`              | `3000`                        | startup | int `1..65535`                                                                                                              |
| `CACHE_TYPE`        | `memory`                      | runtime | `memory` \| `redis`                                                                                                         |
| `PROXY_PROTOCOL`    | `http`                        | startup | `http\|https\|socks4\|socks5\|sockss4\|sockss5`                                                                             |
| `AUTH_ENABLED`      | `false`                       | runtime | auth off                                                                                                                    |
| `AUTH_TYPE`         | `none`                        | runtime | `none\|basic\|jwt\|uid`                                                                                                     |
| `AUTH_USERS_FILE`   | `<configDir>/cfg/users.json`  | runtime | scope seed `cfg/users.json`, resolved by `def`                                                                              |
| `JWT_SECRET`        | `""` (empty)                  | runtime | required when `AUTH_ENABLED=true` + `AUTH_TYPE=jwt`                                                                         |
| `AUTH_LOGGING`      | `true`                        | runtime |                                                                                                                             |
| `ACL_FILE`          | `<configDir>/cfg/acl.json`    | runtime | scope seed `cfg/acl.json`, resolved by `def`; missing file = all 3 groups empty (block nothing; client mode → all upstream) |
| `LOG_LEVEL`         | `error`                       | runtime | console: `debug\|info\|warn\|error\|silent`                                                                                 |
| `LOG_FILE_LEVEL`    | `info`                        | runtime | file level, independent from `LOG_LEVEL`                                                                                    |
| `LOG_FILE`          | `<configDir>/log`             | runtime | dir **or** file path → hourly JSONL                                                                                         |
| `UPSTREAM_TIMEOUT`  | `10000` ms                    | runtime | int `min 1`; also the cluster shutdown-grace base                                                                           |
| `TLS_KEY`           | `<configDir>/keys/server.key` | startup | self-signed placeholder shipped in `keys/`                                                                                  |
| `TLS_CERT`          | `<configDir>/keys/server.crt` | startup |                                                                                                                             |
| `TLS_CA`            | `""` (empty)                  | startup | **no default file** — empty = server-only TLS, set = mTLS enforced                                                          |
| `TLS_PASSPHRASE`    | `""` (empty)                  | startup |                                                                                                                             |
| `UPSTREAM_URL`      | `""` (empty)                  | runtime | empty = use the granular `UPSTREAM_*` fields                                                                                |
| `UPSTREAM_HOST`     | `127.0.0.1`                   | runtime |                                                                                                                             |
| `UPSTREAM_PORT`     | `3000`                        | runtime | int `1..65535`                                                                                                              |
| `UPSTREAM_SECURE`   | `false`                       | runtime | force TLS to upstream; OR-ed with the protocol-derived default (`sockss4`/`sockss5` always imply TLS)                     |
| `UPSTREAM_USERNAME` | `""` (empty)                  | runtime |                                                                                                                             |
| `UPSTREAM_PASSWORD` | `""` (empty)                  | runtime |                                                                                                                             |
| `UPSTREAM_CA`       | `""` (empty)                  | runtime | **empty = system trust store**; set = _replaces_ it                                                                         |
| `UPSTREAM_INSECURE` | `false`                       | runtime | skip upstream cert verification                                                                                             |
| `UPSTREAM_PROTOCOL` | `http`                        | runtime | same enum as `PROXY_PROTOCOL`                                                                                               |
| `PROXY_MODE`        | `server`                      | runtime | `server` \| `client`                                                                                                        |
| `CLUSTER_WORKERS`   | `1`                           | startup | int `0..1024`; `0` = CPU-core count, `1` = no fork                                                                          |
| `USE_HOME_CONFIG`   | `false`                       | startup | `false` = config dir is `cwd`, `true` = `~/.proxy/`                                                                         |
| `PRESET`            | `""`                          | startup | named preset from `src/config/presets.ts`; preset values remain below explicit env/CLI values                               |

- Path fields (`AUTH_USERS_FILE` / `ACL_FILE` / `LOG_FILE` / `TLS_KEY` / `TLS_CERT`) store a **relative** seed (`cfg/users.json` …) and become absolute only after `initConfig()` runs `FIELDS.def(configDir)` — reading one of them before init yields the relative value (`cwd`-relative), after init the absolute one. `configDir` = `~/.proxy` when `useHomeConfig` else `cwd`.
- `TLS_KEY` / `TLS_CERT` / `TLS_CA` / `TLS_PASSPHRASE` only matter for `https` / `sockss4` / `sockss5`.
- Never add a default without adding it in **both** places (`defaults.ts:defaults` + a `def` in `FIELDS` for path fields), and mirror the user-facing ones into the `src/config/AGENTS.md` env table.

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

The third group `upstream` is a **routing** list (action = direct connection, blacklist beats whitelist; go upstream ⇔ hit whitelist ∧ miss blacklist, otherwise direct) and is effective **only with `PROXY_MODE=client`** — `server` mode ignores it, and both-empty keeps the go-upstream default of the old behavior. It never allows/denies: routing is judged **after** `target`, so it cannot waive a `target` denial; client mode logs one `[route]` line per allowed request (`target`, `route=direct|upstream`, plus `reason=blacklist|whitelist` when direct). Functions: `checkUpstreamRoute(host)` / `resolveRoute(dest)`.

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

- Scheme whitelist: `http` / `https` / `socks4` / `socks5` / `sockss4` / `sockss5` (case-insensitive; validated by `src/config/upstream-url.ts:parseUpstreamUrl`)
- Default port by scheme: `http:80` / `https:443` / `socks4, socks5:1080` / `sockss4, sockss5:443`
- Validation (strict — blocks startup): bad scheme, empty host, any path/query/hash, port 1-65535 outside range
- Derived fields: `upstreamProtocol/Secure/Host/Port/Username/Password` via `applyUpstreamUrl`; `UPSTREAM_CA` / `UPSTREAM_INSECURE` stay independent
- `UPSTREAM_CA` **defaults to empty** = system trust store. When set, the file is passed as `ca` and **replaces** the system store (only that CA is trusted) — leave it empty for public HTTPS upstreams, set it only for self-signed ones. Read via `src/utils/net/upstream-tls.ts:readUpstreamCa` (shared by `src/plugins/forwarders.ts` + `core/forward/dial.ts`, both fed from the frozen `ForwardPlan.upstreamTls`; non-regular files return `undefined` instead of throwing EISDIR)
- IPv6 literal hosts are accepted (`socks5://[::1]:1080`) and stored **without** brackets (`upstreamHost === "::1"`), since `net.connect`/DNS reject the bracketed form
- Snapshot logging masks userinfo (`//***@`)

## Config Scope

`src/config/store.ts`（进程级单例 `export const config = new Map(...)`）已删除。配置只存在于
每实例一份的 `ConfigScope`（`src/config/scope.ts`）上，读写都必须显式拿到 scope：

```typescript
import { createConfigScope, type ConfigScope } from "@b-hole/proxy";

// 组合根/库消费方：createConfigScope() 播种 defaults，或传入 seed 覆盖个别字段
const scope: ConfigScope = createConfigScope({ port: 8080 });
const port = scope.get("port");        // 现取（活的，不是快照）
const all = scope.getAll();            // 浅拷贝快照，调用方不得原地改
scope.commit({ ...all, logLevel: "debug" }); // 唯一批量写边界，必须给全字段
```

`instance.config.scope` 是库消费方拿到 scope 的正规入口；`scope.get()` 现取，所以鉴权/ACL/路由
的每请求读取自动跟随热重载，不需要各自实现失效逻辑。

`initConfig()` 不再在模块导入时自动执行；CLI/库入口必须显式调用（`createProxyInstanceFromEnv`
内部调它），隔离代码直接调用 `initConfig()`。**没有幂等位**：每次调用产出一个全新 scope，
同进程可持有任意多个互不可见的实例配置。

## Adding New Config

1. Add field to `AppConfig` in `src/config/types.ts` + `defaults` in `src/config/defaults.ts`
2. Add ONE row to `FIELDS` in `src/config/schema/fields.ts` — `{ key, env, parse, phase }` are required; add `int: { min, max }` for bounded integers
3. Update the `src/config/AGENTS.md` env-key table if user-facing
