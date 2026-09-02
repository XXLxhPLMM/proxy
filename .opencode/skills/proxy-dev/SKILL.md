---
name: proxy-dev
description: Use when starting development server, debugging proxy issues, checking logs, or troubleshooting runtime problems. Triggers on "dev", "start", "debug", "log", "运行", "启动", "调试".
---

# Proxy Development Skill

Use this skill when working with the proxy server in development mode.

## Quick Start

```bash
pnpm dev                    # Build and start with .env.development
pnpm start:dev              # Start only (no build) with .env.development
pnpm dev:http               # HTTP proxy mode
pnpm dev:socks              # SOCKS proxy mode
pnpm dev:tls                # TLS proxy mode
```

## Development Server

The dev server runs with hot-reload capability. Configuration is loaded from `.env.development` file.

### Common Development Commands

```bash
pnpm lint                   # Check code style
pnpm typecheck              # Type checking
pnpm build                  # Build for production
```

## Debugging

### Check Server Status

```bash
# Check if port is in use (Windows)
netstat -ano | findstr :<port>

# Check if port is in use (Linux/Mac)
lsof -i :<port>
```

### View Logs

Logs are written to `log/YYYY-MM-DD-HH.log` when `logFile` is configured.

### Common Issues

1. **EADDRINUSE**: Port already in use
   - Kill the process using the port
   - Or use `pnpm start -- --port <next-port>`

2. **Config not loading**: Check `.env.development` file exists

3. **Auth failures**: Check `authEnabled` and credentials in config

## Environment Variables

Development-specific environment variables in `.env.development`:

```env
PORT=3000
AUTH_ENABLED=false
LOG_LEVEL=debug
```

## Runtime Debugging

The server uses `src/utils/logger.ts` for all logging. Logger reads `logLevel` from config.

- Set `LOG_LEVEL=debug` in `.env.development` for verbose output
- Logs include request details, auth attempts, and connection info