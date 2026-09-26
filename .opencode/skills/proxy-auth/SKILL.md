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

Accounts are a **list** loaded from `AUTH_USERS_FILE` (`users.json`), not a single env username/password. See `src/core/AGENTS.md` → 身份 for the internals (async `identify()` returning `IdentityResult` with the matched username, header-only token extraction (RFC 7235), per-account Basic/uid index for O(1) comparison — built in `src/core/helpers/credentials.ts`, consumed by `FileAccountIdentity` so header-stripping shares one predicate, JWT `defaultJwtVerify` (a thin wrapper over `helpers/credentials:verifyHs256Jwt`) built-in HS256 verification with a `verify`/`jwtVerify` override, outbound `Authorization` stripping that covers JWT mode too, `authLogging` flag). This skill only documents config recipes, client usage, and troubleshooting.

**The identity domain is one pluggable port, not one class.** `IdentityProvider` (`{ kind, isEnabled, isOwnCredential, identify }`) is the single entry point core knows about; behind it there are now **four built-in mode plugins** — `noneIdentity()` / `basicIdentity({ accounts })` / `uidIdentity({ accounts })` / `jwtIdentity({ secret, verify })` — plus `FileAccountIdentity` (the config-driven façade) and `createIdentityFromConfig(ctx, onFileEvent?)`. They are re-exported from the layer exit `src/core/identity.ts` (implementations under `src/core/identity/{modes,file-account,token,factory}.ts`) and from the package entry. Four files exist because the four modes differ **only** in "how do I compare this token" — "extract credential + mask + emit audit + decide the result" is literally the same code, and that shared skeleton is `TokenIdentityBase` (exported on purpose: it is the **only** reuse entry point for a custom plugin, and not exporting it would force every custom plugin to re-copy the audit-emitting skeleton). `TokenIdentityBase` **must not** be split into four copies — the three invariants it carries (case-insensitive scheme, tunnel-tag rule, audit-on-every-failure) cannot survive drifting.

`credentials.ts` also owns **`buildProxyAuthValue(b64)`**: it prefixes `AUTH_SCHEME_BASIC` to a base64 payload and returns the complete `Proxy-Authorization` header value (`"Basic " + b64`). It is **deliberately separate** from `encodeBasicCredentials(user, pass)`, which only produces the base64 payload — the two callers that need a whole header value are `core/helpers/upstream.ts` (upstream Basic credentials) and `core/server/socks-session.ts` (SOCKS upstream auth), and the encoding must exist only once. `@/utils/constants/index.js` is therefore a zero-dependency pure-value module again (no functions). Index/matching/HS256 semantics are unchanged by this move.

### Construction and configuration boundary

- `new FileAccountIdentity(options)` consumes only the explicit `IdentityOptions` passed by the caller. It never reads a store, accessor, environment, or account-file path on its own:

  ```typescript
  const identity = new FileAccountIdentity({
    enabled: true,
    type: "basic",
    accounts: [{ username: "alice", password: "pw1" }],
    enableLogging: false,
  });
  ```

- Or construct one mode **directly** — this is the real payoff of a pluggable identity: a library caller can want "just the uid semantics" or "my own JWT verifier but still want this proxy's outbound stripping and audit" without dragging in the account-table comparison:

  ```typescript
  import { basicIdentity, uidIdentity, jwtIdentity, noneIdentity } from "@b-hole/proxy";

  const basic = basicIdentity({ accounts: [{ username: "alice", password: "pw1" }] });
  const uid = uidIdentity({ accounts: [{ username: "test", password: "" }] }); // socks4 USERID
  const jwt = jwtIdentity({ secret: "s3cr3t", verify: async (token, secret) => myVerify(token, secret) });
  const open = noneIdentity();
  ```

