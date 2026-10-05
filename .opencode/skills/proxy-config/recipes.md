# 常用配置组合（可直接抄的 env 片段）

> **按需分册**：skill 只自动加载 `SKILL.md`（读它的 frontmatter 决定要不要用），同目录的 `*.md` 分册**不会**被自动灌进上下文。
> **什么时候读**：要一份能跑的 `.env` / 启动参数组合时（基础 HTTP / 带鉴权 / 名单 / TLS / cluster）

## Common Configurations

### Basic HTTP Proxy

```env
PORT=3000
PROXY_PROTOCOL=http
AUTH_ENABLED=false
```

### Authenticated Proxy

```env
PORT=3000
AUTH_ENABLED=true
AUTH_TYPE=basic
AUTH_USERS_FILE=./cfg/users.json
```

Accounts live in that file (`[{ "username": "admin", "password": "secret" }, ...]`); copy `cfg/users.json.example` to start. An empty table with `basic`/`uid` aborts startup.

Each account may carry an **optional** `acl` with a single `target` group — same entry grammar as the global `acl.json` `target` list (IP / CIDR / domain / `*.domain`, no ports, no DNS):

```jsonc
[{ "username": "alice", "password": "pw1" },
 { "username": "bob",   "password": "pw2",
   "acl": { "target": { "whitelist": ["*.corp.com"], "blacklist": ["ads.io"] } } }]
```

Old `[{username,password}]` files stay valid. **Only `target` is accepted** — `clientIp` / `upstream` / any unknown key makes the entry **invalid** (startup abort): the client-IP decision runs *before* authentication (`clientIp → auth → target ACL → route`), so a per-user source-IP limit cannot be decided there, and `upstream` is a routing list orthogonal to identity. One bad entry invalidates the entry (same fail-closed semantics as the global ACL). Entry legality is judged **only** via `src/utils/addr/host.ts:parseHostRule` — `users.ts` has no second parser. `loadUserPolicy(username, config, onFileEvent?)` reads one user's policy through the **same** `readAuthUsers` → `readJsonCached` path (one throttle cache, one parse, one bad-file policy) and returns it deeply frozen. `acl` is invisible to the credential indexes — never enters `basic`/`uidUsers`, changes no comparison.

**It is enforced.** `access.checkTarget({ host, user })` — the `AccessControl` port, whose built-in file-driven implementation is `core/access-control.ts:createFileAccessControl(config)` — judges two lists: `allow ⇔ global target allows ∧ this user's target allows`. **Global first, and a global rejection short-circuits** (a personal list may only be stricter, never looser); when both refuse, the reported one is **`source:"global"`** (the global list is the authoritative layer — operators should see their own global config problem first). No user / no `acl` / both lists empty → the personal layer is **neutral (allow)**. A personal list never affects the `checkClient` group (no identity before auth) nor the `checkRoute` routing group. The built-in engine's `reason` stays exactly `whitelist|blacklist`; the layer is reported separately in `source` (`access.target-denied` payload and the `[target-denied]` log line both carry it) so an operator can tell whether to edit `acl.json` or `users.json`. ⚠️ That two-valued discipline is an **internal** one: the port types `reason` / `source` as free `string` (a replacement engine may be a rate limiter or a geo-blocker), so the "reason only has two values" rule is held by source-level assertions rather than by the type — see the `proxy-auth` skill's [`library.md`](../proxy-auth/library.md) ("Library-mode identity injection"). Hot reload is the same as the account table (edit the file, ≤1s, no restart). `loadUserPolicy` is on the **per-request** path, so it allocates nothing while the policy snapshot is unchanged (indexed loop + freeze results memoized by source object identity → two consecutive calls return the **same object identity**).

#### Per-user traffic quota — `quota`

```jsonc
[{ "username": "alice", "password": "pw1" },
 { "username": "carol", "password": "pw3",
   "quota": { "bytes": 53687091200, "window": "month" } }]
```

`quota` is **optional**, and so is each of its two sub-fields. **`bytes` missing or zero = that user is unlimited** (0 means "no cap applies"). `bytes` must be a **non-negative safe integer**; a negative / fractional / string / boolean value, or any unknown sub-key (`rateBps`, `maxConnections`, `concurrency`, … — those are deliberately out of scope), makes the whole group **invalid → startup abort**. `quota` and `acl` are validated **independently**: when one is valid and the other is not, the **whole file is rejected** (fail-closed) rather than silently dropping the bad one — a half-dropped field is exactly the "I configured it and it silently did nothing" failure mode.

**`bytes` is one combined cap, not three.** Upload and download are counted **together**; there is deliberately **no per-direction cap**, because exhaustion is an **account-wide ban** (both directions get refused the moment the combined total goes over) — a `bytesUp`-only config therefore really means "the whole account dies, and only after upload is maxed out", which is worse than the operator thinks. Per-direction shaping is a **rate-limiter** job, not a quota job.

