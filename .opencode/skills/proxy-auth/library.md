# 库模式身份注入

> **按需分册**：skill 只自动加载 `SKILL.md`（读它的 frontmatter 决定要不要用），同目录的 `*.md` 分册**不会**被自动灌进上下文。
> **什么时候读**：在库代码里注入 `IdentityProvider` / `AccessControl` 替身、或调 `createProxyRuntime({ services })` 时

## Library-mode identity injection

- `CoreContext` is the read-only dependency carrier (`{ config, logger, events }`, all three required). `ConfigAccessor` is its configuration port: typed `get()` only; configuration writes remain on the owning `ConfigStore`. Neither `createIdentity` nor `createIdentityFromConfig` has an omitted-argument form.
- **The high-level override point is `createProxyRuntime({ services: { identity, access, traffic } })`.** A supplied service wins; otherwise `buildDefaultServices()` resolves the defaults exactly once. `identity` and `access` are **not** `ProxyOptions` fields you should reach for when you have a runtime — `ProxyOptions.identity` / `access` / `connectors` exist for **directly constructing core** (see `tests/helpers/proxy.ts:withProxy`), and the runtime path injects them on your behalf.
- **To inject a custom access-control policy** (this is also how you make `acl.json` / per-user lists your own engine):

  ```typescript
  import { createProxyRuntime, type AccessControl } from "@b-hole/proxy";

  const access: AccessControl = {
    checkClient: ({ client }) => ({ allowed: !denyIp(client) }),
    checkTarget: ({ host, user }) => (user === "root" ? { allowed: true } : { allowed: !denyHost(host), reason: "policy" }),
    checkRoute: ({ host }) => ({ direct: directFor(host) }),
  };
  const runtime = createProxyRuntime({ config: { port: 9101 }, services: { access } });
  ```

  `reason` / `source` are **free `string`s**, not a closed set — a replacement engine can say `"rate-limited"` / `"geoip"`, and it will reach the `access.target-denied` event **verbatim**. The built-in file-driven engine still only ever says `whitelist` / `blacklist` / `global` / `user`; that is an **internal discipline** held by source-level assertions rather than by the type. Two rules survive the relaxation and are asserted, not assumed: **layer information never goes inside `reason`** (write `"user:blacklist"` and you have merged two facts into one opaque token), and a **missing/empty `reason` or `source` is never back-filled** (back-filling `source` to `global` disguises "refused by a personal list" as "refused globally", sending operators to edit the wrong file).
- All three `AccessControl` methods are **synchronous, by hard decision, not for convenience** — the full argument is in `src/core/AGENTS.md`「三个可插值端口」(`AccessControl` 的三个方法必须同步), with the port shape in `src/core/types/AGENTS.md`; the call chain that forces it is in [`acl.md`](./acl.md) → "Where it is judged". In short: `checkRoute` runs on the **pre-dial hot path of all four inbound channels** and its result feeds a synchronous control-flow chain. **If you need to consult a remote policy, put it behind `IdentityProvider` (`identify` is already `async`), not behind `AccessControl`.**
- A pure-memory runtime owns a private `ConfigStore`. Pass `configDir` when file paths should be anchored outside the current working directory; construction absolutizes all path fields, and the captured `configDir` does not drift after a later `process.chdir()`. If you want to build an identity component explicitly against a runtime, read it through `runtime.context` (which **is** a `CoreContext`):

  ```typescript
  import { createProxyRuntime, createIdentityFromConfig } from "@b-hole/proxy";

  const first = createProxyRuntime({ config: { port: 9101, authEnabled: true, authType: "basic" } });
  const second = createProxyRuntime({ config: { port: 9102, authEnabled: false, authType: "none" } });

  const firstIdentity = createIdentityFromConfig(first.context);
  // first.services.identity is already the equivalent default.
  void firstIdentity;
  void second.services.identity;
  ```

- `runtime.options`, `runtime.services`, and the derived accessor are read-only frozen views; configuration changes go through `runtime.context.store`. `start()` re-establishes the bridge, store, and ACL-file subscriptions after every stop, so `start→stop→start` and `stop-before-start` followed by `start()` both restore identity/ACL events. An externally supplied `EventHub` remains host-owned and its subscriptions are never cleared by runtime.

- Context mode uses the exact live store returned by `loadConfig`; pass the same `ConfigContext` to the runtime and hand it to direct factories:

  ```typescript
  import { createProxyRuntime, loadConfig, createIdentityFromConfig } from "@b-hole/proxy";

  const context = await loadConfig({
    env: { AUTH_ENABLED: "false" },
    envFiles: [],
    argv: [],
    skipFileValidation: true,
  });
  const runtime = createProxyRuntime({ context });
  const fileEvents: string[] = [];
  const identity = createIdentityFromConfig(context, (event) => {
    // Optional: route users-file hot-load events to this service's event/log policy.
    // Do NOT wrap this callback — see the rule below.
    fileEvents.push(event.type);
  });

  console.log(runtime.context.accessor.get("authEnabled")); // false
  void identity;
  void fileEvents;
  ```

- **⚠️ When the caller supplies `onFileEvent` it is passed through verbatim, never wrapped.** That looks like boilerplate you can save but it is a correctness issue: `readJsonCached` de-duplicates transition state **per callback identity** (`src/utils/json-file/subscriber.ts`'s `WeakMap<callback, Map<key, state>>`), so wrapping installs a second subscriber on the same `users.json` and every transition is then reported **twice** — the `[config] 用户账号文件 读取失败…` lines and the `config.file-*` events all double. `live()` runs per request, so that callback identity must be the single one fixed at construction. One fewer entry point always beats one more convenience parameter: two entries writing the same handler table means both get installed while only the later one is honoured, so the earlier one silently stops receiving events (externally: "the log says the list didn't change, but the verdict did").

- Separate pure-memory runtimes have separate stores and accessors. Multiple runtimes built from the same `ConfigContext` intentionally share that context's live store. No identity factory falls back to module-level configuration state.