- `createIdentity(options, config)` also requires an explicit `ConfigAccessor` — and **deliberately still only an accessor, not a `CoreContext`**: this factory reads exactly **one** config key (`authLogging`) and does no file IO and has no observation surface. Handing a three-part context to a port that only touches `config` would make the signature lie about needing `logger`/`events` ("ports declare only what they truly need" is a core rule; `createIdentityFromConfig` is the one that really consumes all three).
- `createIdentityFromConfig(ctx, onFileEvent?)` requires the whole `CoreContext` (config / logger / events) and dynamically reads `authEnabled`, `authType`, `jwtSecret`, `authLogging`, and `authUsersFile` on **each** `identify()` **and each** `isOwnCredential()`. The optional callback receives the users-file hot-load event; it is not a hidden global logger hook.
  - **Why the whole `CoreContext` here** (asymmetric on purpose): `isOwnCredential` runs on the **outbound-header-stripping hot path** — the library layer asks it for **every outbound header name × every value** (`this.connectors.`-style unconditional delegation: only the `proxy-` prefix is short-circuited first by the protocol rule), i.e. **~17 calls on a typical 17-header forwarded HTTP request**, not once per `Authorization` — so per-method parameter passing would push DI cost onto the hottest path in the repo; the identity plugin therefore **holds the three parts at construction** and the hot path costs one property read. The three members each have a job: `config` = the live truth source; `logger` = the **default observation surface** (used only when the caller supplied no `onFileEvent`, so a library caller who subscribes to nothing still sees account-file breakage in their own log); `events` = **deliberately not published to** by this module (see below).
  - **Why the file-observation surface is still a parameter and not `ctx.events`**: `CoreContext` is a **read-only three-part view**, not a subscription registry — putting "what I want to subscribe to" into "what dependencies I have" makes one object be both a dependency and an assembly instruction, and a `readonly` view that carries a registration entry loses "read-only" at the type level. Worse, the subscription **lifecycle** (`runtime.start()` builds, `runtime.stop()` tears down) belongs to the single composition root: had the identity module registered itself, there would be a **second** registration point, and the two concrete consequences are (a) one file transition publishing two `config.file-error` events (one fact, two sources) and (b) `stop()`'s teardown list missing that round, leaving a listener behind after shutdown. So observation goes in via a **parameter** injected by `buildDefaultServices` — which is still the single registration point. The ACL domain is the same discipline with a different entry (`access-control.ts:bindAclFileEvents`).
- `createProxyRuntime()` wires its default identity with the runtime's `CoreContext` and explicitly passes its JSON-event callback. An identity supplied through `services.identity` replaces the default. There is no omitted-argument form and no implicit module-level configuration fallback. In pure-memory mode, an optional `configDir` anchors and absolutizes all path fields at construction; later `process.chdir()` does not move existing file paths.
- **The account-table observation surface is still injected by the single composition point** — `createIdentityFromConfig(ctx, onFileEvent?)`'s second parameter — and the identity module **never registers itself**. One fewer entry point always beats one more convenience parameter: two entries writing the same handler table means both get installed while only the later one is honoured, so the earlier one silently stops receiving events (externally: "the log says the list didn't change, but the verdict did").
  - **When the caller supplies `onFileEvent` it is passed through verbatim, never wrapped.** That looks like boilerplate you can save but it is a correctness issue: `readJsonCached` de-duplicates transition state **per callback identity** (`utils/json-file/subscriber.ts`'s `WeakMap<callback, Map<key, state>>`), so wrapping installs a second subscriber on the same `users.json` and every transition is then reported **twice** — the `[config] 用户账号文件 读取失败…` lines and the `config.file-*` events all double. `live()` runs per request, so that callback identity must be the single one fixed at construction.

### `isEnabled` means one thing only: "will this instance reject anybody"

`isEnabled` is the port's **only** enable switch, and its meaning is **"does this instance ever reject someone"** — which is why `type === "none"` was folded into it (`FileAccountIdentity.isEnabled` is `enabled && type !== "none"`; the three real plugins answer `true`, `noneIdentity()` answers `false`). It is the **same fact** as "the identification template method returns allow at its first line", so there is deliberately no second switch to keep in sync. **Consumers read this one field and must not re-test `kind !== "none"` themselves** — copying that fact into a second place is exactly how a `none` deployment ends up behaving inconsistently at one call site while all tests stay green.

### Scheme & token rules (`src/core/identity/token.ts:extractToken`)

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

`Authorization` is accepted as a proxy-credential fallback, but it is also the end-to-end header a client sends **to the target**. Before forwarding (HTTP/HTTPS request path and the WebSocket upgrade path), `sanitizeHeaders(headers, identity)` / `buildUpgradeReq(..., identity)` drop it when it matches the proxy's own credential. The identity provider must be supplied on every call, so stripping follows the same plugin that gates — **which is the whole point**: a predicate that reads `authEnabled`/`authType`/`jwtSecret` + `users.json` from config and *guesses* "which `Authorization` is ours" only works while config **is** the identity. Identity is a pluggable component here, so the credential shape belongs to the **plugin** (custom header names, HMAC-SHA256 digests, cloud-gateway signatures) and config is no longer the source of truth, so guessing from config is guaranteed to mismatch. And a mismatch's cost is not "stripped too much" (an `Authorization: Bearer <target token>` wrongly removed at worst costs the origin one header) but the reverse — **the proxy's own credential forwarded verbatim to the origin**, i.e. leaking an intranet password / proxy token to a third party. Hence the delegation is **mandatory**, not optional.

Two consequences that must both hold:
- the predicate is **given by the plugin** — only it knows what its own credentials look like;
- the predicate is a **required member with no default and may not return `undefined`** — omitting it must fail at **compile time**, not silently leak at runtime.

`FileAccountIdentity.isOwnCredential(name, value)` implements both modes:
- `basic` / `uid`: walks the **whole account table** (Basic `encodeBasicCredentials(user, pass)` / the bare username / the uid forms) — with 2 accounts that is 2 candidate values checked, never just the first;
- `jwt`: strips any scheme prefix, then verifies the token with the built-in HS256 checker (`verifyHs256Jwt` + `JWT_SECRET`) — **no account table needed** (JWT mode allows an empty table, so that branch must short-circuit before the empty-table early return). This closes the leak where a client authenticates with `Authorization: Bearer <proxy JWT>` and that JWT would otherwise be forwarded to the origin.

Any other value (e.g. `Authorization: Bearer <target-token>`) is forwarded untouched.

**Delegation is open to every outbound header name — do not narrow it back.** The two rules are separate and both must apply:
- `proxy-` prefix → stripped. That is a **protocol** rule (those headers are hop-by-hop proxy headers, always ours), and it stays.
- credential shape → **every** header is asked about it. `isStrippableOutboundHeader(name, value, identity)` asks `identity.isOwnCredential(...)` for whatever header name it is given, not only for `authorization`.

The two are deliberately not merged: "this is a proxy header" and "this value is a credential of mine" are independent facts, and a plugin whose credentials live in `x-api-key` must still be stripped. ⚠️ **If you remember the contract saying the opposite, that memory is stale**: `isOwnCredential`'s own contract explicitly says the **library layer imposes no header-name restriction at all** — the earlier "non-`authorization` answers `false` by default" wording described a `lower === "authorization"` gate in `headers.ts` that has since been **removed** (it made the library dictate a plugin's credential shape, which is precisely the leak this port exists to close). What *is* true is narrower and belongs to the **built-in plugins only**: `noneIdentity`/`basicIdentity`/`uidIdentity`/`jwtIdentity` short-circuit on `name.toLowerCase() !== "authorization"` in `core/identity/token.ts:ownCredentialForms`, because they only ever sign `Authorization`. That is **their** cheap early-out, **not** a licence for the delegation path to skip other names and **not** something a custom plugin has to copy.

