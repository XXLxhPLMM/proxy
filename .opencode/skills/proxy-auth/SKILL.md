---
name: proxy-auth
description: Use when configuring proxy authentication, Basic/JWT verification, the users.json account table, the acl.json access-control lists, or Proxy-Authorization header handling. Triggers on "auth", "认证", "token", "jwt", "login", "password", "用户名", "密码", "basic", "bearer", "proxy-authorization", "鉴权", "users.json", "多账号", "acl", "acl.json", "访问控制", "黑白名单", "白名单", "黑名单", "whitelist", "blacklist", "403", "429", "denied", "ip-denied", "target-denied", "quota-exhausted", "流量配额", "用量上限", "每账号名单".
---

# Proxy Authentication Skill

Use this skill when working with proxy authentication, credential verification, or `Proxy-Authorization` header extraction.

## When to Use

- User enables/disables auth, sets `AUTH_TYPE`/`AUTH_USERS_FILE`/`JWT_SECRET`, edits `cfg/users.json`, writes `cfg/acl.json`, or debugs 407 / 403.
- Do NOT trigger for generic config/env names or defaults — use `proxy-config` instead (this skill owns account-table and ACL *usage*; `proxy-config` owns the `AUTH_*` / `ACL_FILE` env rows).

## Mechanism

Accounts are a **list** loaded from `AUTH_USERS_FILE` (`users.json`), not a single env username/password. See `src/core/AGENTS.md` → 鉴权 for the internals (one provider class per auth kind — `NoneAuthProvider` / `BasicAuthProvider` / `UidAuthProvider` / `JwtAuthProvider`, all implementing `AuthProvider` from `src/plugins/contracts.ts` with a module-private shared base: async `authenticate()` returning `AuthResult` with the matched username, header-only token extraction (RFC 7235), per-account Basic/uid index for O(1) comparison — built in `proxy-helpers.ts`, consumed by the providers so header-stripping shares one predicate, JWT `defaultJwtVerify` (a thin wrapper over `proxy-helpers:verifyHs256Jwt`) built-in HS256 verification with `jwtVerify` injected by the composition root, outbound `Authorization` stripping that covers JWT mode too, `enableLogging` flag). `Auth` / `AuthOptions` / `createAuthFromConfig()` are **gone** — the composition root picks the implementation from the auth registry and injects it (`ProtocolDeps.auth`); the account table, `JWT_SECRET` and `AUTH_LOGGING` arrive as constructor arguments, core reads no config. This skill only documents config recipes, client usage, and troubleshooting.

### Scheme & token rules (`src/core/auth.ts:extractToken`)

- Scheme prefix is **case-insensitive** (RFC 7235): `Basic `, `basic `, `BASIC `, `Bearer `, `bearer ` all strip correctly. Stripping still slices by the constant length, so the token keeps its original case.
- `Proxy-Authorization` wins; `Authorization` is the fallback. Header lookup is case-insensitive (Node header names vary).

### Accounts table (`AUTH_USERS_FILE`, default `<configDir>/cfg/users.json`)

```json
[
  { "username": "alice", "password": "pw1" },
  { "username": "bob",   "password": "" }
]
```

- **Two optional keys** exist per account: `acl` (that account's own three-group access control) and `quota` (that account's traffic ceiling). Both are validated at the same stage as the credentials (`validateAuthUsers`); an illegal `acl`/`quota` aborts startup / keeps the last good table — it is **never silently ignored**. See "Per-account access control" and "Per-account traffic quota" below.
- **Hot-reload asymmetry (do not conflate the two)**: `acl`/`quota` are read **per request** through `readJsonCached` (mtime throttle 1s) so edits land in ~1s; but the **credential index is compiled once at composition time** (`BasicAuthProvider`/`UidAuthProvider` constructor), so **adding/removing an account still needs a restart**. "Add an account and it just works" is false for the credential side.
- `basic` passes when the token matches **any** account's `username`+`password`; `uid` passes when it matches **any** `username` (password ignored). Duplicate names, unknown fields, a non-array top level, an empty `username` or one containing `:` all fail validation (`src/config/resources/users/schema.ts:validateAuthUsers`).
- **Empty-account hard rule (`src/config/schema/guards.ts:assertAuthConfig`, fail-closed)**: with `AUTH_ENABLED=true`, `initConfig()` throws `配置校验失败: ...` and blocks startup (same stage as the parse/range checks, before the store write) when any of:
  - `AUTH_TYPE` ∈ `{basic, uid}` and the account table is empty (`accountCount === 0`) — the real cause is usually a wrong/missing `AUTH_USERS_FILE`; a silent "reject everything" is not allowed;
  - `AUTH_TYPE=none` — enabling auth without choosing a method means everything is allowed; the way to disable auth is `AUTH_ENABLED=false`;
  - `AUTH_TYPE=jwt` with an empty `JWT_SECRET`.
