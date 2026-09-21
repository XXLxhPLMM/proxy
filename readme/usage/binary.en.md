# Usage — Binary Package

## Requirements

- No Node.js installation required — the runtime is bundled
- Windows / Linux / macOS x64

## Directory Structure

```
proxy/
├── proxy-win.exe              # Windows executable
├── proxy-linux                # Linux executable
├── proxy-macos                # macOS executable
├── .env.example               # Environment variable template (copy to .env and edit)
├── README.zh-CN.md            # Project overview (中文)
├── README.en.md               # Project overview (English)
├── USAGE.zh-CN.md             # This file (中文)
├── USAGE.en.md                # This file (English)
├── cfg/
│   ├── users.json.example     # Account table template
│   ├── users.json             # Account table (empty, safe to run)
│   ├── acl.json.example       # Access control template
│   └── acl.json               # Access control (empty, allows all)
└── keys/
    ├── server.crt / server.key   # TLS server certificate
    ├── ca.crt / ca.key           # CA certificate
    └── client.crt / client.key   # Client certificate (for mTLS)
```

## Installation & Run

### Linux

```bash
# Extract
tar -xzf proxy-v5.0.2-linux-x64.zip
cd proxy

# Add execute permission
chmod +x proxy-linux

# Start (default port 3000)
./proxy-linux

# Specify port and protocol
./proxy-linux --port 8080 --proxy-protocol socks5
```

### macOS

```bash
tar -xzf proxy-v5.0.2-macos-x64.zip
cd proxy
chmod +x proxy-macos
./proxy-macos --port 3000
```

### Windows

```powershell
# Extract proxy-v5.0.2-win-x64.zip and enter the directory
proxy-win.exe --port 3000
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
./proxy-linux --port 3000

# SOCKS5 proxy
./proxy-linux --proxy-protocol socks5

# HTTPS proxy (requires TLS certs)
./proxy-linux --proxy-protocol https

# Client mode (forward to upstream)
./proxy-linux --proxy-mode client --upstream-url http://up:8080

# Show all options
./proxy-linux --help
```

## Notes

- `cfg/users.json` and `cfg/acl.json` ship with empty defaults — safe to run immediately
- To enable auth, edit `cfg/users.json` and restart
- TLS certificates in `keys/` — replace with real certs for production
- Editing `cfg/users.json` or `cfg/acl.json` takes effect within 1 second, no restart needed
- Logging defaults to error-level console output; set `LOG_FILE` to enable JSONL file logging