**Known boundary (recorded, not fixed this round): a custom injected `verify` is invisible to the outbound-stripping predicate.** This is a **type-level consequence**, not an oversight:

- `IdentityProvider.isOwnCredential` is **synchronous** by port contract.
- `jwtVerify` / `jwtIdentity`'s `verify` is typed `(token, secret) => Promise<boolean>` — a **Promise-returning** function.
- A synchronous predicate **cannot await a Promise**, so the jwt branch has no choice but to compute with the built-in `verifyHs256Jwt` right now.

Consequences, precisely:
- **Default path: zero boundary.** The production chain injects `defaultJwtVerify`, which is a *thin async wrapper over the very same `verifyHs256Jwt`* — so stripping and identification are byte-for-byte equivalent. Nothing leaks.
- **Only injected non-HS256 verifiers are affected.** If you inject an RS256 / remote-JWKS implementation, a token that **it** accepts but the built-in HS256 checker does not recognise **will not be stripped** from the outbound `Authorization`. It reaches the origin.
- **Fixing it properly needs the port to hand the strip path a synchronous conclusion** (e.g. an optional `isOwnCredentialSync`, or a verifier split into a sync structural check plus an async cryptographic check). Making `isOwnCredential` `async` is *not* the fix: that would make the **entire** outbound-header-stripping path async, which is a much larger change than the problem deserves. **Deliberately not done this round** — recorded here as a known boundary plus the follow-up candidate so the next person either fixes it deliberately or re-confirms the trade-off, rather than rediscovering it.

### Identity result & tunnel tag

