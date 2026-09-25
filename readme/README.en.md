English | [简体中文](README.zh-CN.md)

# @b-hole/proxy

Multi-protocol forward proxy — HTTP / HTTPS / SOCKS4 / SOCKS5 / SOCKSS4 / SOCKSS5 with dual-endpoint heterogeneous chaining, cluster multiprocess, and four authentication methods.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](https://nodejs.org)

---

## Features

- **Six Protocols** — HTTP / HTTPS / SOCKS4 / SOCKS5 / SOCKSS4 (TLS + SOCKS4) / SOCKSS5 (TLS + SOCKS5); each instance starts one protocol selected by `PROXY_PROTOCOL`, and multiple instances can listen on different ports simultaneously
- **Dual-Endpoint Chaining** — Listen on any protocol, forward to any upstream protocol. Ingress and egress are fully independent
- **Four Auth Methods** — Basic / JWT / UID / None. Multi-account table with hot-reload (no restart required)
- **Access Control** — Client IP blacklist/whitelist + target host blacklist/whitelist + client-mode upstream/direct routing list, with wildcard domain matching
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

Requires Node.js installed locally (**>= 22.6** for both CLI and library mode):

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
  },
  "upstream": {
    "whitelist": ["*.example.com"],
    "blacklist": ["secret.example.com"]
  }
}
```

- Three jobs: `clientIp` who may use it (source) | `target` whether it may be reached (destination) | `upstream` how client mode routes (upstream vs direct)
- **`clientIp` / `target`: blacklist match → deny (priority); whitelist non-empty and no match → deny; both empty → allow**
- **`upstream` (action = direct connection, skipping the upstream): blacklist match → direct (**black beats whitelist**, unconditional); whitelist non-empty and no match → direct; both empty (group or file missing) → go upstream (default, byte-for-byte the old behavior)**. One-line formula: **go upstream ⇔ hit the whitelist ∧ miss the blacklist; everything else → direct** — whitelist = the circle of upstream eligibility (outside the circle defaults to direct); blacklist = a veto inside the circle (a named entry goes direct, no matter who covers it)
- **Effective only with `PROXY_MODE=client`**; `server` mode ignores the group entirely (no side effects, zero cost)
- Order of checks: `clientIp` (who) → authentication → `target` blacklist/whitelist (may it be reached; denial = `403` / handshake drop) → `upstream` group (how to route) → dial. **The route lists never waive a `target` denial**

Quick reference per `upstream` configuration:

| `upstream` config | Effect |
|------|------|
| Both empty (group or file missing) | Everything goes upstream (default, same as the old behavior) |
| blacklist only | Named entries go direct, the rest upstream |
| whitelist only | In-circle upstream, outside-circle direct |
| whitelist + blacklist | Whitelist grants eligibility + blacklist vetoes (black wins) |

- `clientIp` accepts **IP / CIDR only** (the peer is always an IP; a domain entry is invalid → startup abort). IPs have **no `*` wildcard** — express ranges with CIDR (`10.0.0.0/8`, `2001:db8::/32`)
- `target` accepts **IP / CIDR / domain / `*.wildcard`**; entries **do not support ports** and trigger **no DNS resolution**; IDN domains must be punycode (`xn--...`)
- `upstream` entry syntax is identical to `target` (**IP / CIDR / domain / `*.wildcard`**, no ports, no DNS resolution, punycode for IDN, CIDR instead of `*` for IP ranges)
- `clientIp` uses TCP peer address only (deliberately ignores `X-Forwarded-For` / `X-Real-IP` — both are forgeable)
- `target` matches the client-request host string; **domain entries cannot stop a client that dials the IP directly** — list both the domain and its resolved IP/CIDR to close both ends; the **`upstream` group shares that same bypass boundary**: domain entries never cover a client that writes the IP directly — list IP / CIDR entries to cover it
- `*.a.com` matches subdomains of `a.com` only, **not `a.com` itself** (list the apex separately)
- Denial behavior: HTTP / CONNECT / WebSocket return **403** (list decisions are credential-unrelated, deliberately never `407`; `clientIp` is judged before authentication, `target` after authentication / before dialing); SOCKS drops the `clientIp` denial before the handshake (no bytes sent) and answers a `target` denial with a failure reply; each denial logs a warn — `[ip-denied]` / `[target-denied]`
- **Whitelist ≠ auth bypass** — passing the whitelist only clears the first gate; credentials are still required per `AUTH_*` (auth failure returns `407`)
- In client (chaining) mode the upstream address (`UPSTREAM_*`) **never enters the lists** — the lists always judge the target the client requested (the `upstream` group judges that same target too, it only picks the route)
- **`[route]` log**: one line per allowed request in client mode, with fields `target`, `route=direct|upstream` (plus `reason=blacklist|whitelist` when direct), filterable via `jq 'select(.msg=="[route]")'`; `server` mode never logs it
- Missing file = all three groups empty: nothing blocked, client mode routes everything upstream; invalid content at startup (unknown keys, illegal entries such as `192.168.*.*` / `example.com:8080`) = **startup abort** (fail-closed); broken at runtime = keep the last valid config + warn
- Both files hot-reload within 1 second, no restart needed

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

> This package requires **Node.js >= 22.6** for both CLI and library mode. The library entry exports APIs and does not start a service automatically; import the package root `@b-hole/proxy`, not internal paths behind the `exports` map.

Shortest runnable example:

```ts
import { createProxyRuntime } from "@b-hole/proxy";

