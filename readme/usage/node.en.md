# Usage — Node.js Package

## Requirements

- **Node.js >= 22.6** (required for both CLI and library mode)

## Directory Structure

```
proxy/
├── app.js                    # Main program
├── package.json              # Version info
├── .env.example              # Environment template (copy to .env.development or .env.production)
├── README.zh-CN.md           # Project overview (中文)
├── README.en.md              # Project overview (English)
├── USAGE.zh-CN.md            # This file (中文)
├── USAGE.en.md               # This file (English)
├── cfg/
│   ├── users.json.example    # Account table template
│   ├── users.json            # Account table (empty, safe to run)
│   ├── acl.json.example      # Access control template
│   └── acl.json              # Access control (empty, allows all)
└── keys/
    ├── server.crt / server.key   # TLS server certificate
    ├── ca.crt / ca.key           # CA certificate
    └── client.crt / client.key   # Client certificate (for mTLS)
```

## Installation & Run

```bash
# Extract
tar -xzf proxy-v5.0.2-node22.zip
cd proxy

# Start (default port 3000)
node app.js

# Specify port and protocol
node app.js --port 8080 --proxy-protocol socks5
```

## Configuration

### Basic Setup

```bash
# 1. Copy the env template (development)
cp .env.example .env.development

# 2. Edit .env.development (use .env.production in production)
PORT=3000
PROXY_PROTOCOL=http
LOG_LEVEL=info
```

### Enable Authentication

```bash
# 1. Edit cfg/users.json to add accounts
[
  { "username": "admin", "password": "your-secret" },
  { "username": "guest", "password": "guest123" }
]

# 2. Enable in .env
AUTH_ENABLED=true
AUTH_TYPE=basic
```

### Configure Upstream Proxy

> **Important**: Upstream proxy only works with `PROXY_MODE=client`. The default `server` mode connects directly to targets.

```bash
# 1. Enable client mode
PROXY_MODE=client

# 2. Option A: Standard URL (recommended)
UPSTREAM_URL=http://user:pass@upstream-proxy:8080

# 2. Option B: Separate fields
UPSTREAM_HOST=upstream-proxy
UPSTREAM_PORT=8080
UPSTREAM_PROTOCOL=socks5
UPSTREAM_USERNAME=user
UPSTREAM_PASSWORD=pass
```

`UPSTREAM_URL` and its six endpoint components are **startup** settings. They are validated and expanded at construction; changing any requires rebuilding/restarting the runtime or process. A URL that also overrides explicit granular fields keeps the override warning.

### Configure TLS

```bash
TLS_KEY=keys/server.key
TLS_CERT=keys/server.crt
PROXY_PROTOCOL=https
```

### Configure Access Control

Edit `cfg/acl.json` — the three groups have different jobs:

- **`clientIp`** — who may use this proxy (source-side), **IP / CIDR only**
- **`target`** — where the proxy is allowed to connect (destination-side): **IP / CIDR / domain / `*.wildcard`**; a denial = `403` / handshake drop
- **`upstream`** — how client mode routes (routing-side): entry syntax identical to `target`; **action = direct connection (skip the upstream)**, effective only with `PROXY_MODE=client`, ignored in `server` mode

`clientIp` / `target` semantics: **blacklist match → deny (priority); whitelist non-empty and no match → deny; both empty → allow**.
`upstream` semantics (action = routing, never allow/deny): **blacklist match → direct (black beats whitelist); whitelist non-empty and no match → direct; both empty (group or file missing) → go upstream (default, identical to the old behavior)** — **go upstream ⇔ hit the whitelist ∧ miss the blacklist, everything else → direct**.
Order of checks: `clientIp` (who) → authentication → `target` (may it be reached) → `upstream` (how to route) → dial; **the route lists never waive a `target` denial**.
Changes to valid `cfg/users.json` / `cfg/acl.json` contents and their configured paths take effect within 1 second, without a restart. A non-missing stat/read error such as `EACCES` keeps the last valid file and is reported; it does not silently turn the ACL into allow-all.

#### Recipes

**① Block a specific target domain (incl. subdomains)**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "blacklist": ["openrouter.ai", "*.openrouter.ai"] }
}
```

Effect: requests to `openrouter.ai` and its subdomains get `403` **before dialing** (the target never sees a connection) on HTTP / CONNECT, and a failure reply on SOCKS. `*.a.com` does not cover the apex `a.com` — list **both** entries.

**② Block a batch of ad / malware sites**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "blacklist": ["ads.example.net", "tracker.example.org", "*.malware.test"] }
}
```

**③ Allow only listed targets (whitelist mode)**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": ["*.google.com", "*.github.com"] }
}
```

Effect: a non-empty whitelist means **deny-by-default** — every target outside the list returns `403`.

**④ Ban source IPs / IP ranges**

```json
{
  "clientIp": { "whitelist": [], "blacklist": ["203.0.113.7", "198.51.100.0/24"] },
  "target": { "whitelist": [], "blacklist": [] }
}
```

Effect: rejected on connect, **before any authentication work** — HTTP / CONNECT / WebSocket return `403`; SOCKS is dropped **before the handshake** (no bytes sent). Each hit logs warn `[ip-denied]`. Express ranges with CIDR; there is **no `*` wildcard** (`198.51.*.*` aborts startup).

**⑤ Localhost / intranet only**

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "::1", "10.0.0.0/8", "192.168.0.0/16"] },
  "target": { "whitelist": [], "blacklist": [] }
}
```

