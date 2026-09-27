# 上游 URL（`UPSTREAM_URL`）

> **按需分册**：skill 只自动加载 `SKILL.md`（读它的 frontmatter 决定要不要用），同目录的 `*.md` 分册**不会**被自动灌进上下文。
> **什么时候读**：配上游地址、或用六项拆项（host/port/protocol/secure/username/password）覆盖 URL 时

## Upstream URL (UPSTREAM_URL)

`UPSTREAM_URL` and its six endpoint components are **startup** fields. `loadConfig` and the pure-memory runtime share the same strict validation and component-derivation entry; parsing/derivation completes before any store commit, so an invalid URL cannot half-write the target. Changing the URL or any derived endpoint requires rebuilding the runtime (or restarting the process), not a request-path reparse. When it overrides explicitly supplied granular fields, the non-fatal warning remains in the context.

Standard endpoint form, overrides granular `UPSTREAM_*` fields when set:

```env
UPSTREAM_URL=https://user:pass@proxy.example.com:8443
UPSTREAM_URL=socks5://proxy.example.com
UPSTREAM_URL=sockss5://proxy.example.com:1080
```

- Scheme whitelist: `http` / `https` / `socks4` / `socks5` / `sockss4` / `sockss5` (case-insensitive; validated by `src/config/schema/upstream-url.ts:parseUpstreamUrl`, whose module-private `UPSTREAM_SCHEMES` table also owns the per-scheme default port). A config field's parse/split belongs to the config layer, not to `utils` — which is why it lives under `schema/`: `schema/fields.ts` imports it as `./upstream-url.js`, `normalize/upstream.ts` as `../schema/upstream-url.js`.
- Default port by scheme: `http:80` / `https:443` / `socks4, socks5:1080` / `sockss4, sockss5:443`. The http/https defaults are **not** hardcoded twice — they come from `DEFAULT_PORT_HTTP` / `DEFAULT_PORT_HTTPS` in `@/utils/constants/index.js`.
- Validation (strict — blocks startup): bad scheme, empty host, any path/query/hash, port 1-65535 outside range
- Derived fields: `upstreamProtocol/Secure/Host/Port/Username/Password` via `applyUpstreamUrl`; `UPSTREAM_CA` / `UPSTREAM_INSECURE` stay independent
- `UPSTREAM_CA` **defaults to empty** = system trust store. When set, the file is passed as `ca` and **replaces** the system store (only that CA is trusted) — leave it empty for public HTTPS upstreams, set it only for self-signed ones. Read via `src/utils/tls/upstream.ts:readUpstreamCa` (exported as `@/utils/tls/index.js`), whose **only** caller is `upstreamTlsOptions(host, config)`; non-regular files return `undefined` instead of throwing EISDIR. The paired builder is **`upstreamTlsOptions(host, config)` — two parameters, host first** (it pins SNI/cert verification to the dial target: `servername` is blanked for IP literals per RFC 6066, `rejectUnauthorized` is `!upstreamInsecure`, `ca` comes from `readUpstreamCa`). Its **sole consumer is `core/forward/upstream/dial.ts:dialTls`** — TLS negotiation happens wholly inside the connector layer, so `core/forward/channel/http.ts` must not call it (calling it there would negotiate TLS twice). Both require the owning `ConfigAccessor`.
- IPv6 literal hosts are accepted (`socks5://[::1]:1080`) and stored **without** brackets (`upstreamHost === "::1"`), since `net.connect`/DNS reject the bracketed form
- Snapshot logging masks userinfo (`//***@`)