- A **blank password** is allowed — it just means "username only".
- The file is validated at startup: illegal JSON/shape aborts startup; **a missing file is an empty table** (not an error by itself). At runtime the file is hot-reloaded (mtime throttled 1s); bad content keeps the last good snapshot + warns.

### Authorization fallback must not leak to the origin

`Authorization` is accepted as a proxy-credential fallback, but it is also the end-to-end header a client sends **to the target**. Before forwarding (HTTP/HTTPS request path and the WebSocket upgrade path), `sanitizeHeaders` / `buildUpgradeReq` drop it when the running provider's `isOwnCredential(value)` says so — the old standalone `src/core/proxy-helpers.ts:isProxyCredentialValue` is **deleted**; `isStrippableOutboundHeader(name, value, auth)` / `sanitizeHeaders(h, auth)` / `stripProxyHeaders(h, auth)` now take the instance's `AuthProvider` explicitly:

- `basic` / `uid`: walks the **whole account table** (Basic `encodeBasicCredentials(user, pass)` / the bare username / the uid forms);
- `jwt`: strips any scheme prefix, then verifies the token with the built-in HS256 checker (`verifyHs256Jwt` + the injected `jwtSecret`) — **no account table needed** (JWT mode allows an empty table, so no "empty table" early return may precede this branch). This closes the leak where a client authenticates with `Authorization: Bearer <proxy JWT>` and that JWT would otherwise be forwarded to the origin.

Any other value (e.g. `Authorization: Bearer <target-token>`) is forwarded untouched. Known boundary: a custom injected `jwtVerify` is not visible to this predicate — it only recognises the built-in HS256 verifier (the production default the composition root wires in). The direction is deliberately "strip more, never leak".

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

Everything above *validates* the table; this is how you actually drive it.

**Schema** — a top-level array, and only these two keys per item (`ACCOUNT_KEYS` in `src/config/resources/users/schema.ts`):

```json
[
  { "username": "alice", "password": "pw1" },
  { "username": "bob",   "password": "" }
]
```

| Rule | Enforced by | On violation |
| --- | --- | --- |
| top level must be an array | `validateAuthUsers` | startup abort / runtime keep-last-good |
| item must be an object, keys ⊆ `{username, password}` | same | same |
| `username`: non-empty string, no `:` (Basic is `user:pass`) | same | same |
| `password`: must be a string — blank (`""`) is legal = username-only account | same | same |
| no duplicate `username` | same | same |

**Lifecycle**

- **Startup**: `initConfig()` force-reads it (`readAuthUsers({ force, path })`); illegal JSON/shape → `配置校验失败: AUTH_USERS_FILE=<path> ...`, startup blocked. Missing file is *not* an error — it is an empty table, which then trips `assertAuthConfig` if `AUTH_ENABLED=true` + `basic`/`uid`.
- **Runtime**: hot-reloaded through `src/utils/file/json.ts:readJsonCached` (mtime throttle 1s, `maxBytes` 1MiB). **Add/remove/rename an account by editing the file — no restart.** Bad edit keeps the last good table; `readJsonCached` emits an edge-triggered `error` event (`onEvent`), which the per-instance subscription `src/config/resources/notice.ts:subscribeConfigNotices` (installed by `src/instance.ts`, released by `ProxyInstance.dispose()`) logs dedup'd via `logger.notice("warn", ...)`; recovery logs `info`.
- The store holds only the **path** (`AUTH_USERS_FILE`, runtime phase → `set("authUsersFile", ...)` retargets it live); parsed accounts live in the cache layer.

