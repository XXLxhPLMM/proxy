# 账号表（`AUTH_USERS_FILE` / `cfg/users.json`）

> **按需分册**：skill 只自动加载 `SKILL.md`（读它的 frontmatter 决定要不要用），同目录的 `*.md` 分册**不会**被自动灌进上下文。
> **什么时候读**：写或改 `users.json`、查字段形状与 `uid` / Basic 两种匹配形态、账号级 `acl` 与 `quota` 两个可选字段时

### Accounts table (`AUTH_USERS_FILE`, default `<configDir>/cfg/users.json`)

```json
[
  { "username": "alice", "password": "pw1" },
  { "username": "bob", "password": "" }
]
```

Each account may additionally carry an optional **`acl`** (per-user target list) and an optional **`quota`** (per-user traffic quota) — both are documented, validated and enforced; see "Account Table Usage" below and `cfg/users.json.example.md`.

- `basic` passes when the token matches **any** account's `username`+`password`; `uid` passes when it matches **any** `username` (password ignored). Duplicate names, unknown fields, a non-array top level, an empty `username` or one containing `:` all fail validation (`src/config/files/users.ts:validateAuthUsers`).
- **Empty-account hard rule (`src/config/schema/validate.ts:assertAuthConfig`, fail-closed)**: with `AUTH_ENABLED=true` and normal file validation enabled, `loadConfig()` rejects with `配置校验失败: ...` (same stage as parse/range checks, before the target store changes) when any of these is true. Passing `skipFileValidation: true` skips both the file read and this cross-field check, so the caller owns validation:
  - `AUTH_TYPE` ∈ `{basic, uid}` and the account table is empty (`accountCount === 0`) — the real cause is usually a wrong/missing `AUTH_USERS_FILE`; a silent "reject everything" is not allowed;
  - `AUTH_TYPE=none` — enabling auth without choosing a method means everything is allowed; the way to disable auth is `AUTH_ENABLED=false`;
  - `AUTH_TYPE=jwt` with an empty `JWT_SECRET`.
- A **blank password** is allowed — it just means "username only".
- The file is validated at startup: illegal JSON/shape aborts startup; **a missing file is an empty table** (not an error by itself). At runtime the file is hot-reloaded (mtime throttled 1s); bad content or a non-missing stat/read error such as `EACCES` keeps the last good table and emits an error. Only `ENOENT`, `ENOTDIR`, and non-regular files count as missing; relative paths are absolutized before caching.

### Account Table Usage (`cfg/users.json`)

Everything above _validates_ the table; this is how you actually drive it.

**Schema** — a top-level array, and only these **five** keys per item (`ACCOUNT_KEYS = {username, password, acl, quota, expiresAt}` in `src/config/files/users.ts`; the last three are all optional — see below):

```json
[
  { "username": "alice", "password": "pw1" },
  { "username": "bob", "password": "" },
  { "username": "carol", "password": "pw3",
    "acl":   { "target": { "whitelist": ["*.corp.com"] } },
    "quota": { "bytes": 53687091200, "window": "month" } },
  { "username": "trial", "password": "pw4",
    "expiresAt": "2026-12-31T23:59:59+08:00" }
]
```

| Rule                                                                         | Enforced by         | On violation                           |
| ---------------------------------------------------------------------------- | ------------------- | -------------------------------------- |
| top level must be an array                                                   | `validateAuthUsers` | startup abort / runtime keep-last-good |
| item must be an object, keys ⊆ `{username, password, acl, quota, expiresAt}`  | same                | same                                   |
| `username`: non-empty string, no `:` (Basic is `user:pass`)                  | same                | same                                   |
| `password`: must be a string — blank (`""`) is legal = username-only account | same                | same                                   |
| no duplicate `username`                                                      | same                | same                                   |
| `acl`: optional; **only** a `target` group; entry grammar identical to the global `acl.json` `target` list | `validateUserPolicy` (entries via `rules/host.ts:parseHostRule`) | whole file illegal → startup abort |
| `quota`: optional; each of `bytes`/`window` itself optional; `bytes` must be a non-negative safe integer, `window` ∈ `{day, month}` (default `month`) | `validateUserQuota` (closed `QUOTA_KEYS`) | whole file illegal → startup abort |
| `expiresAt`: optional; ISO 8601 **with a mandatory timezone offset** (`Z` or `±HH:MM`) | `normalizeAccountExpiry` | whole file illegal → startup abort |

