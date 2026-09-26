---
name: proxy-auth
description: Use when configuring proxy authentication, Basic/JWT verification, the users.json account table, the acl.json access-control lists, or Proxy-Authorization header handling. Triggers on "auth", "认证", "token", "jwt", "login", "password", "用户名", "密码", "basic", "bearer", "proxy-authorization", "鉴权", "users.json", "多账号", "acl", "acl.json", "访问控制", "黑白名单", "白名单", "黑名单", "whitelist", "blacklist", "403", "denied", "ip-denied", "target-denied".
---

# Proxy Authentication Skill

Use this skill when working with proxy authentication, credential verification, or `Proxy-Authorization` header extraction.

## When to Use

- User enables/disables auth, sets `AUTH_TYPE`/`AUTH_USERS_FILE`/`JWT_SECRET`, edits `cfg/users.json`, writes `cfg/acl.json`, or debugs 407 / 403.
- Do NOT trigger for generic config/env names or defaults — use `proxy-config` instead (this skill owns account-table and ACL _usage_; `proxy-config` owns the `AUTH_*` / `ACL_FILE` env rows).

## Mechanism

Accounts are a **list** loaded from `AUTH_USERS_FILE` (`users.json`), not a single env username/password. See `src/core/AGENTS.md` → 鉴权 for the internals (async `authenticate()` returning `AuthResult` with the matched username, header-only token extraction (RFC 7235), per-account Basic/uid index for O(1) comparison — built in `src/core/helpers/credentials.ts`, consumed by `Auth` so header-stripping shares one predicate, JWT `defaultJwtVerify` (a thin wrapper over `helpers/credentials:verifyHs256Jwt`) built-in HS256 verification with `jwtVerify` override, outbound `Authorization` stripping that covers JWT mode too, `authLogging` flag). This skill only documents config recipes, client usage, and troubleshooting.

`credentials.ts` also owns **`buildProxyAuthValue(b64)`**: it prefixes `AUTH_SCHEME_BASIC` to a base64 payload and returns the complete `Proxy-Authorization` header value (`"Basic " + b64`). It is **deliberately separate** from `encodeBasicCredentials(user, pass)`, which only produces the base64 payload — the two callers that need a whole header value are `core/helpers/upstream.ts` (upstream Basic credentials) and `core/server/socks-session.ts` (SOCKS upstream auth), and the encoding must exist only once. `@/utils/constants/index.js` is therefore a zero-dependency pure-value module again (no functions). Index/matching/HS256 semantics are unchanged by this move.

### Construction and configuration boundary

- `new Auth(options)` consumes only the explicit `AuthOptions` passed by the caller. It never reads a store, accessor, environment, or account-file path on its own:

  ```typescript
  const auth = new Auth({
    enabled: true,
    type: "basic",
    accounts: [{ username: "alice", password: "pw1" }],
    enableLogging: false,
  });
  ```

- `createAuthProvider(options, config)` also requires an explicit `ConfigAccessor`. The accessor is used only to supply the default `enableLogging` value from `authLogging`; an explicit `options.enableLogging` wins. Other auth behavior remains exactly what `options` specifies.
- `createAuthFromConfig(config, onFileEvent?)` requires the same explicit accessor and dynamically reads `authEnabled`, `authType`, `jwtSecret`, `authLogging`, and `authUsersFile` on each authentication. The optional callback receives the users-file hot-load event; it is not a hidden global logger hook.
- `createProxyRuntime()` wires its default provider with `runtime.context.accessor` and explicitly passes its JSON-event callback. A provider supplied through `services.auth` replaces the default. There is no omitted-argument form and no implicit module-level configuration fallback. In pure-memory mode, an optional `configDir` anchors and absolutizes all path fields at construction; later `process.chdir()` does not move existing file paths.

### Scheme & token rules (`src/core/auth.ts:extractToken`)

- Scheme prefix is **case-insensitive** (RFC 7235): `Basic `, `basic `, `BASIC `, `Bearer `, `bearer ` all strip correctly. Stripping still slices by the constant length, so the token keeps its original case.
- `Proxy-Authorization` wins; `Authorization` is the fallback. Header lookup is case-insensitive (Node header names vary).

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

### Authorization fallback must not leak to the origin