**How each `AUTH_TYPE` consumes it**

| `AUTH_TYPE` | Match rule | Client credential form |
| --- | --- | --- |
| `basic` | token matches **any** account's `username`+`password` (O(1) index, built by `buildCredentialIndexes`) | `Proxy-Authorization: Basic b64(user:pass)`, or plain `user:pass` token |
| `uid` | matches **any** account's `username`, password ignored | 4 shapes accepted: bare `username`, `user:pass`, `b64(user:pass)`, `b64(username)` |
| `jwt` | delegated to `defaultJwtVerify` (HS256, `JWT_SECRET`, unexpired); username = `sub/username/user/uid/id` claim; the same verified token is stripped from outbound `Authorization` | `Proxy-Authorization: Bearer <jwt>` |
| `none` | n/a | n/a — and `AUTH_ENABLED=true` + `none` is a **startup error** |

- SOCKS: `socks5`/`sockss5` use RFC 1929 user/pass; `socks4`/`sockss4` carry only `USERID` (no password field) — so under `basic`, `USERID == username` also passes, and `uid` is the natural fit for socks4 clients.
- Header-stripping shares one predicate with auth (`AuthProvider.isOwnCredential`, implemented per provider in `src/core/auth.ts`): under `basic`/`uid` it walks the whole account table to decide whether `Authorization` belongs to the proxy (2 accounts means 2 candidate values checked, never just the first); under `jwt` it re-verifies the token with the built-in HS256 checker (no table needed), so a `Bearer <proxy JWT>` fallback header never reaches the origin.

### Access Control (`cfg/acl.json`)