**`window` accepts only the two calendar windows `day` / `month`, and defaults to `month`.** Anything else (`"week"`, `"hour"`, `"rolling"`, a different case such as `"DAY"`, a non-string) makes the whole group **invalid → startup abort** — accepting a value we silently treat as `month` is the worst failure mode ("configured, but not in effect"). **Why no rolling window** (`100GB within 30 days`): ① **explanation cost** — an operator looking at "98GB / 100GB used" cannot answer "why am I refused now", and a quota is something operators must be able to explain; ② **aggregation cost** — a rolling window cannot be one scalar, judgement must sum across several historical windows, which does not fit the ledger's lazy model (no timers, no background task); ③ the project is still in design, so we **do not reserve placeholder values** — shipping `window: "rolling"` that behaves like a calendar window is exactly the failure mode above. If it is ever needed, the ledger shape (sliding queue + on-disk format) must be designed together with it.

**The `month` default is normalised on the consumption side** (`datasource/quota-window.ts:quotaWindow`), not in the file layer: the normalised product only echoes what is on disk, so a missing `window` **writes no key at all** (writing it would put a value the operator never configured into the product and break the "old files produce byte-identical output" invariant). `QUOTA_KEYS` is a **closed set that includes `window`** — forgetting it makes every file that carries a window illegal via the "unknown sub-key" rule; there is a dedicated assertion plus a mutation test for that (removing `window` → 6 red).

Window key computation (`windowKey(nowMs, window, shiftHours)`), the lazy "rolling *is* clearing" ledger invariant, and the deliberate DST approximation are documented in `src/datasource/quota-window.ts`; the guards are `tests/unit/datasource/quota/window-key.test.ts` and `tests/unit/datasource/quota/window-rollover.test.ts`.

**`ACCOUNT_KEYS = {username, password, acl, quota}`** — forgetting `quota` here makes *every* file that carries one illegal via the "unknown top-level key" rule. That is the single easiest thing to miss when adding an optional field; there is a dedicated assertion plus a mutation test for it.

`loadUserQuota(username, config, onFileEvent?)` is **structurally identical to `loadUserPolicy`**: same `readAuthUsers` → `readJsonCached` path (one throttle cache, one parse, one bad-file policy — a second reader would create two caches and two divergent views of the same key), so hot reload is verbatim identical (1s stat throttle, a bad file keeps the last good value, missing = empty). It allocates nothing while the quota snapshot is unchanged (indexed loop + a frozen copy memoized by source object identity, so two consecutive calls return the **same object identity**). `quota` is invisible to the credential indexes, exactly like `acl`.

**Judgement is not here.** `datasource/quota/mirror.ts:UsageMirror.consume` decides "is it over" against the single combined `quota.bytes`, rejecting once the running total **exceeds** it, and **exactly hitting the cap is still allowed** (`bytes: 100` lets the user transfer 100 bytes; byte 101 is refused). Reading the quota from disk on every `consume` call is fine because it rides the same 1s-throttled cache. `usage(user)` returns the current window's **combined** byte count, so **remaining = `bytes - usage(user)`**; there is no separate `remaining()` because "what does it return when unlimited" has no good answer. `quota` is also **not** a rate limiter: there is deliberately **no** `rateBps` field — see `core/quota-meter.ts` for why shaping bytes in user space is the wrong tool.

**With auth disabled, quotas do not apply at all** (no identity → no ownership → nothing to attribute bytes to) and startup emits a `[quota-inert]` warn when a real (non-zero `bytes`) quota is configured. Enforcement is a **hard cut**, never "refuse new requests, leave existing ones" — a long-lived tunnel would otherwise never trip the check.

#### Quota ledger — usage survives a restart

Usage is persisted to `<QUOTA_USAGE_DIR>/worker-<slot>.jsonl`: **one JSON delta per line**, `{ ts, u, d, b }` (timestamp / username / `"up"|"down"` / bytes). **Only deltas are ever written; absolute values are summed on read** — writing absolutes makes "whoever wrote last" the single source of truth, so two interleaved flushes overwrite each other and a crash leaves absolutes that cannot be reconciled against the deltas already appended.

Three things an operator must know:

