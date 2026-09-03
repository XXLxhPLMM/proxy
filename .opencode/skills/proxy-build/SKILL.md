---
name: proxy-build
description: Use when building, bundling, packaging, or compiling the proxy project. Triggers on "build", "bundle", "pack", "构建", "打包", "编译", "compile".
---

# Proxy Build Skill

Use this skill when building, bundling, or packaging the proxy project.

## Commands

See `AGENTS.md` → `Commands` for the full script list (`build`, `build:watch`,
`build:lib`, `build:all`, `build:pkg`, `dev:*`). This skill only documents
what those commands don't: internals, output layout, and troubleshooting.

## Watch Mode (`pnpm build:watch`)

- The long-lived watcher NEVER loads esbuild: on Windows + Node22 the esbuild
  process crashes natively on exit with STATUS_STACK_BUFFER_OVERRUN 3221226505
  (artifacts already written, zero output, uncatchable — `process.exit(0)`
  doesn't prevent it), which would silently kill any watcher in the same process.
- Uses `fs.watch(src/, recursive)` (ignores generated `banner.ts`) + spawns a
  disposable one-shot `node build.mjs` child per change, debounced 300ms.
- A natively-crashed child costs one log line; success is decided by exit code +
  `dist/app.js` mtime (post-write teardown crash counts as success, dev-server
  still restarts). One automatic retry when dist is unchanged.
- Logs every build: `[build] build started (<reason>)...` / `finished in <n>ms`.
- Env files (`.env*`) are loaded at **runtime**, never bundled — editing them
  triggers a server restart via `scripts/dev-server.mjs`, not a rebuild.

## Build Output Structure

```
dist/
├── app.js              # Main bundle (CJS, Node22, `@/*` → `src/*`)
├── app.js.map          # Sourcemap (always generated, ships with bundle)
├── .env.example        # Example env file
├── .env.development    # Dev env (if exists)
├── .env.production     # Prod env (if exists)
├── keys/               # TLS certs (if exists)
├── README.md
└── package.json

lib/                    # `pnpm build:lib` only: tsc + tsc-alias declarations
├── index.d.ts
├── config/
│   ├── store.d.ts
│   └── loader.d.ts
├── core/
│   ├── types.d.ts
│   └── ...
└── ...
```

`build.mjs` also regenerates `src/utils/banner.ts` via `scripts/gen-banner.mjs`
before every bundle (glyphs live in `scripts/fonts/ansi-shadow.json`, not in code).
Missing assets are skipped gracefully, never fail the build.

## Common Build Issues

1. **STATUS_STACK_BUFFER_OVERRUN** (Windows + Node22)
   - `node --watch` crashes with 0xC0000409 on file restart; esbuild's own
     process crashes on exit even after artifacts are written.
   - Never use either for long-lived processes — `dev:watch`/`dev:hot` use
     `scripts/dev-server.mjs` + one-shot build children instead.

2. **Missing assets**
   - Build skips missing files gracefully.
   - Check `.gitignore` for excluded patterns.

3. **Path alias errors**
   - Ensure `@/*` configured in both `tsconfig.json` and esbuild.

4. **Type errors**
   - Run `pnpm typecheck` before build.
   - Fix type errors in source code.

## CI/CD Build

For CI environments:

```bash
pnpm install --frozen-lockfile    # Install deps
pnpm lint                         # Check code style
pnpm typecheck                    # Type checking
pnpm build:all                    # Build everything
```
