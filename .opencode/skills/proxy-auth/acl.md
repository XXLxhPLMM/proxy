# 访问控制名单（`cfg/acl.json`）

> **按需分册**：skill 只自动加载 `SKILL.md`（读它的 frontmatter 决定要不要用），同目录的 `*.md` 分册**不会**被自动灌进上下文。
> **什么时候读**：写 `acl.json`、查三组名单（`clientIp` / `target` / `upstream`）的匹配语义、或排查 403（不是 407）时

### Access Control (`cfg/acl.json`)

```env
ACL_FILE=./cfg/acl.json          # default <configDir>/cfg/acl.json; missing file = block nothing
```

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "10.0.0.0/8"], "blacklist": ["203.0.113.7"] },
  "target": { "whitelist": ["*.example.com"], "blacklist": ["ads.example.net", "198.51.100.0/24"] },
  "upstream": { "whitelist": ["*.example.com"], "blacklist": ["secret.example.com"] }
}
```

Three independent groups, one file, one hot-reload. `clientIp`/`target` may be omitted (≡ empty); `upstream` may be omitted (≡ empty = everything goes upstream in client mode); unknown top-level or per-group keys → `配置校验失败: ACL_FILE=<path> ...` at startup. Only `ENOENT`, `ENOTDIR`, and non-regular files count as missing; other stat errors keep the last valid ACL and emit an error.

**Entry syntax** (validated by `@/datasource/acl/validate.ts:validateList` → the address syntax layer `src/utils/addr/`: `parseIpRule` in `ip.ts`, `parseHostRule` in `host.ts`):

| Group      | Accepts                                                          | Rejects                                            |
| ---------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| `clientIp` | IP / CIDR only (`1.2.3.4`, `10.0.0.0/8`, `::1`, `2001:db8::/32`) | domains — the TCP peer is always an IP             |
| `target`   | IP / CIDR / exact domain / `*.domain`                            | ports, paths, IDN (write punycode), `_`, non-ASCII |
| `upstream` | same as `target`: IP / CIDR / exact domain / `*.domain`          | ports, paths, IDN (write punycode), `_`, non-ASCII |

- `*.a.com` matches sub-domains of `a.com` **only**, not `a.com` itself (exact and wildcard are separate responsibilities — list both).
- Ports are never allowed in an entry, and bracket stripping is strict: `normalizeIp` peels `[...]` only when the value both starts with `[` and ends with `]`, so **`[::1]:443` is rejected** and `[::1]` is a valid IPv6 literal. Bracket stripping stays strict **on purpose**: loosening it would let a `host:port` string be read as a bare IPv6 literal, which is exactly the fail-open direction.
- `10.0.0.5/24` ≡ `10.0.0.0/24` (host bits are masked); `0.0.0.0/0` matches all; IPv4 vs IPv6 rules never cross-match.
- Domains are matched as **strings** against the requested host (lowercased, trailing dot and `[...]` stripped) — **no DNS resolution**. Consequence: a domain entry does **not** cover a client that dials the IP directly (true for `target` and `upstream` alike — to close both ends, list IP/CIDR entries too).

**Semantics**

- `clientIp` / `target` (identical): blacklist hit → **deny** (wins); else whitelist non-empty && not hit → deny; both empty → allow.
- `upstream` (**action = route, never allow/deny**; **effective only with `PROXY_MODE=client`** — `server` mode ignores the group): blacklist hit → **direct** (**black beats whitelist**, unconditional); else whitelist non-empty && not hit → direct; both empty (group or file missing) → **upstream** (the default). Formula: **go upstream ⇔ hit whitelist ∧ miss blacklist; everything else → direct** — whitelist = the circle of upstream eligibility (outside defaults to direct), blacklist = a veto inside the circle (a named entry goes direct, whoever covers it).

Quick reference: both empty → all upstream | blacklist only → named direct, rest upstream | whitelist only → in-circle upstream, outside direct | both → whitelist grants eligibility + blacklist vetoes (black wins).

**Where it is judged.** All three checks are **methods on the `AccessControl` port** (`{ checkClient, checkTarget, checkRoute }`, all three **synchronous**). The order per allowed request is `clientIp` → auth → `target` → route → dial. The port has exactly **one** built-in implementation: `createFileAccessControl(config)`, which **closes over** `config` — there is no `config` parameter on any of the three methods, so "which configuration is this verdict reading" has no second source of truth. That shape is what keeps the verdict attached to the instance that produced it; a per-call `config` argument would spread that fact across every call site, and any one of them wrong means "instance A's list judging instance B's requests" — a class of bug whose runtime symptom is "the list works sometimes".

1. `services.access.checkClient({ client })` — **stage A** of the shared inbound admission (`core/server/admission.ts:createInboundAdmission(...).admitClientIp(...)`, called by `core/server/http.ts:handleForward()` and `socks-base.ts:onConn()`), i.e. **before auth and (for SOCKS) before the handshake**: a blacklisted IP gets dropped, never a 407. `client` is the TCP peer address. Judgment and response are **separate**: `admitClientIp` publishes `pipe: ip-denied` + settles the `access` terminal; the caller supplies the protocol-shaped response (HTTP writes 403, SOCKS destroys the socket). Deliberately ignores `X-Forwarded-For`/`X-Real-IP` (client-forgeable; those two are only used for auth audit display). `::ffff:1.2.3.4` is normalized to IPv4 (mandatory for Windows/dual-stack). Unresolvable address + a configured whitelist → deny (fail-closed).
   - `admission.ts` receives the whole normalized `CoreServices` package even though it only uses `access` — deliberate, judged by "would a reader wonder why `identity` is in one place and `access` in another, with no principled answer". Splitting the package into "half as a parameter, half as a closure" is the shape that invites that question.
2. Authentication runs next (a `checkClient` pass is **not** an auth bypass — failures still return `407`). Stage B's `admission.authenticate(credentials, rejectedStatus, respond)` injects `requestId`/`connectionId` and settles the `auth` terminal; SOCKS's handshake sits **between** stage A and this call, which is exactly why the admission is two stages rather than one three-gate function.
3. `access.checkTarget({ host, user })` — on all four forward paths (http / CONNECT tunnel / websocket upgrade / socks), once the target is resolved, **after auth and before dialing**, next to the `isSelfLoop` guard. The chain is exactly one: `RequestScope.user` → `ForwarderBase.preDial` → `guardPreDial({ access, … })` → `access.checkTarget`. `ForwarderBase.preDial` is the **only** place in the repo that reads `scope.user`. The judged object is **what the client asked for** (absolute-form request-target authority, falling back to `Host`) — **independent of `proxyMode`**: in `client` mode the dial target is the upstream, and `UPSTREAM_*` is never subject to these lists. Omit `user` and only the global layer runs.
4. `access.checkRoute({ host })` — **client mode only**, immediately after the `target` check and before dialing: decides the route. It never allows or denies — **the route lists cannot waive a `target` denial** (a denied request never reaches routing).
   - ⚠️ **The `proxyMode` mode gate is in `resolveRoute`, NOT in the decision layer.** `helpers/route.ts:resolveRoute(dest, { access, mode })` takes `mode` as a **configuration fact sitting beside** the `access` policy port (they are two parameters, never merged — collapsing them into one "can read anything" accessor would be a second source of truth) and **short-circuits on its very first line** when `mode === "server"`, without asking `access` at all. `checkRoute` itself is a **pure list decision and does not read `proxyMode`**.
   - **Why the gate must not move into the decision layer**: `proxyMode` is a **routing-mode** decision and is **orthogonal to authorization**. Pushing it into `checkRoute` would force every custom policy implementation to re-implement the mode gate, and `checkRoute`'s hard invariant (a mode-free truth table) would gain a mode qualifier. The concrete cost of getting it wrong is observable: `forward/base:emitRoute` skips on `mode === "server" && !reason`, so if the short-circuit is lost, a `proxyMode=server` deployment that happens to have an `upstream` group configured will **emit a spurious `route` event / a spurious `[route]` log line** that the "server mode direct ⇒ zero route events" guard (`tests/integration/forward/upgrade-channel.test.ts`) exists to catch.

**`[route]` log**: one line per allowed request in client mode with fields `target`, `route=direct|upstream`, and `reason=blacklist|whitelist` when the route is direct — `jq 'select(.msg=="[route]")'`. `server` mode logs nothing (the group is ignored).

**Deny behavior**: HTTP/CONNECT/upgrade → `403 Forbidden` (list decisions are credential-unrelated, deliberately never `407`); SOCKS behaves **per layer**: a `clientIp` denial drops the connection **before the handshake** (no protocol reply — there is not even a target to parse yet), while a `target` denial sends a SOCKS **failure reply** (the handshake already parsed the target by then, so silently dropping would leave the client waiting for bytes that never come). One warn per denial: `[ip-denied]` (`client`/`reason`) or `[target-denied]` (`target`/`host`/`reason`), `reason` ∈ `whitelist` | `blacklist`.

**Lifecycle**: same fail-closed/hot-load contract as `users.json` — `loadConfig()` resolves the `ACL_DRIVER` implementation and calls `AclSource.readStartup()` before committing and rejects illegal content (unknown keys or entries such as `192.168.*.*` / `example.com:8080`); **only `ENOENT` is treated as missing on this startup path** (→ all three groups empty, i.e. block nothing; client mode routes everything upstream), every other read failure aborts. At runtime, `loadAcl(configAccessor, onFileEvent?)` reads the same accessor-bound file, edits land within ~1s, and a bad edit or non-missing stat/read error such as `EACCES` keeps the last good snapshot and emits an error instead of silently allowing all traffic — **here** (the `readJsonCached` hot path) the missing set is `ENOENT` / `ENOTDIR` / non-regular files, and every other stat error is `stat-error`, never disguised as missing. Relative paths are absolutized before caching. The explicitly supplied logger renders the event. Regression guards: `tests/integration/acl/client-mode-target.test.ts`（名单判定语义）+ `tests/unit/core/access-control/decision.test.ts`（启动期 fail-closed 与越过 1s 节流的热加载）.