```env
ACL_FILE=./cfg/acl.json          # default <configDir>/cfg/acl.json; missing file = block nothing
```

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "10.0.0.0/8"], "blacklist": ["203.0.113.7"] },
  "target":   { "whitelist": ["*.example.com"], "blacklist": ["ads.example.net", "198.51.100.0/24"] },
  "upstream": { "whitelist": ["*.example.com"], "blacklist": ["secret.example.com"] }
}
```

Three independent groups, one file, one hot-reload. `clientIp`/`target` may be omitted (≡ empty); `upstream` may be omitted (≡ empty = everything goes upstream in client mode); unknown top-level or per-group keys → `配置校验失败: ACL_FILE=<path> ...` at startup.

**Entry syntax** (validated by `src/config/resources/acl/schema.ts:validateList` → `parseIpRule` / `parseHostRule`):

| Group | Accepts | Rejects |
| --- | --- | --- |
| `clientIp` | IP / CIDR only (`1.2.3.4`, `10.0.0.0/8`, `::1`, `2001:db8::/32`) | domains — the TCP peer is always an IP |
| `target` | IP / CIDR / exact domain / `*.domain` | ports, paths, IDN (write punycode), `_`, non-ASCII |
| `upstream` | same as `target`: IP / CIDR / exact domain / `*.domain` | ports, paths, IDN (write punycode), `_`, non-ASCII |

- `*.a.com` matches sub-domains of `a.com` **only**, not `a.com` itself (exact and wildcard are separate responsibilities — list both).
- `10.0.0.5/24` ≡ `10.0.0.0/24` (host bits are masked); `0.0.0.0/0` matches all; IPv4 vs IPv6 rules never cross-match.
- Domains are matched as **strings** against the requested host (lowercased, trailing dot and `[...]` stripped) — **no DNS resolution**. Consequence: a domain entry does **not** cover a client that dials the IP directly (true for `target` and `upstream` alike — to close both ends, list IP/CIDR entries too).

**Semantics**

- `clientIp` / `target` (identical): blacklist hit → **deny** (wins); else whitelist non-empty && not hit → deny; both empty → allow.
- `upstream` (**action = route, never allow/deny**; **effective only with `PROXY_MODE=client`** — `server` mode ignores the group): blacklist hit → **direct** (**black beats whitelist**, unconditional); else whitelist non-empty && not hit → direct; both empty (group or file missing) → **upstream** (default, byte-for-byte the old behavior). Formula: **go upstream ⇔ hit whitelist ∧ miss blacklist; everything else → direct** — whitelist = the circle of upstream eligibility (outside defaults to direct), blacklist = a veto inside the circle (a named entry goes direct, whoever covers it).

Quick reference: both empty → all upstream | blacklist only → named direct, rest upstream | whitelist only → in-circle upstream, outside direct | both → whitelist grants eligibility + blacklist vetoes (black wins).

**Where it is judged** (order per allowed request: `clientIp` → auth → `target` → route → dial):

1. `checkClientIp(socket.remoteAddress)` — **first line** of `core/server/http.ts:handleForward()` and `socks-base.ts:onConn()`, i.e. **before auth**: a blacklisted IP gets dropped, never a 407. Deliberately ignores `X-Forwarded-For`/`X-Real-IP` (client-forgeable; those two are only used for auth audit display). `::ffff:1.2.3.4` is normalized to IPv4 (mandatory for Windows/dual-stack). Unresolvable address + a configured whitelist → deny (fail-closed).
2. Authentication runs next (a `clientIp` pass is **not** an auth bypass — failures still return `407`).
3. `checkTargetHost(host)` — on all four forward paths (http / CONNECT tunnel / websocket upgrade / socks), once the target is resolved, **after auth and before dialing**, next to the `isSelfLoop` guard. The judged object is **what the client asked for** (absolute-form request-target authority, falling back to `Host`) — **independent of `proxyMode`**: in `client` mode the dial target is the upstream, and `UPSTREAM_*` is never subject to these lists.
4. `checkUpstreamRoute(host)` — **client mode only**, immediately after the `target` check and before dialing: decides the route (`resolveRoute(dest)` returns the effective mode; a bypass hit resolves to `direct` per server semantics). It never allows or denies — **the route lists cannot waive a `target` denial** (a denied request never reaches routing).

**`[route]` log**: one line per allowed request in client mode with fields `target`, `route=direct|upstream`, and `reason=blacklist|whitelist` when the route is direct — `jq 'select(.msg=="[route]")'`. `server` mode logs nothing (the group is ignored).

**Deny behavior**: HTTP/CONNECT/upgrade → `403 Forbidden` (list decisions are credential-unrelated, deliberately never `407`); SOCKS `clientIp` denial → connection dropped before the handshake (no protocol reply), SOCKS `target` denial → failure reply. One warn per denial: `[ip-denied]` (`client`/`reason`) or `[target-denied]` (`target`/`host`/`reason`), `reason` ∈ `whitelist` | `blacklist`.

**Lifecycle**: same fail-closed/hot-load contract as `users.json` — startup force-read (`readAcl({ force, path })`) aborts on illegal content (unknown keys, illegal entries such as `192.168.*.*` or `example.com:8080`); missing file = all three groups empty (block nothing; client mode routes everything upstream); runtime edits land within ~1s (mtime throttle), bad edit keeps the last good snapshot + `logger.warn`. Validation: verify startup force-read rejection, missing-file behavior, hot reload within about 1 second, and retention of the last valid snapshot after an invalid edit.

### Per-account access control (`users.json` → `acl`)

`acl.json` is the **instance-level** list (it governs everything). An account may additionally carry its **own** three-group list inline, same shape, same entry syntax, same hot-reload:

```json
[
  { "username": "admin", "password": "secret" },
  { "username": "guest",  "password": "guest123",
    "acl": {
      "clientIp": { "whitelist": ["10.0.0.0/8"], "blacklist": [] },
      "target":   { "whitelist": ["*.example.com"], "blacklist": ["ads.example.net"] },
      "upstream": { "whitelist": [], "blacklist": ["intranet.example.com"] }
    } }
]
```

**Semantics: two independent gates in series, never one merged list** (single implementation: `src/config/resources/acl/resolve.ts`):

1. **Fixed order** — instance-level first, then the account's. The outer cause is reported first.
2. **Either hit denies.** The account list can only **narrow**; it can **never waive** an instance-level denial. *Override semantics are explicitly rejected*: with `target.blacklist: ["ads.example.net"]` globally, an account writing `"acl": {"target": {}}` would mean "no restriction" and would **void the company-wide policy with one account entry**.
3. **Absent = no extra restriction.** No `acl` key / account not in the table (unknown JWT `sub`) / `AUTH_ENABLED=false` → that dimension runs only the instance-level gate. **Policy absence is not a denial.**
   - `upstream` inverts its action but keeps the same shape: going upstream requires **both** gates to agree; either one demanding direct wins.

`AclDecision.scope` (`instance` | `user`) reports **which gate** stopped the request, and lands in the `[ip-denied]` / `[target-denied]` / `[route]` log lines as a structured `scope` field.

**Decision order per request** — `clientIp(global)` → auth → **`clientIp(account)`** → `target` (both gates) → route (both gates) → quota → dial. The account-level `clientIp` can only run **after auth** (no identity before it) and answers **403, never 407** (the credential was valid; the refusal came from a list). SOCKS drops the connection for that gate — the method negotiation already answered `0x01 0x00`, so writing a SOCKS reply would be protocol pollution.

**JWT mode**: the account table does **not** take part in credential verification, but it still carries per-identity policy — the token's `sub/username/user/uid/id` picks the account whose `acl` applies. An unknown `sub` gets no account policy (instance-level only).

### Per-account traffic quota (`users.json` → `quota`)

A **total** byte ceiling per account per window (not a rate limit):

```json
{ "username": "guest", "password": "pw2",
  "quota": { "bytes": 1073741824, "period": "daily" } }