**`ACCOUNT_KEYS` is the single easiest thing to miss when adding an optional field**: any key not in that set makes *every* file carrying it illegal via the "unknown top-level key" rule. There is a dedicated assertion plus a mutation test for it (removing `quota` → 10+ red).

**The three optional fields are validated independently but each one alone decides the whole file's fate**: when one is valid and the other is not, the **whole file is rejected** (fail-closed) rather than silently dropping the bad one — a half-dropped field is exactly the "I configured it and it silently did nothing" failure mode. All three are **invisible to the credential indexes** (they never enter `basic`/`uidUsers` and change no comparison).

**Per-user enforcement (all three fields are wired, not just parsed)**:
- `acl.target` — `access.checkTarget({ host, user })` (the `AccessControl` port; the built-in file-driven implementation is `core/access-control.ts:createFileAccessControl(config).checkTarget`) judges two lists: `allow ⇔ global target allows ∧ this user's target allows`, **global first with a global rejection short-circuiting**; both refusing reports the **global** one (`source:"global"`). Never participates in `checkClient` (runs before auth) nor in the `checkRoute` routing group.
- `quota` — metering and the exhausted verdict live in `src/datasource/quota/` (not here): `UsageMirror.consume` decides "is it over" against the **single combined cap** `quota.bytes` (upload + download counted together), rejecting once the running total **exceeds** it, with **exactly hitting the cap still allowed**. There is deliberately **no per-direction cap**: exhaustion is an account-wide ban, so `bytesUp` alone would really mean "the whole account dies, and only after upload is maxed out" — shaping bytes per direction is a rate-limiter job. Enforcement is a **hard cut** (HTTP without headers → 507, otherwise `destroy()`), never "refuse new requests, leave existing ones" — a long-lived tunnel would otherwise never trip the check. With `AUTH_ENABLED=false` there is no identity, so quotas are not applied at all and startup emits a `[quota-inert]` warn. Usage is persisted to `<QUOTA_LEDGER_DIR>/quota.db` (or `usage.jsonl`) so it survives a restart. That file is the **global** truth shared by every process, while **real-time judgement still runs per process** off a mirror of it — a mirror that is re-read once per `QUOTA_FLUSH_INTERVAL`, so another process's bytes become visible within `2 × QUOTA_FLUSH_INTERVAL` (`datasource/quota/mirror.ts:mirrorLagBoundMs`). With `CLUSTER_WORKERS=N` each process still judges its own copy, so the ceiling is `N × quota.bytes` **plus** that lag; **remaining = `bytes - usage(user)`** (no separate `remaining` entry point — that is pure subtraction, and "what does it return when unlimited" has no good answer).
- `expiresAt` — judged at the **authentication point** in `core/identity/token.ts:TokenIdentityBase.identify`, i.e. **after** the credential matched, never inside the credential indexes (an expired account dropped from the index would stop being recognized on the outbound strip path, so its `Proxy-Authorization` would be forwarded to the target site verbatim — credentials not recognized ≠ credentials absent). Rejected once `now >= expiresAt` (**exactly** hitting the instant is already refused — the opposite of the quota's "exactly hitting the cap still allowed", because an expiry is the *end* of an authorization while a cap is a *limit* on consumption). The `auth.decided` audit carries `user` plus `reason:"account-expired"`. **Already-established tunnels are not cut**: a CONNECT / SOCKS session authenticates once and runs until it drops, while the next request on an HTTP keep-alive connection re-authenticates and is refused. **A past timestamp is a legal value** (it is precisely the state the field exists to express); only a malformed *shape* rejects the file. ⚠️ **It does not apply under `AUTH_TYPE=jwt`** — jwt identity comes from the token itself (`sub` / `exp`) and the decision never consults the account table, so a deployment that configures it gets an `[account-expiry-inert]` startup warn (and the fix is to use the token's `exp`, or switch to `basic` / `uid`). Fully **orthogonal to `quota`**: an expired account does not clear recorded usage. Because `Date.parse` silently guesses a timezone for `"2026-10-01"` (UTC midnight) and `"2026-10-01 00:00"` (local midnight) — an 8-hour spread between hosts for one config — no-offset / date-only / space-separated forms are all rejected, as are days absent from the calendar (`Date.parse("2026-02-30T00:00:00Z")` returns a finite value, silently rolling into March).

