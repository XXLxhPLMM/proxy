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

Requires Node.js >= 22.6 (the version declared in `package.json`):

```bash
# Extract the Node.js archive
tar -xzf proxy-v*-node22.zip
cd proxy
node app.js --port 3000
```

The Node.js package requires **Node >= 22.6**. Development commands select
`NODE_ENV=development`; the application loader reads the environment files
itself. A plain `pnpm start` preserves the caller's `NODE_ENV` (and uses the
development file when it is unset).

### Build from Source

```bash
git clone https://github.com/b-hole/proxy.git
cd proxy
pnpm install
pnpm build          # esbuild -> dist/app.js + dist/app-v22.js
pnpm start          # node dist/app.js
```

## Configuration

### Priority

```
CLI args  >  Terminal env vars  >  .env files  >  PRESET  >  Defaults
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
| `PRESET` | Named configuration preset | empty | startup |

#### Upstream Proxy (`PROXY_MODE=client` required)

| Variable | Description | Default | Phase |
|----------|-------------|---------|-------|
| `UPSTREAM_URL` | Upstream URL, format `scheme://[user:pass@]host[:port]`, overrides the 6 granular fields below | empty | runtime |
| `UPSTREAM_HOST` | Upstream host | `127.0.0.1` | runtime |
| `UPSTREAM_PORT` | Upstream port | `3000` | runtime |
| `UPSTREAM_PROTOCOL` | Upstream protocol (independent from ingress) | `http` | runtime |
| `UPSTREAM_USERNAME` | Upstream username | empty | runtime |
| `UPSTREAM_PASSWORD` | Upstream password | empty | runtime |
| `UPSTREAM_SECURE` | Force TLS to upstream (OR-ed with the `UPSTREAM_PROTOCOL`-derived default; `sockss4`/`sockss5` are always TLS) | `false` | runtime |
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
| `startup` | Read once at start, restart required | `HOST` `PORT` `PROXY_PROTOCOL` `TLS_KEY` `TLS_CERT` `TLS_CA` `TLS_PASSPHRASE` `CLUSTER_WORKERS` `USE_HOME_CONFIG` `PRESET` |
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

```ts
import { createProxyInstance } from "@b-hole/proxy";

// Importing the library neither reads the environment nor starts a server:
// configuration is code.
const instance = createProxyInstance({
  name: "edge",
  config: { port: 8080, proxyProtocol: "socks5", authType: "basic" },
});
await instance.start();

// Configuration is readable only through this instance's scope; a second
// instance in the same process never sees it.
console.log(instance.config.scope.get("port"));

// The host decides when to stop.
await instance.stop();
```

`createProxyInstance()` reads **no** env/CLI source (config is given as an object,
missing fields fall back to `defaults`). For the full loading chain — env files,
terminal env, CLI argv, presets — use `createProxyInstanceFromEnv({ argv: [] })`.
You **must** pass `argv: []`, otherwise the host process's argv (e.g. a web
server's) is parsed as proxy configuration.

**Any number of instances can coexist in one process, fully isolated** (config,
logging, auth, ACL, routing and the connection set are per instance):

```ts
const a = createProxyInstance({ name: "edge-a", config: { port: 8080 } });
const b = createProxyInstance({ name: "edge-b", config: { port: 9090, authType: "jwt" } });
await Promise.all([a.start(), b.start()]);

await a.reload({ authEnabled: false }); // affects a only
await b.stop();
```

### Swapping in your own implementations (plugin contracts)

Every capability domain is one Provider interface — "same API, different
implementation" — and the composition root's `plugins?` is the override point:

```ts
import { createPluginRegistry, createProxyInstance, NoneAuthProvider } from "@b-hole/proxy";

const instance = createProxyInstance({
  config: { port: 8080, authEnabled: true, authType: "basic" },
  plugins: {
    auths: createPluginRegistry([["none", () => new NoneAuthProvider()]]),
  },
});
```

Adding a capability means implementing the interface and adding one registry entry
— **no existing file changes**. A missing key throws at assembly time
(`require()` is fail-fast) instead of silently falling back to a default.

### Process lifecycle belongs to the host

- Library mode defaults to **`allowProcessExit=false`**: the proxy's rollback /
  stop / signal paths never call `process.exit`, so it cannot kill your host
  process. Pass `{ allowProcessExit: true }` from a host that wants the exit
  fallback (that is exactly what the CLI does).