Effect: only listed sources can connect; everything else (including unresolvable addresses) is denied — fail-closed.

**⑥ Close both ends: domain + IP (anti-bypass)**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "blacklist": ["openrouter.ai", "*.openrouter.ai", "x.x.x.x/24"] }
}
```

Effect: `target` domain entries match the request host string with **no DNS resolution** — a client that dials the IP directly bypasses domain entries. Add the domain's resolved IP/CIDR to block both ends (replace the `x.x.x.x/24` placeholder with the real range).

**⑦ Combined: intranet-only + target lists**

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "10.0.0.0/8"] },
  "target": { "whitelist": ["*.example.com"], "blacklist": ["secret.example.com"] }
}
```

Effect: the `clientIp` whitelist keeps external sources out; within `target`, the **blacklist wins over the whitelist** — `secret.example.com` is denied even though `*.example.com` covers it. Note the **whitelist does not bypass authentication**: credentials per `AUTH_*` are still required (auth failure returns `407`, distinct from ACL's `403`).

**⑧ Block nothing (default)**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": [], "blacklist": [] }
}
```

A missing file behaves the same as empty lists: nothing is blocked.

> **⑨–⑫ apply only with `PROXY_MODE=client`**: the `upstream` group's action is **direct connection** (skip the upstream; **black beats whitelist**) — it only picks a route, it never allows or denies; `server` mode ignores the group entirely (no side effects, zero overhead). Routing is judged **after** `target` — a request denied by `target` never reaches routing, and **the route lists never waive a `target` denial**.

**⑨ Intranet targets go direct (`10.0.0.0/8` etc. never touch the upstream)**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": [], "blacklist": [] },
  "upstream": { "whitelist": [], "blacklist": ["10.0.0.0/8", "192.168.0.0/16", "*.internal.example.com"] }
}
```

Effect: blacklist-matched intranet IPs / domains are dialed **directly** (the upstream is skipped); every other target goes upstream. `[route]` logs show `route=direct reason=blacklist` (filter with `jq 'select(.msg=="[route]")'`).

**⑩ Whitelist-scoped upstream (outside the circle → direct)**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": [], "blacklist": [] },
  "upstream": { "whitelist": ["*.example.com"], "blacklist": [] }
}
```

Effect: only `*.example.com` — inside the circle of upstream eligibility — is handed to the upstream; targets outside the circle always connect directly. `[route]` logs show `route=upstream` inside the circle and `route=direct reason=whitelist` outside.

**⑪ Named targets go direct (blacklist only)**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": [], "blacklist": [] },
  "upstream": { "whitelist": [], "blacklist": ["secret.example.com"] }
}
```

Effect: `secret.example.com` is forced direct (the upstream is skipped) while every other target goes upstream. `[route]` logs show `route=direct reason=blacklist`.

**⑫ Both lists: whitelist grants eligibility, blacklist vetoes**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": [], "blacklist": [] },
  "upstream": { "whitelist": ["*.example.com"], "blacklist": ["secret.example.com"] }
}
```

Effect: inside the circle `*.example.com` goes upstream, but `secret.example.com` is vetoed by the blacklist → direct (**black beats whitelist**); targets outside the circle go direct. `[route]` logs show `route=upstream`, `route=direct reason=blacklist`, and `route=direct reason=whitelist` respectively.

#### Syntax Constraints (invalid → startup abort)

All of the following are **invalid**; the process exits with an error at startup (fail-closed) instead of running with a bad config:

```json
{
  "clientIp": { "blacklist": ["openrouter.ai"] },
  "target": { "blacklist": ["192.168.*.*", "example.com:8080"] }
}
```

| Wrong | Why it fails |
|-------|--------------|
| Domain in `clientIp` | The peer is always an IP — domains are invalid → abort |
| `192.168.*.*` | IPs have no `*` wildcard → use CIDR (`192.168.0.0/16`) |
| `example.com:8080` | Entries do not support ports → host only |
| Raw IDN domain | Must be punycode (`xn--...`) |

`upstream` entries follow exactly the same syntax as `target` (IP / CIDR / domain / `*.wildcard`, no ports, punycode for IDN, CIDR instead of `*` for IP ranges) — the table above applies to that group too.

> Breaking `cfg/acl.json` while running never kills the service: the last valid config is kept + a warning is logged; the new (valid) content takes effect within 1 second.

## Common Commands

```bash
# Basic start
node app.js --port 3000

# SOCKS5 proxy
node app.js --proxy-protocol socks5

# HTTPS proxy (requires TLS certs)
node app.js --proxy-protocol https

# Client mode (forward to upstream)
node app.js --proxy-mode client --upstream-url http://up:8080

# Via environment variables
PORT=8080 PROXY_PROTOCOL=socks5 node app.js

# Background (Linux/macOS)
nohup node app.js --port 3000 > /dev/null 2>&1 &
```

## Notes

- `cfg/users.json` and `cfg/acl.json` ship with empty defaults — safe to run immediately
- Add/remove accounts by editing `cfg/users.json`; the table hot-reloads within at most 1 second, so adding an account does not require a restart
- `AUTH_USERS_FILE` / `ACL_FILE` path fields are hot-changeable; auth types and other settings follow the documented phase
- TLS certificates in `keys/` — replace with real certs for production
- Editing `cfg/users.json` or `cfg/acl.json` takes effect within 1 second, no restart needed
- Logging defaults to error-level console output; set `LOG_FILE` to enable JSONL file logging
