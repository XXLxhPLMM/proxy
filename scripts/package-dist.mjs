import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";
import {
  ARCHIVE_FILE_MODE,
  assertNoDisallowedEnvAssets,
  assertNoSymlinks,
  assertRegularFile,
  assertManifestCoverage,
  assertSnapshotMapsEqual,
  captureRegularFile,
  cleanReleaseArchives,
  closeRegularFileSnapshot,
  createExclusiveRealDirectory,
  ensureRealDirectory,
  fingerprintBuffer,
  generatedCfgAssets,
  generatedCfgRelativePaths,
  isLinkLikePath,
  manifestSubtree,
  openRegularFileSnapshot,
  readBuildManifest,
  snapshotTree,
  stageRegularFileSnapshot,
  verifyBinaryArtifacts,
  verifyBuildManifestFiles,
  verifyLibraryArtifacts,
  verifyMacOSSignatureSnapshot,
  verifyTreeSnapshot,
  writeZipToExclusiveFile,
} from "./release-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const distDir = path.join(root, "dist");
const libDir = path.join(root, "lib");

const GENERATED_CFG_SET = new Set(generatedCfgRelativePaths());
const GENERATED_CFG_PATHS = generatedCfgRelativePaths();

// The batch this run verified, kept only for failure diagnostics: packaging
// must never delete it, and the log line names it explicitly.
let verifiedBatch = null;

const packagePath = path.join(root, "package.json");
assertRegularFile(packagePath, "project package");
const packageSnapshot = captureRegularFile(packagePath, "project package");
const pkg = JSON.parse(packageSnapshot.data.toString("utf8"));
const version = pkg.version;

const BINARY_TARGETS = [
  {
    target: "node22-win-x64",
    platform: "win",
    os: "win",
    file: "proxy-win.exe",
    zipName: "proxy-win.exe",
  },
  {
    target: "node22-linux-x64",
    platform: "linux",
    os: "linux",
    file: "proxy-linux",
    zipName: "proxy-linux",
  },
  {
    target: "node22-darwin-x64",
    platform: "darwin",
    os: "macos",
    file: "proxy-macos",
    zipName: "proxy-macos",
  },
];

const NODE_TARGETS = [{ file: "app-v22.js", label: "node22" }];

const HOST_PLATFORMS = {
  win32: "win",
  linux: "linux",
  darwin: "darwin",
};

