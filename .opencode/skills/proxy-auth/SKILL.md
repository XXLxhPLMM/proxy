---
name: proxy-auth
description: Use when configuring authentication, JWT, Basic Auth, token extraction, or debugging auth issues. Triggers on "auth", "认证", "token", "jwt", "login", "password", "用户名", "密码".
---

# Proxy Authentication Skill

Use this skill when working with proxy authentication, JWT, Basic Auth, or token extraction.

## Authentication Types

| Type | Description | Use Case |
|------|-------------|----------|
| `basic` | Username/Password | Simple auth |
| `jwt` | JSON Web Token | Token-based auth |

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

## Environment Variable Aliases

| Config Key | Aliases |
|------------|---------|
| `AUTH_ENABLED` | `APP_USE_AUTH`, `USE_AUTH`, `AUTH_SWITCH` |
| `AUTH_LOGGING` | `AUTH_LOG`, `LOG_AUTH` |
| `JWT_SECRET` | `PROXY_SECRET`, `JWT_KEY`, `JWTSECRET` |

## Token Extraction Chain

The proxy extracts tokens from requests in this order (first-match wins):

1. **Header Token** - `Proxy-Authorization` or `Authorization` header
   - Basic auth: `Basic base64(username:password)`
   - Bearer token: `Bearer <token>`

2. **Cookie Token** - Cookie with key (7 aliases checked):
   - `token`, `auth_token`, `access_token`, `jwt`, `session`, `session_token`, `auth`

3. **URL Token** - Query parameter
   - `?token=<token>`
   - `?access_token=<token>`

## Basic Auth

### How It Works

1. Client sends `Proxy-Authorization: Basic base64(username:password)`
2. Server compares against precomputed values (O(1) comparison)
3. If match → allow; else → deny

### Precomputed Values

At construction time, server precomputes:
- `expectedB64`: Base64 encoded `username:password`
- `expectedPlain`: Plain text `username:password`

This enables O(1) comparison for better performance.

## JWT Auth

### How It Works

1. Client sends `Authorization: Bearer <jwt-token>`
2. Server calls `jwtVerify(token, secret)` to validate
3. If valid → allow; else → deny

### Requirements

JWT authentication requires external `jwtVerify` injection. If not provided, placeholder throws error.

## Token Examples

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

## Auth Flow

```
Client Request
    ↓
Token Extraction (Header → Cookie → URL)
    ↓
Auth.authenticate(ctx)
    ↓
┌─────────────────┐
│  Basic Auth     │ → Compare with precomputed values
│  JWT Auth       │ → jwtVerify(token, secret)
└─────────────────┘
    ↓
Allow/Deny
    ↓
Proxy Request Forwarded (if allowed)
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
- Is cookie key one of the 7 aliases?

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