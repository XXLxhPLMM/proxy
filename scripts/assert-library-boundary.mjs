/**
 * Machine guard for the public library boundary.
 *
 * The public CJS library is exactly the `src/index.ts` closure, and it is
 * enforced by a gate rather than by convention:
 *
 *  - `lib/` must exist, be a real directory, and emit `index.js` + `index.d.ts`
 *    (an empty or missing `lib/` must never pass vacuously);
 *  - no `cli.*` artifact: the CLI module owns `require.main` and process side
 *    effects and is never published;
 *  - no `runtime` path segment anywhere in the published tree;
 *  - no `config/store.*` artifact and no reference to that module: the
 *    process-wide `export const config = new Map()` singleton is deleted, and
 *    configuration lives on a per-instance `ConfigScope`. Re-emitting it (even
 *    under a different name) is exactly the multi-instance regression this
 *    refactor exists to prevent, so it is guarded by path *and* by specifier;
 *  - `tsconfig.build.json` must keep the compiled program closed on the entry;
 *  - the public export allowlist must match the entry module exactly.
 *
 * ## Why the cordis assertions are still here
 *
 * `src/runtime/` and the `cordis` dependency were **deleted** (the CLI stopped
 * mounting `startRuntime()`, so the whole Cordis control plane was dead code
 * that esbuild tree-shook out of `dist/app.js`; the explicit plugin wiring in
 * `src/plugins/contracts.ts` + `src/instance.ts` already covers its job, and
 * cordis is ESM-only, which the CJS / Node >=22.6 library cannot require).
 *
 * The cordis / `runtime` checks are therefore **anti-resurrection guards**, not
 * a statement about the current tree:
 *
 *  - no `runtime` path segment: do not let a new `src/runtime/` (or any other
 *    runtime-style layer) reach the published library;
 *  - no `require("cordis")` in any emitted JS-like file;
 *  - no `from "cordis"` / `import "cordis"` / `import("cordis")` /
 *    `declare module "cordis"` / `types="cordis"` in any emitted declaration.
 *
 * Deleting the guard together with the dependency is exactly the regression
 * these checks exist to catch, so they stay until the decision to allow
 * `require(ESM)` (Node >=22.12) is written down here — at which point they
 * become a real ESM-dependency gate again.
 *
 * The content patterns are deliberately blunt (they also match prose in
 * comments). A boundary guard must fail closed: a false positive costs one
 * cleanup, a false negative ships an ESM dependency to CJS consumers.
 *
 * `assertLibraryBoundary()` is exported so the release build can call it
 * in-process and keep the real diagnostic instead of a bare child exit code.
 * The file also runs standalone (`node scripts/assert-library-boundary.mjs`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertRegularFile, captureRegularFile, collectRegularFiles } from "./release-assets.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, "..");

/** The single file whose closure defines the public CJS library. */
export const LIBRARY_BOUNDARY_ENTRY = "src/index.ts";

/** Artifacts every library build must emit; an empty `lib/` must not pass. */
export const LIBRARY_BOUNDARY_REQUIRED = Object.freeze(["index.js", "index.d.ts"]);

/**
 * Documented public surface of `src/index.ts`. This is the **enforced** source of
 * truth, not documentation: `assertPublicExportSurface` re-reads the entry and
 * fails closed on any addition or removal. Keep docs/AGENTS quoting this list
 * only because the guard now enforces it.
 *
 * The surface is "multi-instance API + plugin contracts":
 *  - instance lifecycle: `createProxyInstance` / `createProxyInstanceFromEnv` / `ProxyInstance`
 *  - configuration: `createConfigScope` / `ConfigScope` / `initializeConfig`
 *  - plugin contracts + default assembly: `createPluginRegistry` and friends
 *  - the pure type vocabulary a custom plugin needs (`ForwardPlan`, `ProtocolDeps`, …)
 *
 * Deliberately **absent**: `ProxyServer` (instance-internal orchestrator — it needs
 * a fully wired plugin graph and owns process-exit/rollback policy that a library
 * consumer must opt into explicitly), plus the former `get`/`getAll`/`set` process
 * config free functions and `runServer`. Those two sets were the global-singleton
 * surface this refactor deleted; a guard that still allowed them would let the
 * singleton creep back in under a new name.
 */
