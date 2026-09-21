English | [简体中文](README.zh-CN.md)

# @b-hole/proxy

Multi-protocol forward proxy — HTTP / HTTPS / SOCKS4 / SOCKS5 / SOCKSS4 / SOCKSS5 with dual-endpoint heterogeneous chaining, cluster multiprocess, and four authentication methods.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](https://nodejs.org)

---

## Features

- **Six Protocols** — HTTP / HTTPS / SOCKS4 / SOCKS5 / SOCKSS4 (TLS + SOCKS4) / SOCKSS5 (TLS + SOCKS5)
- **Dual-Endpoint Chaining** — Listen on any protocol, forward to any upstream protocol. Ingress and egress are fully independent
- **Four Auth Methods** — Basic / JWT / UID / None. Multi-account table with hot-reload (no restart required)
- **Access Control** — Client IP blacklist/whitelist + target host blacklist/whitelist with wildcard domain matching
- **TLS & mTLS** — Server-side TLS encryption with optional mutual TLS client certificate verification
- **Cluster** — Fork workers by CPU count or fixed number, automatic crash restart
- **Structured Logging** — Human-readable console + JSONL file output, queryable with `jq`
- **Hot-Reload** — Account table and ACL changes take effect within 1 second, no restart needed

## Quick Start

### Binary (Recommended)

Download the archive for your platform, extract, and run:

```bash
# Linux / macOS
tar -xzf proxy-v*-linux-x64.zip
cd proxy
./proxy-linux --port 3000

# Windows
# Extract proxy-v*-win-x64.zip, cd into the directory
proxy-win.exe --port 3000
```

### Node.js

Requires Node.js installed locally (>= 16 for node16 version, >= 22 recommended for node22 version):

```bash
# Extract the Node.js archive
tar -xzf proxy-v*-node22.zip
cd proxy
node app.js --port 3000
```

### Build from Source

```bash
git clone https://github.com/b-hole/proxy.git
cd proxy
pnpm install
pnpm build          # esbuild -> dist/app.js
pnpm start          # node dist/app.js
```

## Configuration

### Priority

```
CLI args  >  Terminal env vars  >  .env files  >  Defaults
```

`.env` files are loaded low → high, later overrides earlier:

1. `.env.production`
2. `.env.development`
3. `.env.<NODE_ENV>` (defaults to `.env.development` if unset)

**Terminal-set variables are never overwritten by files**, so `PORT=9000 pnpm start` always wins.

### Key Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Listen port | `3000` |
| `HOST` | Listen address | `0.0.0.0` |
| `PROXY_PROTOCOL` | Protocol (http/https/socks4/socks5/sockss4/sockss5) | `http` |
| `AUTH_ENABLED` | Enable authentication | `false` |
| `AUTH_TYPE` | Auth type (none/basic/jwt/uid) | `none` |
| `AUTH_USERS_FILE` | Account table path | `cfg/users.json` |
| `JWT_SECRET` | JWT secret | - |
| `LOG_LEVEL` | Console log level | `error` |
| `LOG_FILE` | Log directory or file path | - |
| `UPSTREAM_URL` | Upstream proxy (`scheme://[user:pass@]host[:port]`) | - |
| `CLUSTER_WORKERS` | Worker count (0 = CPU cores) | `1` |
| `TLS_KEY` / `TLS_CERT` | TLS certificate paths | - |
| `TLS_CA` | mTLS switch — non-empty requires client cert | empty |

See `.env.example` for the full variable list.

### When Changes Take Effect

| Phase | Meaning | Fields |
|-------|---------|--------|
| `startup` | Read once at start, restart required | `host` `port` `proxyProtocol` `tls*` `clusterWorkers` |
| `runtime` | Re-read per request | All others |

## Authentication

Enable with `AUTH_ENABLED=true`, enforced per `AUTH_TYPE`. Account table in `cfg/users.json`:

```json
[
  { "username": "admin", "password": "secret" },
  { "username": "guest", "password": "guest123" }
]
```

| Type | Verification |
|------|-------------|
| `none` | Allow all |
| `basic` | Match any account's username + password |
| `jwt` | Verify Bearer token (requires `JWT_SECRET`) |
| `uid` | Match any username (socks4 uses USERID) |

Credential source: HTTP/HTTPS reads `Proxy-Authorization`, falls back to `Authorization`; socks4 uses USERID; socks5 uses USER_PASS negotiation.

## Access Control

Configure `cfg/acl.json`:

```json
{
  "clientIp": {
    "whitelist": ["127.0.0.1", "10.0.0.0/8"],
    "blacklist": ["203.0.113.7"]
  },
  "target": {
    "whitelist": ["*.example.com"],
    "blacklist": ["ads.example.net", "198.51.100.0/24"]
  }
}
```

- **Blacklist match → deny (priority); whitelist non-empty and no match → deny; both empty → allow**
- `clientIp` uses TCP peer address only (ignores `X-Forwarded-For`)
- `target` matches client request host string, no DNS resolution
- `*.a.com` matches subdomains only, not `a.com` itself
- Both files hot-reload within 1 second

## Logging

Console is human-readable text, file output is JSONL (`LOG_FILE` rotates hourly to `log/YYYY-MM-DD-HH.jsonl`):

```bash
jq -r 'select(.user=="alice") | .msg, .target' log/*.jsonl
jq -r 'select(.msg=="[auth] deny") | .client' log/*.jsonl | sort | uniq -c
```

## Docker

```bash
docker build -t proxy .
docker run --env-file .env.production -p 3000:3000 proxy
```

## Use as a Library

```ts
import { ProxyServer, runServer, get, getAll, set } from "@b-hole/proxy";
```

Importing initializes configuration; the server does not start until explicitly called.

## Development

```bash
pnpm install
cp cfg/users.json.example cfg/users.json   # Required: .env.development enables uid auth
pnpm dev             # build:dev + start:dev
pnpm dev:hot         # watch + auto-restart
pnpm test            # vitest run
pnpm lint            # eslint
pnpm typecheck       # tsc --noEmit
```

## License

[Apache-2.0](LICENSE)