function assertSupportedHost() {
  const platform = HOST_PLATFORMS[process.platform];
  if (process.arch !== "x64" || !platform) {
    throw new Error(
      `[package] unsupported host ${process.platform}-${process.arch}; expected x64 Windows/Linux/macOS`,
    );
  }
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function assertDistDirectory() {
  const stat = lstatIfExists(distDir);
  if (!stat || isLinkLikePath(distDir, stat) || !stat.isDirectory()) {
    throw new Error(
      `[package] dist directory not found or not real: ${distDir}; run pnpm build:all first`,
    );
  }
}

function assertBuildBatch() {
  assertNoSymlinks(distDir, "package dist");
  assertNoDisallowedEnvAssets(distDir, "package dist");

  const envExample = path.join(distDir, ".env.example");
  const envSnapshot = captureRegularFile(envExample, "package environment template");
  if (envSnapshot.fingerprint.size === 0) {
    throw new Error(`[package] required environment template is empty: ${envExample}`);
  }

  const manifest = readBuildManifest(distDir);
  if (manifest.mode !== "production") {
    throw new Error(
      `[package] refusing non-production build batch (mode=${manifest.mode}); run pnpm build first`,
    );
  }
  if (manifest.version !== version) {
    throw new Error(
      `[package] manifest version ${manifest.version} does not match package ${version}; rebuild`,
    );
  }

  verifyBuildManifestFiles(distDir, manifest, ["app.js", "app-v22.js"]);
  verifyLibraryArtifacts(libDir, manifest);
  verifyBinaryArtifacts(distDir, manifest, BINARY_TARGETS);
  return manifest;
}

function recordedFingerprint(recordMap, relativePath, label) {
  if (!recordMap || !Object.hasOwn(recordMap, relativePath)) {
    throw new Error(`[package] ${label} is not recorded in the verified build batch`);
  }
  return recordMap[relativePath];
}

function stageRegularFile(sourcePath, stagingDir, label, expected = null, options = {}) {
  return stageRegularFileSnapshot(sourcePath, stagingDir, label, expected, options);
}

function stageDistFile(stagingDir, manifest, relativePath, label, binary = false) {
  const recordMap = binary ? manifest.binaries : manifest.files;
  const expected = recordedFingerprint(recordMap, relativePath, label);
  return stageRegularFile(
    path.join(distDir, relativePath),
    stagingDir,
    label,
    expected,
    { retainData: false },
  );
}

function removePathNoFollow(filePath) {
  const stat = lstatIfExists(filePath);
  if (!stat) return;
  if (isLinkLikePath(filePath, stat) || !stat.isDirectory()) {
    fs.unlinkSync(filePath);
    return;
  }
  fs.rmSync(filePath, { recursive: true, force: true });
}

function assertRealDirectoryIfExists(dirPath, label) {
  const stat = lstatIfExists(dirPath);
  if (!stat) return false;
  if (isLinkLikePath(dirPath, stat) || !stat.isDirectory()) {
    throw new Error(`[package] ${label} is not a real directory: ${dirPath}`);
  }
  return true;
}

function stageCfgExamples(stagingDir, manifest) {
  const cfgDir = path.join(distDir, "cfg");
  const expected = manifestSubtree(manifest.files, "cfg");
  if (!assertRealDirectoryIfExists(cfgDir, "cfg source")) {
    assertSnapshotMapsEqual(expected, {}, "package cfg");
    return [];
  }
  assertNoSymlinks(cfgDir, "package cfg");
  const sourceFiles = snapshotTree(cfgDir, {
    allowRootEnvExample: false,
    label: "package cfg",
  });

  // Explicit semantics, two classes only:
  //  - `*.example` is the release template: it is staged from the verified
  //    build manifest and shipped as-is;
  //  - `cfg/users.json` / `cfg/acl.json` are generated safe defaults. They are
  //    recorded in the manifest and verified byte-for-byte here, but they are
  //    never staged: the archive ships freshly generated safe defaults (see
  //    addCommonAssets), so a real account table in dist can never leak into a
  //    release. Any other recorded cfg name is a hard error.
  const templates = Object.create(null);
  const generated = [];
  for (const [relativePath, record] of Object.entries(expected)) {
    if (GENERATED_CFG_SET.has(`cfg/${relativePath}`)) {
      generated.push(relativePath);
      continue;
    }
    if (!relativePath.endsWith(".example")) {
      throw new Error(
        `[package] cfg asset is neither a publishable .example template nor a known generated default: cfg/${relativePath}`,
      );
    }
    templates[relativePath] = record;
  }
  for (const relativePath of generated) {
    console.log(`[package] cfg generated default is not staged: cfg/${relativePath}`);
  }
  assertSnapshotMapsEqual(expected, sourceFiles, "package cfg");

  const items = [];
  for (const relativePath of Object.keys(templates)) {
    const archiveName = `cfg/${relativePath}`;
    items.push({
      ...stageDistFile(stagingDir, manifest, archiveName, `package ${archiveName}`),
      archiveName,
    });
  }
  return items;
}

function stageKeys(stagingDir, manifest) {
  const keysDir = path.join(distDir, "keys");
  const expected = manifestSubtree(manifest.files, "keys");
  if (!assertRealDirectoryIfExists(keysDir, "keys source")) {
    assertSnapshotMapsEqual(expected, {}, "package keys");
    return [];
  }

  const sourceFiles = snapshotTree(keysDir, {
    allowRootEnvExample: false,
    label: "package keys",
  });
  assertSnapshotMapsEqual(expected, sourceFiles, "package keys");
  const items = [];
  for (const relativePath of Object.keys(expected)) {
    const archiveName = `keys/${relativePath}`;
    items.push({
      ...stageDistFile(stagingDir, manifest, archiveName, `package ${archiveName}`),
      archiveName,
    });
  }
  return items;
}

function stageReadmes(stagingDir, type, cache) {
  const readmeDir = path.join(root, "readme");
  if (!assertRealDirectoryIfExists(readmeDir, "readme source")) return [];
  assertNoSymlinks(readmeDir, "package readme source");

  const files = [
    [path.join(readmeDir, "README.zh-CN.md"), "README.zh-CN.md"],
    [path.join(readmeDir, "README.en.md"), "README.en.md"],
    [path.join(readmeDir, "usage", `${type}.zh-CN.md`), "USAGE.zh-CN.md"],
    [path.join(readmeDir, "usage", `${type}.en.md`), "USAGE.en.md"],
  ];
  const staged = [];
  for (const [source, archiveName] of files) {
    if (!lstatIfExists(source)) continue;
    let item = cache.get(source);
    if (!item) {
      item = {
        ...stageRegularFile(source, stagingDir, `package ${archiveName}`, null, {
          retainData: false,
        }),
        archiveName,
      };
      cache.set(source, item);
    }
    staged.push(item);
  }
  return staged;
}

function cleanupArchiveStaging(stagingDir) {
  if (!stagingDir) return;
  removePathNoFollow(stagingDir);
}

function createArchiveStaging(manifest) {
  const distBefore = ensureRealDirectory(distDir, "package archive source");
  let stagingDir;
  try {
    stagingDir = createExclusiveRealDirectory(
      os.tmpdir(),
      "proxy-archive-staging-",
      "package archive staging",
    );
    const expectedStaging = Object.create(null);
    const coveredManifestFiles = Object.create(null);
    const coveredBinaries = Object.create(null);
    /**
     * Every expected-staging key must be the real on-disk staging name
     * (currently `snapshot-<pid>-<uuid>.bin`, not the archive name), otherwise
     * the two-way comparison against the staging tree snapshot below can never
     * match. The archive name is tracked separately on each item.
     */
    const registerStaged = (item) => {
      const key = path.relative(stagingDir, item.path).split(path.sep).join("/");
      if (Object.hasOwn(expectedStaging, key)) {
        throw new Error(`[package] duplicate archive staging file: ${key}`);
      }
      expectedStaging[key] = item.fingerprint;
      return key;
    };

    const envExample = stageDistFile(
      stagingDir,
      manifest,
      ".env.example",
      "package environment template",
    );
    if (envExample.fingerprint.size === 0) {
      throw new Error(`[package] required environment template is empty: ${envExample.path}`);
    }
    registerStaged(envExample);
    coveredManifestFiles[".env.example"] = envExample.fingerprint;

    const cfgItems = stageCfgExamples(stagingDir, manifest);
    for (const item of cfgItems) {
      registerStaged(item);
      coveredManifestFiles[item.archiveName] = item.fingerprint;
    }
    const keyItems = stageKeys(stagingDir, manifest);
    for (const item of keyItems) {
      registerStaged(item);
      coveredManifestFiles[item.archiveName] = item.fingerprint;
    }
    const commonAssets = [
      { ...envExample, archiveName: ".env.example" },
      ...cfgItems,
      ...keyItems,
    ];

    const binaries = new Map();
    for (const { file } of BINARY_TARGETS) {
      const item = stageDistFile(stagingDir, manifest, file, `package binary ${file}`, true);
      binaries.set(file, item);
      registerStaged(item);
      coveredBinaries[file] = item.fingerprint;
    }

    const nodeFiles = new Map();
    for (const { file } of NODE_TARGETS) {
      const item = stageDistFile(
        stagingDir,
        manifest,
        file,
        `package Node archive source ${file}`,
      );
      nodeFiles.set(file, item);
      registerStaged(item);
      coveredManifestFiles[file] = item.fingerprint;
    }

    const readmeCache = new Map();
    const readmes = {
      binary: stageReadmes(stagingDir, "binary", readmeCache),
      node: stageReadmes(stagingDir, "node", readmeCache),
    };
    // The binary and Node readme lists share the two README files, so the cache
    // is what keeps a single staging file per source.
    for (const item of readmeCache.values()) {
      registerStaged(item);
    }
    assertNoDisallowedEnvAssets(stagingDir, "package archive staging", {
      allowEnvExample: true,
    });
    const snapshot = snapshotTree(stagingDir, {
      allowRootEnvExample: true,
      label: "package archive staging",
    });
    assertSnapshotMapsEqual(expectedStaging, snapshot, "package archive staging");
    // app.js is a source-build entry, README.md / package.json are inputs that
    // each archive rebuilds, and the generated cfg defaults are shipped as
    // freshly generated safe defaults. All omissions are explicit.
    assertManifestCoverage(
      manifest.files,
      coveredManifestFiles,
      ["app.js", "README.md", "package.json", ...GENERATED_CFG_PATHS],
      "package archive staging",
    );
    assertManifestCoverage(manifest.binaries, coveredBinaries, [], "package binary staging");
    assertSameDirectoryIdentity(
      distBefore,
      ensureRealDirectory(distDir, "package archive source"),
      "after archive staging",
    );
    return { dir: stagingDir, snapshot, commonAssets, binaries, nodeFiles, readmes };
  } catch (error) {
    if (!stagingDir) throw error;
    try {
      cleanupArchiveStaging(stagingDir);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "[package] archive staging setup and cleanup both failed",
      );
    }
    throw error;
  }
}

