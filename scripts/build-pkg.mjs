/**
 * Build the three explicit Node 22 x64 pkg targets.
 *
 * pkg is always run from an immutable staging tree created from the verified
 * dist batch. The mutable project root is only used for the preflight snapshot
 * and is checked again after pkg; it is never an asset source while pkg runs.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertMacSignatureVerifierAvailable,
  assertNoDisallowedEnvAssets,
  ENV_EXAMPLE_NAME,
  assertNoSymlinks,
  assertRegularFile,
  assertManifestCoverage,
  assertSnapshotMapsEqual,
  attachBinaryArtifacts,
  captureRegularFile,
  closeRegularFileSnapshot,
  copyRegularFileNoFollow,
  copyTreeWithoutEnv,
  createExclusiveRealDirectory,
  DIST_BINARY_MODE,
  ensureRealDirectory,
  fingerprintBuffer,
  fingerprintFile,
  generatedCfgRelativePaths,
  isLinkLikePath,
  manifestSubtree,
  openRegularFileSnapshot,
  PRIVATE_FILE_MODE,
  readBuildManifest,
  readRealDirectoryNames,
  removeReleaseArtifacts,
  snapshotTree,
  stageRegularFileSnapshot,
  verifyBinaryArtifacts,
  verifyBuildManifestFiles,
  verifyLibraryArtifacts,
  verifyMacOSSignatureSnapshot,
  verifyTreeSnapshot,
  writeBuildManifest,
  writeExclusiveRegularFileNoFollow,
} from "./release-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const distDir = path.join(root, "dist");
const libDir = path.join(root, "lib");
const packagePath = path.join(root, "package.json");
assertRegularFile(packagePath, "project package");
const packageSnapshot = captureRegularFile(packagePath, "project package");
const pkg = JSON.parse(packageSnapshot.data.toString("utf8"));

const GENERATED_CFG_SET = new Set(generatedCfgRelativePaths());
const GENERATED_CFG_PATHS = generatedCfgRelativePaths();

const BINARY_TARGETS = [
  { target: "node22-win-x64", platform: "win", file: "proxy-win.exe" },
  { target: "node22-linux-x64", platform: "linux", file: "proxy-linux" },
  { target: "node22-darwin-x64", platform: "darwin", file: "proxy-macos" },
];

const HOST_PLATFORMS = {
  win32: "win",
  linux: "linux",
  darwin: "darwin",
};

function getHostTarget() {
  const platform = HOST_PLATFORMS[process.platform];
  if (process.arch !== "x64" || !platform) {
    throw new Error(
      `[build-pkg] unsupported host ${process.platform}-${process.arch}; expected x64 Windows/Linux/macOS`,
    );
  }
  return BINARY_TARGETS.find((entry) => entry.platform === platform);
}

function formatError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function childFailure(label, result) {
  const status = Number.isInteger(result.status) ? result.status : null;
  const error = new Error(
    `[build-pkg] ${label} failed (status=${status ?? "null"} signal=${result.signal ?? "null"})`,
  );
  if (status !== null) error.exitCode = status;
  return error;
}

function snapshotOptionalFile(filePath) {
  const stat = lstatIfExists(filePath);
  if (!stat) return { exists: false, fingerprint: null };
  assertRegularFile(filePath, "pkg source file");
  return { exists: true, fingerprint: fingerprintFile(filePath) };
}

function assertSameFingerprint(actualPath, expected, label) {
  const stat = lstatIfExists(actualPath);
  if (!stat || isLinkLikePath(actualPath, stat) || !stat.isFile()) {
    throw new Error(`[build-pkg] ${label} is missing or not a regular file`);
  }
  const actual = fingerprintFile(actualPath);
  if (!expected || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new Error(`[build-pkg] ${label} changed after the source snapshot`);
  }
}

function snapshotOptionalTree(rootDir, label) {
  const stat = lstatIfExists(rootDir);
  if (!stat) return { exists: false, files: Object.create(null) };
  if (isLinkLikePath(rootDir, stat) || !stat.isDirectory()) {
    throw new Error(`[build-pkg] ${label} is not a real directory: ${rootDir}`);
  }
  assertNoSymlinks(rootDir, label);
  return {
    exists: true,
    files: snapshotTree(rootDir, { allowRootEnvExample: false, label }),
  };
}

function snapshotSourceInputs() {
  const keysDir = path.join(root, "keys");
  const cfgDir = path.join(root, "cfg");
  assertNoDisallowedEnvAssets(keysDir, "pkg keys source", { allowEnvExample: false });
  assertNoDisallowedEnvAssets(cfgDir, "pkg cfg source", { allowEnvExample: false });

  return {
    trees: {
      keys: snapshotOptionalTree(keysDir, "pkg keys source"),
      cfg: snapshotOptionalTree(cfgDir, "pkg cfg source"),
    },
    files: {
      env: snapshotOptionalFile(path.join(root, ".env.example")),
      readme: snapshotOptionalFile(path.join(root, "README.md")),
      package: snapshotOptionalFile(path.join(root, "package.json")),
    },
  };
}

function assertSourceSnapshot(snapshot) {
  for (const [name, tree] of Object.entries(snapshot.trees)) {
    const current = snapshotOptionalTree(
      name === "keys" ? path.join(root, "keys") : path.join(root, "cfg"),
      `pkg ${name} source`,
    );
    if (current.exists !== tree.exists) {
      throw new Error(`[build-pkg] pkg ${name} source appeared or disappeared after snapshot`);
    }
    if (tree.exists) {
      verifyTreeSnapshot(
        name === "keys" ? path.join(root, "keys") : path.join(root, "cfg"),
        tree.files,
        `pkg ${name} source`,
      );
    }
  }

  for (const [name, expected] of Object.entries(snapshot.files)) {
    const filePath = {
      env: path.join(root, ".env.example"),
      readme: path.join(root, "README.md"),
      package: path.join(root, "package.json"),
    }[name];
    const current = snapshotOptionalFile(filePath);
    if (current.exists !== expected.exists) {
      throw new Error(`[build-pkg] pkg ${name} source appeared or disappeared after snapshot`);
    }
    if (expected.exists)
      assertSameFingerprint(filePath, expected.fingerprint, `pkg ${name} source`);
  }
}

function assertSameFile(sourcePath, copiedPath, label) {
  if (!lstatIfExists(sourcePath) || !lstatIfExists(copiedPath)) {
    throw new Error(`[build-pkg] ${label} is not copied into the build batch`);
  }
  assertRegularFile(sourcePath, `pkg ${label} source`);
  assertRegularFile(copiedPath, `dist ${label}`);
  const source = fingerprintFile(sourcePath);
  const copied = fingerprintFile(copiedPath);
  if (source.size !== copied.size || source.sha256 !== copied.sha256) {
    throw new Error(`[build-pkg] ${label} differs between the pkg source and dist copy`);
  }
}

function assertCopiedTrees() {
  const sourceKeys = path.join(root, "keys");
  const copiedKeys = path.join(distDir, "keys");
  if (lstatIfExists(sourceKeys)) {
    assertNoSymlinks(sourceKeys, "pkg keys source");
    const sourceFiles = snapshotTree(sourceKeys, {
      allowRootEnvExample: false,
      label: "pkg keys source",
    });
    const copiedFiles = snapshotTree(copiedKeys, {
      allowRootEnvExample: false,
      label: "dist keys",
    });
    assertSnapshotMapsEqual(sourceFiles, copiedFiles, "keys/ tree");
  } else if (lstatIfExists(copiedKeys)) {
    throw new Error("[build-pkg] keys source is missing but dist/keys exists");
  }

  const sourceCfg = path.join(root, "cfg");
  const copiedCfg = path.join(distDir, "cfg");
  if (lstatIfExists(sourceCfg)) {
    assertNoSymlinks(sourceCfg, "pkg cfg source");
    const sourceExamples = Object.create(null);
    const copiedExamples = Object.create(null);
    for (const name of readRealDirectoryNames(sourceCfg, "pkg cfg source")) {
      const source = path.join(sourceCfg, name);
      const stat = fs.lstatSync(source);
      if (isLinkLikePath(source, stat)) {
        throw new Error(`[build-pkg] cfg source symlink or junction is not allowed: ${source}`);
      }
      if (!stat.isFile() || !name.endsWith(".example")) continue;
      sourceExamples[name] = fingerprintFile(source);
      assertSameFile(source, path.join(copiedCfg, name), `cfg/${name}`);
    }
    if (lstatIfExists(copiedCfg)) {
      assertNoSymlinks(copiedCfg, "dist cfg");
      for (const name of readRealDirectoryNames(copiedCfg, "dist cfg")) {
        const copied = path.join(copiedCfg, name);
        const stat = fs.lstatSync(copied);
        if (isLinkLikePath(copied, stat)) {
          throw new Error(`[build-pkg] dist cfg symlink or junction is not allowed: ${copied}`);
        }
        if (stat.isFile() && name.endsWith(".example")) {
          copiedExamples[name] = fingerprintFile(copied);
        }
        // A non-template dist cfg entry is only legitimate as one of the
        // generated safe defaults; build.mjs never copies real cfg data here.
        if (stat.isFile() && !name.endsWith(".example") && !GENERATED_CFG_SET.has(`cfg/${name}`)) {
          throw new Error(
            `[build-pkg] dist cfg holds an asset that is neither a template nor a known generated default: cfg/${name}`,
          );
        }
      }
    }
    assertSnapshotMapsEqual(sourceExamples, copiedExamples, "cfg/ example tree");
  } else if (lstatIfExists(copiedCfg)) {
    assertNoSymlinks(copiedCfg, "dist cfg");
    for (const name of readRealDirectoryNames(copiedCfg, "dist cfg")) {
      if (name.endsWith(".example")) {
        throw new Error(`[build-pkg] cfg source is missing but dist/cfg/${name} exists`);
      }
    }
  }
}

function assertRootAssetCopies() {
  for (const file of [".env.example", "README.md", "package.json"]) {
    const source = path.join(root, file);
    assertRegularFile(source, `pkg ${file} source`);
    assertSameFile(source, path.join(distDir, file), file);
    if (file === ".env.example" && lstatIfExists(path.join(distDir, file))?.size === 0) {
      throw new Error("[build-pkg] required environment template is empty");
    }
  }
}

function assertSourceTree(manifest) {
  if (manifest.mode !== "production") {
    throw new Error(
      `[build-pkg] refusing non-production build batch (mode=${manifest.mode}); run pnpm build first`,
    );
  }
  if (manifest.version !== pkg.version) {
    throw new Error(
      `[build-pkg] manifest version ${manifest.version} does not match package ${pkg.version}; rebuild`,
    );
  }
  assertNoDisallowedEnvAssets(distDir, "pkg dist");
  assertNoDisallowedEnvAssets(path.join(root, "keys"), "pkg keys", {
    allowEnvExample: false,
  });
  assertNoDisallowedEnvAssets(path.join(root, "cfg"), "pkg cfg", {
    allowEnvExample: false,
  });
  assertRootAssetCopies();
  assertCopiedTrees();
  verifyBuildManifestFiles(distDir, manifest, ["app.js", "app-v22.js"]);
  verifyLibraryArtifacts(libDir, manifest);
  return manifest;
}

function recordedManifestFile(manifest, relativePath, label) {
  if (!Object.hasOwn(manifest.files, relativePath)) {
    throw new Error(`[build-pkg] ${label} is not recorded in the build manifest: ${relativePath}`);
  }
  return manifest.files[relativePath];
}

function copyCfgExamples(sourceDir, destinationDir, manifest) {
  const copied = Object.create(null);
  const stat = lstatIfExists(sourceDir);
  if (!stat) {
    assertSnapshotMapsEqual(manifestSubtree(manifest.files, "cfg"), {}, "dist cfg");
    return copied;
  }
  if (isLinkLikePath(sourceDir, stat) || !stat.isDirectory()) {
    throw new Error(`[build-pkg] cfg dist tree is not a real directory: ${sourceDir}`);
  }
  assertNoSymlinks(sourceDir, "dist cfg");
  const sourceFiles = snapshotTree(sourceDir, {
    allowRootEnvExample: false,
    label: "dist cfg",
  });

  // Two explicit classes, and nothing else is publishable:
  //  - `*.example` is the release template and is copied into pkg staging;
  //  - the generated safe defaults are recorded in the manifest but must never
  //    be copied into a release: the real dist file may hold an operator's
  //    accounts and lists.
  const templates = Object.create(null);
  const generated = [];
  for (const [relativePath, record] of Object.entries(manifest.files)) {
    if (!relativePath.startsWith("cfg/")) continue;
    const name = relativePath.slice("cfg/".length);
    if (GENERATED_CFG_SET.has(relativePath)) {
      generated.push(relativePath);
      continue;
    }
    if (!name.endsWith(".example")) {
      throw new Error(
        `[build-pkg] cfg asset is neither a publishable .example template nor a known generated default: ${relativePath}`,
      );
    }
    templates[name] = record;
  }
  for (const relativePath of generated) {
    // The generated defaults are still verified byte-for-byte below through the
    // two-way comparison against the real dist tree; this only records that
    // they are intentionally not staged.
    console.log(`[build-pkg] cfg generated default is not staged: ${relativePath}`);
  }

  const expected = manifestSubtree(manifest.files, "cfg");
  assertSnapshotMapsEqual(expected, sourceFiles, "dist cfg");
  ensureRealDirectory(destinationDir, "pkg staging cfg");
  for (const [name, record] of Object.entries(templates)) {
    const source = path.join(sourceDir, name);
    const result = copyRegularFileNoFollow(
      source,
      path.join(destinationDir, name),
      "pkg staging cfg",
      record,
      PRIVATE_FILE_MODE,
    );
    copied[`cfg/${name}`] = result.fingerprint;
  }
  return copied;
}

function createPkgStaging(manifest) {
  const stagingDir = createExclusiveRealDirectory(
    os.tmpdir(),
    "proxy-pkg-staging-",
    "pkg staging root",
  );
  try {
    const expectedStaging = Object.create(null);
    const coveredManifestFiles = Object.create(null);
    const stagingDist = path.join(stagingDir, "dist");
    ensureRealDirectory(stagingDist, "pkg staging dist");

    const stageManifestFile = (sourceRelative, destinationRelative, label) => {
      const expected = recordedManifestFile(manifest, sourceRelative, label);
      const result = copyRegularFileNoFollow(
        path.join(distDir, sourceRelative),
        path.join(stagingDir, destinationRelative),
        label,
        expected,
        PRIVATE_FILE_MODE,
      );
      expectedStaging[destinationRelative] = result.fingerprint;
      coveredManifestFiles[sourceRelative] = result.fingerprint;
      return result;
    };

    stageManifestFile("app.js", "dist/app.js", "pkg staging app");
    stageManifestFile(".env.example", ENV_EXAMPLE_NAME, "pkg staging environment template");
    stageManifestFile("README.md", "README.md", "pkg staging README");
    stageManifestFile("package.json", "package.json.input", "pkg staging package input");

    const keys = copyTreeWithoutEnv(
      path.join(distDir, "keys"),
      path.join(stagingDir, "keys"),
      "pkg staging keys",
      { expectedFiles: manifest.files, expectedPrefix: "keys" },
    );
    for (const [relativePath, record] of Object.entries(keys.files)) {
      expectedStaging[`keys/${relativePath}`] = record;
      coveredManifestFiles[`keys/${relativePath}`] = record;
    }
    const cfg = copyCfgExamples(path.join(distDir, "cfg"), path.join(stagingDir, "cfg"), manifest);
    for (const [relativePath, record] of Object.entries(cfg)) {
      expectedStaging[relativePath] = record;
      coveredManifestFiles[relativePath] = record;
    }

    const packageInput = captureRegularFile(
      path.join(stagingDir, "package.json.input"),
      "pkg staging package input",
      recordedManifestFile(manifest, "package.json", "pkg staging package input"),
    );
    const builtPackage = JSON.parse(packageInput.data.toString("utf8"));
    const stagingPackage = {
      ...builtPackage,
      pkg: {
        ...(builtPackage.pkg ?? {}),
        scripts: "dist/app.js",
        assets: [".env.example", "keys/**/*", "cfg/*.example", "package.json", "README.md"],
        targets: BINARY_TARGETS.map(({ target }) => target),
      },
    };
    const packageBytes = `${JSON.stringify(stagingPackage, null, 2)}\n`;
    const packagePathStaging = path.join(stagingDir, "package.json");
    writeExclusiveRegularFileNoFollow(
      packagePathStaging,
      packageBytes,
      "pkg staging package",
      PRIVATE_FILE_MODE,
    );
    const generatedPackage = captureRegularFile(
      packagePathStaging,
      "pkg staging package",
      fingerprintBuffer(Buffer.from(packageBytes)),
    );
    expectedStaging["package.json"] = generatedPackage.fingerprint;
    const packageInputPath = path.join(stagingDir, "package.json.input");
    assertRegularFile(packageInputPath, "pkg staging package input");
    fs.unlinkSync(packageInputPath);
    // package.json.input is a consumable intermediate: the expectedStaging entry
    // only exists to fingerprint-verify the copy, so removing the file must also
    // revoke that expectation. Keeping it would make the bidirectional
    // expectedStaging/actualStaging reconcile fail closed on the missing key.
    delete expectedStaging["package.json.input"];

    assertNoDisallowedEnvAssets(stagingDir, "pkg staging", { allowEnvExample: true });
    const actualStaging = snapshotTree(stagingDir, {
      allowRootEnvExample: true,
      label: "pkg staging",
    });
    assertSnapshotMapsEqual(expectedStaging, actualStaging, "pkg staging");
    // app-v22.js is the archive-only entry and the generated cfg defaults are
    // published as freshly generated safe defaults. Both omissions are
    // explicit: an unrecorded new dist file must still fail this check.
    assertManifestCoverage(
      manifest.files,
      coveredManifestFiles,
      ["app-v22.js", ...GENERATED_CFG_PATHS],
      "pkg staging",
    );
    return { dir: stagingDir, snapshot: actualStaging };
  } catch (error) {
    try {
      removeStaging(stagingDir);
    } catch (cleanupError) {
      console.error(
        `[build-pkg] staging cleanup after setup failure failed: ${formatError(cleanupError)}`,
      );
    }
    throw error;
  }
}

function runPkg(stagingDir, outputDir) {
  const pkgEntry = path.join(root, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js");
  if (!lstatIfExists(pkgEntry)) {
    throw new Error(`[build-pkg] pkg entry not found: ${pkgEntry}; run pnpm install`);
  }
  assertRegularFile(pkgEntry, "pkg entry");
  assertMacSignatureVerifierAvailable();
  ensureRealDirectory(outputDir, "pkg output");

  const targets = BINARY_TARGETS.map((entry) => entry.target).join(",");
  const result = spawnSync(
    process.execPath,
    [pkgEntry, ".", "--out-path", outputDir, "--targets", targets, "--signature"],
    {
      cwd: stagingDir,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) throw childFailure("pkg", result);
}

function createBinaryStaging(outputDir) {
  const binaryDir = createExclusiveRealDirectory(
    os.tmpdir(),
    "proxy-pkg-snapshot-",
    "pkg binary staging root",
  );
  try {
    assertNoSymlinks(outputDir, "pkg output");
    const outputNames = readRealDirectoryNames(outputDir, "pkg output").sort();
    const expectedNames = BINARY_TARGETS.map(({ file }) => file).sort();
    if (outputNames.join("\n") !== expectedNames.join("\n")) {
      throw new Error(
        `[build-pkg] pkg output contains unregistered file(s): ${outputNames.join(", ")}`,
      );
    }
    const files = new Map();
    const expected = Object.create(null);
    for (const { file, target } of BINARY_TARGETS) {
      const staged = stageRegularFileSnapshot(
        path.join(outputDir, file),
        binaryDir,
        `pkg ${target} binary snapshot`,
        null,
        { name: file, retainData: false },
      );
      if (staged.fingerprint.size === 0) {
        throw new Error(`[build-pkg] pkg produced an empty binary: ${file}`);
      }
      files.set(file, staged);
      expected[file] = staged.fingerprint;
    }
    const actual = snapshotTree(binaryDir, {
      allowRootEnvExample: false,
      label: "pkg binary staging",
    });
    assertSnapshotMapsEqual(expected, actual, "pkg binary staging");
    return { dir: binaryDir, files, snapshot: actual };
  } catch (error) {
    try {
      removeStaging(binaryDir);
    } catch (cleanupError) {
      console.error(
        `[build-pkg] binary staging cleanup after setup failure failed: ${formatError(cleanupError)}`,
      );
    }
    throw error;
  }
}

function assertSameDirectoryIdentity(before, after, phase) {
  if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeMs !== after.birthtimeMs) {
    throw new Error(`[build-pkg] dist identity changed ${phase}`);
  }
}

/**
 * Remove one file created by this run. Deliberately never recursive: a binary
 * destination that turned into a directory is an attack, not something to wipe.
 */
