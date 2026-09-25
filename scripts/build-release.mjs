import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLibraryBoundary } from "./assert-library-boundary.mjs";
import {
  assertNoDisallowedEnvAssets,
  assertRegularFile,
  attachLibraryArtifacts,
  captureRegularFile,
  cleanReleaseArchives,
  readBuildManifest,
  verifyBuildManifestFiles,
  verifyLibraryArtifacts,
  writeBuildManifest,
} from "./release-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const distDir = path.join(root, "dist");
const libDir = path.join(root, "lib");
const packagePath = path.join(root, "package.json");
assertRegularFile(packagePath, "project package");
const packageSnapshot = captureRegularFile(packagePath, "project package");
const pkg = JSON.parse(packageSnapshot.data.toString("utf8"));

// STATUS_STACK_BUFFER_OVERRUN, observed with Windows + Node 22 + esbuild.
const WINDOWS_ESBUILD_KNOWN_EXIT = 0xc0000409; // 3221226505
const REQUIRED_DIST_FILES = ["app.js", "app-v22.js"];

// Set as soon as the library stage of this run starts: it decides whether a
// failure may delete lib/ (see cleanupFailedRun).
let libraryStageStarted = false;

function formatError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function childFailure(label, result) {
  const status = Number.isInteger(result.status) ? result.status : null;
  const signal = result.signal ?? null;
  const error = new Error(
    `[release-build] ${label} failed (status=${status ?? "null"} signal=${signal ?? "null"})`,
  );
  if (status !== null) error.exitCode = status;
  error.signal = signal;
  return error;
}

function runNodeScript(label, scriptPath, args = [], cwd = root) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function assertSuccessfulChild(label, result) {
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) throw childFailure(label, result);
}

function validateDistBatch() {
  assertNoDisallowedEnvAssets(distDir, "release build dist");
  const manifest = readBuildManifest(distDir);
  if (manifest.mode !== "production") {
    throw new Error(`[release-build] refusing non-production build batch (mode=${manifest.mode})`);
  }
  if (manifest.version !== pkg.version) {
    throw new Error(
      `[release-build] manifest version ${manifest.version} does not match package ${pkg.version}`,
    );
  }
  verifyBuildManifestFiles(distDir, manifest, REQUIRED_DIST_FILES);
  for (const file of REQUIRED_DIST_FILES) {
    const stat = assertRegularFile(path.join(distDir, file), "release build output");
    if (stat.size === 0) {
      throw new Error(`[release-build] required release output is empty: dist/${file}`);
    }
  }
  return manifest;
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function removeGeneratedLibrary() {
  const stat = lstatIfExists(libDir);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fs.unlinkSync(libDir);
    return;
  }
  fs.rmSync(libDir, { recursive: true, force: true });
}

/**
 * Whether the current lib/ is registered by the verified build manifest. Only
 * a registered library may survive a failed run; an unregistered lib/ is a
 * half-product of this run and has to go.
 */
function isLibraryRegistered() {
  const stat = lstatIfExists(libDir);
  if (!stat) return false;
  try {
    const manifest = readBuildManifest(distDir);
    return Boolean(manifest.library);
  } catch {
    // A missing or unreadable manifest means no verified library record.
    return false;
  }
}

function runLibraryBuild() {
  removeGeneratedLibrary();
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const tscAlias = path.join(root, "node_modules", "tsc-alias", "dist", "bin", "index.js");
  let result = runNodeScript("TypeScript build", tsc, [
    "-p",
    path.join(root, "tsconfig.build.json"),
  ]);
  assertSuccessfulChild("TypeScript build", result);
  result = runNodeScript("tsc-alias", tscAlias, ["-p", path.join(root, "tsconfig.build.json")]);
  assertSuccessfulChild("tsc-alias", result);
  // Machine guard for the public library boundary (方案 A+). It runs here — after
  // tsc/tsc-alias, before `recordAndValidateLibrary` registers anything — so a
  // cordis leak, a published `runtime/` or a published `cli.*` can never reach the
  // manifest, build-pkg or the archive. Called in-process on purpose: a child
  // process would only surface a bare exit code and lose the real diagnostic.
  // Because `libraryStageStarted` is already true, cleanupFailedRun then drops the
  // unregistered lib/ and keeps the verified manifest.
  assertLibraryBoundary(libDir);
}