Full per-field walkthrough: `cfg/users.json.example.md` (the example JSON itself must stay comment-free — `users.json` is `JSON.parse` input and **any** comment makes the whole file unparseable → startup abort).

**Lifecycle**

- **Startup validation**: `loadConfig()` directly reads it with `readAuthUsersAsync(resolvedPath)` before committing the target store. Illegal JSON/shape rejects with `配置校验失败: AUTH_USERS_FILE=<path> ...`. **Only `ENOENT` counts as "missing" on this startup path** — it yields an empty table, which then trips `assertAuthConfig` if `AUTH_ENABLED=true` + `basic`/`uid` and file validation is enabled. **Every other read failure aborts** (`ENOTDIR`, the path being a directory, `EACCES`, oversize, …): the startup readers do *not* share the hot path's `ENOENT`/`ENOTDIR`/non-regular-file rule (see the Runtime bullet below for that one).
- **Runtime**: hot-reloaded through `loadAuthUsers(configAccessor, onFileEvent?)` → `src/utils/json-file/index.ts:readJsonCached` (mtime throttle 1s, `maxBytes` 1MiB). **Add/remove/rename an account by editing the file — no restart.** Relative paths are made absolute before entering the cache. A bad edit or non-missing stat/read error (for example `EACCES`) keeps the last good table and emits an error; only `ENOENT`, `ENOTDIR`, and non-regular files are missing. The composition layer explicitly renders it with `createJsonFileEventHandler(logger)` / `logJsonFileEvent(event, logger)`, so errors/missing files warn and recovery/reload reports info.
- The owning store holds only the **path** (`AUTH_USERS_FILE` is runtime phase, so `store.set("authUsersFile", ...)` retargets subsequent reads); parsed accounts live in the shared path/label cache, while each accessor selects the path it reads.

**How each `AUTH_TYPE` consumes it**

| `AUTH_TYPE` | Plugin                | Match rule                                                                                                                                                                          | Client credential form                                                             |
| ----------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `basic`     | `basicIdentity()`     | token matches **any** account's `username`+`password` (O(1) index, built by `buildCredentialIndexes`)                                                                             | `Proxy-Authorization: Basic b64(user:pass)`, or plain `user:pass` token            |
| `uid`       | `uidIdentity()`       | matches **any** account's `username`, password ignored                                                                                                                            | 4 shapes accepted: bare `username`, `user:pass`, `b64(user:pass)`, `b64(username)` |
| `jwt`       | `jwtIdentity()`       | delegated to the injected `verify` (production: `defaultJwtVerify` = HS256, `JWT_SECRET`, unexpired); username = `sub/username/user/uid/id` claim; the same verified token is stripped from outbound `Authorization` | `Proxy-Authorization: Bearer <jwt>`                                                |
| `none`      | `noneIdentity()`      | n/a                                                                                                                                                                               | n/a — and `AUTH_ENABLED=true` + `none` is a **startup error**                      |

`AUTH_TYPE` only selects which plugin the **default** `FileAccountIdentity` behaves like. It does **not** select the protocol's auth implementation — a library caller picks that by injecting a plugin, and config cannot express "custom plugin".

- SOCKS: `socks5`/`sockss5` use RFC 1929 user/pass; `socks4`/`sockss4` carry only `USERID` (no password field) — so under `basic`, `USERID == username` also passes, and `uid` is the natural fit for socks4 clients.
- Header-stripping shares **one** predicate with identification: `IdentityProvider.isOwnCredential(name, value)`. Under `basic`/`uid` it walks the whole account table to decide whether `Authorization` belongs to the proxy (2 accounts means 2 candidate values checked, never just the first); under `jwt` it re-verifies the token with the built-in HS256 checker (no table needed), so a `Bearer <proxy JWT>` fallback header never reaches the origin. **That sharing is not an optimisation, it is the security property**: if the predicate read one source and identification read another, a credential that passes identification would not be stripped — the original leak. Hence `createIdentityFromConfig` builds `isOwnCredential` and `identify` on the **same** `live()` closure.