async function main(): Promise<void> {
  const runtime = createProxyRuntime({
    config: {
      host: "127.0.0.1",
      port: 8787,
      proxyProtocol: "http",
    },
  });

  try {
    await runtime.start();
    console.log(`proxy listening on ${runtime.getStats().host}:${runtime.getStats().port}`);
  } finally {
    await runtime.stop();
  }
}

void main();
```

### Zero-side-effect guarantees in library mode

`createProxyRuntime()` uses only the in-memory configuration and dependencies supplied by the caller. Apart from the network listener opened by an explicit `start()` call, it does not:

- read `.env.production`, `.env.development`, or any other `.env` file;
- read `process.env` or `process.argv`, or write to and pollute `process.env`;
- install signal handlers, call `process.exit`, or take over the host process lifecycle;
- use cluster, create log files, or automatically select the CLI global logger (the default is `createNoopLogger()`);
- read or write the CLI global `get`/`set` configuration singleton. Every runtime owns its own `ConfigStore`.

If configuration really needs to come from files or command-line arguments, call `loadConfig()` explicitly as shown below. That is a caller-requested file read, not an implicit environment read by `createProxyRuntime()`.

> Exception: with `https`/`sockss4`/`sockss5` and explicitly configured certificate paths, the protocol lazily reads those TLS files during `start()`. This is explicit protocol configuration, not an implicit scan of other configuration sources.

### Inject custom authentication

Inject an `AuthProvider` through `services.auth` to replace the default authentication service. This example accepts one fixed token; production code can connect a session, RBAC, or remote authentication service here:

```ts
import { createProxyRuntime, type AuthProvider } from "@b-hole/proxy";

const auth: AuthProvider = {
  isEnabled: true,
  authType: "custom",
  async authenticate(ctx) {
    const raw = ctx.req.headers["proxy-authorization"];
    const token = Array.isArray(raw) ? raw[0] : raw;
    return {
      passed: token === "Bearer app-token",
      username: "app-user",
    };
  },
};

const runtime = createProxyRuntime({
  config: { host: "127.0.0.1", port: 8788, authEnabled: true },
  services: { auth },
});

try {
  await runtime.start();
} finally {
  await runtime.stop();
}
```

### Subscribe to strongly typed events

`runtime.events` is the runtime-private, strongly typed event bus. The event name infers its payload type, so `event.data` exposes the fields of `auth.decided` directly:

```ts
const runtime = createProxyRuntime({
  config: { host: "127.0.0.1", port: 8789 },
});
const subscription = runtime.events.subscribe("auth.decided", (event) => {
  const decision = event.data;
  console.log("auth:", decision.passed, decision.user ?? "-", decision.reason ?? "-");
});

try {
  await runtime.start();
} finally {
  subscription.dispose();
  await runtime.stop();
}
```

### Correlate events per request (requestId)

Every per-request event carries `event.context.requestId` (plus `connectionId`, `protocol`, and `client`), so the auth, routing, and terminal events of one request can be stitched into a single trace:

```ts
import { createProxyRuntime } from "@b-hole/proxy";

const runtime = createProxyRuntime({ config: { port: 8793 } });

// Group by requestId to reconstruct the full trace of a request
const byRequest = new Map<string, string[]>();
const track = (e: { context: { requestId?: string }; name: string }): void => {
  const id = e.context.requestId;
  if (id) byRequest.set(id, [...(byRequest.get(id) ?? []), e.name]);
};

