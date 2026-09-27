---
name: proxy-auth
description: Use when configuring proxy authentication, Basic/JWT verification, the users.json account table, the acl.json access-control lists, or Proxy-Authorization header handling. Triggers on "auth", "认证", "token", "jwt", "login", "password", "用户名", "密码", "basic", "bearer", "proxy-authorization", "鉴权", "users.json", "多账号", "acl", "acl.json", "访问控制", "黑白名单", "白名单", "黑名单", "whitelist", "blacklist", "403", "denied", "ip-denied", "target-denied".
---

# Proxy Authentication Skill

Use this skill when working with proxy authentication, credential verification, or `Proxy-Authorization` header extraction.

> **本文件是路由表：怎么配、怎么用、怎么排查。身份机制不在这里。**
>
> 四个身份插件如何比较凭证、审计载荷、隧道 `tag`、`IdentityProvider` 端口的缺省档与不变集，**唯一一份**在 `src/core/identity/AGENTS.md` 与 `src/core/types/AGENTS.md`（端口形状）＋ `src/core/AGENTS.md`「三个可插值端口」小节。改那边时不要往这里抄第二份——副本就是改一处漂两处的起点。
>
> 分册不会被自动加载：命中下面路由表哪一行，再读那**一个**分册。

## 分册索引（按需加载，**不要预先全读**）

| 分册 | 什么时候读它 |
|---|---|
| [`users.md`](./users.md) | 写或改 `users.json`、查字段形状与 `uid` / Basic 两种匹配形态、账号级 `acl` 与 `quota` 两个可选字段时 |
| [`acl.md`](./acl.md) | 写 `acl.json`、查三组名单（`clientIp` / `target` / `upstream`）的匹配语义、或排查 403（不是 407）时 |
| [`library.md`](./library.md) | 在库代码里注入 `IdentityProvider` / `AccessControl` 替身、或调 `createProxyRuntime({ services })` 时 |
| [`troubleshooting.md`](./troubleshooting.md) | **认证行为与预期不符时读这一份**：凭证没被提取、HS256 校验失败、403 vs 407 的归属、审计日志没打出来 |
| [`references.md`](./references.md) | 只想知道「这个概念落在哪个文件哪一行」时查这一份，不要通读 |

## When to Use

- User enables/disables auth, sets `AUTH_TYPE`/`AUTH_USERS_FILE`/`JWT_SECRET`, edits `cfg/users.json`, writes `cfg/acl.json`, or debugs 407 / 403.
- Do NOT trigger for generic config/env names or defaults — use `proxy-config` instead (this skill owns account-table and ACL _usage_; `proxy-config` owns the `AUTH_*` / `ACL_FILE` env rows).

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

⚠️ Read the **已知边界** in `src/core/identity/AGENTS.md` (凭证防泄漏的判据由 `IdentityProvider.isOwnCredential` 独占) before you do this: with a non-HS256 verifier, tokens it accepts but the built-in HS256 checker does not recognise **will not be stripped** from the outbound `Authorization`. The config-driven path (`AUTH_TYPE=jwt` + `JWT_SECRET`) has **zero** such boundary.

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

## Security Best Practices

1. Use strong passwords (≥12 chars)
2. **Keep the account table non-empty and private** when auth is on (`basic`/`uid` with an empty table is a hard startup error; `users.json` holds plaintext passwords — it is gitignored, keep it mode `0600`)
3. Rotate `JWT_SECRET` periodically
4. Keep `AUTH_LOGGING=true` in production to monitor brute force
5. Use `https`/`sockss*` for `proxyProtocol` to encrypt credentials in transit
6. Limit access via firewall when possible, and **default-deny with ACLs**: a non-empty `clientIp.whitelist` (only your egress IPs) plus `target.blacklist` entries — see the Access Control section above; note `acl.json` also holds plaintext-adjacent policy, so it is gitignored like `users.json`
