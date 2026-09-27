---
name: proxy-config
description: Use when configuring proxy settings, environment variables, CLI arguments, or store/loadConfig/FIELDS internals. Triggers on "config", "配置", "env", "environment", "settings", "环境变量", "cli", "命令行参数", "upstream", "store", "loadConfig", "FIELDS", "users.json", "acl.json".
---

# Proxy Configuration Skill

Use this skill when working with proxy configuration, explicit configuration sources, CLI arguments, or table-driven configuration loading.

> **本文件是路由表：配置项怎么设、优先级、校验规则。分层与加载机制不在这里。**
>
> `src/config/` 的模块分层（`types`/`store`/`schema`/`sources`/`normalize`/`context`/`files`/`load`）、table-driven 加载设计、引用规约、`config → core` 那条唯一出边，**唯一一份**在 `src/config/AGENTS.md`（跨子目录）与它的 5 份子目录 `AGENTS.md`（`schema/` / `sources/` / `normalize/` / `files/` / `files/rules/`）。改那边时不要往这里抄第二份。
>
> 那 5 份子目录文件**不会**被自动加载：命中下面路由表哪一行，再去读**对应那一个**子目录的 `AGENTS.md`。

## 分册索引（按需加载，**不要预先全读**）

| 分册 | 什么时候读它 |
|---|---|
| [`env-defaults.md`](./env-defaults.md) | **查表用**：想知道某个 `*_` 配置项叫什么、默认值是多少、合法取值有哪些 |
| [`recipes.md`](./recipes.md) | 要一份能跑的 `.env` / 启动参数组合时（基础 HTTP / 带鉴权 / 名单 / TLS / cluster） |
| [`upstream.md`](./upstream.md) | 配上游地址、或用六项拆项（host/port/protocol/secure/username/password）覆盖 URL 时 |
| [`library.md`](./library.md) | 在库代码里手搓 context、调 `createProxyRuntime({ config })` 纯内存装配，或**排查「我设的 env 为什么不生效」**（库层只消费显式入参，零 `process.env`）时 |

## When to Use

- User edits `.env.*`, runs `pnpm start -- --port`, asks about defaults, or adds a new `AppConfig` field.
- Do NOT trigger for generic logging/auth questions — use `proxy-logger` / `proxy-auth` instead.

## Configuration Priority

1. Explicit `argv` (highest priority) — `--port 3000` / `--port=3000` / `PORT=3000`
2. Explicit `env` source (including a terminal snapshot supplied by the CLI) — an explicitly present key always wins over every env file, even when its value is `undefined`
3. Explicit `envFiles`, in input order — later files override earlier files
4. `FIELDS.def(configDir)` and hardcoded `defaults` (lowest)

`src/config/load.ts:loadConfig` is the only configuration-loading entry. It never reads the host environment or argv, and it never discovers env files by itself:

- Omitted `env`, `envFiles`, and `argv` mean empty inputs, not “use the host process”.
- `envFiles` contains explicit paths only. Relative paths resolve against the final `configDir`; absolute paths are used as-is. Missing files are skipped; other read errors reject the load.
- `readEnvFiles()` copies the explicit env source, then reads files in order, so later files replace earlier file values while explicit env keys remain authoritative.
- `process.env` is never read or written by the configuration modules. `src/cli.ts` is the separate host boundary: it snapshots the process environment/argv and passes those snapshots as explicit `env`/`argv` to `loadConfig`.
- The CLI helper `defaultEnvFileNames()` generates raw candidates in low→high precedence order `.env.production` → `.env.development` → `.env.<NODE_ENV>`, with the later candidate winning. Duplicate names are removed keeping the last occurrence, so `NODE_ENV=production` actually reads `.env.development` then `.env.production`. The CLI passes the resulting names explicitly. `.env` and `.env.local` are not auto-loaded, but a custom caller may pass any explicit path.

## Validation & Guardrails

