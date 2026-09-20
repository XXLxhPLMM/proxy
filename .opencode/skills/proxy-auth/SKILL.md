---
name: proxy-auth
description: Use when configuring proxy authentication, Basic/JWT verification, or Proxy-Authorization header handling. Triggers on "auth", "认证", "token", "jwt", "login", "password", "用户名", "密码", "basic", "bearer", "proxy-authorization", "鉴权".
---

# Proxy Authentication Skill

Use this skill when working with proxy authentication, credential verification, or `Proxy-Authorization` header extraction.

## When to Use

- User enables/disables auth, sets `AUTH_TYPE`/`AUTH_USERNAME`/`JWT_SECRET`, or debugs 407.
- Do NOT trigger for generic config/env questions — use `proxy-config` instead.

## Mechanism

See `AGENTS.md` → `Auth system` for the internals (async `authenticate()`, header-only token extraction (RFC 7235), Basic O(1) precomputed comparison, JWT `jwtVerify` injection, `authLogging` flag). This skill only documents config recipes, client usage, and troubleshooting.

### Scheme & token rules (`src/core/auth.ts:extractToken`)

- Scheme prefix is **case-insensitive** (RFC 7235): `Basic `, `basic `, `BASIC `, `Bearer `, `bearer ` all strip correctly. Stripping still slices by the constant length, so the token keeps its original case.
- `Proxy-Authorization` wins; `Authorization` is the fallback. Header lookup is case-insensitive (Node header names vary).

### Empty-username hard rule

An empty `AUTH_USERNAME` is **never** a valid credential — enforced twice:

1. **Depth of defense (`src/core/auth.ts`)**: `verifyBasic` / `verifyUid` return `false` whenever the configured username is empty. This blocks the `Proxy-Authorization: :` / `Og==` bypass (Basic `expectedPlain === ":"`) and the `a` / `!` lenient-base64 bypass (UID decodes an invalid single char to `""`).
2. **Startup cross-check (`src/config/loader.ts:assertAuthConfig`, fail-closed)**: with `AUTH_ENABLED=true` and any of the following, `initConfig()` throws `配置校验失败: ...` and blocks startup (same stage as the parse/range checks, before the store write):
   - `AUTH_TYPE` ∈ `{basic, uid}` with an empty username — an empty username would let every request through;
   - `AUTH_TYPE=none` — enabling auth without choosing a method means everything is allowed; the way to disable auth is `AUTH_ENABLED=false`;
   - `AUTH_TYPE=jwt` with an empty `JWT_SECRET`.

   Basic with an empty **password** is still allowed — it just means "username only" (`user:` form), and `logConfig()` warns `密码为空，仅按用户名校验`.

### Authorization fallback must not leak to the origin

`Authorization` is accepted as a proxy-credential fallback, but it is also the end-to-end header a client sends **to the target**. Before forwarding (HTTP/HTTPS request path and the WebSocket upgrade path), `sanitizeHeaders` / `buildUpgradeReq` drop it when it matches the proxy's own credential — `src/core/proxy-helpers.ts:isProxyCredentialValue` compares against Basic `base64(user:pass)`, the bare username, and the base64 username (`uid`). Any other value (e.g. `Authorization: Bearer <target-token>`) is forwarded untouched.

### Tunnel tag criterion

The audit `tag` is `"tunnel "` **only** when `ctx.req.method === "CONNECT"` or `ctx.protocol.startsWith("socks")`. It is NOT derived from `authority` (a normal request's `Host` routinely carries a `:port`, which would mislabel every request as a tunnel). `AuthRequestLike.method` exists for this check.

## Configuration

### Enable Basic Auth

```env
AUTH_ENABLED=true
AUTH_TYPE=basic
AUTH_USERNAME=admin
AUTH_PASSWORD=secret
```

### JWT Configuration

```env
AUTH_ENABLED=true
AUTH_TYPE=jwt
JWT_SECRET=your-secret-key-here
# jwtVerify must be injected via AuthOptions — otherwise authenticate() throws "JWT auth requires jwtVerify"
```

### Disable Auth Logging

```env
AUTH_LOGGING=false
```

Env names are single source of truth in `proxy-config` skill (`AUTH_ENABLED`, `JWT_SECRET`, `AUTH_LOGGING`).

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
- Are credentials correct? Basic compares `Basic <b64>` or plain `user:pass` via `src/core/auth.ts:verifyBasic`.
- Is `AUTH_USERNAME` empty? That is rejected at startup (`assertAuthConfig`) and always denied at runtime; a blank password is fine (username-only).

Debug: `pnpm start -- --log-level debug` and watch `[auth]` events from `src/server/index.ts:bindProxyEventLogs`.

### 2. Token Not Being Extracted

- Header must be `Proxy-Authorization` (preferred) or `Authorization` fallback, with scheme prefix `Basic <b64>` / `Bearer <jwt>` — matched **case-insensitively** (`src/core/auth.ts:extractToken`).
- Cookie/URL token carrying is removed (non-standard, leaks into logs/origin); use headers only.

### 3. JWT Verification Fails

- Is `JWT_SECRET` set (an empty secret is now a startup error)? Is the token expired? Is `jwtVerify` injected via `new Auth({ jwtVerify })`? A missing injection is caught inside `authenticate()` and treated as a plain deny — so the `[auth] deny` audit event is still emitted (this path can never produce `allow`).

### 4. Auth Logging Disabled

Set `AUTH_LOGGING=false` to suppress `[auth] allow/deny` events. `Auth` itself is zero-log; details are emitted via `AuthContext.onAuthEvent` and logged centrally.

## Security Best Practices

1. Use strong passwords (≥12 chars)
2. **Never leave `AUTH_USERNAME` empty** — it is a hard startup error for `basic`/`uid`, and would otherwise defeat auth entirely
3. Rotate `JWT_SECRET` periodically
4. Keep `AUTH_LOGGING=true` in production to monitor brute force
5. Use `https`/`sockss*` for `proxyProtocol` to encrypt credentials in transit
6. Limit access via firewall when possible

## Code References

- Auth class: `src/core/auth.ts:Auth` + `createAuthFromConfig()` at `src/core/auth.ts:304` (reads `src/config/store.ts` directly)
- Token extraction: `src/core/auth.ts:extractToken` (inline, header-only, case-insensitive scheme)
- Auth gate: `src/core/server/base.ts:authorize()` (catches exceptions → deny)
- Startup cross-check: `src/config/loader.ts:assertAuthConfig`
- Credential-leak guard: `src/core/proxy-helpers.ts:isProxyCredentialValue` (used by `sanitizeHeaders` + `buildUpgradeReq`)
- Wiring: `src/server/index.ts:createAuthFromConfig` → `ProxyServer` `auth` event