export const LIBRARY_BOUNDARY_PUBLIC_EXPORTS = Object.freeze([
  // --- 多实例 API ---
  "createProxyInstance",
  "createProxyInstanceFromEnv",
  "ProxyInstance",
  "ProxyInstanceOptions",
  "ProxyInstanceFromEnvOptions",
  "InstancePlugins",
  // --- 配置：实例作用域 + 显式初始化 ---
  "createConfigScope",
  "ConfigScope",
  "initializeConfig",
  "prepareRuntimeConfig",
  "InitConfigOptions",
  "AppConfig",
  "ConfigKey",
  "AuthType",
  "LogLevel",
  "CacheType",
  // --- 插件契约与注册表 ---
  "createPluginRegistry",
  "PluginRegistry",
  "ConfigProvider",
  "ConfigReloadResult",
  "LoggerProvider",
  "AuthProvider",
  "AuthKind",
  "AuthFactoryOptions",
  "AuthProviderFactory",
  "AccessControlProvider",
  "AclDecision",
  "AclReason",
  "AclScope",
  "UpstreamRouteDecision",
  "UsageProvider",
  "QuotaPeriod",
  "QuotaReservation",
  "UsageSnapshot",
  "RoutingProvider",
  "ForwarderProvider",
  "ProtocolProvider",
  "ProtocolDeps",
  "ClusterProvider",
  "ClusterRole",
  "InstanceRequest",
  "ResolvedInstance",
  // --- 默认插件装配工厂 ---
  "createRoutingProvider",
  "createAuthProviderRegistry",
  "createForwarderRegistry",
  "createProtocolRegistry",
  "createMemoryUsageProvider",
  "NoneAuthProvider",
  // --- 转发计划契约 ---
  "ForwardPlan",
  "ForwardInbound",
  "ForwardTransport",
  "ForwardPayload",
  "ForwardTarget",
  "UpstreamEndpoint",
  "RoutingInput",
  "RoutingOutcome",
  "RoutingRejection",
  "ForwarderContext",
  "ForwardFact",
  "ProtocolResponder",
  // --- 内核类型词汇（句柄透出的 core 用得上） ---
  "ProxyCore",
  "ProxyProtocol",
  "ProxyOptions",
  "ProxyStats",
  "LifecycleState",
  "ProxyLifecycleErrorCode",
  "AuthContext",
  "AuthResult",
  "AuthAccount",
  "ProxyAuthEvent",
]);

/**
 * Collect the exported names of a re-export-only entry module.
 *
 * Deliberately refuses `export *` / `export * as ns`: those cannot be enumerated
 * statically, so allowing them would silently reopen the hole this guard closes.
 * `export { local as public }` contributes `public` (the published name), and a
 * `type` modifier is stripped — the public surface includes type-only exports.
 */
function collectExportedNames(source, entryPath, label) {
  const names = new Set();
  const starRe = /^\s*export\s+\*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*(?:from\s*["'][^"']+["'])?\s*;?\s*$/gm;
  if (starRe.test(source)) {
    throw new Error(
      `[${label}] ${LIBRARY_BOUNDARY_ENTRY} must not use \`export *\` / \`export * as ns\`: the public surface cannot be enumerated statically, so the allowlist check would be bypassed`,
    );
  }

  const listRe = /^\s*export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*["'][^"']+["'])?\s*;?\s*$/gm;
  for (const match of source.matchAll(listRe)) {
    for (const rawPart of match[1].split(",")) {
      const part = rawPart.trim().replace(/^type\s+/, "").trim();
      if (part === "") continue;
      const alias = part.split(/\s+as\s+/);
      const published = (alias[1] ?? alias[0]).trim();
      if (published !== "") names.add(published);
    }
  }
  return names;
}

/**
 * Fail closed unless `src/index.ts` exports exactly `LIBRARY_BOUNDARY_PUBLIC_EXPORTS`.
 *
 * Without this the guard only covered path segments / cli.* / cordis, so a new
 * internal export (say `logger`) would ship to library consumers undetected.
 */