for (const name of ["auth.decided", "route.selected", "request.completed", "request.rejected", "request.failed"] as const) {
  runtime.events.subscribe(name, (e) => track({ context: e.context, name: e.name }));
}

await runtime.start();
// A rejected request leaves: auth.decided → request.rejected
// A successful request leaves: route.selected → request.completed (same requestId)
```

All events of one request share the same `requestId`. Multiple requests over the same TCP connection (HTTP keep-alive) share one `connectionId` but get distinct `requestId`s.

### Use a configuration preset

Instead of spelling out the whole config, start from a built-in preset and override individual keys with an explicit `config`:

```ts
import { createProxyRuntime, listPresets } from "@b-hole/proxy";

console.log(listPresets()); // ["development", "socks5-basic", "secure-http-auth", "https-tls"]

const runtime = createProxyRuntime({
  preset: "socks5-basic",              // preset as the base
  config: { port: 8794 },              // explicit config overrides the preset
});
```

You can also merge presets yourself with `applyPreset()`, or register your own with `registerPreset()` / `definePreset()`:

```ts
import { applyPreset, definePreset, registerPreset } from "@b-hole/proxy";

// Manual merge: base → preset → overrides
const config = applyPreset("secure-http-auth", { host: "127.0.0.1" }, { port: 8795 });

// Register a custom preset
registerPreset(definePreset({
  name: "team-socks",
  description: "Team intranet SOCKS5",
  config: { proxyProtocol: "socks5", host: "0.0.0.0", upstreamTimeout: 20000 },
}));
```

### Isolated multiple instances

Different ports, protocols, and configurations can run at the same time. Each instance has isolated configuration, events, logger, and services:

```ts
import { createProxyRuntime } from "@b-hole/proxy";

const httpRuntime = createProxyRuntime({
  config: { host: "127.0.0.1", port: 8790, proxyProtocol: "http" },
});
const socksRuntime = createProxyRuntime({
  config: { host: "127.0.0.1", port: 8791, proxyProtocol: "socks5" },
});

await Promise.all([httpRuntime.start(), socksRuntime.start()]);
try {
  // Both instances are serving; connect the application's own lifecycle here.
  console.log(httpRuntime.runtimeId, socksRuntime.runtimeId);
} finally {
  await Promise.all([httpRuntime.stop(), socksRuntime.stop()]);
}
```

### Load configuration explicitly

`loadConfig()` makes both the data source and destination explicit. Library callers should provide their own `env`/`argv` and set `writeProcessEnv: false` so `.env` values cannot pollute the host process; parsed values are written to an isolated `ConfigStore`:

```ts
import { createProxyRuntime, loadConfig } from "@b-hole/proxy";

const { store } = loadConfig({
  env: { PROXY_PROTOCOL: "http", PORT: "8792" },
  argv: [],
  writeProcessEnv: false,
});

const runtime = createProxyRuntime({ config: store.getAll() });
try {
  await runtime.start();
} finally {
  await runtime.stop();
}
```

### CLI mode versus library mode

| Concern | CLI mode (`dist/app.js` / `ProxyServer`) | Library mode (`ConfigStore` + `createProxyRuntime`) |
|---|---|---|
| Environment variables, `.env`, argv | `initConfig()` reads and validates them | The runtime does not read them; only explicit `loadConfig()` uses caller-supplied sources |
| `process.env` | The CLI loader follows its existing rules | Not read or written by default; `loadConfig({ writeProcessEnv: false })` guarantees no host pollution |
| Signals and exit | CLI/server owns signal handling, graceful shutdown, and exit codes | No handlers are installed and `process.exit` is never called; the host decides |
| Cluster | `runServer()` can fork workers according to configuration | No cluster; the host can orchestrate multiple runtimes when needed |
| Logging | The CLI global logger can persist JSONL | Noop by default; output requires an injected `Logger` or `createConsoleLogger()` |
| Lifecycle | `runServer()` / `ProxyServer` are process-oriented | `runtime.start()` / `runtime.stop()` are idempotent and caller-managed |

The CLI compatibility exports remain available for process-level use:

```ts
import { ProxyServer, runServer, get, getAll, set } from "@b-hole/proxy";
```

> `get`, `set`, `ProxyServer`, and `runServer` are CLI-compatibility or process-level APIs. In library mode, prefer `ConfigStore` + `createProxyRuntime()` to preserve instance isolation and avoid taking over the host process.

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
