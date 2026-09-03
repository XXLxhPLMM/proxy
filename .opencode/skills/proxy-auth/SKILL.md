---
name: proxy-auth
description: Use when configuring authentication, JWT, Basic Auth, token extraction, or debugging auth issues. Triggers on "auth", "认证", "token", "jwt", "login", "password", "用户名", "密码".
---

# Proxy Authentication Skill

Use this skill when working with proxy authentication, JWT, Basic Auth, or token extraction.

## Mechanism

See `AGENTS.md` → `Auth system` for the internals (async `authenticate()`,
`CompositeTokenExtractor` chain Header > Cookie > URL, Basic O(1) precomputed
comparison, JWT `jwtVerify` injection, `authLogging` flag). This skill only
documents what that section doesn't: config recipes, client usage, and
troubleshooting.

## Env Aliases

Single source of truth: `proxy-config` skill (`AUTH_ENABLED`, `JWT_SECRET`,
`AUTH_LOGGING` and their aliases). Not duplicated here.

## Configuration

### Enable Authentication

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
```

### Disable Auth Logging

```env
AUTH_LOGGING=false
```

## Client Usage

### Basic Auth

```bash
# Using curl
curl -x http://localhost:3000 \
     -Proxy-authorization "Basic YWRtaW46c2VjcmV0" \
     http://example.com

# Using environment variable
export http_proxy="http://admin:secret@localhost:3000"
curl http://example.com
```

### Bearer Token

```bash
curl -x http://localhost:3000 \
     -H "Authorization: Bearer <your-jwt-token>" \
     http://example.com
```

### Cookie Token

```bash
curl -x http://localhost:3000 \
     --cookie "token=<your-jwt-token>" \
     http://example.com
```

### URL Token

```bash
curl "http://localhost:3000?url=http://example.com&token=<your-jwt-token>"
```

## Common Auth Issues

### 1. Auth Enabled But Not Working

**Check:**
- Is `AUTH_ENABLED=true` in `.env` or env file?
- Are credentials correct?
- Is auth type supported?

**Debug:**
```bash
# Check config
pnpm start -- --log-level debug
```

### 2. Token Not Being Extracted

**Check:**
- Is token in correct format?
- Is header name correct (`Proxy-Authorization` vs `Authorization`)?
- Is cookie key one of the 7 aliases (`token`, `auth_token`, `access_token`,
  `jwt`, `session`, `session_token`, `auth`)?

### 3. JWT Verification Fails

**Check:**
- Is `JWT_SECRET` set correctly?
- Is token expired?
- Is `jwtVerify` function properly injected?

### 4. Auth Logging Disabled

Set `AUTH_LOGGING=false` to suppress auth logs:
- Silent allow/deny
- No request details logged

## Security Best Practices

1. **Use strong passwords**: Minimum 12 characters
2. **Rotate JWT secrets**: Change periodically
3. **Enable auth logging**: Monitor failed attempts
4. **Use HTTPS**: Encrypt credentials in transit
5. **Limit access**: Use firewall rules when possible

## Code References

- Auth class: `src/core/auth.ts`
- Token extractors: `src/core/auth.ts:CompositeTokenExtractor`
- Auth middleware: `src/core/base.ts:authorize()`
- Config loading: `src/config/loader.ts:createAuthFromConfig()`