- **No silent fallback**: an invalid explicit CLI/env value rejects with `配置校验失败: ...`; invalid bounds reject with `配置校验失败: ... 越界`.
- **JSON config files (fail-closed by default)**: before committing configuration, `loadConfig()` directly reads and validates `AUTH_USERS_FILE` and `ACL_FILE` via `readAuthUsersAsync()` / `readAclAsync()`. Illegal content rejects with `配置校验失败: AUTH_USERS_FILE=<path> ...` / `ACL_FILE=<path> ...`. Only the paths enter the store; runtime values remain hot-loadable through their cached readers.
- **Cross-field auth (fail-closed)**: `assertAuthConfig({ authEnabled, authType, accountCount, jwtSecret })` rejects when auth is enabled with `{basic, uid}` plus an empty account table, with `none`, or with JWT plus an empty secret.
- **`skipFileValidation`**: defaults to `false`. When `true`, both JSON files are not read and `assertAuthConfig` is skipped as well; the caller then owns validation of that combination.
- **Atomic commit**: all parsing, range, env-file, JSON, and cross-field checks finish before one `store.merge(resolved)`. A rejected call leaves a supplied store unchanged rather than half-written.
- **Successful result**: `loadConfig()` returns a `ConfigContext` containing the target `store`, a live single-key `accessor`, a frozen load-time `config` snapshot, an absolute `configDir`, source-key/path metadata, the complete `startupKeys`, and non-fatal warnings. The public `createConfigContext({ store, configDir, sources?, warnings? })` factory is object-only and requires `configDir`; it has no positional overload or implicit cwd fallback, and `startupKeys` is not an input. Importing the package or the load module does not load configuration, start a server, or touch host state.

## JSON Config Files (hot-load)

`cfg/users.json` (`AUTH_USERS_FILE`) and `cfg/acl.json` (`ACL_FILE`) are **runtime-hot-loaded** through `src/utils/json-file/index.ts:readJsonCached`:

- **mtime/size throttled stat**: at most one `stat` per file per `maxAgeMs` (default `1000` ms), so an edit takes effect within ~1s and **without restart**. Relative paths are made absolute before entering the cache. `maxBytes` default `1MiB`.
- **Bad content is not adopted**: a JSON/schema error keeps the **last good snapshot**. Other stat errors such as `EACCES` also keep the last good snapshot (or use the fallback when no history exists) and emit an error; only `ENOENT`, `ENOTDIR`, and non-regular files count as missing. `readJsonCached` itself never logs — it emits edge-triggered `error` / `missing` / `recovered` / `reloaded` events through `onEvent`. The composition layer supplies `createJsonFileEventHandler(logger)` (or passes the same callback into `loadAuthUsers` / ACL binding), so a bad edit or permission error becomes an explicit warn line and recovery becomes info. Reads never throw.
- **True missing file = empty config** (only `ENOENT`, `ENOTDIR`, or a non-regular file; not a file-read error): ACL = all three groups empty (blocks nothing; client mode routes everything upstream), and the account table is empty. A permission/stat error must not silently turn ACL into allow-all. With file validation enabled, `loadConfig` then applies `assertAuthConfig` before committing.

## CLI Arguments

```bash
pnpm start -- --port 3000              # --key value
pnpm start -- --proxy-protocol=socks5  # --key=value
pnpm start -- PORT=3000                # KEY=VALUE form
pnpm start -- --auth-enabled           # bare flag → "true"
```

`KEY=VALUE` splits on the **first** `=`, so values may contain `=` (`JWT_SECRET=Zm9v==` → full `Zm9v==`), matching the `--key=value` path. The CLI snapshots these argv values and passes them explicitly to `loadConfig`; importing the CLI or package does not parse them.

## Environment Variable Names

One name per field — there is no alias table. The `env` of every field lives in `src/config/schema/fields.ts:FIELDS`. An unknown name simply is not matched: CLI keys normalise the same way, so a misspelled `--proxy-type` resolves to nothing rather than to a default.

Protocol enum (both `proxyProtocol` and `upstreamProtocol`): `http | https | socks4 | socks5 | sockss4 | sockss5` (see `src/core/types/proxy.ts:ProxyProtocol`; `src/config/types.ts` only consumes it).

## Adding New Config

1. Add the field to `AppConfig` in `src/config/types.ts`, and its primitive default to `defaults` in `src/config/store.ts`
2. Add ONE row to `FIELDS` in `src/config/schema/fields.ts` — `{ key, env, parse, phase }` are required; add `int: { min, max }` for bounded integers and `path: true` for path fields
3. If user-facing, add the row to the repo-root `.env.example` (and `tests/setup-env.ts:CONFIG_ENV_KEYS`) — those two, not a doc table, are what the guards assert against