`Authorization` is accepted as a proxy-credential fallback, but it is also the end-to-end header a client sends **to the target**. Before forwarding (HTTP/HTTPS request path and the WebSocket upgrade path), `sanitizeHeaders(headers, config)` / `buildUpgradeReq(..., config)` drop it when it matches the proxy's own credential — `src/core/helpers/headers.ts:isProxyCredentialValue(value, config)`. The owning `ConfigAccessor` is required on every call, so stripping follows the same auth settings and account file as the gate:

- `basic` / `uid`: walks the **whole account table** (Basic `encodeBasicCredentials(user, pass)` / the bare username / the uid forms);
- `jwt`: strips any scheme prefix, then verifies the token with the built-in HS256 checker (`verifyHs256Jwt` + `JWT_SECRET`) — **no account table needed** (JWT mode allows an empty table). This closes the leak where a client authenticates with `Authorization: Bearer <proxy JWT>` and that JWT would otherwise be forwarded to the origin.

Any other value (e.g. `Authorization: Bearer <target-token>`) is forwarded untouched. Known boundary: a custom injected `jwtVerify` is not visible to this predicate — it only recognises the built-in HS256 verifier (the production default wired by `createAuthFromConfig(config, onFileEvent?)`). The direction is deliberately "strip more, never leak".

### Auth result & tunnel tag

