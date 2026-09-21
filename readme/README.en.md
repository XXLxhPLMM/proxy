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

### All Environment Variables

#### Basic

| Variable | Description | Default | Phase |
|----------|-------------|---------|-------|
| `HOST` | Listen address | `0.0.0.0` | startup |
| `PORT` | Listen port | `3000` | startup |
| `PROXY_PROTOCOL` | Protocol: `http`/`https`/`socks4`/`socks5`/`sockss4`/`sockss5` | `http` | startup |
| `PROXY_MODE` | Mode: `server`=direct / `client`=chain through upstream | `server` | runtime |
| `CLUSTER_WORKERS` | Worker count (`0`=CPU cores, `1`=single) | `1` | startup |
| `USE_HOME_CONFIG` | `true` to read config from `~/.proxy/` | `false` | startup |

#### Upstream Proxy (`PROXY_MODE=client` required)

| Variable | Description | Default | Phase |
|----------|-------------|---------|-------|
| `UPSTREAM_URL` | Upstream URL, format `scheme://[user:pass@]host[:port]`, overrides the 6 granular fields below | empty | runtime |
| `UPSTREAM_HOST` | Upstream host | `127.0.0.1` | runtime |
| `UPSTREAM_PORT` | Upstream port | `3000` | runtime |
| `UPSTREAM_PROTOCOL` | Upstream protocol (independent from ingress) | `http` | runtime |
| `UPSTREAM_USERNAME` | Upstream username | empty | runtime |
| `UPSTREAM_PASSWORD` | Upstream password | empty | runtime |
| `UPSTREAM_SECURE` | TLS to upstream | `false` | runtime |
| `UPSTREAM_CA` | Upstream CA path (empty=system trust store) | empty | runtime |
| `UPSTREAM_INSECURE` | Skip upstream cert verification | `false` | runtime |
| `UPSTREAM_TIMEOUT` | Upstream timeout (ms) | `10000` | runtime |

#### Authentication

| Variable | Description | Default | Phase |
|----------|-------------|---------|-------|
| `AUTH_ENABLED` | Enable authentication | `false` | runtime |
| `AUTH_TYPE` | Auth type: `none`/`basic`/`jwt`/`uid` | `none` | runtime |
| `AUTH_USERS_FILE` | Account table path | `cfg/users.json` | runtime |
| `JWT_SECRET` | JWT secret | empty | runtime |
| `AUTH_LOGGING` | Log auth audit events | `true` | runtime |

#### Access Control

| Variable | Description | Default | Phase |
|----------|-------------|---------|-------|
| `ACL_FILE` | ACL file path | `cfg/acl.json` | runtime |

#### TLS / mTLS

| Variable | Description | Default | Phase |
|----------|-------------|---------|-------|
| `TLS_KEY` | TLS private key path | `keys/server.key` | startup |
| `TLS_CERT` | TLS certificate path | `keys/server.crt` | startup |
| `TLS_CA` | mTLS switch (non-empty = require client cert) | empty | startup |
| `TLS_PASSPHRASE` | TLS key passphrase | empty | startup |

#### Logging

| Variable | Description | Default | Phase |
|----------|-------------|---------|-------|
| `LOG_LEVEL` | Console level: `debug`/`info`/`warn`/`error`/`silent` | `error` | runtime |
| `LOG_FILE_LEVEL` | File level (independent from `LOG_LEVEL`) | `info` | runtime |
| `LOG_FILE` | Log dir or file path (empty=no file logging), hourly JSONL rotation | `log` | runtime |

#### Cache

| Variable | Description | Default | Phase |
|----------|-------------|---------|-------|
| `CACHE_TYPE` | Cache backend: `memory`/`redis` | `memory` | runtime |

### When Changes Take Effect

| Phase | Meaning | Fields |
|-------|---------|--------|
| `startup` | Read once at start, restart required | `HOST` `PORT` `PROXY_PROTOCOL` `TLS_KEY` `TLS_CERT` `TLS_CA` `TLS_PASSPHRASE` `CLUSTER_WORKERS` `USE_HOME_CONFIG` |
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
