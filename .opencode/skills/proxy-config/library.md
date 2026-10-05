# 库模式配置（`ConfigStore` / `ConfigContext` / 私有 store）

> **按需分册**：skill 只自动加载 `SKILL.md`（读它的 frontmatter 决定要不要用），同目录的 `*.md` 分册**不会**被自动灌进上下文。
> **什么时候读**：在库代码里手搓 context、调 `createProxyRuntime({ config })` 纯内存装配，或**排查「我设的 env 为什么不生效」**（库层只消费显式入参，零 `process.env`）时

### Env's influence converges in `loadConfig` — the library layer reads zero `process.env`

`loadConfig` is the **only** place in the repo that reads env / argv / env files, and it merges everything into a `ConfigStore` in **one** commit after all validation passes. The library layer (`createProxyRuntime`, `runtime/presets.ts:pickStartupPreset`, the connectors registry, …) reads **zero** `process.env`. Reading it a second time is the second source of truth, and the shape of the failure is concrete:

- container starts with `PROXY_PROTOCOL=socks5`;
- library code calls `pickStartupPreset(context)`, which re-reads the host env and sees a different value (or worse: the caller **deliberately** put `sockss5` into the `ConfigStore` and the library reads `http` back out of the env);
- now "the protocol written in configuration" and "the protocol actually running" disagree, and **no log line and no event can explain the difference**.

`UPSTREAM_PROTOCOL` has already paid this tuition: the memoized `ConnectorSource` becomes a second source of truth the moment it reads a second, hot-changed value (see `core/forward/upstream/connector/registry.ts`'s file header).

**The two correct routes:**
1. **Choosing the protocol server → use `PROXY_PROTOCOL`.** It was always this job's env key; `loadConfig` collects it into the store and `context.accessor.get("proxyProtocol")` reads it.
2. **Named assembly (change the protocol *and* service doubles *and* upstream access at once) → pass `StartupPreset` programmatically** via `createProxyRuntime({ assembly })`. That decision lives in code where a reader can see it.

⚠️ **There is deliberately no `STARTUP_PRESET` config key.** Adding one would mean touching `FIELDS` + `defaults` + `.env.example` + `setup-env.ts` + the guards over those — six files — to name a decision that, for anyone who genuinely wants a *named* assembly, belongs in code. `PROXY_PROTOCOL` already covers "which protocol server"; presets cover "which assembly, under a name I chose". Guard: `tests/unit/runtime/presets.test.ts` (source-level zero `process.env` / `argv` in `pickStartupPreset` and `runtime.ts`).

## Config Store

`src/config/store.ts` defines instance-owned `ConfigStore`; it has no module-level configuration Map and performs no IO:

```typescript
import { ConfigStore, configAccessorFromStore } from "@b-hole/proxy";

const store = new ConfigStore({ port: 9101, proxyMode: "client" });
store.set("host", "127.0.0.1");

const accessor = configAccessorFromStore(store);
console.log(accessor.get("proxyMode")); // "client"
```

`ConfigAccessor` intentionally exposes only typed `get()`. Consumers read configuration; the owning `ConfigStore` performs writes. `loadConfig` and the package entry are import-safe, and the CLI composition root loads configuration before calling `runServer(context, { logger, noColor, assembly })` — all three go through the `RunServerOptions` object (which also carries `processPolicy` / `services` / `connectors`). There is **no** worker-slot parameter: usage data is shared by every worker in one file, so nothing needs to be threaded per process. `assembly: cliPreset()` is the code form of "the CLI is one assembly of the library presets".

## Library-mode configuration

- `ConfigStore` is the configuration state contract. `new ConfigStore(initial?: Partial<AppConfig>)` seeds every key from `defaults` and applies the supplied patch. `get`, `set`, `getAll`, `has`, `merge`, and `onChange` all operate on that instance; snapshots are shallow copies, and change listeners receive only keys whose values actually changed.
- `loadConfig({ env, envFiles, argv, cwd, store, skipFileValidation })` is the only async loading API. It accepts explicit sources, uses `FIELDS` for parsing/validation, normalizes explicit relative path fields against the final `configDir`, optionally writes into the supplied `ConfigStore` (or creates one), and returns a `ConfigContext` only after every enabled validation succeeds. Rejection leaves the supplied store unchanged.
- `ConfigContext.store` is the live owner, `ConfigContext.accessor` is its single-key read port, and `ConfigContext.config` is a frozen load-time snapshot. `sources`, `startupKeys`, `configDir`, and `warnings` describe the successful load without copying sensitive values into source metadata. Manual contexts must use the object factory; `startupKeys` is not an input and always comes from the complete FIELDS startup set.
- The `config.loaded` payload key is **`source`** (computed by `src/runtime/runtime.ts:sourceName(context)`), selected by first match in `argv` > `environment` > `env-files` > `memory`; mixed inputs report only the highest-priority class.
- A pure-memory runtime owns a private store created from its `config` patch. It accepts `configDir`; all path fields are made absolute at construction, and an omitted `configDir` captures `process.cwd()` only as a convenience default. Its public configuration read port is `runtime.context.accessor`:

  ```typescript
  import { createProxyRuntime } from "@b-hole/proxy";

  const runtime = createProxyRuntime({
    config: { port: 9101, proxyMode: "client" },
    configDir: "/srv/proxy",
  });

  console.log(runtime.context.accessor.get("proxyMode")); // "client"
  runtime.context.store.set("proxyMode", "server");
  ```

- Context mode shares the exact live `ConfigStore` returned by `loadConfig` with runtime/core consumers:

  ```typescript
  import { createProxyRuntime, loadConfig } from "@b-hole/proxy";

  const context = await loadConfig({
    env: { PORT: "9200", PROXY_PROTOCOL: "socks5" },
    envFiles: [".env.local"],
    argv: [],
    cwd: process.cwd(),
    skipFileValidation: true,
  });

  const runtime = createProxyRuntime({ context });
  console.log(context.accessor.get("port")); // 9200
  console.log(runtime.context.accessor.get("proxyMode")); // "server"
  ```

- Runtime startup fields (including `UPSTREAM_URL`) are frozen into the runtime view; later store changes publish `config.restart-required` instead of silently changing the current listener/TLS/upstream setup. Rebuild the runtime to apply them. `runtime.options`, `runtime.services`, and the derived accessor are read-only frozen views; write live runtime values through `runtime.context.store`.
- `start()` / `stop()` are idempotent, but each `start()` re-establishes the bridge, store, and ACL-file subscriptions. Thus `start→stop→start` and `stop-before-start` followed by `start()` both restore the full event/hot-load path. An external `EventHub` remains host-owned and is never cleared by runtime.
- Multiple runtimes sharing a `ConfigContext` intentionally share that store; separate contexts or pure-memory runtimes remain isolated.
- Neither loading nor logger creation mutates `process.env`. Host environment values exist in a loaded context only when the host application (for this repository, `src/cli.ts`) explicitly snapshots and passes them.