- `authenticate()` returns `AuthResult` `{ passed: boolean; username?: string }` (was a plain `boolean`). On allow the **matched username** is carried up and injected into the connection's log lines as `user`.
- The audit `tag` is `"tunnel"` **only** when `ctx.req.method === "CONNECT"` or `ctx.protocol.startsWith("socks")`. It is NOT derived from `authority` (a normal request's `Host` routinely carries a `:port`, which would mislabel every request as a tunnel). `AuthRequestLike.method` exists for this check. The value was normalised from the old `"tunnel "` (trailing space) so JSONL can match it exactly.
- `ProxyAuthEvent` dropped `expected` — with many accounts that field was noise; deny audits keep `attempted`/`reason`.

## Configuration

### Enable Basic Auth

```env
AUTH_ENABLED=true
AUTH_TYPE=basic
AUTH_USERS_FILE=./cfg/users.json
```

`cfg/users.json`:

```json
[
  { "username": "admin", "password": "secret" },
  { "username": "guest", "password": "guest123" }
]
```

Copy `cfg/users.json.example` and edit, or write your own; the file is gitignored (it holds plaintext passwords).

### Account Table Usage (`cfg/users.json`)

Everything above _validates_ the table; this is how you actually drive it.

**Schema** — a top-level array, and only these **four** keys per item (`ACCOUNT_KEYS = {username, password, acl, quota}` in `src/config/files/users.ts`; `acl` and `quota` are both optional — see below):

```json
[
  { "username": "alice", "password": "pw1" },
  { "username": "bob", "password": "" },
  { "username": "carol", "password": "pw3",
    "acl":   { "target": { "whitelist": ["*.corp.com"] } },
    "quota": { "bytesTotal": 53687091200, "window": "month" } }
]
```

| Rule                                                                         | Enforced by         | On violation                           |
| ---------------------------------------------------------------------------- | ------------------- | -------------------------------------- |
| top level must be an array                                                   | `validateAuthUsers` | startup abort / runtime keep-last-good |
| item must be an object, keys ⊆ `{username, password, acl, quota}`            | same                | same                                   |
| `username`: non-empty string, no `:` (Basic is `user:pass`)                  | same                | same                                   |
| `password`: must be a string — blank (`""`) is legal = username-only account | same                | same                                   |
| no duplicate `username`                                                      | same                | same                                   |
| `acl`: optional; **only** a `target` group; entry grammar identical to the global `acl.json` `target` list | `validateUserPolicy` (entries via `rules/host.ts:parseHostRule`) | whole file illegal → startup abort |
| `quota`: optional; each of `bytesUp`/`bytesDown`/`bytesTotal`/`window` itself optional; byte fields must be non-negative safe integers, `window` ∈ `{day, month}` (default `month`) | `validateUserQuota` (closed `QUOTA_KEYS`) | whole file illegal → startup abort |

**`ACCOUNT_KEYS` is the single easiest thing to miss when adding an optional field**: any key not in that set makes *every* file carrying it illegal via the "unknown top-level key" rule. There is a dedicated assertion plus a mutation test for it (removing `quota` → 10+ red).

**`acl` and `quota` are validated independently but each one alone decides the whole file's fate**: when one is valid and the other is not, the **whole file is rejected** (fail-closed) rather than silently dropping the bad one — a half-dropped field is exactly the "I configured it and it silently did nothing" failure mode. Both are **invisible to the credential indexes** (`acl`/`quota` never enter `basic`/`uidUsers` and change no comparison).

**Per-user enforcement (both fields are wired, not just parsed)**:
- `acl.target` — `core/access-control.ts:checkTargetHost(host, config, user?)` judges two lists: `allow ⇔ global target allows ∧ this user's target allows`, **global first with a global rejection short-circuiting**; both refusing reports the **global** one (`source:"global"`). Never participates in `clientIp` (runs before auth) nor in the `upstream` routing group.
- `quota` — metering and the exhausted verdict live in `src/core/traffic/` (not here): `MemoryTrafficAccount.consume` decides "is it over" in the order `bytesUp` → `bytesDown` → `bytesTotal`, rejecting if **any** is breached, with **exactly hitting a cap still allowed**. Enforcement is a **hard cut** (HTTP without headers → 507, otherwise `destroy()`), never "refuse new requests, leave existing ones" — a long-lived tunnel would otherwise never trip the check. With `AUTH_ENABLED=false` there is no identity, so quotas are not applied at all and startup emits a `[quota-inert]` warn. Usage is persisted to `<QUOTA_LEDGER_DIR>/worker-<slot>.jsonl` so it survives a restart.

Full per-field walkthrough: `cfg/users.json.example.md` (the example JSON itself must stay comment-free — `users.json` is `JSON.parse` input and **any** comment makes the whole file unparseable → startup abort).

**Lifecycle**

- **Startup validation**: `loadConfig()` directly reads it with `readAuthUsersAsync(resolvedPath)` before committing the target store. Illegal JSON/shape rejects with `配置校验失败: AUTH_USERS_FILE=<path> ...`. **Only `ENOENT` counts as "missing" on this startup path** — it yields an empty table, which then trips `assertAuthConfig` if `AUTH_ENABLED=true` + `basic`/`uid` and file validation is enabled. **Every other read failure aborts** (`ENOTDIR`, the path being a directory, `EACCES`, oversize, …): the startup readers do *not* share the hot path's `ENOENT`/`ENOTDIR`/non-regular-file rule (see the Runtime bullet below for that one).
- **Runtime**: hot-reloaded through `loadAuthUsers(configAccessor, onFileEvent?)` → `src/utils/json-file/index.ts:readJsonCached` (mtime throttle 1s, `maxBytes` 1MiB). **Add/remove/rename an account by editing the file — no restart.** Relative paths are made absolute before entering the cache. A bad edit or non-missing stat/read error (for example `EACCES`) keeps the last good table and emits an error; only `ENOENT`, `ENOTDIR`, and non-regular files are missing. The composition layer explicitly renders it with `createJsonFileEventHandler(logger)` / `logJsonFileEvent(event, logger)`, so errors/missing files warn and recovery/reload reports info.
- The owning store holds only the **path** (`AUTH_USERS_FILE` is runtime phase, so `store.set("authUsersFile", ...)` retargets subsequent reads); parsed accounts live in the shared path/label cache, while each accessor selects the path it reads.

**How each `AUTH_TYPE` consumes it**

| `AUTH_TYPE` | Match rule                                                                                                                                                                       | Client credential form                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `basic`     | token matches **any** account's `username`+`password` (O(1) index, built by `buildCredentialIndexes`)                                                                            | `Proxy-Authorization: Basic b64(user:pass)`, or plain `user:pass` token            |
| `uid`       | matches **any** account's `username`, password ignored                                                                                                                           | 4 shapes accepted: bare `username`, `user:pass`, `b64(user:pass)`, `b64(username)` |
| `jwt`       | delegated to `defaultJwtVerify` (HS256, `JWT_SECRET`, unexpired); username = `sub/username/user/uid/id` claim; the same verified token is stripped from outbound `Authorization` | `Proxy-Authorization: Bearer <jwt>`                                                |
| `none`      | n/a                                                                                                                                                                              | n/a — and `AUTH_ENABLED=true` + `none` is a **startup error**                      |

- SOCKS: `socks5`/`sockss5` use RFC 1929 user/pass; `socks4`/`sockss4` carry only `USERID` (no password field) — so under `basic`, `USERID == username` also passes, and `uid` is the natural fit for socks4 clients.
- Header-stripping shares one predicate with auth (`isProxyCredentialValue`): under `basic`/`uid` it walks the whole account table to decide whether `Authorization` belongs to the proxy (2 accounts means 2 candidate values checked, never just the first); under `jwt` it re-verifies the token with the built-in HS256 checker (no table needed), so a `Bearer <proxy JWT>` fallback header never reaches the origin.

### Access Control (`cfg/acl.json`)

```env
ACL_FILE=./cfg/acl.json          # default <configDir>/cfg/acl.json; missing file = block nothing
```

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "10.0.0.0/8"], "blacklist": ["203.0.113.7"] },
  "target": { "whitelist": ["*.example.com"], "blacklist": ["ads.example.net", "198.51.100.0/24"] },
  "upstream": { "whitelist": ["*.example.com"], "blacklist": ["secret.example.com"] }
}
```

Three independent groups, one file, one hot-reload. `clientIp`/`target` may be omitted (≡ empty); `upstream` may be omitted (≡ empty = everything goes upstream in client mode); unknown top-level or per-group keys → `配置校验失败: ACL_FILE=<path> ...` at startup. Only `ENOENT`, `ENOTDIR`, and non-regular files count as missing; other stat errors keep the last valid ACL and emit an error.

**Entry syntax** (validated by `src/config/files/acl.ts:validateList` → the entry rule layer `src/config/files/rules/`: `parseIpRule` in `rules/ip.ts`, `parseHostRule` in `rules/host.ts`):

| Group      | Accepts                                                          | Rejects                                            |
| ---------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| `clientIp` | IP / CIDR only (`1.2.3.4`, `10.0.0.0/8`, `::1`, `2001:db8::/32`) | domains — the TCP peer is always an IP             |
| `target`   | IP / CIDR / exact domain / `*.domain`                            | ports, paths, IDN (write punycode), `_`, non-ASCII |
| `upstream` | same as `target`: IP / CIDR / exact domain / `*.domain`          | ports, paths, IDN (write punycode), `_`, non-ASCII |

- `*.a.com` matches sub-domains of `a.com` **only**, not `a.com` itself (exact and wildcard are separate responsibilities — list both).
- Ports are never allowed in an entry, and bracket stripping is strict: `normalizeIp` peels `[...]` only when the value both starts with `[` and ends with `]`, so **`[::1]:443` is rejected** and `[::1]` is a valid IPv6 literal. This was intentionally not loosened when the matchers moved out of `utils`.
- `10.0.0.5/24` ≡ `10.0.0.0/24` (host bits are masked); `0.0.0.0/0` matches all; IPv4 vs IPv6 rules never cross-match.
- Domains are matched as **strings** against the requested host (lowercased, trailing dot and `[...]` stripped) — **no DNS resolution**. Consequence: a domain entry does **not** cover a client that dials the IP directly (true for `target` and `upstream` alike — to close both ends, list IP/CIDR entries too).

**Semantics**

- `clientIp` / `target` (identical): blacklist hit → **deny** (wins); else whitelist non-empty && not hit → deny; both empty → allow.
- `upstream` (**action = route, never allow/deny**; **effective only with `PROXY_MODE=client`** — `server` mode ignores the group): blacklist hit → **direct** (**black beats whitelist**, unconditional); else whitelist non-empty && not hit → direct; both empty (group or file missing) → **upstream** (default, byte-for-byte the old behavior). Formula: **go upstream ⇔ hit whitelist ∧ miss blacklist; everything else → direct** — whitelist = the circle of upstream eligibility (outside defaults to direct), blacklist = a veto inside the circle (a named entry goes direct, whoever covers it).

Quick reference: both empty → all upstream | blacklist only → named direct, rest upstream | whitelist only → in-circle upstream, outside direct | both → whitelist grants eligibility + blacklist vetoes (black wins).

**Where it is judged** (order per allowed request: `clientIp` → auth → `target` → route → dial):

1. `checkClientIp(socket.remoteAddress, config)` — **first line** of `core/server/http.ts:handleForward()` and `socks-base.ts:onConn()`, i.e. **before auth**: a blacklisted IP gets dropped, never a 407. Deliberately ignores `X-Forwarded-For`/`X-Real-IP` (client-forgeable; those two are only used for auth audit display). `::ffff:1.2.3.4` is normalized to IPv4 (mandatory for Windows/dual-stack). Unresolvable address + a configured whitelist → deny (fail-closed).
2. Authentication runs next (a `clientIp` pass is **not** an auth bypass — failures still return `407`).
3. `checkTargetHost(host, config, user?)` — on all four forward paths (http / CONNECT tunnel / websocket upgrade / socks), once the target is resolved, **after auth and before dialing**, next to the `isSelfLoop` guard. The judged object is **what the client asked for** (absolute-form request-target authority, falling back to `Host`) — **independent of `proxyMode`**: in `client` mode the dial target is the upstream, and `UPSTREAM_*` is never subject to these lists. `user` is injected by `ForwarderBase.preDial` from `scope.user`; omit it and only the global layer runs.
4. `checkUpstreamRoute(host, config)` — **client mode only**, immediately after the `target` check and before dialing: decides the route (`resolveRoute(dest, config)` returns the effective mode; a bypass hit resolves to `direct` per server semantics). It never allows or denies — **the route lists cannot waive a `target` denial** (a denied request never reaches routing).

**`[route]` log**: one line per allowed request in client mode with fields `target`, `route=direct|upstream`, and `reason=blacklist|whitelist` when the route is direct — `jq 'select(.msg=="[route]")'`. `server` mode logs nothing (the group is ignored).

**Deny behavior**: HTTP/CONNECT/upgrade → `403 Forbidden` (list decisions are credential-unrelated, deliberately never `407`); SOCKS behaves **per layer**: a `clientIp` denial drops the connection **before the handshake** (no protocol reply — there is not even a target to parse yet), while a `target` denial sends a SOCKS **failure reply** (the handshake already parsed the target by then, so silently dropping would leave the client waiting for bytes that never come). One warn per denial: `[ip-denied]` (`client`/`reason`) or `[target-denied]` (`target`/`host`/`reason`), `reason` ∈ `whitelist` | `blacklist`.

**Lifecycle**: same fail-closed/hot-load contract as `users.json` — `loadConfig()` uses `readAclAsync(resolvedPath)` before committing and rejects illegal content (unknown keys or entries such as `192.168.*.*` / `example.com:8080`); **only `ENOENT` is treated as missing on this startup path** (→ all three groups empty, i.e. block nothing; client mode routes everything upstream), every other read failure aborts. At runtime, `loadAcl(configAccessor, onFileEvent?)` reads the same accessor-bound file, edits land within ~1s, and a bad edit or non-missing stat/read error such as `EACCES` keeps the last good snapshot and emits an error instead of silently allowing all traffic — **here** (the `readJsonCached` hot path) the missing set is `ENOENT` / `ENOTDIR` / non-regular files, and every other stat error is `stat-error`, never disguised as missing. Relative paths are absolutized before caching. The explicitly supplied logger renders the event. Regression guards: `tests/integration/client-mode-acl.test.ts`.

### JWT Configuration

```env
AUTH_ENABLED=true
AUTH_TYPE=jwt
JWT_SECRET=your-secret-key-here
# Built-in HS256 verification is wired by default (createAuthFromConfig → defaultJwtVerify):
# no jwtVerify injection is needed. Tokens must be alg=HS256, signed with JWT_SECRET, unexpired.
# A verified proxy JWT sent via the Authorization fallback is stripped before forwarding to the origin.
# A directly constructed new Auth({ type: "jwt" }) without jwtVerify denies during
# authentication ("JWT auth requires jwtVerify", caught fail-closed).
```

### Disable Auth Logging

```env
AUTH_LOGGING=false
```

Env names are single source of truth in `proxy-config` skill (`AUTH_ENABLED`, `AUTH_TYPE`, `AUTH_USERS_FILE`, `JWT_SECRET`, `AUTH_LOGGING`, `ACL_FILE`) — including their defaults; this skill owns the file _contents_ and runtime behavior.

## Client Usage

### Basic Auth

```bash
# curl with Proxy-Authorization header (correct — not "-Proxy-authorization")
curl -x http://localhost:3000 -H "Proxy-Authorization: Basic YWRtaW46c2VjcmV0" http://example.com

