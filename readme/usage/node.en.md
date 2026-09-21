# Usage — Node.js Package

## Requirements

- **node16 version**: Node.js >= 16 (compatible with 16~21)
- **node22 version**: Node.js >= 22 (recommended, better performance)

## Directory Structure

```
proxy/
├── app.js                    # Main program
├── package.json              # Version info
├── .env.example              # Environment variable template (copy to .env and edit)
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
tar -xzf proxy-v5.0.2-node22.zip   # or proxy-v5.0.2-node16.zip
cd proxy

# Start (default port 3000)
node app.js

# Specify port and protocol
node app.js --port 8080 --proxy-protocol socks5
```

## Configuration

### Basic Setup

```bash
# 1. Copy the env template
cp .env.example .env

# 2. Edit .env
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

```bash
# Option A: Standard URL (recommended)
UPSTREAM_URL=http://user:pass@upstream-proxy:8080

# Option B: Separate fields
UPSTREAM_HOST=upstream-proxy
UPSTREAM_PORT=8080
UPSTREAM_USERNAME=user
UPSTREAM_PASSWORD=pass
```

### Configure TLS

```bash
TLS_KEY=keys/server.key
TLS_CERT=keys/server.crt
PROXY_PROTOCOL=https
```

### Configure Access Control

Edit `cfg/acl.json`:

```json
{
  "clientIp": {
    "whitelist": ["127.0.0.1", "10.0.0.0/8"],
    "blacklist": []
  },
  "target": {
    "whitelist": ["*.google.com", "*.github.com"],
    "blacklist": ["ads.example.net"]
  }
}
```

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

## node16 vs node22

| Version | Requires | Notes |
|---------|----------|-------|
| node16 | Node 16~21 | Broader compatibility |
| node22 | Node 22+ | Better performance with native APIs |

## Notes

- `cfg/users.json` and `cfg/acl.json` ship with empty defaults — safe to run immediately
- To enable auth, edit `cfg/users.json` and restart
- TLS certificates in `keys/` — replace with real certs for production
- Editing `cfg/users.json` or `cfg/acl.json` takes effect within 1 second, no restart needed
- Logging defaults to error-level console output; set `LOG_FILE` to enable JSONL file logging