/**
 * The archive parent must be the real dist directory at every step, otherwise a
 * swapped junction would redirect the temporary file outside the tree.
 */
function assertArchiveParentIsReal() {
  return ensureRealDirectory(distDir, "package dist");
}

function assertSameDirectoryIdentity(before, after, phase) {
  if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeMs !== after.birthtimeMs) {
    throw new Error(`[package] archive parent identity changed ${phase}`);
  }
}

function assertSameArchiveIdentity(before, after, label) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.birthtimeMs !== after.birthtimeMs ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`[package] ${label} identity or length changed`);
  }
}

async function writeArchiveAtomic(outFile, zip) {
  if (path.dirname(path.resolve(outFile)) !== path.resolve(distDir)) {
    throw new Error(`[package] archive must be written directly into dist: ${outFile}`);
  }
  const parentBefore = assertArchiveParentIsReal();

  const existing = lstatIfExists(outFile);
  if (existing) {
    if (isLinkLikePath(outFile, existing) || !existing.isFile()) {
      throw new Error(`[package] existing archive output is not a regular file: ${outFile}`);
    }
    throw new Error(`[package] archive output already exists: ${outFile}`);
  }

  const temporaryFile = `${outFile}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let primaryError;
  let primaryFailed = false;
  try {
    // Refuse a pre-planted link on the temporary path before any byte is
    // written. The shared writer repeats this check at exclusive open.
    const temporaryStat = lstatIfExists(temporaryFile);
    if (temporaryStat) {
      if (isLinkLikePath(temporaryFile, temporaryStat)) {
        throw new Error(
          `[package] temporary archive path is a symlink or junction: ${temporaryFile}`,
        );
      }
      if (!temporaryStat.isFile()) {
        throw new Error(
          `[package] temporary archive path is not a regular file: ${temporaryFile}`,
        );
      }
      throw new Error(`[package] temporary archive path already exists: ${temporaryFile}`);
    }
    const parentBeforeWrite = assertArchiveParentIsReal();
    assertSameDirectoryIdentity(parentBefore, parentBeforeWrite, "before archive write");
    const written = await writeZipToExclusiveFile(
      temporaryFile,
      zip,
      "temporary archive",
      // 最终 zip 本身是发布物：显式 0o644（临时文件 rename 过去后权限保留）
      ARCHIVE_FILE_MODE,
    );
    const parentAfterWrite = assertArchiveParentIsReal();
    assertSameDirectoryIdentity(parentBefore, parentAfterWrite, "after archive write");
    const beforeRename = assertRegularFile(temporaryFile, "temporary archive");
    assertSameArchiveIdentity(written, beforeRename, "temporary archive");
    if (beforeRename.size === 0) {
      throw new Error(`[package] temporary archive is empty: ${temporaryFile}`);
    }
    const parentBeforeRename = assertArchiveParentIsReal();
    assertSameDirectoryIdentity(parentBefore, parentBeforeRename, "before archive rename");
    if (lstatIfExists(outFile)) {
      throw new Error(`[package] archive output appeared during write: ${outFile}`);
    }
    fs.renameSync(temporaryFile, outFile);
    const parentAfterRename = assertArchiveParentIsReal();
    assertSameDirectoryIdentity(parentBefore, parentAfterRename, "after archive rename");
    const created = assertRegularFile(outFile, "created archive");
    assertSameArchiveIdentity(beforeRename, created, "created archive");
    if (created.size === 0) {
      throw new Error(`[package] archive is empty after write: ${outFile}`);
    }
  } catch (error) {
    primaryError = error;
    primaryFailed = true;
  }

  let cleanupError;
  let cleanupFailed = false;
  try {
    removePathNoFollow(temporaryFile);
  } catch (error) {
    cleanupError = error;
    cleanupFailed = true;
  }

  if (primaryFailed) {
    if (cleanupFailed) {
      console.error(`[package] temporary archive cleanup failed: ${String(cleanupError)}`);
    }
    throw primaryError;
  }
  if (cleanupFailed) throw cleanupError;
}

function addStagedFile(zip, staged, options = {}) {
  let data;
  if (staged.data !== undefined) {
    data = staged.data;
    const actual = fingerprintBuffer(data);
    if (actual.size !== staged.fingerprint.size || actual.sha256 !== staged.fingerprint.sha256) {
      throw new Error(`[package] staged snapshot bytes changed: ${staged.archiveName ?? "archive source"}`);
    }
  } else {
    const captured = captureRegularFile(
      staged.path,
      `staged ${staged.archiveName ?? "archive source"}`,
      staged,
    );
    data = captured.data;
  }
  // yazl receives a Buffer, never a mutable source or staging path. This keeps
  // archive creation immune to a later replacement before yazl's async read.
  zip.addBuffer(data, staged.archiveName, {
    mtime: staged.mtime,
    ...options,
  });
}

function addCommonAssets(zip, stagedAssets) {
  // The generated cfg defaults are appended from a fixed buffer, never staged
  // from dist. Refuse any overlap with a staged archive name: yazl would emit two
  // entries under one name and the archive would silently depend on ordering.
  const names = new Set();
  for (const staged of stagedAssets) {
    const name = staged.archiveName;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`[package] staged archive entry has no name: ${String(staged.path)}`);
    }
    if (names.has(name)) {
      throw new Error(`[package] duplicate staged archive entry: ${name}`);
    }
    names.add(name);
  }
  for (const generated of generatedCfgAssets()) {
    if (names.has(generated.archiveName)) {
      throw new Error(
        `[package] generated default collides with a staged archive entry: ${generated.archiveName}`,
      );
    }
    names.add(generated.archiveName);
  }

  for (const staged of stagedAssets) addStagedFile(zip, staged);
  for (const generated of generatedCfgAssets()) {
    // Safe generated defaults, not a copy of whatever dist happens to hold.
    zip.addBuffer(generated.data, generated.archiveName);
  }
}

function addReadme(zip, stagedReadmes) {
  for (const staged of stagedReadmes) addStagedFile(zip, staged);
}

function assertArchives(archives) {
  for (const file of archives) {
    const captured = captureRegularFile(path.join(distDir, file), "created archive");
    if (captured.fingerprint.size === 0) {
      throw new Error(`[package] archive is empty after write: ${file}`);
    }
  }
}

async function main() {
  assertDistDirectory();
  // Delete old archives before validation so a failed independent invocation
  // cannot leave an old zip looking like a successful current package. This runs
  // before any staging of this batch, so nothing created below is affected.
  cleanReleaseArchives(distDir);
  assertSupportedHost();
  const manifest = assertBuildBatch();
  verifiedBatch = manifest;

  const staging = createArchiveStaging(manifest);
  const archives = [];
  // Recorded before each write so a failure still cleans up an archive whose
  // post-rename verification threw. Only these files are ever removed.
  const attemptedArchives = [];
  let archiveError = null;
  let openedMac;
  let verifiedMac;
  try {
    const stagedMac = staging.binaries.get("proxy-macos");
    if (!stagedMac) throw new Error("[package] staged macOS binary is missing");
    openedMac = openRegularFileSnapshot(
      stagedMac.path,
      "package macOS binary snapshot",
      stagedMac,
    );
    const verification = verifyMacOSSignatureSnapshot(openedMac, "package macOS binary snapshot");
    verifiedMac = verification.snapshot;

    // The archive staging map is reconciled again after all sources have been
    // captured. Every later add uses either this map's expected fingerprint or
    // the already-verified macOS descriptor buffer.
    verifyTreeSnapshot(staging.dir, staging.snapshot, "package archive staging", {
      allowRootEnvExample: true,
    });

    for (const { file, zipName, os } of BINARY_TARGETS) {
      const stagedBinary = staging.binaries.get(file);
      if (!stagedBinary) throw new Error(`[package] staged binary is missing: ${file}`);
      const zipBinary = file === "proxy-macos" ? { ...stagedBinary, ...verifiedMac } : stagedBinary;
      const zip = new yazl.ZipFile();
      addStagedFile(zip, { ...zipBinary, archiveName: zipName }, { mode: 0o755 });
      addCommonAssets(zip, staging.commonAssets);
      addReadme(zip, staging.readmes.binary);

      const outName = `proxy-v${version}-${os}-x64.zip`;
      const outFile = path.join(distDir, outName);
      attemptedArchives.push(outName);
      await writeArchiveAtomic(outFile, zip);
      archives.push(outName);
      const size = (captureRegularFile(outFile, "created archive").fingerprint.size / 1024 / 1024).toFixed(1);
      console.log(`[package] ${outName} (${size} MB)`);
    }

    for (const { file, label } of NODE_TARGETS) {
      const stagedApp = staging.nodeFiles.get(file);
      if (!stagedApp) throw new Error(`[package] staged Node source is missing: ${file}`);
      const zip = new yazl.ZipFile();
      addStagedFile(zip, { ...stagedApp, archiveName: "app.js" });

      const minimalPkg = JSON.stringify(
        {
          name: pkg.name,
          version,
          engines: { node: pkg.engines.node },
        },
        null,
        2,
      );
      zip.addBuffer(Buffer.from(minimalPkg + "\n"), "package.json");
      addCommonAssets(zip, staging.commonAssets);
      addReadme(zip, staging.readmes.node);

      const outName = `proxy-v${version}-${label}.zip`;
      const outFile = path.join(distDir, outName);
      attemptedArchives.push(outName);
      await writeArchiveAtomic(outFile, zip);
      archives.push(outName);
      const size = (captureRegularFile(outFile, "created archive").fingerprint.size / 1024 / 1024).toFixed(1);
      console.log(`[package] ${outName} (${size} MB)`);
    }

    verifyTreeSnapshot(staging.dir, staging.snapshot, "package archive staging", {
      allowRootEnvExample: true,
    });
    assertArchives(archives);
  } catch (error) {
    archiveError = error;
  }

  let stagingCleanupError = null;
  try {
    closeRegularFileSnapshot(verifiedMac ?? openedMac);
  } catch (error) {
    stagingCleanupError = error;
  }
  try {
    cleanupArchiveStaging(staging.dir);
  } catch (error) {
    stagingCleanupError = stagingCleanupError
      ? new AggregateError([stagingCleanupError, error], "archive staging close and cleanup failed")
      : error;
  }
  if (archiveError) {
    // A partial archive set from this run is the only thing that may be removed.
    // The verified build manifest, its recorded binaries, and lib/ stay: a
    // failed packaging attempt must not throw away a verified release batch.
    cleanupAttemptedArchives(attemptedArchives);
    console.error(
      `[package] preserved verified build batch ${verifiedBatch?.buildId ?? "<none recorded>"} and its binaries`,
    );
    if (stagingCleanupError) {
      throw new AggregateError(
        [archiveError, stagingCleanupError],
        "[package] archive creation and staging cleanup both failed",
      );
    }
    throw archiveError;
  }
  if (stagingCleanupError) throw stagingCleanupError;

  console.log(`[package] verified ${archives.length} archives for the recorded build batch`);
}

/**
 * Remove only the archives this run tried to create. The build manifest, the
 * recorded binaries, and lib/ belong to the verified build batch and are never
 * touched on a packaging failure.
 */
function cleanupAttemptedArchives(attemptedArchives) {
  const errors = [];
  for (const outName of new Set(attemptedArchives)) {
    try {
      removePathNoFollow(path.join(distDir, outName));
    } catch (error) {
      errors.push(error);
    }
  }
  for (const error of errors) {
    console.error(`[package] archive cleanup after failure failed: ${String(error)}`);
  }
  return errors;
}

try {
  await main();
} catch (error) {
  // Nothing to clean: main() already removed the staging directory and every
  // archive it created. Keep the primary archive error and add a batch-preserve
  // diagnostic instead of deleting the verified build batch.
  console.error(
    `[package] preserved build batch ${verifiedBatch?.buildId ?? "<not verified: failed before batch validation>"}; only this run's archives and staging were removed`,
  );
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}