# via http_proxy env (curl auto-sends Proxy-Authorization)
export http_proxy="http://admin:secret@localhost:3000"
curl http://example.com
```

### Bearer Token

```bash
curl -x http://localhost:3000 -H "Proxy-Authorization: Bearer <your-jwt-token>" http://example.com
# Fallback header also accepted: Authorization: Bearer <token>
```

## Common Auth Issues

### 1. Auth Enabled But Not Working

- Is `AUTH_ENABLED=true` and `AUTH_TYPE` is `basic` or `jwt` (not `none`)?
- Are credentials correct? Basic compares `Basic <b64>` or plain `user:pass` against the compiled account index in `Auth.matchBasic()` / `helpers/credentials:matchBasicCredential`.
- Is the account table empty? `AUTH_ENABLED=true` + `basic|uid` + empty table is a hard startup error (`assertAuthConfig`); check that `AUTH_USERS_FILE` points at a non-empty, valid `users.json`. A blank password is fine (username-only).

Debug: `pnpm start -- --log-level debug` and watch `[auth]` events from `src/server/index.ts:bindProxyEventLogs`.

### 2. Token Not Being Extracted

- Header must be `Proxy-Authorization` (preferred) or `Authorization` fallback, with scheme prefix `Basic <b64>` / `Bearer <jwt>` — matched **case-insensitively** (`src/core/auth.ts:extractToken`).
- Cookie/URL token carrying is removed (non-standard, leaks into logs/origin); use headers only.

### 3. JWT Verification Fails

- Is `JWT_SECRET` set (an empty secret is a startup error)? Is the token `alg=HS256`, signed with `JWT_SECRET`, and unexpired? The default verifier (`src/core/auth.ts:defaultJwtVerify`, a thin async wrapper over `src/core/helpers/credentials.ts:verifyHs256Jwt`) checks all three — wrong secret, non-HS256 alg (e.g. `none`), malformed shape or expired `exp` → deny. An explicitly injected `jwtVerify` (provider setter or `AuthOptions`) takes precedence; a directly constructed `Auth` without injection is caught inside `authenticate()` and treated as a plain deny — so the `[auth] deny` audit event is still emitted (this path can never produce `allow`).

### 4. Auth Logging Disabled

Set `AUTH_LOGGING=false` to suppress `[auth] allow/deny` events. `Auth` itself is zero-log; details are emitted via `AuthContext.onAuthEvent` and logged centrally.

### 5. 403 (Not 407) — the ACL, Not Auth

- A `403 Forbidden` (HTTP/CONNECT/upgrade) or a failed/dropped SOCKS connection means a list denied it — `clientIp` runs **before** auth (a blacklisted source never sees a 407) and `target` runs after auth but **before dialing**; either way a list decision is credential-unrelated, so it is `403`, never `407`. With a per-user `acl.target` in play, read the `source=` segment of the `[target-denied]` log line (or `access.target-denied`'s `source`) to learn whether `acl.json` or that user's entry in `users.json` is the one to fix.
- The `upstream` group can never produce a `403` — it only picks direct vs upstream (client mode only), and that choice is visible as a `[route]` log line instead.
- Check the warn line: `[ip-denied]` (`client`/`reason`) or `[target-denied]` (`target`/`host`/`reason`, plus `source=global|user` when a per-user list is in play), where `reason` is `whitelist` (non-empty whitelist, no match) or `blacklist` (explicit hit).
- Common causes: a non-empty `clientIp.whitelist` that omits your client IP; a `target.blacklist` entry matching the requested host; that user's own `acl.target` in `users.json` (check `source=user`); client dialing an **IP** that only has a domain blacklist entry (domains are matched as strings, no DNS — list the IP/CIDR too).
- An unresolvable peer address with a whitelist configured denies (fail-closed); a missing `acl.json` leaves all three groups empty (blocks nothing).

## Security Best Practices

1. Use strong passwords (≥12 chars)
2. **Keep the account table non-empty and private** when auth is on (`basic`/`uid` with an empty table is a hard startup error; `users.json` holds plaintext passwords — it is gitignored, keep it mode `0600`)
3. Rotate `JWT_SECRET` periodically
4. Keep `AUTH_LOGGING=true` in production to monitor brute force
5. Use `https`/`sockss*` for `proxyProtocol` to encrypt credentials in transit
6. Limit access via firewall when possible, and **default-deny with ACLs**: a non-empty `clientIp.whitelist` (only your egress IPs) plus `target.blacklist` entries — see the Access Control section above; note `acl.json` also holds plaintext-adjacent policy, so it is gitignored like `users.json`

## Code References

- Auth class and factories: `src/core/auth.ts:Auth`, `createAuthProvider(options, config)`, and `createAuthFromConfig(config, onFileEvent?)`; all configuration is explicit, and the dynamic factory wires built-in `defaultJwtVerify` over `src/core/helpers/credentials.ts:verifyHs256Jwt`.
- Credential primitives (all pure: zero `ConfigAccessor`, zero file IO, zero logging): `src/core/helpers/credentials.ts` — `buildCredentialIndexes` / `credentialIndexesFor` / `matchBasicCredential` / `matchUidCredential` / `extractBasicUser` / `encodeBasicCredentials` (base64 payload only) / `isJwtShape` / `verifyHs256Jwt` / **`buildProxyAuthValue`** (full `Proxy-Authorization` value). Cross-directory consumers import the helpers barrel `@/core/helpers/index.js`; `@/utils/constants/index.js` is now pure values with no functions.
- Account table: `src/config/files/users.ts` (`validateAuthUsers` / startup `readAuthUsersAsync` / runtime `readAuthUsers({ config, onEvent })` / `loadAuthUsers(config, onEvent?)`, hot-loaded via `src/utils/json-file/index.ts:readJsonCached`).
- ACL **data** layer: `src/config/files/acl.ts` (`validateAcl` / startup `readAclAsync` / runtime `readAcl({ config, onEvent })` / `loadAcl(config, onEvent?)`). ACL **decision** layer: `src/core/access-control.ts` (`checkClientIp(addr, config)` / `checkTargetHost(host, config, user?)` / `checkUpstreamRoute(host, config)` / `bindAclFileEvents`; compiled once per accessor snapshot identity). Config never decides anything, core never parses a file.
- **Per-user target lists (Phase 4b)**: an account's optional `acl.target` is read by `src/config/files/users.ts:loadUserPolicy(username, config, onFileEvent?)` (same throttled reader as the account table, **zero allocation while the policy snapshot is unchanged**) and judged by `checkTargetHost(host, config, user?)`. `allow ⇔ global target allows ∧ this user's target allows`; **global first and a global refusal short-circuits** (personal lists may only be stricter), and when both refuse the reported one is the **global** one (`source: "global"`). The username reaches the decision through exactly one chain: `RequestScope.user` → `ForwarderBase.preDial` → `guardPreDial` → `checkTargetHost`. `reason` stays `whitelist|blacklist`; the layer travels separately as `source` on `access.target-denied` and in the `[target-denied]` log line. Guards: `tests/unit/user-acl-merge.test.ts` (3×3 truth table) + `tests/integration/user-acl-enforcement.test.ts` (all four forward paths).
- ACL **entry rule** layer: `src/config/files/rules/` — `ip.ts` (`normalizeIp` incl. `::ffff:` → IPv4, `ipv6BytesToString`, `ipToString`, `parseIpRule`/`compileIpRules`/`ipMatches`) + `host.ts` (`normalizeHost`/`parseHostRule`/`compileHostRules`/`hostMatches`, no DNS). These came from the deleted `src/utils/ip-list.ts` / `src/utils/host-list.ts`; **exported names and signatures are byte-for-byte unchanged**, only the owner moved (`acl.ts` imports `./rules/index.js`, core imports `@/config/files/rules/index.js` — the one sanctioned second exit, since it is deliberately not re-exported by `@/config/index.js`). Behaviour was intentionally not loosened: `normalizeIp` still strips brackets only when the value both starts with `[` and ends with `]`, so `[::1]:443` in `acl.json` is still **invalid** (fail-closed). Shared text normalisation (`stripIpBrackets`/`stripZone`/`stripTrailingDot`/`lowerTrim`) comes from the leaf module `@/utils/host-text.js`.
- ACL call sites: `src/core/server/http.ts:handleForward()` + `src/core/server/socks-base.ts:onConn()` (client IP, before auth) and `src/core/helpers/predial.ts` (target host, after auth / before dial, beside `isSelfLoop`).
- Route decision (client mode only, after the `target` check): `checkUpstreamRoute(host, config)` + `resolveRoute(dest, config)`; a bypass hit resolves to `direct` under server semantics and the emitted pipe fact becomes one `[route]` log line in the server composition layer.
- Token extraction: `src/core/auth.ts:extractToken` (inline, header-only, case-insensitive scheme).
- Auth gate: `src/core/server/base.ts:authorize()` (catches exceptions → deny, returns `AuthResult`).
- Startup cross-check: `src/config/schema/validate.ts:assertAuthConfig`, run by `src/config/load.ts:loadConfig` after direct JSON reads and before its atomic store commit.
- Credential-leak guard: `src/core/helpers/headers.ts:isProxyCredentialValue(value, config)` (basic/uid walk the account table; jwt re-verifies with `verifyHs256Jwt`; used by `sanitizeHeaders(headers, config)` + the websocket upgrade builder).
- Wiring: `src/runtime/services.ts:buildDefaultServices(configAccessor, overrides, onFileEvent?, host?)` creates the default provider unless `services.auth` is supplied; `ProxyServer.bindProxyEventLogs()` renders the resulting auth and ACL-denial events. (The fourth parameter is `TrafficLedgerHost` — `{ slot?, onLedgerError? }` — and belongs to the quota-ledger wiring, not to auth.)