function assertPublicExportSurface(label) {
  const entryPath = path.join(repoRoot, ...LIBRARY_BOUNDARY_ENTRY.split("/"));
  const snapshot = captureRegularFile(entryPath, `${label} library entry`);
  const declared = collectExportedNames(snapshot.data.toString("utf8"), entryPath, label);
  const expected = new Set(LIBRARY_BOUNDARY_PUBLIC_EXPORTS);

  const problems = [];
  for (const name of declared) {
    if (!expected.has(name)) {
      problems.push(
        `undeclared public export "${name}": add it to LIBRARY_BOUNDARY_PUBLIC_EXPORTS with a public-contract justification, or stop exporting it`,
      );
    }
  }
  for (const name of expected) {
    if (!declared.has(name)) {
      problems.push(
        `declared public export "${name}" is missing from ${LIBRARY_BOUNDARY_ENTRY}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `[${label}] public export surface drifted (${problems.length} problem(s)):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return declared;
}

/** Directory name that may never appear in the published library tree. */
const FORBIDDEN_SEGMENT = "runtime";

/**
 * A bare `cordis` specifier, plus any subpath export of it. Kept as a single
 * source so the JS and declaration checks cannot drift apart. cordis is no
 * longer a dependency (see the header): this pattern is the anti-resurrection
 * guard, and it still has to cover subpaths so a reintroduction cannot sneak
 * in as `cordis/fiber` or similar.
 */
const CORDIS_SPECIFIER = String.raw`["']cordis(?:\/[^"'\r\n]*)?["']`;

/**
 * Every syntactic form by which emitted output can depend on cordis. Applied
 * to both JS-like files and declarations: `tsc` erases `import type` from JS
 * but keeps it in `.d.ts`, and a runtime value import survives in JS only.
 * Exhausting the forms matters even though the dependency is gone — a
 * reintroduced `import type { Context } from "cordis"` must fail the gate, not
 * slip through `.d.ts` and break consumers at type-check time.
 */
const CORDIS_REFERENCE_PATTERNS = Object.freeze([
  ["require()", new RegExp(String.raw`\brequire\s*\(\s*${CORDIS_SPECIFIER}\s*\)`)],
  ["import/export from", new RegExp(String.raw`\bfrom\s*${CORDIS_SPECIFIER}`)],
  ["side-effect import", new RegExp(String.raw`\bimport\s+${CORDIS_SPECIFIER}`)],
  ["dynamic import()", new RegExp(String.raw`\bimport\s*\(\s*${CORDIS_SPECIFIER}\s*\)`)],
  ["declare module", new RegExp(String.raw`\bdeclare\s+module\s+${CORDIS_SPECIFIER}`)],
  ["triple-slash types", new RegExp(String.raw`\btypes\s*=\s*${CORDIS_SPECIFIER}`)],
]);

const JS_LIKE_EXTENSIONS = Object.freeze([".js", ".cjs", ".mjs"]);
const DECLARATION_SUFFIXES = Object.freeze([".d.ts", ".d.mts", ".d.cts"]);

/**
 * Emitted files that must never exist in the published tree.
 *
 * `config/store.*` was the process-wide configuration singleton
 * (`export const config = new Map(...)` plus free `get`/`set`/`getAll`). It is
 * deleted: configuration now lives on a per-instance `ConfigScope`, injected by
 * the composition root. The pattern covers *every* extension (`.js`, `.d.ts`,
 * `.js.map`, …) so renaming the file cannot slip past, and it is matched
 * case-insensitively because a case-only rename still resolves on Windows and
 * macOS.
 */
const FORBIDDEN_EMITTED_PATH = /^config\/store(\.[^/]*)?$/i;
const FORBIDDEN_EMITTED_REASON =
  "全局配置单例 config/store.ts 已删除（配置随实例走）";

/**
 * A specifier that resolves to the deleted singleton module, in every syntactic
 * form an emitted file can use to depend on it. tsc + tsc-alias rewrite the
 * `@/config/store.js` alias to a relative `./config/store.js`, so the leading
 * `[^"']*` covers both the original alias form and the rewritten one.
 *
 * Checked independently of the path check on purpose: a surviving import would
 * fail the library build at runtime, whereas a surviving *file* that nothing
 * imports would merely be dead weight. Both are regressions, but only one of
 * them is load-bearing.
 */
const CONFIG_STORE_SPECIFIER = String.raw`["'][^"'\r\n]*config\/store(?:\.[cm]?js)?["']`;
const CONFIG_STORE_REFERENCE_PATTERNS = Object.freeze([
  ["require()", new RegExp(String.raw`\brequire\s*\(\s*${CONFIG_STORE_SPECIFIER}\s*\)`)],
  ["import/export from", new RegExp(String.raw`\bfrom\s*${CONFIG_STORE_SPECIFIER}`)],
  ["side-effect import", new RegExp(String.raw`\bimport\s+${CONFIG_STORE_SPECIFIER}`)],
  ["dynamic import()", new RegExp(String.raw`\bimport\s*\(\s*${CONFIG_STORE_SPECIFIER}\s*\)`)],
]);

/** String literal | line comment | block comment, for JSONC normalization. */
const JSONC_TOKEN = new RegExp(String.raw`"(?:\\.|[^"\\])*"|//[^\r\n]*|/\*[\s\S]*?\*/`, "g");

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function assertRealDirectory(dirPath, label) {
  const stat = lstatOrNull(dirPath);
  if (!stat) {
    throw new Error(`[${label}] library output directory does not exist: ${dirPath}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`[${label}] expected a real library output directory: ${dirPath}`);
  }
  return stat;
}

/**
 * `cli.*` covers `cli.js`, `cli.mjs`, `cli.cjs` and `cli.d.ts`. Case-insensitive
 * so a case-only rename cannot slip past on Windows/macOS.
 */
function isForbiddenCliArtifact(relativePath) {
  const base = path.posix.basename(relativePath).toLowerCase();
  return base === "cli" || base.startsWith("cli.");
}

function classifyLibraryFile(relativePath) {
  const base = path.posix.basename(relativePath).toLowerCase();
  if (DECLARATION_SUFFIXES.some((suffix) => base.endsWith(suffix))) return "declaration";
  if (JS_LIKE_EXTENSIONS.includes(path.posix.extname(base))) return "javascript";
  return null;
}

function locate(text, index) {
  const upTo = text.slice(0, index);
  const line = upTo.split(/\r\n|\r|\n/).length;
  const column = index - (upTo.lastIndexOf("\n") + 1) + 1;
  return { line, column };
}

/** JSONC is a superset of JSON; normalize comments and trailing commas only. */
function parseJsonc(text, label, filePath) {
  const withoutComments = text.replace(JSONC_TOKEN, (token) =>
    token.startsWith('"') ? token : " ",
  );
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(withoutTrailingCommas);
  } catch (error) {
    throw new Error(`[${label}] unparseable tsconfig ${filePath}: ${error.message}`);
  }
}

function normalizeTsconfigEntry(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The compiled program must be closed on `src/index.ts`.
 *
 * tsc unions `files` with `include`, and a child tsconfig inherits `include`
 * through `extends` when it omits the key. So the contract is both "files is
 * exactly the entry" and "include is present and empty" — dropping either one
 * silently widens the published closure back to the whole `src/` tree.
 */
function assertLibraryEntryTsconfig(tsconfigPath, label) {
  const snapshot = captureRegularFile(tsconfigPath, `${label} tsconfig`);
  const parsed = parseJsonc(snapshot.data.toString("utf8"), label, tsconfigPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[${label}] tsconfig must be a JSON object: ${tsconfigPath}`);
  }

  if (!Array.isArray(parsed.files) || parsed.files.length !== 1) {
    throw new Error(
      `[${label}] tsconfig "files" must be exactly ["./${LIBRARY_BOUNDARY_ENTRY}"], got ${JSON.stringify(parsed.files ?? null)}: ${tsconfigPath}`,
    );
  }
  if (normalizeTsconfigEntry(parsed.files[0]) !== LIBRARY_BOUNDARY_ENTRY) {
    throw new Error(
      `[${label}] tsconfig "files[0]" must be "./${LIBRARY_BOUNDARY_ENTRY}", got ${JSON.stringify(parsed.files[0])}: ${tsconfigPath}`,
    );
  }
  if (!Array.isArray(parsed.include) || parsed.include.length !== 0) {
    throw new Error(
      `[${label}] tsconfig must declare an empty "include": [] so the program stays closed on the entry, got ${JSON.stringify(parsed.include ?? null)}: ${tsconfigPath}`,
    );
  }
  return parsed;
}

function collectBoundaryViolations(libDir, files, label) {
  const violations = [];
  const report = (message) => violations.push(`[${label}] ${message}`);

  for (const required of LIBRARY_BOUNDARY_REQUIRED) {
    if (!files.includes(required)) {
      report(`missing required library artifact: lib/${required}`);
      continue;
    }
    assertRegularFile(path.join(libDir, required), `${label} artifact`);
  }

  for (const relativePath of files) {
    const segments = relativePath.split("/");
    if (segments.some((segment) => segment.toLowerCase() === FORBIDDEN_SEGMENT)) {
      report(
        `${FORBIDDEN_SEGMENT}/ output must never be published: lib/${relativePath}`,
      );
    }
    if (isForbiddenCliArtifact(relativePath)) {
      report(`CLI output is CLI-internal and must not be published: lib/${relativePath}`);
    }
    if (FORBIDDEN_EMITTED_PATH.test(relativePath)) {
      report(`${FORBIDDEN_EMITTED_REASON}: lib/${relativePath}`);
    }

    const kind = classifyLibraryFile(relativePath);
    if (!kind) continue;
    const snapshot = captureRegularFile(path.join(libDir, relativePath), `${label} ${kind} file`);
    const text = snapshot.data.toString("utf8");
    for (const [patternName, pattern] of CORDIS_REFERENCE_PATTERNS) {
      const match = pattern.exec(text);
      if (!match) continue;
      const position = locate(text, match.index);
      report(
        `cordis ${patternName} is not a dependency of this project and must never be published: lib/${relativePath} (line ${position.line}, column ${position.column})`,
      );
      break;
    }
    for (const [patternName, pattern] of CONFIG_STORE_REFERENCE_PATTERNS) {
      const match = pattern.exec(text);
      if (!match) continue;
      const position = locate(text, match.index);
      report(
        `${FORBIDDEN_EMITTED_REASON}; ${patternName} reference found: lib/${relativePath} (line ${position.line}, column ${position.column})`,
      );
      break;
    }
  }

  return violations;
}

/**
 * Assert that `libDir` is a publishable public CJS library: the `src/index.ts`
 * closure only, with no CLI module, no `runtime` segment and no cordis.
 *
 * @param {string} libDir emitted library directory to inspect
 * @param {{ tsconfigPath?: string, label?: string }} [options]
 * @returns {{ libDir: string, tsconfigPath: string, entry: string, fileCount: number }}
 */
export function assertLibraryBoundary(
  libDir,
  { tsconfigPath = path.join(repoRoot, "tsconfig.build.json"), label = "library boundary" } = {},
) {
  assertRealDirectory(libDir, label);
  // lstat-based traversal: symlinks, junctions and non-regular entries fail here.
  const files = collectRegularFiles(libDir);
  const violations = collectBoundaryViolations(libDir, files, label);
  assertLibraryEntryTsconfig(tsconfigPath, label);
  // The export allowlist is the guard's own core duty: without this, adding an
  // internal symbol to the entry would publish it and still pass every other check.
  const publicExports = assertPublicExportSurface(label);

  if (violations.length > 0) {
    throw new Error(
      `[${label}] public library boundary violated (${violations.length} problem(s)):\n${violations.join("\n")}`,
    );
  }

  return {
    libDir,
    tsconfigPath,
    entry: LIBRARY_BOUNDARY_ENTRY,
    fileCount: files.length,
    publicExports: [...publicExports],
  };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const selfPath = fileURLToPath(import.meta.url);
  const resolved = path.resolve(entry);
  return process.platform === "win32"
    ? selfPath.toLowerCase() === resolved.toLowerCase()
    : selfPath === resolved;
}

if (isMainModule()) {
  try {
    const targetLibDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "lib"));
    const targetTsconfig = path.resolve(
      process.argv[3] ?? path.join(repoRoot, "tsconfig.build.json"),
    );
    const result = assertLibraryBoundary(targetLibDir, { tsconfigPath: targetTsconfig });
    console.log(
      `[library-boundary] ok: ${result.fileCount} published file(s), entry ${result.entry}, no ${FORBIDDEN_SEGMENT}/cli/cordis leak`,
    );
  } catch (error) {
    console.error(
      `[library-boundary] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exitCode = 1;
  }
}
