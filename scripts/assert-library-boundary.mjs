/**
 * Machine guard for the public library boundary (方案 A+).
 *
 * The public CJS library is exactly the `src/index.ts` closure. The Cordis
 * runtime is CLI-internal: cordis is an ESM-only package that ships as a
 * build-time `devDependency`, so any cordis reference surviving into `lib/`
 * would push library consumers onto `require(ESM)` on Node 22.6. The boundary
 * is therefore enforced by a gate, not by convention:
 *
 *  - `lib/` must exist, be a real directory, and emit `index.js` + `index.d.ts`
 *    (an empty or missing `lib/` must never pass vacuously);
 *  - no `lib/runtime` and no `runtime` path segment: runtime output is
 *    CLI-internal;
 *  - no `cli.*` artifact: the CLI module owns `require.main` and process side
 *    effects and is never published;
 *  - no `require("cordis")` in any emitted JS-like file;
 *  - no `from "cordis"` / `import "cordis"` / `import("cordis")` /
 *    `declare module "cordis"` / `types="cordis"` in any emitted declaration;
 *  - `tsconfig.build.json` must keep the compiled program closed on the entry.
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
 */
export const LIBRARY_BOUNDARY_PUBLIC_EXPORTS = Object.freeze([
  "ProxyServer",
  "ProxyServerOptions",
  "runServer",
  "get",
  "getAll",
  "set",
  "initializeConfig",
  "ProxyLifecycleErrorCode",
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
 * source so the JS and declaration checks cannot drift apart.
 */
const CORDIS_SPECIFIER = String.raw`["']cordis(?:\/[^"'\r\n]*)?["']`;

/**
 * Every syntactic form by which emitted output can depend on cordis. Applied
 * to both JS-like files and declarations: `tsc` erases `import type` from JS
 * but keeps it in `.d.ts`, and a runtime value import survives in JS only.
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
        `${FORBIDDEN_SEGMENT}/ output is CLI-internal and must not be published: lib/${relativePath}`,
      );
    }
    if (isForbiddenCliArtifact(relativePath)) {
      report(`CLI output is CLI-internal and must not be published: lib/${relativePath}`);
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
        `cordis ${patternName} is CLI-internal and must not be published: lib/${relativePath} (line ${position.line}, column ${position.column})`,
      );
      break;
    }
  }

  return violations;
}

/**
 * Assert that `libDir` is a publishable public CJS library: the `src/index.ts`
 * closure only, with no Cordis runtime and no CLI module.
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