- `identify()` returns `IdentityResult` `{ passed: boolean; username?: string }` (it was a plain `boolean` long ago). On allow the **matched username** is carried up and injected into the connection's log lines as `user`.
- The audit `tag` is `"tunnel"` **only** when `ctx.req.method === "CONNECT"` or `ctx.protocol.startsWith("socks")`. It is NOT derived from `authority` (a normal request's `Host` routinely carries a `:port`, which would mislabel every request as a tunnel). `IdentityRequestLike.method` exists for this check. The value was normalised from the old `"tunnel "` (trailing space) so JSONL can match it exactly.
- `ProxyAuthEvent` dropped `expected` — with many accounts that field was noise; deny audits keep `attempted`/`reason`. **`ProxyAuthEvent` and `IdentityContext.onAuthEvent` deliberately keep the `Auth` spelling**: they describe **data / an audit callback**, not a way of identifying someone. Renaming them would only make callers translate for nothing. The *port* names (`IdentityProvider` and friends) are the ones that were fully de-`Auth`-ified, because those describe "a pluggable identity component".
- core is zero-log: the identity layer emits **no** log lines. Audits go up through `IdentityContext.onAuthEvent`, get turned into `auth.decided` by `BaseProxy.authorize`, and are persisted by the server layer. The only exception is the account-file observation surface described above, and that writes to the **injected** `ctx.logger`, never to a global logger.

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
- `acl.target` — `access.checkTarget({ host, user })` (the `AccessControl` port; the built-in file-driven implementation is `core/access-control.ts:createFileAccessControl(config).checkTarget`) judges two lists: `allow ⇔ global target allows ∧ this user's target allows`, **global first with a global rejection short-circuiting**; both refusing reports the **global** one (`source:"global"`). Never participates in `checkClient` (runs before auth) nor in the `checkRoute` routing group.
- `quota` — metering and the exhausted verdict live in `src/core/traffic/` (not here): `MemoryTrafficAccount.consume` decides "is it over" in the order `bytesUp` → `bytesDown` → `bytesTotal`, rejecting if **any** is breached, with **exactly hitting a cap still allowed**. Enforcement is a **hard cut** (HTTP without headers → 507, otherwise `destroy()`), never "refuse new requests, leave existing ones" — a long-lived tunnel would otherwise never trip the check. With `AUTH_ENABLED=false` there is no identity, so quotas are not applied at all and startup emits a `[quota-inert]` warn. Usage is persisted to `<QUOTA_LEDGER_DIR>/worker-<slot>.jsonl` so it survives a restart.

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

**Where it is judged.** All three checks are now **methods on the `AccessControl` port** (`{ checkClient, checkTarget, checkRoute }`, all three **synchronous**), not three free functions. The order per allowed request is unchanged: `clientIp` → auth → `target` → route → dial. What changed is that each call goes through the port, and the port has exactly **one** built-in implementation: `createFileAccessControl(config)`, which **closes over** `config` (there is no `config` parameter on any of the three methods — the factory captured it, so "which configuration is this verdict reading" has no second source of truth; the three old free functions each took a `config` argument, which meant four call sites to get right and any one of them wrong meant "instance A's list judging instance B's requests" — a class of bug whose runtime symptom is "the list works sometimes").

1. `services.access.checkClient({ client })` — **stage A** of the shared inbound admission (`core/server/admission.ts:createInboundAdmission(...).admitClientIp(...)`, called by `core/server/http.ts:handleForward()` and `socks-base.ts:onConn()`), i.e. **before auth and (for SOCKS) before the handshake**: a blacklisted IP gets dropped, never a 407. `client` is the TCP peer address. Judgment and response are **separate**: `admitClientIp` publishes `pipe: ip-denied` + settles the `access` terminal; the caller supplies the protocol-shaped response (HTTP writes 403, SOCKS destroys the socket). Deliberately ignores `X-Forwarded-For`/`X-Real-IP` (client-forgeable; those two are only used for auth audit display). `::ffff:1.2.3.4` is normalized to IPv4 (mandatory for Windows/dual-stack). Unresolvable address + a configured whitelist → deny (fail-closed).
   - `admission.ts` receives the whole normalized `CoreServices` package even though it only uses `access` — deliberate, judged by "would a reader wonder why `identity` is in one place and `access` in another, with no principled answer". Splitting the package into "half as a parameter, half as a closure" is the shape that invites that question.
2. Authentication runs next (a `checkClient` pass is **not** an auth bypass — failures still return `407`). Stage B's `admission.authenticate(credentials, rejectedStatus, respond)` injects `requestId`/`connectionId` and settles the `auth` terminal; SOCKS's handshake sits **between** stage A and this call, which is exactly why the admission is two stages rather than one three-gate function.
3. `access.checkTarget({ host, user })` — on all four forward paths (http / CONNECT tunnel / websocket upgrade / socks), once the target is resolved, **after auth and before dialing**, next to the `isSelfLoop` guard. The chain is exactly one: `RequestScope.user` → `ForwarderBase.preDial` → `guardPreDial({ access, … })` → `access.checkTarget`. `ForwarderBase.preDial` is the **only** place in the repo that reads `scope.user`. The judged object is **what the client asked for** (absolute-form request-target authority, falling back to `Host`) — **independent of `proxyMode`**: in `client` mode the dial target is the upstream, and `UPSTREAM_*` is never subject to these lists. Omit `user` and only the global layer runs.
4. `access.checkRoute({ host })` — **client mode only**, immediately after the `target` check and before dialing: decides the route. It never allows or denies — **the route lists cannot waive a `target` denial** (a denied request never reaches routing).
   - ⚠️ **The `proxyMode` mode gate is in `resolveRoute`, NOT in the decision layer.** `helpers/route.ts:resolveRoute(dest, { access, mode })` takes `mode` as a **configuration fact sitting beside** the `access` policy port (they are two parameters, never merged — collapsing them into one "can read anything" accessor would be a second source of truth) and **short-circuits on its very first line** when `mode === "server"`, without asking `access` at all. `checkRoute` itself is a **pure list decision and does not read `proxyMode`**.
   - **Why the gate must not move into the decision layer**: `proxyMode` is a **routing-mode** decision and is **orthogonal to authorization**. Pushing it into `checkRoute` would force every custom policy implementation to re-implement the mode gate, and `checkRoute`'s hard invariant (a mode-free truth table) would gain a mode qualifier. The concrete cost of getting it wrong is observable: `forward/base:emitRoute` skips on `mode === "server" && !reason`, so if the short-circuit is lost, a `proxyMode=server` deployment that happens to have an `upstream` group configured will **emit a spurious `route` event / a spurious `[route]` log line** that the "server mode direct ⇒ zero route events" guard (`integration/websocket-single-path.test.ts`) exists to catch.

**`[route]` log**: one line per allowed request in client mode with fields `target`, `route=direct|upstream`, and `reason=blacklist|whitelist` when the route is direct — `jq 'select(.msg=="[route]")'`. `server` mode logs nothing (the group is ignored).

**Deny behavior**: HTTP/CONNECT/upgrade → `403 Forbidden` (list decisions are credential-unrelated, deliberately never `407`); SOCKS behaves **per layer**: a `clientIp` denial drops the connection **before the handshake** (no protocol reply — there is not even a target to parse yet), while a `target` denial sends a SOCKS **failure reply** (the handshake already parsed the target by then, so silently dropping would leave the client waiting for bytes that never come). One warn per denial: `[ip-denied]` (`client`/`reason`) or `[target-denied]` (`target`/`host`/`reason`), `reason` ∈ `whitelist` | `blacklist`.

**Lifecycle**: same fail-closed/hot-load contract as `users.json` — `loadConfig()` uses `readAclAsync(resolvedPath)` before committing and rejects illegal content (unknown keys or entries such as `192.168.*.*` / `example.com:8080`); **only `ENOENT` is treated as missing on this startup path** (→ all three groups empty, i.e. block nothing; client mode routes everything upstream), every other read failure aborts. At runtime, `loadAcl(configAccessor, onFileEvent?)` reads the same accessor-bound file, edits land within ~1s, and a bad edit or non-missing stat/read error such as `EACCES` keeps the last good snapshot and emits an error instead of silently allowing all traffic — **here** (the `readJsonCached` hot path) the missing set is `ENOENT` / `ENOTDIR` / non-regular files, and every other stat error is `stat-error`, never disguised as missing. Relative paths are absolutized before caching. The explicitly supplied logger renders the event. Regression guards: `tests/integration/client-mode-acl.test.ts`.

### JWT Configuration

```env
AUTH_ENABLED=true
AUTH_TYPE=jwt
JWT_SECRET=your-secret-key-here
# Built-in HS256 verification is wired by default (createIdentityFromConfig → defaultJwtVerify):
# no verifier injection is needed. Tokens must be alg=HS256, signed with JWT_SECRET, unexpired.
# A verified proxy JWT sent via the Authorization fallback is stripped before forwarding to the origin.
# A jwt plugin built without a verifier denies during identification
# ("JWT auth requires jwtVerify", caught fail-closed): jwtIdentity({ secret, verify }) requires
# `verify` explicitly, and a directly constructed new FileAccountIdentity({ type: "jwt" })
# without one is denied too.
```

**Custom verifier (library mode only)** — you cannot express this in env; inject the plugin:

```typescript
import { createProxyRuntime, jwtIdentity } from "@b-hole/proxy";

const identity = jwtIdentity({ secret: process.env.SIGNING_KEY!, verify: myRs256Verify });
const runtime = createProxyRuntime({ config: { port: 9101 }, services: { identity } });
```

⚠️ Read the **Known boundary** in "Authorization fallback must not leak to the origin" above before you do this: with a non-HS256 verifier, tokens it accepts but the built-in HS256 checker does not recognise **will not be stripped** from the outbound `Authorization`. The config-driven path (`AUTH_TYPE=jwt` + `JWT_SECRET`) has **zero** such boundary.

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
- Are credentials correct? Basic compares `Basic <b64>` or plain `user:pass` against the compiled account index in `FileAccountIdentity.matchBasic()` / `helpers/credentials:matchBasicCredential`.
- Is the account table empty? `AUTH_ENABLED=true` + `basic|uid` + empty table is a hard startup error (`assertAuthConfig`); check that `AUTH_USERS_FILE` points at a non-empty, valid `users.json`. A blank password is fine (username-only).
- **Injected a custom identity plugin and everything is being let through?** Check `isEnabled` — the port's only switch, meaning "will this instance reject anybody". A plugin built as `{ kind: "apikey", isEnabled: false, … }` denies nobody, by definition.

Debug: `pnpm start -- --log-level debug` and watch `[auth]` events from `src/runtime/event-log.ts:bindProxyEventLogs`.

### 2. Token Not Being Extracted

- Header must be `Proxy-Authorization` (preferred) or `Authorization` fallback, with scheme prefix `Basic <b64>` / `Bearer <jwt>` — matched **case-insensitively** (`src/core/identity/token.ts:extractToken`).
- Cookie/URL token carrying is removed (non-standard, leaks into logs/origin); use headers only.

### 3. JWT Verification Fails

- Is `JWT_SECRET` set (an empty secret is a startup error)? Is the token `alg=HS256`, signed with `JWT_SECRET`, and unexpired? The default verifier (`src/core/identity/token.ts:defaultJwtVerify`, a thin async wrapper over `src/core/helpers/credentials.ts:verifyHs256Jwt`) checks all three — wrong secret, non-HS256 alg (e.g. `none`), malformed shape or expired `exp` → deny. An explicitly injected verifier (the `jwtVerify` slot on `FileAccountIdentity` / `createIdentityFromConfig`'s dynamic façade, or `jwtIdentity({ verify })`) takes precedence; a jwt plugin without a verifier is caught inside `identify()` and treated as a plain deny — so the `[auth] deny` audit event is still emitted (this path can never produce `allow`).
- **Custom verifier + token still reaching the origin?** That is the Known boundary above, not a second bug: the outbound-stripping predicate is synchronous and cannot await your `verify`, so it only recognises the built-in HS256 form.

### 4. Auth Logging Disabled

Set `AUTH_LOGGING=false` to suppress `[auth] allow/deny` events. The identity layer itself is zero-log; details are emitted via `IdentityContext.onAuthEvent` and logged centrally.

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

- Identity layer exit: `src/core/identity.ts` (re-exports everything; **no** `index.ts` inside `identity/` — the exit uses relative paths on purpose, per-file, to avoid "self-importing the barrel"). Implementations: `identity/token.ts` (`TokenIdentityBase` + `extractToken` + `defaultJwtVerify`), `identity/modes.ts` (the four plugins), `identity/file-account.ts` (`FileAccountIdentity`), `identity/factory.ts` (`createIdentity` / `createIdentityFromConfig`). Type leaf: `src/core/types/identity.ts` re-exports the identity contracts from `types/proxy.ts` (the single source of truth).
- Ports: `src/core/types/proxy.ts` declares `IdentityProvider` / `IdentityOptions` / `IdentityContext` / `IdentityResult` / `AuthAccount` / `ProxyAuthEvent` plus `AccessControl` / `AccessDecision` / `AccessRouteDecision` and the `CoreServices` package (`{ identity, access, traffic }`, all three **required** after normalization).
- Factories: `createIdentity(options, config)` (thin `FileAccountIdentity` wrapper, fills `enableLogging` from `authLogging`) and `createIdentityFromConfig(ctx, onFileEvent?)` (dynamic façade, hot-reloading; wires the built-in `defaultJwtVerify` over `src/core/helpers/credentials.ts:verifyHs256Jwt`).
- Credential primitives (all pure: zero `ConfigAccessor`, zero file IO, zero logging): `src/core/helpers/credentials.ts` — `buildCredentialIndexes` / `credentialIndexesFor` / `matchBasicCredential` / `matchUidCredential` / `extractBasicUser` / `encodeBasicCredentials` (base64 payload only) / `isJwtShape` / `verifyHs256Jwt` / **`buildProxyAuthValue`** (full `Proxy-Authorization` value). Cross-directory consumers import the helpers barrel `@/core/helpers/index.js`; `@/utils/constants/index.js` is now pure values with no functions.
- Account table: `src/config/files/users.ts` (`validateAuthUsers` / startup `readAuthUsersAsync` / runtime `readAuthUsers({ config, onEvent })` / `loadAuthUsers(config, onEvent?)`, hot-loaded via `src/utils/json-file/index.ts:readJsonCached`).
- ACL **data** layer: `src/config/files/acl.ts` (`validateAcl` / startup `readAclAsync` / runtime `readAcl({ config, onEvent })` / `loadAcl(config, onEvent?)`). ACL **decision** layer: `src/core/access-control.ts` — the port's **only** built-in implementation, `createFileAccessControl(config)` returning `{ checkClient, checkTarget, checkRoute }` (compiled once per accessor snapshot identity), plus `bindAclFileEvents` as the **sole** registration point for the ACL-file observation surface. The three decision functions themselves are **module-private** and not exported. Config never decides anything, core never parses a file.
- **Per-user target lists**: an account's optional `acl.target` is read by `src/config/files/users.ts:loadUserPolicy(username, config, onFileEvent?)` (same throttled reader as the account table, **zero allocation while the policy snapshot is unchanged**) and judged by `access.checkTarget({ host, user })`. `allow ⇔ global target allows ∧ this user's target allows`; **global first and a global refusal short-circuits** (personal lists may only be stricter), and when both refuse the reported one is the **global** one (`source: "global"`). The username reaches the decision through exactly one chain: `RequestScope.user` → `ForwarderBase.preDial` → `guardPreDial({ access })` → `access.checkTarget`. `reason` stays `whitelist|blacklist`; the layer travels separately as `source` on `access.target-denied` and in the `[target-denied]` log line. Guards: `tests/unit/user-acl-merge.test.ts` (3×3 truth table) + `tests/integration/user-acl-enforcement.test.ts` (all four forward paths).
- ACL **entry rule** layer: `src/config/files/rules/` — `ip.ts` (`normalizeIp` incl. `::ffff:` → IPv4, `ipv6BytesToString`, `ipToString`, `parseIpRule`/`compileIpRules`/`ipMatches`) + `host.ts` (`normalizeHost`/`parseHostRule`/`compileHostRules`/`hostMatches`, no DNS). This is the **one sanctioned second exit** — deliberately not re-exported by `@/config/index.js` (`acl.ts` imports `./rules/index.js`, core imports `@/config/files/rules/index.js`). Behaviour is intentionally not loosened: `normalizeIp` still strips brackets only when the value both starts with `[` and ends with `]`, so `[::1]:443` in `acl.json` is still **invalid** (fail-closed). Shared text normalisation (`stripIpBrackets`/`stripZone`/`stripTrailingDot`/`lowerTrim`) comes from the leaf module `@/utils/host-text.js`.
- ACL call sites: `src/core/server/admission.ts` (`services.access.checkClient({ client })` — the single judgment, shared by both inbound paths) reached from `src/core/server/http.ts:handleForward()` + `src/core/server/socks-base.ts:onConn()`, `src/core/helpers/predial.ts` (`opts.access.checkTarget({ host, user })`, after auth / before dial, beside `isSelfLoop`), and `src/core/helpers/route.ts` (`policy.access.checkRoute({ host })`, after the `mode` short-circuit). Neither `route.ts` nor `predial.ts` imports `access-control.ts` at runtime any more — they are **type-only** on the port. Order guard: `tests/integration/inbound-admission-order.test.ts`.
- Route decision (client mode only, after the `target` check): `access.checkRoute({ host })` + `resolveRoute(dest, { access, mode })`; a bypass hit resolves to `direct` under server semantics and the emitted pipe fact becomes one `[route]` log line in the server composition layer.
- Token extraction: `src/core/identity/token.ts:extractToken` (inline, header-only, case-insensitive scheme).
- Identity gate: `src/core/server/base.ts:authorize()` (catches exceptions → deny, returns `IdentityResult`).
- Startup cross-check: `src/config/schema/validate.ts:assertAuthConfig`, run by `src/config/load.ts:loadConfig` after direct JSON reads and before its atomic store commit.
- Credential-leak guard: **`IdentityProvider.isOwnCredential(name, value)`** — a mandatory port member with no default, implemented by `FileAccountIdentity` (basic/uid walk the account table; jwt re-verifies with `verifyHs256Jwt`). Consumed by `src/core/helpers/headers.ts` — `isStrippableOutboundHeader(name, value, identity)` / `stripProxyHeaders(h, identity)` / `sanitizeHeaders(headers, identity)` — plus the websocket upgrade builder. `headers.ts` imports **zero** `@/config/**` and calls **zero** `config.get`: the predicate is the plugin's, and the only coupling point is that single injected port. See the Known boundary above for what a custom async verifier costs.
- Wiring: `src/runtime/services.ts:buildDefaultServices(ctx, overrides, onFileEvent?, host?)` is the **one** place in the whole project that resolves default services. It creates the default `identity` unless `services.identity` is supplied, and the default `access` unless `services.access` is supplied. Its **first parameter is a `CoreContext`**, not a `ConfigAccessor` (see the construction-boundary section above for why). `src/runtime/event-log.ts:bindProxyEventLogs()` renders the resulting identity and ACL-denial events (it binds the `EventHub` to the injected logger, so CLI and library callers share one binding). (The fourth parameter is `TrafficLedgerHost` — `{ slot?, onLedgerError? }` — and belongs to the quota-ledger wiring, not to identity.)

## Library-mode identity injection

- `CoreContext` is the read-only dependency carrier (`{ config, logger, events }`, all three required). `ConfigAccessor` is its configuration port: typed `get()` only; configuration writes remain on the owning `ConfigStore`. Neither `createIdentity` nor `createIdentityFromConfig` has an omitted-argument form.
- **The high-level override point is `createProxyRuntime({ services: { identity, access, traffic } })`.** A supplied service wins; otherwise `buildDefaultServices()` resolves the defaults exactly once. `identity` and `access` are **not** `ProxyOptions` fields you should reach for when you have a runtime — `ProxyOptions.identity` / `access` / `connectors` exist for **directly constructing core** (see `tests/helpers/proxy.ts:withProxy`), and the runtime path injects them on your behalf.
- **To inject a custom access-control policy** (this is also how you make `acl.json` / per-user lists your own engine):

  ```typescript
  import { createProxyRuntime, type AccessControl } from "@b-hole/proxy";

  const access: AccessControl = {
    checkClient: ({ client }) => ({ allowed: !denyIp(client) }),
    checkTarget: ({ host, user }) => (user === "root" ? { allowed: true } : { allowed: !denyHost(host), reason: "policy" }),
    checkRoute: ({ host }) => ({ direct: directFor(host) }),
  };
  const runtime = createProxyRuntime({ config: { port: 9101 }, services: { access } });
  ```

  `reason` / `source` are **free `string`s**, not a closed set — a replacement engine can say `"rate-limited"` / `"geoip"`, and it will reach the `access.target-denied` event **verbatim**. The built-in file-driven engine still only ever says `whitelist` / `blacklist` / `global` / `user`; that is now an **internal discipline** held by source-level assertions rather than by the type. Two rules survive the relaxation and are asserted, not assumed: **layer information never goes inside `reason`** (write `"user:blacklist"` and you have merged two facts into one opaque token), and a **missing/empty `reason` or `source` is never back-filled** (back-filling `source` to `global` disguises "refused by a personal list" as "refused globally", sending operators to edit the wrong file).
- All three `AccessControl` methods are **synchronous, by hard decision, not for convenience** — see the call-chain section above for the full argument. In short: `checkRoute` runs on the **pre-dial hot path of all four inbound channels** and its result feeds a synchronous control-flow chain. **If you need to consult a remote policy, put it behind `IdentityProvider` (`identify` is already `async`), not behind `AccessControl`.**
- A pure-memory runtime owns a private `ConfigStore`. Pass `configDir` when file paths should be anchored outside the current working directory; construction absolutizes all path fields, and the captured `configDir` does not drift after a later `process.chdir()`. If you want to build an identity component explicitly against a runtime, read it through `runtime.context` (which **is** a `CoreContext`):

  ```typescript
  import { createProxyRuntime, createIdentityFromConfig } from "@b-hole/proxy";

  const first = createProxyRuntime({ config: { port: 9101, authEnabled: true, authType: "basic" } });
  const second = createProxyRuntime({ config: { port: 9102, authEnabled: false, authType: "none" } });

  const firstIdentity = createIdentityFromConfig(first.context);
  // first.services.identity is already the equivalent default.
  void firstIdentity;
  void second.services.identity;
  ```

- `runtime.options`, `runtime.services`, and the derived accessor are read-only frozen views; configuration changes go through `runtime.context.store`. `start()` re-establishes the bridge, store, and ACL-file subscriptions after every stop, so `start→stop→start` and `stop-before-start` followed by `start()` both restore identity/ACL events. An externally supplied `EventHub` remains host-owned and its subscriptions are never cleared by runtime.

- Context mode uses the exact live store returned by `loadConfig`; pass the same `ConfigContext` to the runtime and hand it to direct factories:

  ```typescript
  import { createProxyRuntime, loadConfig, createIdentityFromConfig } from "@b-hole/proxy";

  const context = await loadConfig({
    env: { AUTH_ENABLED: "false" },
    envFiles: [],
    argv: [],
    skipFileValidation: true,
  });
  const runtime = createProxyRuntime({ context });
  const fileEvents: string[] = [];
  const identity = createIdentityFromConfig(context, (event) => {
    // Optional: route users-file hot-load events to this service's event/log policy.
    // Do NOT wrap this callback — see the construction-boundary section.
    fileEvents.push(event.type);
  });

  console.log(runtime.context.accessor.get("authEnabled")); // false
  void identity;
  void fileEvents;
  ```

- Separate pure-memory runtimes have separate stores and accessors. Multiple runtimes built from the same `ConfigContext` intentionally share that context's live store. No identity factory falls back to module-level configuration state.
