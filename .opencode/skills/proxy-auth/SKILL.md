---
name: proxy-auth
description: Use when configuring proxy authentication, Basic/JWT verification, the users.json account table, or Proxy-Authorization header handling. Triggers on "auth", "认证", "token", "jwt", "login", "password", "用户名", "密码", "basic", "bearer", "proxy-authorization", "鉴权", "users.json", "多账号".
---

# Proxy Authentication Skill

Use this skill when working with proxy authentication, credential verification, or `Proxy-Authorization` header extraction.

## When to Use

- User enables/disables auth, sets `AUTH_TYPE`/`AUTH_USERS_FILE`/`JWT_SECRET`, or debugs 407.
- Do NOT trigger for generic config/env questions — use `proxy-config` instead.

## Mechanism

Accounts are a **list** loaded from `AUTH_USERS_FILE` (`users.json`), not a single env username/password. See `src/core/AGENTS.md` → 鉴权 for the internals (async `authenticate()` returning `AuthResult` with the matched username, header-only token extraction (RFC 7235), per-account Basic/uid index for O(1) comparison — built in `proxy-helpers.ts`, consumed by `Auth` so header-stripping shares one predicate, JWT `defaultJwtVerify` built-in HS256 verification with `jwtVerify` override, `authLogging` flag). This skill only documents config recipes, client usage, and troubleshooting.

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

- `basic` passes when the token matches **any** account's `username`+`password`; `uid` passes when it matches **any** `username` (password ignored). Duplicate names, unknown fields, a non-array top level, an empty `username` or one containing `:` all fail validation (`src/config/auth-users.ts:validateAuthUsers`).
- **Empty-account hard rule (`src/config/loader.ts:assertAuthConfig`, fail-closed)**: with `AUTH_ENABLED=true`, `initConfig()` throws `配置校验失败: ...` and blocks startup (same stage as the parse/range checks, before the store write) when any of:
  - `AUTH_TYPE` ∈ `{basic, uid}` and the account table is empty (`accountCount === 0`) — the real cause is usually a wrong/missing `AUTH_USERS_FILE`; a silent "reject everything" is not allowed;
  - `AUTH_TYPE=none` — enabling auth without choosing a method means everything is allowed; the way to disable auth is `AUTH_ENABLED=false`;
  - `AUTH_TYPE=jwt` with an empty `JWT_SECRET`.
- A **blank password** is allowed — it just means "username only".
- The file is validated at startup: illegal JSON/shape aborts startup; **a missing file is an empty table** (not an error by itself). At runtime the file is hot-reloaded (mtime throttled 1s); bad content keeps the last good snapshot + warns.

### Authorization fallback must not leak to the origin

`Authorization` is accepted as a proxy-credential fallback, but it is also the end-to-end header a client sends **to the target**. Before forwarding (HTTP/HTTPS request path and the WebSocket upgrade path), `sanitizeHeaders` / `buildUpgradeReq` drop it when it matches the proxy's own credential — `src/core/proxy-helpers.ts:isProxyCredentialValue` now walks the **whole account table** (Basic `encodeBasicCredentials(user, pass)` or the bare username). Any other value (e.g. `Authorization: Bearer <target-token>`) is forwarded untouched.

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

### JWT Configuration

```env
AUTH_ENABLED=true
AUTH_TYPE=jwt
JWT_SECRET=your-secret-key-here
# Built-in HS256 verification is wired by default (createAuthFromConfig → defaultJwtVerify):
# no jwtVerify injection is needed. Tokens must be alg=HS256, signed with JWT_SECRET, unexpired.
# A directly constructed new Auth({ type: "jwt" }) without jwtVerify throws
# "JWT auth requires jwtVerify" (caught as deny).
```

### Disable Auth Logging

```env
AUTH_LOGGING=false
```

Env names are single source of truth in `proxy-config` skill (`AUTH_ENABLED`, `AUTH_USERS_FILE`, `JWT_SECRET`, `AUTH_LOGGING`).

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
- Are credentials correct? Basic compares `Basic <b64>` or plain `user:pass` against **every** account in `AUTH_USERS_FILE` via `src/core/auth.ts:verifyBasic`.
- Is the account table empty? `AUTH_ENABLED=true` + `basic|uid` + empty table is a hard startup error (`assertAuthConfig`); check that `AUTH_USERS_FILE` points at a non-empty, valid `users.json`. A blank password is fine (username-only).

Debug: `pnpm start -- --log-level debug` and watch `[auth]` events from `src/server/index.ts:bindProxyEventLogs`.

### 2. Token Not Being Extracted

- Header must be `Proxy-Authorization` (preferred) or `Authorization` fallback, with scheme prefix `Basic <b64>` / `Bearer <jwt>` — matched **case-insensitively** (`src/core/auth.ts:extractToken`).
- Cookie/URL token carrying is removed (non-standard, leaks into logs/origin); use headers only.

### 3. JWT Verification Fails

- Is `JWT_SECRET` set (an empty secret is a startup error)? Is the token `alg=HS256`, signed with `JWT_SECRET`, and unexpired? The default verifier (`src/core/auth.ts:defaultJwtVerify`) checks all three — wrong secret, non-HS256 alg (e.g. `none`), malformed shape or expired `exp` → deny. An explicitly injected `jwtVerify` (provider setter or `AuthOptions`) takes precedence; a directly constructed `Auth` without injection is caught inside `authenticate()` and treated as a plain deny — so the `[auth] deny` audit event is still emitted (this path can never produce `allow`).

### 4. Auth Logging Disabled

Set `AUTH_LOGGING=false` to suppress `[auth] allow/deny` events. `Auth` itself is zero-log; details are emitted via `AuthContext.onAuthEvent` and logged centrally.

## Security Best Practices

1. Use strong passwords (≥12 chars)
2. **Keep the account table non-empty and private** when auth is on (`basic`/`uid` with an empty table is a hard startup error; `users.json` holds plaintext passwords — it is gitignored, keep it mode `0600`)
3. Rotate `JWT_SECRET` periodically
4. Keep `AUTH_LOGGING=true` in production to monitor brute force
5. Use `https`/`sockss*` for `proxyProtocol` to encrypt credentials in transit
6. Limit access via firewall when possible (or the `clientIp` ACL — see `src/config/AGENTS.md` → 访问控制)

## Code References

- Auth class: `src/core/auth.ts:Auth` + `createAuthFromConfig()` (reads `src/config/store.ts` + the account table via `src/config/auth-users.ts:loadAuthUsers`; wires built-in JWT verifier `defaultJwtVerify` — HS256 HMAC via `node:crypto`)
- Account table: `src/config/auth-users.ts` (`validateAuthUsers`/`readAuthUsers`/`loadAuthUsers`, hot-loaded via `src/utils/json-file.ts:readJsonCached`)
- Token extraction: `src/core/auth.ts:extractToken` (inline, header-only, case-insensitive scheme)
- Auth gate: `src/core/server/base.ts:authorize()` (catches exceptions → deny, returns `AuthResult`)
- Startup cross-check: `src/config/loader.ts:assertAuthConfig`
- Credential-leak guard: `src/core/proxy-helpers.ts:isProxyCredentialValue` (walks the account table; used by `sanitizeHeaders` + `buildUpgradeReq`)
- Wiring: `src/server/index.ts:createAuthFromConfig` → `ProxyServer` `auth` event