- **Signals are explicit opt-in**: `start()` binds no process signal. To make
  Ctrl+C stop gracefully, call `instance.attachSignals()` **before** `start()`
  (SIGINT/SIGTERM, plus SIGBREAK on win32; a cluster worker also listens for the
  master's shutdown IPC message).
- After the public `stop()` view times out, await the real full stop with
  `instance.waitForStopSettled()` instead of calling `stop()` again to rewrite the
  grace. While a stop is in flight, `start()` rejects with
  `ERR_PROXY_STOP_IN_PROGRESS`; retry explicitly once the full stop settles.
- **Hot configuration change**: `instance.reload(patch)` is transactional —
  startup fields are rejected as a batch, field ranges and the cross-field auth
  guards run the same validation as startup, and a failure keeps the old values
  and rethrows. `users.json` / `acl.json` hot-reload through the readers' 1s
  throttle and need no reload at all.

### Library boundary

The public library exposes exactly the `src/index.ts` closure: the multi-instance
API (`createProxyInstance` / `createProxyInstanceFromEnv`), configuration
(`createConfigScope` / `initializeConfig` / `prepareRuntimeConfig`), the plugin
contracts and registry (`createPluginRegistry` plus every `*Provider`), the default
assembly factories and the types. There is **no** `ProxyServer` (it is the internal
instance orchestrator), **no** `runServer`, **no** process-wide `get`/`getAll`/`set`,
and no subpath export at all — `package.json` declares `"."` only, and configuration
is readable exclusively through `instance.config.scope`.

The library is a **zero-ESM-dependency CommonJS** package on a Node **>=22.6**
baseline (`require(esm)` needs >=22.12). The former Cordis runtime layer
(`src/runtime/`, with `ConfigService` / `PresetService` / `ErrorService` /
`RuntimeHandle` / `startupFacts` / `eventObserver`) was **deleted outright** — not
"CLI-internal, therefore unexported", but simply gone. Its responsibilities are now
the transactional `commit` of `ConfigScope` (`prepareRuntimeConfig` +
`instance.reload`) and the `ProxyInstance` handle; resource hot-reload runs on a
framework-free in-process event bus with per-instance notice subscriptions.

`scripts/assert-library-boundary.mjs` guards that boundary on the machine: both
`build:lib` and `build:pkg` verify, before `lib/` is registered in the manifest, that
no `lib/runtime`, no `cli.*`, no cordis reference and no `config/store.*` (the deleted
process-wide config singleton) exists; the cordis / `runtime` assertions are
anti-resurrection guards.

When you need process-level hosting (cluster forking, graceful Ctrl+C shutdown, exit
code semantics), run the CLI as a child process (the `proxy` bin or `dist/app.js`),
driven by environment variables and `cfg/*.json`, and observe it through its logs
and stdout. See `docs/cordis-v6-refactor-plan.md` §14 for the decision and the gate.

## Development

```bash
pnpm install
cp cfg/users.json.example cfg/users.json   # Required: .env.development enables uid auth
pnpm dev             # build:dev + start:dev
pnpm dev:hot         # watch + auto-restart
pnpm test:server     # local HTTP test origin
pnpm lint            # eslint: src (*.ts) + tests (*.mjs) + build.mjs + scripts (*.mjs)
pnpm typecheck       # tsc --noEmit
pnpm build:pkg       # controlled all-platform binary + archive build; missing artifacts fail
```

Release builds require Node **>=22.6**. The controlled `build:pkg` wrapper runs the
build, library, pkg, and archive stages in order. The known Windows esbuild exit
code `3221226505` is accepted only after `app.js`, `app-v22.js`, the manifest,
and the library artifacts are complete and SHA-256 verified; every other non-zero
error is propagated. `package-dist` accepts only artifacts registered in that
same batch and verifies the macOS x64 binary with `codesign` or `ldid`; a host
that cannot verify the signature (including Windows without a verifier) fails
closed.

The release tree, pkg staging tree, `pkg.assets`, and every zip are scanned with
lstat and reject symlinks/junctions. Environment basenames are matched without
case sensitivity: only the exact-case root `.env.example` is allowed. Any file
or directory whose basename starts with `.env` (including nested `keys/` entries)
is rejected or stripped, while ordinary certificates remain in the package; an
`.env.example` symlink is never dereferenced. Cleanup independently attempts
binaries, archives, the manifest, and temporary manifests; any deletion failure
returns non-zero instead of allowing stale archives to be collected. Fixed release
directories use non-recursive creation with a post-create lstat check; private pkg
and archive staging directories are created exclusively. Every mutable file is read
through one closed-loop snapshot: lstat, exclusive/no-follow open where available,
fstat, fd read, then fstat/lstat identity and length/hash checks. pkg writes only to
a private output directory, which is copied into exclusive regular-file staging;
only verified bytes are materialized back into `dist/` for the later archive stage,
and macOS x64 signing plus the final archive reuse the same verified fd/bytes. Archive
sources are reconciled against manifest fingerprints before yazl receives their
Buffers, and a temporary zip is written through a pre-opened exclusive fd with
identity checks before and after close/rename. yazl never receives a mutable path.
Manifest `files`/`library.files`/`binaries` maps are null-prototype records and are
looked up with `Object.hasOwn`, so names such as `toString`, `constructor`, and
`__proto__` cannot bypass the unregistered-file check.

## License

[Apache-2.0](LICENSE)
