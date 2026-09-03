---
name: proxy-build
description: Use when building, bundling, packaging, or compiling the proxy project. Triggers on "build", "bundle", "pack", "构建", "打包", "编译", "compile".
---

# Proxy Build Skill

Use this skill when building, bundling, or packaging the proxy project.

## Build Commands

```bash
pnpm build                  # Build dist/app.js (esbuild bundle)
pnpm build:lib              # Build lib/ (type declarations)
pnpm build:all              # Build both dist/ and lib/
pnpm build:pkg              # Package to standalone executables
```

## Build Targets

| Command | Output | Purpose |
|---------|--------|---------|
| `pnpm build` | `dist/app.js` | Production bundle (CJS, Node22) |
| `pnpm build:lib` | `lib/` | TypeScript declarations |
| `pnpm build:pkg` | `node22-*` | Standalone executables |

## Build Process

### esbuild Bundle (`pnpm build`)

- Entry: `src/index.ts` → `dist/app.js`
- Format: CommonJS
- Target: Node.js 22
- Path aliases: `@/*` → `src/*`
- Copies: `.env.example`, `README.md`, `package.json`, `.env.*` to `dist/`

### Watch Mode (`pnpm build:watch`)

- The long-lived watcher NEVER loads esbuild: on Windows + Node22 the esbuild
  process crashes natively on exit with STATUS_STACK_BUFFER_OVERRUN 3221226505
  (artifacts already written, zero output, `process.exit(0)` can't prevent it),
  which would silently kill any watcher living in the same process.
- Uses `fs.watch(src/, recursive)` (ignores generated `banner.ts`) + spawns a
  disposable one-shot `node build.mjs` child per change, debounced 300ms.
- A natively-crashed child costs one log line; success is decided by exit code +
  `dist/app.js` mtime (post-write teardown crash counts as success, dev-server
  still restarts). One automatic retry when dist is unchanged.
- Logs every build: `[build] build started (<reason>)...` / `finished in <n>ms`.

### Type Declarations (`pnpm build:lib`)

- Runs `tsc` then `tsc-alias`
- Generates `lib/` with `.d.ts` files
- Separate from esbuild bundle

### Package Executables (`pnpm build:pkg`)

Targets (defined in `package.json#pkg.targets`):
- `node22-win-x64`
- `node22-linux-x64`
- `node22-darwin-x64`

## Build Output Structure

```
dist/
├── app.js              # Main bundle
├── .env.example        # Example env file
├── .env.development    # Dev env (if exists)
├── .env.production     # Prod env (if exists)
├── README.md
└── package.json

lib/
├── index.d.ts
├── config/
│   ├── store.d.ts
│   └── loader.d.ts
├── core/
│   ├── types.d.ts
│   └── ...
└── ...
```

## Build Scripts

| Script | Purpose |
|--------|---------|
| `scripts/gen-banner.mjs` | Generate ASCII art banner |
| `scripts/patch-pkg-fetch.mjs` | Patch pkg-fetch postinstall |

## Common Build Issues

1. **STATUS_STACK_BUFFER_OVERRUN** (Windows)
   - `node --watch` on Windows + Node22 crashes with 0xC0000409 on file restart
   - Use `scripts/dev-server.mjs` instead (configured in `dev:watch`/`dev:hot`)
   - Non-watch build uses `process.exit(0)` to mitigate esbuild variant

2. **Missing assets**
   - Build skips missing files gracefully
   - Check `.gitignore` for excluded patterns

3. **Path alias errors**
   - Ensure `@/*` configured in both `tsconfig.json` and esbuild

4. **Type errors**
   - Run `pnpm typecheck` before build
   - Fix type errors in source code

## Development Build

For development with hot-reload:

```bash
pnpm dev                    # Build + start:dev
pnpm dev:watch              # scripts/dev-server.mjs watches dist/ + .env*, auto-restarts server
pnpm dev:hot                # concurrently: esbuild watch + dev-server.mjs (full hot reload)
pnpm dev:http               # HTTP mode with dev settings
```

Note: `dev:watch`/`dev:hot` use `nodemon` instead of `node --watch` to avoid STATUS_STACK_BUFFER_OVERRUN crash on Windows + Node22.

## CI/CD Build

For CI environments:

```bash
pnpm install --frozen-lockfile    # Install deps
pnpm lint                         # Check code style
pnpm typecheck                    # Type checking
pnpm build:all                    # Build everything
```