function removeFileNoFollow(filePath) {
  const stat = lstatIfExists(filePath);
  if (!stat) return;
  if (isLinkLikePath(filePath, stat) || !stat.isDirectory()) {
    fs.unlinkSync(filePath);
    return;
  }
  throw new Error(`[build-pkg] refusing to remove a directory as a release file: ${filePath}`);
}

/** Undo only the binaries this run wrote; the verified build batch is kept. */
function rollbackMaterializedBinaries(paths) {
  const errors = [];
  for (const filePath of [...paths].reverse()) {
    try {
      removeFileNoFollow(filePath);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/**
 * Write the three verified binaries into dist and report the exact files this
 * call created, so a later failure can roll them back. Callers must treat the
 * returned list as "unregistered half-products" until the manifest records them.
 */
function materializeBinaryArtifacts(binaryStaging, verifiedMac, materialized) {
  const distBefore = ensureRealDirectory(distDir, "materialized binary dist");
  const registered = new Map();
  for (const { file } of BINARY_TARGETS) {
    const staged = binaryStaging.files.get(file);
    if (!staged) throw new Error(`[build-pkg] binary staging snapshot is missing: ${file}`);
    const expectedFingerprint =
      file === "proxy-macos" ? verifiedMac?.fingerprint : staged.fingerprint;
    if (
      !expectedFingerprint ||
      expectedFingerprint.size !== staged.fingerprint.size ||
      expectedFingerprint.sha256 !== staged.fingerprint.sha256
    ) {
      throw new Error(`[build-pkg] verified binary snapshot changed: ${file}`);
    }
    const destination = path.join(distDir, file);
    assertSameDirectoryIdentity(
      distBefore,
      ensureRealDirectory(distDir, "materialized binary dist"),
      `before writing ${file}`,
    );
    if (file === "proxy-macos") {
      if (!verifiedMac?.data) {
        throw new Error("[build-pkg] verified macOS snapshot has no bytes to materialize");
      }
      writeExclusiveRegularFileNoFollow(
        destination,
        verifiedMac.data,
        `materialized macOS binary ${file}`,
        // dist 裸二进制是发布物：0o600 的产物在 POSIX 上别人连跑都跑不了
        DIST_BINARY_MODE,
      );
    } else {
      copyRegularFileNoFollow(
        staged.path,
        destination,
        `materialized binary ${file}`,
        expectedFingerprint,
        DIST_BINARY_MODE,
      );
    }
    const materializedBinary = captureRegularFile(
      destination,
      `materialized binary ${file}`,
      expectedFingerprint,
    );
    materialized.push(destination);
    registered.set(file, {
      fingerprint: expectedFingerprint,
      mtimeMs: materializedBinary.mtimeMs,
    });
    assertSameDirectoryIdentity(
      distBefore,
      ensureRealDirectory(distDir, "materialized binary dist"),
      `after writing ${file}`,
    );
  }
  return registered;
}

function removeStaging(stagingDir) {
  if (!stagingDir) return;
  const stat = lstatIfExists(stagingDir);
  if (!stat) return;
  if (isLinkLikePath(stagingDir, stat) || !stat.isDirectory()) {
    fs.unlinkSync(stagingDir);
    return;
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

let primaryError = null;
let completedManifest = null;
let verifiedBatch = null;
let staging = null;
let binaryOutputDir = null;
let binaryStaging = null;
try {
  getHostTarget();
  const existingDist = lstatIfExists(distDir);
  if (existingDist && (isLinkLikePath(distDir, existingDist) || !existingDist.isDirectory())) {
    throw new Error(`[build-pkg] dist is not a real directory: ${distDir}`);
  }
  ensureRealDirectory(distDir, "pkg dist");

  // Read and validate the immutable batch before deleting any prior output.
  const manifest = assertSourceTree(readBuildManifest(distDir));
  verifiedBatch = manifest;
  const sourceSnapshot = snapshotSourceInputs();
  // Stale binaries and archives go, the verified build manifest stays: it is the
  // product of `pnpm build` / `build:lib`, not of this pkg run, and deleting it
  // here would destroy a verified batch on any later failure.
  removeReleaseArtifacts(distDir, { keepManifest: true });

  staging = createPkgStaging(manifest);
  const stagingSnapshot = staging.snapshot;

  // Preflight all three sides before pkg. The same checks run after pkg.
  assertSourceSnapshot(sourceSnapshot);
  verifyTreeSnapshot(staging.dir, stagingSnapshot, "pkg staging", {
    allowRootEnvExample: true,
  });
  verifyBuildManifestFiles(distDir, manifest, ["app.js", "app-v22.js"]);
  verifyLibraryArtifacts(libDir, manifest);

  binaryOutputDir = createExclusiveRealDirectory(
    os.tmpdir(),
    "proxy-pkg-output-",
    "pkg output root",
  );
  console.log(
    `[build-pkg] building ${BINARY_TARGETS.map((entry) => entry.target).join(", ")} (host: ${getHostTarget().target}; batch: ${manifest.buildId})...`,
  );
  runPkg(staging.dir, binaryOutputDir);

  assertNoSymlinks(distDir, "pkg output");
  assertNoDisallowedEnvAssets(distDir, "pkg output");
  verifyBuildManifestFiles(distDir, manifest, ["app.js", "app-v22.js"]);
  verifyLibraryArtifacts(libDir, manifest);
  assertSourceSnapshot(sourceSnapshot);
  verifyTreeSnapshot(staging.dir, stagingSnapshot, "pkg staging", {
    allowRootEnvExample: true,
  });

  // pkg writes only into a private output directory; registration and signing
  // consume a second private, fd-captured regular-file snapshot.
  binaryStaging = createBinaryStaging(binaryOutputDir);
  verifyTreeSnapshot(binaryStaging.dir, binaryStaging.snapshot, "pkg binary staging");

  const stagedMac = binaryStaging.files.get("proxy-macos");
  if (!stagedMac) throw new Error("[build-pkg] macOS binary staging snapshot is missing");
  let openedMac;
  let verifiedMac;
  const materializedBinaries = [];
  try {
    openedMac = openRegularFileSnapshot(
      stagedMac.path,
      "pkg macOS binary snapshot",
      stagedMac,
    );
    const verification = verifyMacOSSignatureSnapshot(openedMac, "pkg macOS binary snapshot");
    verifiedMac = verification.snapshot;
    const binarySnapshots = materializeBinaryArtifacts(
      binaryStaging,
      verifiedMac,
      materializedBinaries,
    );
    const completed = attachBinaryArtifacts(
      distDir,
      manifest,
      BINARY_TARGETS,
      {
        macosSignature: {
          file: "proxy-macos",
          verified: true,
          verifier: verification.verifier,
          verifiedAt: new Date().toISOString(),
        },
      },
      binarySnapshots,
    );
    writeBuildManifest(distDir, completed);
  } catch (error) {
    // Until writeBuildManifest succeeds the binaries are unregistered
    // half-products: remove exactly the files this run created and keep the
    // verified build manifest, so the next build-pkg can resume from it.
    const rollbackErrors = rollbackMaterializedBinaries(materializedBinaries);
    if (rollbackErrors.length) {
      for (const rollbackError of rollbackErrors) {
        console.error(
          `[build-pkg] binary materialization rollback also failed: ${formatError(rollbackError)}`,
        );
      }
    } else if (materializedBinaries.length) {
      console.log(
        `[build-pkg] rolled back ${materializedBinaries.length} unregistered binary file(s); verified build batch kept`,
      );
    }
    throw error;
  } finally {
    closeRegularFileSnapshot(verifiedMac ?? openedMac);
  }

  completedManifest = readBuildManifest(distDir);
  verifyBinaryArtifacts(distDir, completedManifest, BINARY_TARGETS);
  verifyTreeSnapshot(binaryStaging.dir, binaryStaging.snapshot, "pkg binary staging");
  console.log(`[build-pkg] node22 binaries verified for batch ${manifest.buildId}`);
} catch (error) {
  primaryError = error;
}

const stagingCleanupErrors = [];
for (const directory of [staging?.dir, binaryOutputDir, binaryStaging?.dir]) {
  try {
    removeStaging(directory);
  } catch (error) {
    stagingCleanupErrors.push(error);
  }
}
if (stagingCleanupErrors.length && !primaryError) primaryError = stagingCleanupErrors[0];

if (primaryError) {
  // Batch-preserve: a failed pkg run must not delete the verified build
  // manifest or the registered lib/. Unregistered binaries were already rolled
  // back above, so dist can never keep a half-registered binary here.
  console.error(
    `[build-pkg] preserved verified build batch ${verifiedBatch?.buildId ?? "<none recorded>"} and lib/; run pnpm build:pkg again to resume`,
  );

  // The primary error is intentionally printed before any cleanup diagnostics.
  console.error(`[build-pkg] node22 build failed: ${formatError(primaryError)}`);
  for (const error of stagingCleanupErrors) {
    if (error !== primaryError) {
      console.error(`[build-pkg] staging cleanup failed: ${formatError(error)}`);
    }
  }
  const requested = Number.isInteger(primaryError.exitCode) ? primaryError.exitCode : 1;
  process.exitCode = requested > 0 ? requested : 1;
} else {
  console.log(`[build-pkg] completed release batch ${completedManifest.buildId}`);
}