## Library-mode authentication injection

- `ConfigAccessor` is the required, read-only configuration port. It exposes only typed `get()`; configuration writes remain on the owning `ConfigStore`. `createAuthProvider(options, config)` and `createAuthFromConfig(config, onFileEvent?)` have no omitted-argument form.
- A pure-memory runtime owns a private `ConfigStore`. Pass `configDir` when file paths should be anchored outside the current working directory; construction absolutizes all path fields, and the captured `configDir` does not drift after a later `process.chdir()`. Read that runtime through `runtime.context.accessor` when constructing another provider explicitly:

  ```typescript
  import { createProxyRuntime } from "@b-hole/proxy";
  import { createAuthFromConfig } from "@/core/auth.js";

  const first = createProxyRuntime({
    config: { port: 9101, authEnabled: true, authType: "basic" },
  });
  const second = createProxyRuntime({
    config: { port: 9102, authEnabled: false, authType: "none" },
  });

  const firstAuth = createAuthFromConfig(first.context.accessor);
  // first.services.auth is already the equivalent default provider.
  void firstAuth;
  void second.services.auth;
  ```

- `runtime.options`, `runtime.services`, and the derived accessor are read-only frozen views; configuration changes go through `runtime.context.store`. `start()` re-establishes the bridge, store, and ACL-file subscriptions after every stop, so `start→stop→start` and `stop-before-start` followed by `start()` both restore auth/ACL events. An externally supplied `EventHub` remains host-owned and its subscriptions are never cleared by runtime.

- Context mode uses the exact live store returned by `loadConfig`; pass the same accessor to direct factories and to the runtime:

  ```typescript
  import { createProxyRuntime, loadConfig } from "@b-hole/proxy";
  import { createAuthFromConfig } from "@/core/auth.js";

  const context = await loadConfig({
    env: { AUTH_ENABLED: "false" },
    envFiles: [],
    argv: [],
    skipFileValidation: true,
  });
  const runtime = createProxyRuntime({ context });
  const fileEvents: string[] = [];
  const auth = createAuthFromConfig(context.accessor, (event) => {
    // Optional: route users-file hot-load events to this service's event/log policy.
    fileEvents.push(event.type);
  });

  console.log(runtime.context.accessor.get("authEnabled")); // false
  void auth;
  void fileEvents;
  ```

- `createProxyRuntime({ services: { auth } })` is the higher-level override point for external identity providers and tests. A supplied provider wins; otherwise `buildDefaultServices()` calls `createAuthFromConfig(runtime.context.accessor, onFileEvent)` exactly once.
- Separate pure-memory runtimes have separate stores and accessors. Multiple runtimes built from the same `ConfigContext` intentionally share that context’s live store. No auth factory falls back to module-level configuration state.
