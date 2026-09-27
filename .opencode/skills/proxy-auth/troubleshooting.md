# 排查手册

> **按需分册**：skill 只自动加载 `SKILL.md`（读它的 frontmatter 决定要不要用），同目录的 `*.md` 分册**不会**被自动灌进上下文。
> **什么时候读**：**认证行为与预期不符时读这一份**：凭证没被提取、HS256 校验失败、403 vs 407 的归属、审计日志没打出来

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
- **Custom verifier + token still reaching the origin?** That is the 已知边界 recorded in `src/core/identity/AGENTS.md`, not a second bug: the outbound-stripping predicate is synchronous and cannot await your `verify`, so it only recognises the built-in HS256 form.

### 4. Auth Logging Disabled

Set `AUTH_LOGGING=false` to suppress `[auth] allow/deny` events. The identity layer itself is zero-log; details are emitted via `IdentityContext.onAuthEvent` and logged centrally.

### 5. 403 (Not 407) — the ACL, Not Auth

- A `403 Forbidden` (HTTP/CONNECT/upgrade) or a failed/dropped SOCKS connection means a list denied it — `clientIp` runs **before** auth (a blacklisted source never sees a 407) and `target` runs after auth but **before dialing**; either way a list decision is credential-unrelated, so it is `403`, never `407`. With a per-user `acl.target` in play, read the `source=` segment of the `[target-denied]` log line (or `access.target-denied`'s `source`) to learn whether `acl.json` or that user's entry in `users.json` is the one to fix.
- The `upstream` group can never produce a `403` — it only picks direct vs upstream (client mode only), and that choice is visible as a `[route]` log line instead.
- Check the warn line: `[ip-denied]` (`client`/`reason`) or `[target-denied]` (`target`/`host`/`reason`, plus `source=global|user` when a per-user list is in play), where `reason` is `whitelist` (non-empty whitelist, no match) or `blacklist` (explicit hit).
- Common causes: a non-empty `clientIp.whitelist` that omits your client IP; a `target.blacklist` entry matching the requested host; that user's own `acl.target` in `users.json` (check `source=user`); client dialing an **IP** that only has a domain blacklist entry (domains are matched as strings, no DNS — list the IP/CIDR too).
- An unresolvable peer address with a whitelist configured denies (fail-closed); a missing `acl.json` leaves all three groups empty (blocks nothing).