1. **Without a non-all-zero `quota` the ledger does not exist at all**: no directory, no file handle, no background timer. The judgement is a **file fact** (`hasConfiguredQuota`), and it is the *same* function the `[quota-inert]` warning uses — two copies would eventually disagree ("the warning says not configured, the ledger says configured").
2. **Write failures never stop the service** — in-memory counting continues, the verdict keeps working, un-persisted deltas accumulate for the next retry, and one `[usage-write-error]` **error**-level line is emitted. Failing outright would mean "disk full → the whole proxy dies" (an enhancement must not be able to take down the data plane); failing silently would leave you believing quotas are persisted until a restart loses them. **Do not restart when you see that line** — a restart drops the queued deltas; fix the file/directory permissions instead.
3. **The ledger is compacted at startup and whenever it grows past 8MiB** (default threshold). Compaction sums by `(user, windowKey)` and **drops entries from expired windows**, which is what bounds the on-disk half of the "unbounded `jwt` `sub` growth" limitation (28 subs over 28 days compress to a 0-line file, and those slots never come back into memory on restart). Compaction never runs while an append handle is open (on Windows that is `EPERM`), uses `.tmp` + `rename` (so an interrupted compaction leaves the original byte-identical), and is **idempotent** because surviving entries keep their own `max ts` rather than being stamped with "now".

### Access Control

```env
ACL_FILE=./cfg/acl.json
```

See `cfg/acl.json.example` for the file shape and the `clientIp` / `target` / `upstream` schema. Code side, the feature is three layers: entry grammar/rules in `src/utils/addr/` (`ip.ts` / `host.ts`, pure), file read + structure validation in `src/datasource/acl/` (driver chosen by `ACL_DRIVER`), request-time judgement in `src/core/access-control.ts`. All three groups are judged against **what the client asked for**; the upstream address (`UPSTREAM_*`) is never subject to them — in `client` mode a `target` whitelist only needs the sites you allow, not the upstream.

The third group `upstream` is a **routing** list (action = direct connection, blacklist beats whitelist; go upstream ⇔ hit whitelist ∧ miss blacklist, otherwise direct) and is effective **only with `PROXY_MODE=client`** — `server` mode ignores it, and both-empty keeps the go-upstream default of the old behavior. It never allows/denies: routing is judged **after** `target`, so it cannot waive a `target` denial; client mode logs one `[route]` line per allowed request (`target`, `route=direct|upstream`, plus `reason=blacklist|whitelist` when direct). Code side, two things are needed and they are **deliberately not merged**: `access.checkRoute({ host })` (the pluggable policy port, which answers only "should this target go direct?") and `resolveRoute(dest, { access, mode })` in `src/core/helpers/route.ts` (`mode` is a **configuration fact** the caller reads live, sitting **beside** the port rather than inside it). Collapsing them into one "can read anything" accessor would be a second source of truth; `resolveRoute` short-circuits on its first line when `mode === "server"` and never asks `access` at all.

### TLS Proxy

```env
PORT=3443
PROXY_PROTOCOL=https
TLS_KEY=./keys/server.key
TLS_CERT=./keys/server.crt
# Optional: client-certificate CA. Empty = server-only TLS. Set = mTLS enforced
# (clients must present a cert signed by it; an unreadable file aborts startup).
# TLS_CA=./keys/ca.crt
```

- `TLS_CA` is the **mTLS switch** for `https` / `sockss4` / `sockss5`: set → `requestCert + rejectUnauthorized`; empty (default) → no client cert is requested. It must be **empty by default** — `keys/` is a repo-committed test PKI (private keys included).
- mTLS rejections and other TLS handshake failures are logged as `[tls-client-error]` (warn) with `code` / `authorizationError`. That alarm is **not** in `utils/`: it is `src/core/server/tls-alarm.ts:bindTlsClientError` (shared by `core/server/https.ts:doStart` and TLS SOCKS' `onListenerReady`), because translating a core handshake fact into a log line must not make `utils` depend on `core`.
- Repo test PKI for mTLS: server `keys/server.crt`, CA `keys/ca.crt`, client `keys/client.crt` + `keys/client.key`.
- **Certificate reads** go through the `src/utils/tls/` directory, cross-directory via `@/utils/tls/index.js` only: `certs.ts` (`loadCerts` + three types), `server-options.ts` (`requiresClientCert` / `tlsServerOptions`), `upstream.ts` (`readUpstreamCa` / `upstreamTlsOptions`).
- **Relative certificate paths resolve against `configDir` — that is the only answer.** `tlsKey` / `tlsCert` / `tlsCa` / `upstreamCa` are all marked `path: true` in `FIELDS`, so `resolveConfigPaths` absolutizes them against the final `configDir` during `loadConfig` / `createConfigContext` / pure-memory runtime construction. `loadCerts` performs **no** path resolution of its own (it must not grow a cwd-based one either) and hands the given path straight to `readFileSync`; it only throws when the material is missing or unreadable.

### Multiple instances

One proxy per process; no in-process multi-process mode. Scale out with containers, each with its
own `PORT` / `MANAGER_PORT`. Shared data (accounts / ACL / quota ledger) still resolves to the same
files if the containers mount the same config directory.