function recordAndValidateLibrary(manifest) {
  const updated = attachLibraryArtifacts(libDir, manifest);
  writeBuildManifest(distDir, updated);
  const checked = readBuildManifest(distDir);
  verifyBuildManifestFiles(distDir, checked, REQUIRED_DIST_FILES);
  verifyLibraryArtifacts(libDir, checked);
  return checked;
}

/**
 * Cleanup for a failed run. Only artifacts this run produced are removed:
 *
 *  - archives: `clean-release` already removed every older zip before this run,
 *    so any zip present now was created by this run's package-dist;
 *  - lib/: only when the library stage of this run started and never got
 *    registered. A registered library is a verified product and is kept;
 *  - the build manifest: never. It is the verified batch and must survive.
 */
function cleanupFailedRun({ libraryStageStarted }) {
  const cleanupErrors = [];
  try {
    cleanReleaseArchives(distDir);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (libraryStageStarted && !isLibraryRegistered()) {
    try {
      removeGeneratedLibrary();
      console.error("[release-build] removed unregistered lib/ from the failed library stage");
    } catch (error) {
      cleanupErrors.push(error);
    }
  } else if (libraryStageStarted) {
    console.error("[release-build] kept the registered lib/ of the verified batch");
  }
  return cleanupErrors;
}

function runReleaseBuild() {
  // This is intentionally the only place where the known esbuild exit is
  // tolerated. Watch mode keeps its existing mtime-based development behavior.
  const clean = runNodeScript("release cleanup", path.join(__dirname, "clean-release.mjs"));
  assertSuccessfulChild("release cleanup", clean);

  let manifest;
  let knownEsbuildExit = false;
  const result = runNodeScript("esbuild", path.join(root, "build.mjs"));
  if (result.error) throw result.error;

  if (result.status === 0 && !result.signal) {
    manifest = validateDistBatch();
  } else if (
    process.platform === "win32" &&
    result.status === WINDOWS_ESBUILD_KNOWN_EXIT &&
    !result.signal
  ) {
    // This is only a provisional acceptance. The library stage below must
    // finish and its hashes must be recorded before pkg is allowed to run.
    console.warn(
      `[release-build] esbuild exited with known Windows code ${WINDOWS_ESBUILD_KNOWN_EXIT}; validating the complete batch before continuing`,
    );
    manifest = validateDistBatch();
    knownEsbuildExit = true;
  } else {
    throw childFailure("esbuild", result);
  }

  libraryStageStarted = true;
  runLibraryBuild();
  manifest = recordAndValidateLibrary(manifest);
  if (knownEsbuildExit) {
    console.log(
      `[release-build] accepted known Windows esbuild code ${WINDOWS_ESBUILD_KNOWN_EXIT} after complete hash validation`,
    );
  }

  const pkgResult = runNodeScript("build-pkg", path.join(__dirname, "build-pkg.mjs"));
  assertSuccessfulChild("build-pkg", pkgResult);
  const packageResult = runNodeScript("package-dist", path.join(__dirname, "package-dist.mjs"));
  assertSuccessfulChild("package-dist", packageResult);

  return manifest;
}

let primaryError = null;
let manifest;
try {
  manifest = runReleaseBuild();
} catch (error) {
  primaryError = error;
}

if (primaryError) {
  const cleanupErrors = cleanupFailedRun({ libraryStageStarted });

  // Always print the primary failure first. Cleanup failures are additional
  // diagnostics and must never replace the original build error.
  console.error(`[release-build] primary failure:\n${formatError(primaryError)}`);
  console.error(
    "[release-build] kept the verified build manifest; only this run's archives and unregistered artifacts were removed",
  );
  for (const error of cleanupErrors) {
    console.error(`[release-build] cleanup failure:\n${formatError(error)}`);
  }
  const requested = Number.isInteger(primaryError.exitCode) ? primaryError.exitCode : 1;
  process.exitCode = requested > 0 ? requested : 1;
} else {
  console.log(`[release-build] completed release batch ${manifest.buildId}`);
}