```

| Field | Rule |
| --- | --- |
| `bytes` | positive safe integer. **`0` is illegal** — `0` does not mean "unlimited"; omit the whole `quota` key for unlimited |
| `period` | `hourly` \| `daily` \| `monthly` \| `total` |

- **Both fields are required** — no defaults. `{"bytes": N}` alone is ambiguous ("1GB per what?"), and this project aborts on ambiguity rather than silently picking a window.
- Rejection is **429 Too Many Requests** with a `[quota-exhausted]` warn line (fields `user`/`target`/`limit`/`used`; bytes are structured, the message renders them as `1.00 GB/1.00 GB`). 403 is *not* reused: 403 means "not allowed" (don't retry), 429 means "quota spent" (wait for the window).
- **Three honest limits** (implemented in `src/plugins/usage-store.ts`, not just documented):
  1. **Not persistent** — in-process counters, a restart zeroes them.
  2. **Not cross-process** — with `CLUSTER_WORKERS > 1` each worker counts separately, so `1GB` means **1GB per worker**, not one shared global pool. (`CACHE_TYPE=redis` remains a dead config, zero implementation in `src/`.)
  3. **Does not cut live transfers** — only **new** requests are refused at `reserve` time. A total quota physically cannot predict a single request's size, so an in-flight download may legitimately overshoot. Cutting the stream would truncate a download that had quota left.
- Changing `quota` (limit or period) through hot reload **discards the old counter** for that account instead of carrying it over.

### JWT Configuration

```env
AUTH_ENABLED=true
AUTH_TYPE=jwt
JWT_SECRET=your-secret-key-here
# The composition root wires the built-in HS256 verifier (defaultJwtVerify) into
# new JwtAuthProvider({ jwtSecret, jwtVerify: defaultJwtVerify }); no user-side injection needed.
# Tokens must be alg=HS256, signed with JWT_SECRET, unexpired.
# A verified proxy JWT sent via the Authorization fallback is stripped before forwarding to the origin.
# A JwtAuthProvider constructed WITHOUT a verifier denies everything (fail-closed) and
# still emits the [auth] deny audit — it never silently allows.
```

### Disable Auth Logging

```env
AUTH_LOGGING=false
```

Env names are single source of truth in `proxy-config` skill (`AUTH_ENABLED`, `AUTH_TYPE`, `AUTH_USERS_FILE`, `JWT_SECRET`, `AUTH_LOGGING`, `ACL_FILE`) — including their defaults; this skill owns the file *contents* and runtime behavior.

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
- Are credentials correct? Basic compares `Basic <b64>` or plain `user:pass` against **every** account in `AUTH_USERS_FILE` via the index built by `buildCredentialIndexes` and consulted by `BasicAuthProvider` (`src/core/auth.ts`).
- Is the account table empty? `AUTH_ENABLED=true` + `basic|uid` + empty table is a hard startup error (`assertAuthConfig`); check that `AUTH_USERS_FILE` points at a non-empty, valid `users.json`. A blank password is fine (username-only).

Debug: `pnpm start -- --log-level debug` and watch `[auth]` events from `src/server/index.ts:bindProxyEventLogs`.

### 2. Token Not Being Extracted

- Header must be `Proxy-Authorization` (preferred) or `Authorization` fallback, with scheme prefix `Basic <b64>` / `Bearer <jwt>` — matched **case-insensitively** (`src/core/auth.ts:extractToken`).
- Cookie/URL token carrying is removed (non-standard, leaks into logs/origin); use headers only.

### 3. JWT Verification Fails

- Is `JWT_SECRET` set (an empty secret is a startup error)? Is the token `alg=HS256`, signed with `JWT_SECRET`, and unexpired? The default verifier (`src/core/auth.ts:defaultJwtVerify`, a thin async wrapper over `src/core/proxy-helpers.ts:verifyHs256Jwt`) checks all three — wrong secret, non-HS256 alg (e.g. `none`), malformed shape or expired `exp` → deny. A custom `jwtVerify` passed to `new JwtAuthProvider({ jwtVerify })` takes precedence; a provider constructed **without** one denies every token (fail-closed, no throw at construction) and the `[auth] deny` audit event is still emitted — this path can never produce `allow`.

### 4. Auth Logging Disabled

Set `AUTH_LOGGING=false` to suppress `[auth] allow/deny` events. The auth providers are zero-log (`AUTH_LOGGING` is injected as their `enableLogging` flag); details are emitted via `AuthContext.onAuthEvent` and logged centrally.

### 4b. 429 — Quota, Not Auth

- A `429` means the authenticated account **used up its `quota`**, not that authentication failed. Grep the warn line: `jq 'select(.msg=="[quota-exhausted]")'` — it carries `user`, `limit`, `used` (bytes).
- Counter resets on process restart and is **per worker** under `CLUSTER_WORKERS > 1`; if the limit seems not to hold, check the worker count first.
- A `[quota-exhausted]` right after `[auth] allow` is **normal and honest**: the check happens before dialing, so the bytes of the request that exhausted the quota were legitimately served.

### 5. 403 (Not 407) — the ACL, Not Auth

- A `403 Forbidden` (HTTP/CONNECT/upgrade) or a failed/dropped SOCKS connection means `acl.json` denied it — `clientIp` runs **before** auth (a blacklisted source never sees a 407) and `target` runs after auth but **before dialing**; either way a list decision is credential-unrelated, so it is `403`, never `407`.
- The `upstream` group can never produce a `403` — it only picks direct vs upstream (client mode only), and that choice is visible as a `[route]` log line instead.
- Check the warn line: `[ip-denied]` (`client`/`reason`) or `[target-denied]` (`target`/`host`/`reason`), where `reason` is `whitelist` (non-empty whitelist, no match) or `blacklist` (explicit hit). Both now also carry **`scope`** (`instance` = `acl.json`, `user` = that account's own list) — read it to answer *which* list refused.
- Common causes: a non-empty `clientIp.whitelist` that omits your client IP; a `target.blacklist` entry matching the requested host; client dialing an **IP** that only has a domain blacklist entry (domains are matched as strings, no DNS — list the IP/CIDR too).
- An unresolvable peer address with a whitelist configured denies (fail-closed); a missing `acl.json` leaves all three groups empty (blocks nothing).

## Security Best Practices

1. Use strong passwords (≥12 chars)
2. **Keep the account table non-empty and private** when auth is on (`basic`/`uid` with an empty table is a hard startup error; `users.json` holds plaintext passwords — it is gitignored, keep it mode `0600`)
3. Rotate `JWT_SECRET` periodically
4. Keep `AUTH_LOGGING=true` in production to monitor brute force
5. Use `https`/`sockss*` for `proxyProtocol` to encrypt credentials in transit
6. Limit access via firewall when possible, and **default-deny with ACLs**: a non-empty `clientIp.whitelist` (only your egress IPs) plus `target.blacklist` entries — see the Access Control section above; note `acl.json` also holds plaintext-adjacent policy, so it is gitignored like `users.json`

## Code References

- Auth providers: `src/core/auth.ts` — `NoneAuthProvider` / `BasicAuthProvider` / `UidAuthProvider` / `JwtAuthProvider` implementing `AuthProvider` from `src/plugins/contracts.ts` (registry key = `AuthKind`), sharing the module-private `AuthProviderBase`; the account table / `JWT_SECRET` / `enableLogging` arrive as constructor arguments (core reads no config) and the composition root selects/injects the instance. `defaultJwtVerify` (a thin wrapper over `src/core/proxy-helpers.ts:verifyHs256Jwt`, HS256 HMAC via `node:crypto`) is the built-in verifier the root wires in.
- Account table: `src/config/resources/users/{schema,reader}.ts` (`validateAuthUsers`/`readAuthUsers`/`loadAuthUsers`, hot-loaded via `src/utils/file/json.ts:readJsonCached`)
- ACL: `src/config/resources/acl/{schema,reader,eval,resolve}.ts` (`validateAcl` — reused verbatim for the per-account inline `acl`, `readAcl`/`loadAcl`, `evaluate*` (one list, zero IO), `resolve*` (two gates in series)); per-account lookup + quota index in `src/config/resources/users/policy.ts`; quota contract/default in `src/plugins/{contracts.ts,usage-store.ts}`
- ACL entry matchers: `src/utils/addr/address.ts` (`normalizeIp` incl. `::ffff:` → IPv4, `ipv4/ipv6BytesToString`) + `src/utils/addr/cidr.ts` (`parseIpRule`/`compileIpRules`/`ipMatches`) + `src/utils/addr/host.ts` (`parseHostRule`/`compileHostRules`/`hostMatches`, no DNS)
- ACL call sites: `src/core/server/base.ts:rejectByClientIp()` (client IP — **called twice**: before auth with the global list only, and after auth with the account's list too) from `src/core/server/http.ts:handleForward()` + `src/core/server/socks-base.ts:onConn()`; target host via `src/plugins/routing-provider.ts:plan()` (main) and `src/core/proxy-helpers.ts:guardPreDial` (defense in depth, now carrying `user`); quota via `src/core/forward/inbound/base.ts:admit()` (last gate before dial) with the byte meter in `src/core/forward/meter.ts`
- Route decision (client mode only, after the `target` check): `acl.checkUpstreamRoute(host)` + `resolveRoute(dest, mode, acl)` (returns the effective mode; a bypass hit resolves to `direct` per server semantics) — emits the `[route]` log line
- Token extraction: `src/core/auth.ts:extractToken` (inline, header-only, case-insensitive scheme)
- Auth gate: `src/core/server/base.ts:authorize()` (catches exceptions → deny, returns `AuthResult`)
- Startup cross-check: `src/config/schema/guards.ts:assertAuthConfig` (imported and run by `src/config/load.ts:initConfig`)
- Credential-leak guard: `AuthProvider.isOwnCredential` in `src/core/auth.ts` (basic/uid walk the account table; jwt re-verifies with `verifyHs256Jwt`), consumed by `src/core/proxy-helpers.ts:isStrippableOutboundHeader` / `sanitizeHeaders` / `stripProxyHeaders` and by `buildUpgradeReq`
- Wiring: the composition root picks the auth provider from the registry by `AUTH_TYPE` (or `NoneAuthProvider` when `AUTH_ENABLED=false`) and injects it via `ProtocolDeps.auth`; denial logging (`ip-denied`/`target-denied`) lives in `src/server/index.ts:bindProxyEventLogs`
