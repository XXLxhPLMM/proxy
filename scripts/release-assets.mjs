import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The release tree has one environment asset: the exact root .env.example.
 * Basename matching is case-insensitive so Windows cannot bypass the rule with
 * names such as .ENV or .Env.Example.
 */
export const ENV_EXAMPLE_NAME = ".env.example";
export const BUILD_MANIFEST_NAME = ".build-manifest.json";
export const BINARY_OUTPUTS = Object.freeze(["proxy-win.exe", "proxy-linux", "proxy-macos"]);

/**
 * cfg files that `build.mjs` generates as safe defaults next to the copied
 * `*.example` templates.
 *
 * They are real files in dist, so `createBuildManifest` records them, but they
 * are NOT publishable templates: a real `users.json` may hold password hashes
 * and a real `acl.json` may hold an operator's lists. Release scripts therefore
 * never stage them from the build manifest; `package-dist` ships a freshly
 * generated safe default for each name instead.
 *
 * Both the manifest-coverage omissions and the generated archive entries are
 * derived from this single list, and the manifest key and the zip entry name
 * are the same string. A generated name can therefore never be both staged
 * from dist and generated into the archive, which would silently emit a
 * duplicate zip entry.
 *
 * Keep the bytes in sync with `build.mjs`, which writes the same contents.
 */
export const GENERATED_CFG_DEFAULTS = Object.freeze([
  Object.freeze({ relativePath: "cfg/users.json", contents: "[]\n" }),
  Object.freeze({
    relativePath: "cfg/acl.json",
    contents: `${JSON.stringify(
      { clientIp: { whitelist: [], blacklist: [] }, target: { whitelist: [], blacklist: [] } },
      null,
      2,
    )}\n`,
  }),
]);

/** Manifest keys of the generated cfg defaults: explicit coverage omissions. */
export function generatedCfgRelativePaths() {
  return GENERATED_CFG_DEFAULTS.map((entry) => entry.relativePath);
}

/** Archive entries for the generated cfg defaults, built once per archive. */
export function generatedCfgAssets() {
  return GENERATED_CFG_DEFAULTS.map((entry) => ({
    archiveName: entry.relativePath,
    data: Buffer.from(entry.contents, "utf8"),
  }));
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function isLinkLike(filePath, stat) {
  if (stat.isSymbolicLink()) return true;
  // On Windows a junction is a reparse point. Recent Node versions expose it
  // through lstat as a symlink, but readlink also covers older/edge behavior.
  if (process.platform === "win32" && stat.isDirectory()) {
    try {
      fs.readlinkSync(filePath);
      return true;
    } catch (error) {
      if (error?.code === "EINVAL" || error?.code === "UNKNOWN") return false;
      throw error;
    }
  }
  return false;
}

/**
 * Public, junction-aware link check for the build scripts. Every caller must
 * pass an lstat result: stat() would traverse a junction and defeat the check.
 */
export function isLinkLikePath(filePath, stat) {
  return Boolean(stat) && isLinkLike(filePath, stat);
}

/** Enumerate a real directory and recheck its identity after readdir. */
export function readRealDirectoryNames(dirPath, label = "directory") {
  const before = lstatIfExists(dirPath);
  if (!before) throw new Error(`[${label}] directory is missing: ${dirPath}`);
  if (isLinkLike(dirPath, before) || !before.isDirectory()) {
    throw new Error(`[${label}] expected a real directory: ${dirPath}`);
  }
  const names = fs.readdirSync(dirPath);
  const after = lstatIfExists(dirPath);
  if (!after) throw new Error(`[${label}] directory vanished while reading: ${dirPath}`);
  if (isLinkLike(dirPath, after) || !after.isDirectory()) {
    throw new Error(`[${label}] directory became a link or non-directory: ${dirPath}`);
  }
  assertSameFileIdentity(before, after, label, "while reading");
  return names;
}

/**
 * Fail closed on a directory that is missing, a link, or a non-directory.
 *
 * Recursive directory creation is deliberately not used: it succeeds against
 * a pre-existing symlink or junction and would silently relocate every later
 * write outside the tree. Creation is non-recursive so a missing parent is an
 * error rather than a silently created path, and the result is re-verified
 * with lstat to close the check/create race.
 */
export function ensureRealDirectory(dirPath, label = "directory") {
  const existing = lstatIfExists(dirPath);
  if (existing) {
    if (isLinkLike(dirPath, existing)) {
      throw new Error(`[${label}] directory is a symlink or junction: ${dirPath}`);
    }
    if (!existing.isDirectory()) {
      throw new Error(`[${label}] path is not a real directory: ${dirPath}`);
    }
    return existing;
  }

  try {
    fs.mkdirSync(dirPath);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new Error(`[${label}] cannot create directory ${dirPath}: ${error?.message ?? error}`);
    }
  }

  const created = lstatIfExists(dirPath);
  if (!created) {
    throw new Error(`[${label}] directory vanished after creation: ${dirPath}`);
  }
  if (isLinkLike(dirPath, created)) {
    throw new Error(`[${label}] directory is a symlink or junction: ${dirPath}`);
  }
  if (!created.isDirectory()) {
    throw new Error(`[${label}] path is not a real directory: ${dirPath}`);
  }
  return created;
}

/**
 * Create a random private directory without ever accepting an existing path.
 *
 * mkdtemp is deliberately not used here: callers should get the same
 * lstat-before / non-recursive-create / lstat-after contract as fixed release
 * directories, while an EEXIST candidate causes a fresh UUID to be tried
 * instead of silently reusing a pre-planted directory.
 */
export function createExclusiveRealDirectory(parentDir, prefix, label = "temporary directory") {
  if (typeof prefix !== "string" || prefix.length === 0 || path.basename(prefix) !== prefix) {
    throw new Error(`[${label}] invalid directory name prefix`);
  }

  const parent = path.resolve(parentDir);
  ensureRealDirectory(parent, `${label} parent`);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const dirPath = path.join(parent, `${prefix}${process.pid}-${crypto.randomUUID()}`);
    const existing = lstatIfExists(dirPath);
    if (existing) {
      if (isLinkLike(dirPath, existing)) {
        throw new Error(`[${label}] candidate is a symlink or junction: ${dirPath}`);
      }
      continue;
    }

    try {
      fs.mkdirSync(dirPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        const raced = lstatIfExists(dirPath);
        if (raced && isLinkLike(dirPath, raced)) {
          throw new Error(`[${label}] candidate is a symlink or junction: ${dirPath}`);
        }
        continue;
      }
      throw new Error(
        `[${label}] cannot create exclusive directory ${dirPath}: ${error?.message ?? error}`,
      );
    }

    const created = lstatIfExists(dirPath);
    if (!created) {
      throw new Error(`[${label}] directory vanished after exclusive creation: ${dirPath}`);
    }
    if (isLinkLike(dirPath, created)) {
      throw new Error(`[${label}] directory is a symlink or junction: ${dirPath}`);
    }
    if (!created.isDirectory()) {
      throw new Error(`[${label}] path is not a real directory: ${dirPath}`);
    }
    return dirPath;
  }

  throw new Error(`[${label}] could not obtain an exclusive directory below ${parent}`);
}

function isSafeRelativePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    return false;
  }
  const segments = relativePath.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isEnvLikeName(name) {
  return typeof name === "string" && name.toLowerCase().startsWith(".env");
}

function isAllowedEnvironmentEntry(relativePath, entry, allowEnvExample) {
  return (
    allowEnvExample &&
    relativePath === ENV_EXAMPLE_NAME &&
    entry.name === ENV_EXAMPLE_NAME &&
    entry.isFile === true &&
    entry.isSymbolicLink === false
  );
}

/**
 * lstat is deliberate: Node reports Windows junctions as symbolic links, and
 * stat would silently traverse them. A release tree may contain only regular
 * files and real directories.
 */
export function assertNoSymlinks(rootDir, label = "release tree") {
  const rootStat = lstatIfExists(rootDir);
  if (!rootStat) return false;
  if (isLinkLike(rootDir, rootStat)) {
    throw new Error(`[${label}] symlink or junction is not allowed: ${rootDir}`);
  }
  if (!rootStat.isDirectory()) return true;

  const visit = (currentDir) => {
    for (const name of readRealDirectoryNames(currentDir, label)) {
      const fullPath = path.join(currentDir, name);
      const stat = fs.lstatSync(fullPath);
      if (isLinkLike(fullPath, stat)) {
        throw new Error(`[${label}] symlink or junction is not allowed: ${fullPath}`);
      }
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (!stat.isFile()) {
        throw new Error(`[${label}] unsupported non-regular release entry: ${fullPath}`);
      }
    }
  };

  visit(rootDir);
  const after = lstatIfExists(rootDir);
  if (!after || isLinkLike(rootDir, after) || !after.isDirectory()) {
    throw new Error(`[${label}] release tree changed while scanning: ${rootDir}`);
  }
  assertSameFileIdentity(rootStat, after, label, "while scanning");
  return true;
}

export function assertRegularFile(filePath, label = "release file") {
  const stat = fs.lstatSync(filePath);
  if (isLinkLike(filePath, stat) || !stat.isFile()) {
    throw new Error(`[${label}] expected a regular, non-symlink file: ${filePath}`);
  }
  return stat;
}

function assertSameFileIdentity(before, after, label, phase) {
  if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeMs !== after.birthtimeMs) {
    throw new Error(`[${label}] file identity changed ${phase}`);
  }
}

function assertStableFileStat(before, after, label, phase) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.birthtimeMs !== after.birthtimeMs ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`[${label}] file changed ${phase}`);
  }
}

function noFollowFlag() {
  return Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
}

function binaryFlag() {
  return Number.isInteger(fs.constants.O_BINARY) ? fs.constants.O_BINARY : 0;
}

function normalizeExpectedFingerprint(expected, label) {
  if (expected === null || expected === undefined) return null;
  const record = expected?.fingerprint ?? expected;
  if (
    !record ||
    !Number.isInteger(record.size) ||
    record.size < 0 ||
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(record.sha256)
  ) {
    throw new Error(`[${label}] invalid expected fingerprint`);
  }
  return { size: record.size, sha256: record.sha256 };
}

function assertFingerprint(actual, expected, label) {
  const normalized = normalizeExpectedFingerprint(expected, label);
  if (normalized && (actual.size !== normalized.size || actual.sha256 !== normalized.sha256)) {
    throw new Error(`[${label}] does not match its expected fingerprint`);
  }
}

export function fingerprintBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return {
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function readDescriptorFully(descriptor, expectedSize) {
  const chunks = [];
  let position = 0;
  const chunkSize = 64 * 1024;
  while (position < expectedSize) {
    const chunk = Buffer.allocUnsafe(Math.min(chunkSize, expectedSize - position));
    const read = fs.readSync(descriptor, chunk, 0, chunk.length, position);
    if (read === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, read)));
    position += read;
  }
  if (position !== expectedSize) {
    throw new Error("file length changed while reading");
  }
  const extra = Buffer.allocUnsafe(1);
  if (fs.readSync(descriptor, extra, 0, extra.length, position) !== 0) {
    throw new Error("file grew while reading");
  }
  if (position === 0) return Buffer.alloc(0);
  return Buffer.concat(chunks, position);
}

function openRegularFileNoFollow(filePath, label) {
  const beforePath = assertRegularFile(filePath, label);
  const flags = fs.constants.O_RDONLY | noFollowFlag() | binaryFlag();
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, flags);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error(`[${label}] opened path is not a regular file: ${filePath}`);
    }
    assertSameFileIdentity(beforePath, opened, label, "between lstat and open");
    const afterOpen = assertRegularFile(filePath, label);
    assertStableFileStat(beforePath, afterOpen, label, "while opening");
    return { descriptor, filePath, opened, label };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

function readOpenRegularFile(handle, expected = null) {
  const { descriptor, filePath, opened, label } = handle;
  const before = fs.fstatSync(descriptor);
  if (!before.isFile()) {
    throw new Error(`[${label}] descriptor is not a regular file: ${filePath}`);
  }
  assertStableFileStat(opened, before, label, "before reading");
  const beforePath = assertRegularFile(filePath, label);
  assertStableFileStat(before, beforePath, label, "before reading");

  const data = readDescriptorFully(descriptor, before.size);
  const after = fs.fstatSync(descriptor);
  assertStableFileStat(before, after, label, "while reading");
  if (after.size !== data.length) {
    throw new Error(`[${label}] length changed while reading: ${filePath}`);
  }
  const afterPath = assertRegularFile(filePath, label);
  assertStableFileStat(before, afterPath, label, "while reading");
  const fingerprint = fingerprintBuffer(data);
  assertFingerprint(fingerprint, expected, label);
  return {
    data,
    fingerprint,
    stat: after,
    mtimeMs: after.mtimeMs,
    mtime: new Date(after.mtimeMs),
  };
}

/**
 * Open and read one regular file through a checked descriptor. The descriptor
 * remains open so callers that need an external verifier can revalidate the
 * exact same handle before and after that verifier runs.
 */
export function openRegularFileSnapshot(filePath, label = "release file", expected = null) {
  const handle = openRegularFileNoFollow(filePath, label);
  try {
    const snapshot = readOpenRegularFile(handle, expected);
    return {
      ...snapshot,
      filePath,
      descriptor: handle.descriptor,
      openedStat: handle.opened,
    };
  } catch (error) {
    fs.closeSync(handle.descriptor);
    throw error;
  }
}

export function closeRegularFileSnapshot(snapshot) {
  if (!snapshot || snapshot.descriptor === null || snapshot.descriptor === undefined) return;
  const descriptor = snapshot.descriptor;
  let before;
  try {
    before = fs.fstatSync(descriptor);
    assertStableFileStat(snapshot.stat, before, snapshot.filePath, "before closing");
  } finally {
    try {
      fs.closeSync(descriptor);
    } finally {
      snapshot.descriptor = null;
    }
  }
  const after = assertRegularFile(snapshot.filePath, snapshot.filePath);
  assertStableFileStat(before, after, snapshot.filePath, "after closing");
}

export function revalidateRegularFileSnapshot(snapshot, label = snapshot?.filePath ?? "release file") {
  if (!snapshot || snapshot.descriptor === null || snapshot.descriptor === undefined) {
    throw new Error(`[${label}] regular-file snapshot is not open`);
  }
  const handle = {
    descriptor: snapshot.descriptor,
    filePath: snapshot.filePath,
    opened: snapshot.stat,
    label,
  };
  const refreshed = readOpenRegularFile(handle, snapshot.fingerprint);
  if (
    refreshed.fingerprint.size !== snapshot.fingerprint.size ||
    refreshed.fingerprint.sha256 !== snapshot.fingerprint.sha256
  ) {
    throw new Error(`[${label}] snapshot bytes changed during revalidation`);
  }
  return { ...snapshot, ...refreshed };
}

export function captureRegularFile(filePath, label = "release file", expected = null) {
  const snapshot = openRegularFileSnapshot(filePath, label, expected);
  try {
    return {
      data: snapshot.data,
      fingerprint: snapshot.fingerprint,
      stat: snapshot.stat,
      mtimeMs: snapshot.mtimeMs,
      mtime: snapshot.mtime,
    };
  } finally {
    closeRegularFileSnapshot(snapshot);
  }
}

export function fingerprintFile(filePath) {
  return captureRegularFile(filePath, "release fingerprint").fingerprint;
}

export function statRegularFileNoFollow(filePath, label = "release file") {
  const handle = openRegularFileNoFollow(filePath, label);
  const descriptor = handle.descriptor;
  let closed = false;
  try {
    const beforeClose = fs.fstatSync(descriptor);
    assertStableFileStat(handle.opened, beforeClose, label, "before closing");
    fs.closeSync(descriptor);
    closed = true;
    const afterClose = assertRegularFile(filePath, label);
    assertStableFileStat(beforeClose, afterClose, label, "after closing");
    return afterClose;
  } catch (error) {
    if (!closed) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  }
}

/**
 * Exclusively create a regular file without accepting a pre-existing link.
 *
 * The lstat pre-check is required on Windows: CreateFile(CREATE_NEW) may follow
 * a planted reparse point even with O_EXCL. O_EXCL then closes the remaining
 * create race, and the opened handle plus post-write fstat/lstat checks prevent
 * a replaced path from being accepted as the file that was actually written.
 */
export function writeExclusiveRegularFileNoFollow(filePath, data, label = "temporary file") {
  const existing = lstatIfExists(filePath);
  if (existing) {
    throw new Error(`[${label}] path already exists: ${filePath}`);
  }

  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    noFollowFlag() |
    binaryFlag();
  let descriptor;
  let opened;
  let written;
  try {
    descriptor = fs.openSync(filePath, flags, 0o600);
    opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error(`[${label}] opened path is not a regular file: ${filePath}`);
    }
    const openedPath = assertRegularFile(filePath, label);
    assertSameFileIdentity(opened, openedPath, label, "while opening");
    fs.writeFileSync(descriptor, bytes);
    written = fs.fstatSync(descriptor);
    if (written.size !== bytes.length) {
      throw new Error(`[${label}] length changed during exclusive write: ${filePath}`);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  const current = assertRegularFile(filePath, label);
  assertSameFileIdentity(opened, current, label, "after exclusive write");
  if (written.size !== bytes.length || current.size !== bytes.length) {
    throw new Error(`[${label}] file changed during exclusive write: ${filePath}`);
  }
  const verified = captureRegularFile(filePath, `${label} verification`, fingerprintBuffer(bytes));
  return verified.stat;
}

/** Copy a source snapshot into an exclusively-created destination and re-read it. */
export function copyRegularFileNoFollow(sourcePath, destinationPath, label = "copy", expected = null) {
  const captured = captureRegularFile(sourcePath, `${label} source`, expected);
  const destinationStat = lstatIfExists(destinationPath);
  if (destinationStat) {
    if (isLinkLike(destinationPath, destinationStat)) {
      throw new Error(`[${label}] destination is a symlink or junction: ${destinationPath}`);
    }
    throw new Error(`[${label}] destination already exists: ${destinationPath}`);
  }
  writeExclusiveRegularFileNoFollow(destinationPath, captured.data, `${label} destination`);
  const copied = captureRegularFile(
    destinationPath,
    `${label} destination`,
    captured.fingerprint,
  );
  return {
    fingerprint: captured.fingerprint,
    mtimeMs: captured.mtimeMs,
    mtime: captured.mtime,
    sourceStat: captured.stat,
    destinationStat: copied.stat,
  };
}

/** Capture a source and write the exact bytes to a private regular-file snapshot. */
export function stageRegularFileSnapshot(
  sourcePath,
  stagingDir,
  label = "staging",
  expected = null,
  { name = null, retainData = true } = {},
) {
  const captured = captureRegularFile(sourcePath, `${label} source`, expected);
  const fileName = name ?? `snapshot-${process.pid}-${crypto.randomUUID()}.bin`;
  if (path.basename(fileName) !== fileName || fileName.length === 0) {
    throw new Error(`[${label}] invalid staging file name`);
  }
  const stagedPath = path.join(stagingDir, fileName);
  writeExclusiveRegularFileNoFollow(stagedPath, captured.data, `${label} staging`);
  const staged = captureRegularFile(stagedPath, `${label} staging`, captured.fingerprint);
  return {
    path: stagedPath,
    data: retainData ? staged.data : undefined,
    fingerprint: captured.fingerprint,
    mtimeMs: captured.mtimeMs,
    mtime: captured.mtime,
    stat: staged.stat,
  };
}

/** Exact two-way reconciliation for a snapshot map, including special property names. */
export function assertSnapshotMapsEqual(expected, actual, label = "snapshot") {
  const expectedPaths = Object.keys(expected).sort();
  const actualPaths = Object.keys(actual).sort();
  if (expectedPaths.join("\n") !== actualPaths.join("\n")) {
    throw new Error(`[${label}] file set differs from its verified snapshot`);
  }
  for (const relativePath of expectedPaths) {
    if (!Object.hasOwn(actual, relativePath)) {
      throw new Error(`[${label}] file is not present in its verified snapshot: ${relativePath}`);
    }
    const expectedRecord = expected[relativePath];
    const actualRecord = actual[relativePath];
    if (
      !expectedRecord ||
      !actualRecord ||
      actualRecord.size !== expectedRecord.size ||
      actualRecord.sha256 !== expectedRecord.sha256
    ) {
      throw new Error(`[${label}] file differs from its verified snapshot: ${relativePath}`);
    }
  }
}

/** Require every manifest record to be staged unless it is an explicit omission. */
export function assertManifestCoverage(recordMap, coveredFiles, allowedOmissions = [], label = "manifest") {
  const missing = Object.create(null);
  for (const relativePath of Object.keys(recordMap)) {
    if (Object.hasOwn(coveredFiles, relativePath)) continue;
    if (allowedOmissions.includes(relativePath)) continue;
    missing[relativePath] = recordMap[relativePath];
  }
  if (Object.keys(missing).length !== 0) {
    throw new Error(
      `[${label}] manifest files were not staged: ${Object.keys(missing).join(", ")}`,
    );
  }
}

/**
 * Re-key one manifest subtree (`cfg/`, `keys/`) by its path below the prefix.
 * The result is a null-prototype map so `Object.hasOwn` stays the only lookup.
 */
export function manifestSubtree(recordMap, prefix) {
  const subtree = Object.create(null);
  const fullPrefix = `${prefix}/`;
  for (const [relativePath, record] of Object.entries(recordMap ?? {})) {
    if (relativePath.startsWith(fullPrefix)) {
      subtree[relativePath.slice(fullPrefix.length)] = record;
    }
  }
  return subtree;
}

/**
 * Write a yazl-like object through an exclusively-created descriptor. The
 * readable is never handed a mutable source path and the descriptor is checked
 * before and after the stream closes.
 */
export async function writeZipToExclusiveFile(zipPath, zip, label = "archive") {
  const existing = lstatIfExists(zipPath);
  if (existing) {
    throw new Error(`[${label}] path already exists: ${zipPath}`);
  }
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    noFollowFlag() |
    binaryFlag();
  let descriptor;
  let output;
  try {
    descriptor = fs.openSync(zipPath, flags, 0o600);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error(`[${label}] opened path is not a regular file: ${zipPath}`);
    }
    const openedPath = assertRegularFile(zipPath, label);
    assertSameFileIdentity(opened, openedPath, label, "while opening");

    output = fs.createWriteStream(zipPath, { fd: descriptor, autoClose: false });
    const readable = zip.outputStream;
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try {
          readable.unpipe(output);
          output.destroy();
        } catch {
          // Preserve the stream error.
        }
        reject(error);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      readable.once("error", fail);
      output.once("error", fail);
      output.once("finish", succeed);
      readable.pipe(output);
      zip.end();
    });

    const written = fs.fstatSync(descriptor);
    assertSameFileIdentity(opened, written, label, "while writing");
    if (written.size === 0) throw new Error(`[${label}] is empty: ${zipPath}`);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const current = assertRegularFile(zipPath, label);
    assertStableFileStat(written, current, label, "after writing");
    if (current.size === 0) throw new Error(`[${label}] is empty: ${zipPath}`);
    return current;
  } catch (error) {
    if (output) {
      try {
        output.destroy();
      } catch {
        // Preserve the primary archive error.
      }
    }
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the primary archive error.
      }
    }
    throw error;
  }
}

/**
 * Return every env-like entry below a directory. Directories are returned as
 * one entry and are not traversed: the whole directory is forbidden anyway.
 */
export function findEnvLikeEntries(rootDir) {
  const rootStat = lstatIfExists(rootDir);
  if (!rootStat || isLinkLike(rootDir, rootStat) || !rootStat.isDirectory()) return [];

  const found = [];
  const visit = (currentDir, relativeBase = "") => {
    for (const name of readRealDirectoryNames(currentDir, "environment assets")) {
      const fullPath = path.join(currentDir, name);
      const stat = fs.lstatSync(fullPath);
      const linkLike = isLinkLike(fullPath, stat);
      const relativePath = relativeBase ? path.join(relativeBase, name) : name;
      const normalizedPath = toPosixPath(relativePath);

      if (isEnvLikeName(name)) {
        found.push({
          name,
          relativePath: normalizedPath,
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          isSymbolicLink: linkLike,
        });
        continue;
      }

      if (linkLike) {
        // Do not traverse. assertNoDisallowedEnvAssets rejects it separately.
        continue;
      }
      if (stat.isDirectory()) visit(fullPath, relativePath);
    }
  };

  visit(rootDir);
  const after = lstatIfExists(rootDir);
  if (!after || isLinkLike(rootDir, after) || !after.isDirectory()) {
    throw new Error(`[environment assets] directory changed while scanning: ${rootDir}`);
  }
  assertSameFileIdentity(rootStat, after, "environment assets", "while scanning");
  return found;
}

/**
 * Fail closed when a release tree contains a symlink/junction or an
 * environment-like basename. Only a regular file at the exact, case-sensitive
 * root path .env.example is accepted.
 */
export function assertNoDisallowedEnvAssets(
  rootDir,
  label = "release tree",
  { allowEnvExample = true } = {},
) {
  assertNoSymlinks(rootDir, label);
  const disallowed = findEnvLikeEntries(rootDir).filter(
    (entry) => !isAllowedEnvironmentEntry(entry.relativePath, entry, allowEnvExample),
  );
  if (disallowed.length) {
    const names = disallowed.map((entry) => entry.relativePath).join(", ");
    throw new Error(
      `[${label}] forbidden environment asset(s): ${names}; only the exact root ${ENV_EXAMPLE_NAME} is allowed`,
    );
  }
}


/**
 * Copy a tree without following symlinks and without copying any env-like
 * basename. Ordinary certificates and keys with non-env names are retained.
 */
export function copyTreeWithoutEnv(
  sourceDir,
  destinationDir,
  label = "copy",
  { expectedFiles = null, expectedPrefix = "" } = {},
) {
  const expectedTree = Object.create(null);
  if (expectedFiles) {
    const prefix = expectedPrefix ? `${expectedPrefix}/` : "";
    for (const [relativePath, record] of Object.entries(expectedFiles)) {
      if (!prefix || relativePath.startsWith(prefix)) {
        expectedTree[prefix ? relativePath.slice(prefix.length) : relativePath] = record;
      }
    }
  }

  const sourceStat = lstatIfExists(sourceDir);
  if (!sourceStat) {
    if (lstatIfExists(destinationDir)) {
      throw new Error(`[${label}] destination exists although source is missing`);
    }
    if (expectedFiles) assertSnapshotMapsEqual(expectedTree, {}, `${label} source`);
    return { copied: 0, skipped: [], files: Object.create(null) };
  }
  if (isLinkLike(sourceDir, sourceStat) || !sourceStat.isDirectory()) {
    throw new Error(`[${label}] source is not a real directory: ${sourceDir}`);
  }
  assertNoSymlinks(sourceDir, label);

  const destinationStat = lstatIfExists(destinationDir);
  if (destinationStat && isLinkLike(destinationDir, destinationStat)) {
    throw new Error(`[${label}] destination is a symlink or junction: ${destinationDir}`);
  }
  ensureRealDirectory(destinationDir, label);
  if (readRealDirectoryNames(destinationDir, label).length !== 0) {
    throw new Error(`[${label}] destination is not an empty private staging directory`);
  }

  const skipped = [];
  const files = Object.create(null);
  let copied = 0;
  const visit = (source, destination) => {
    for (const name of readRealDirectoryNames(source, label)) {
      const from = path.join(source, name);
      const to = path.join(destination, name);
      const stat = fs.lstatSync(from);
      const relativePath = toPosixPath(path.relative(sourceDir, from));

      if (isEnvLikeName(name)) {
        skipped.push(name);
        continue;
      }
      if (isLinkLike(from, stat)) {
        throw new Error(`[${label}] source symlink or junction is not allowed: ${from}`);
      }
      if (stat.isDirectory()) {
        ensureRealDirectory(to, label);
        visit(from, to);
      } else if (stat.isFile()) {
        ensureRealDirectory(path.dirname(to), label);
        const expected = expectedFiles
          ? expectedTree[relativePath]
          : null;
        if (expectedFiles && !Object.hasOwn(expectedTree, relativePath)) {
          throw new Error(`[${label}] source file is not recorded: ${relativePath}`);
        }
        const result = copyRegularFileNoFollow(from, to, label, expected);
        files[relativePath] = result.fingerprint;
        copied += 1;
      } else {
        throw new Error(`[${label}] unsupported non-regular source entry: ${from}`);
      }
    }
  };

  visit(sourceDir, destinationDir);
  if (expectedFiles) assertSnapshotMapsEqual(expectedTree, files, `${label} source`);
  if (skipped.length) {
    console.log(`[${label}] skipped environment entries: ${skipped.join(", ")}`);
  }
  return { copied, skipped, files };
}

function isReleaseOutputPath(relativePath) {
  const firstSegment = relativePath.split("/")[0];
  const lower = firstSegment.toLowerCase();
  return (
    lower === BUILD_MANIFEST_NAME.toLowerCase() ||
    BINARY_OUTPUTS.some((file) => file.toLowerCase() === lower) ||
    (lower.startsWith("proxy-v") && (lower.endsWith(".zip") || lower.includes(".zip.tmp")))
  );
}

function collectTreeFiles(
  rootDir,
  { allowRootEnvExample = false, excludeReleaseOutputs = false, label = "tree" } = {},
) {
  const rootStat = lstatIfExists(rootDir);
  if (!rootStat) return [];
  if (isLinkLike(rootDir, rootStat) || !rootStat.isDirectory()) {
    throw new Error(`[${label}] expected a real directory: ${rootDir}`);
  }
  assertNoSymlinks(rootDir, label);

  const files = [];
  const visit = (currentDir, relativeBase = "") => {
    for (const name of readRealDirectoryNames(currentDir, label)) {
      const fullPath = path.join(currentDir, name);
      const stat = fs.lstatSync(fullPath);
      const relativePath = relativeBase ? path.join(relativeBase, name) : name;
      const normalized = toPosixPath(relativePath);

      if (isEnvLikeName(name)) {
        const allowed =
          allowRootEnvExample &&
          relativeBase === "" &&
          name === ENV_EXAMPLE_NAME &&
          stat.isFile() &&
          !stat.isSymbolicLink();
        if (!allowed) {
          throw new Error(`[${label}] forbidden environment asset: ${normalized}`);
        }
      }
      if (isLinkLike(fullPath, stat)) {
        throw new Error(`[${label}] symlink or junction is not allowed: ${fullPath}`);
      }
      if (excludeReleaseOutputs && isReleaseOutputPath(normalized)) continue;
      if (stat.isDirectory()) {
        visit(fullPath, relativePath);
      } else if (stat.isFile()) {
        files.push(normalized);
      } else {
        throw new Error(`[${label}] unsupported non-regular entry: ${fullPath}`);
      }
    }
  };

  visit(rootDir);
  const after = lstatIfExists(rootDir);
  if (!after || isLinkLike(rootDir, after) || !after.isDirectory()) {
    throw new Error(`[${label}] tree changed while scanning: ${rootDir}`);
  }
  assertSameFileIdentity(rootStat, after, label, "while scanning");
  return files.sort();
}

export function collectRegularFiles(rootDir) {
  return collectTreeFiles(rootDir, {
    allowRootEnvExample: true,
    excludeReleaseOutputs: true,
    label: "release files",
  });
}

export function snapshotTree(
  rootDir,
  { allowRootEnvExample = false, label = "release snapshot" } = {},
) {
  const files = Object.create(null);
  for (const relativePath of collectTreeFiles(rootDir, {
    allowRootEnvExample,
    excludeReleaseOutputs: false,
    label,
  })) {
    files[relativePath] = fingerprintFile(path.join(rootDir, relativePath));
  }
  return files;
}

export function verifyTreeSnapshot(
  rootDir,
  expectedFiles,
  label = "tree snapshot",
  { allowRootEnvExample = false } = {},
) {
  const actualFiles = snapshotTree(rootDir, { allowRootEnvExample, label });
  const expectedPaths = Object.keys(expectedFiles).sort();
  const actualPaths = Object.keys(actualFiles).sort();
  if (expectedPaths.join("\n") !== actualPaths.join("\n")) {
    throw new Error(`[${label}] file set changed after snapshot`);
  }
  for (const relativePath of expectedPaths) {
    if (!hasRecorded(actualFiles, relativePath)) {
      throw new Error(`[${label}] file disappeared after snapshot: ${relativePath}`);
    }
    const expected = expectedFiles[relativePath];
    const actual = actualFiles[relativePath];
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(`[${label}] file changed after snapshot: ${relativePath}`);
    }
  }
}

export function createBuildManifest({ distDir, version, mode }) {
  assertNoDisallowedEnvAssets(distDir, "build manifest");
  const files = Object.create(null);
  for (const relativePath of collectRegularFiles(distDir)) {
    files[relativePath] = fingerprintFile(path.join(distDir, relativePath));
  }
  return {
    schema: 1,
    buildId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    version,
    mode,
    files,
  };
}

/**
 * Copy an own-property record map into a null-prototype object.
 *
 * Manifests arrive from JSON.parse, so `files` is a normal object: a plain
 * lookup such as `manifest.files["toString"]` returns the inherited
 * Object.prototype function and is truthy, which would let a dist file named
 * `toString` (or `constructor`, `__proto__`, ...) count as a recorded entry.
 * A null-prototype map makes every lookup an own-property lookup by
 * construction; `Object.hasOwn` is still used explicitly at the call sites.
 */
function toNullPrototypeRecordMap(source, label) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`[release] invalid ${label} file map`);
  }
  const copy = Object.create(null);
  for (const [relativePath, record] of Object.entries(source)) {
    Object.defineProperty(copy, relativePath, {
      value: record,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Exact own-property membership test. Never use a truthiness check such as
 * `if (map[key])` on a manifest record map.
 */
function hasRecorded(map, relativePath) {
  return Boolean(map) && typeof relativePath === "string" && Object.hasOwn(map, relativePath);
}

function validateFileRecords(files, label) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error(`[release] invalid ${label} file map`);
  }
  for (const [relativePath, record] of Object.entries(files)) {
    if (
      !isSafeRelativePath(relativePath) ||
      !record ||
      !Number.isInteger(record.size) ||
      record.size < 0 ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(record.sha256)
    ) {
      throw new Error(`[release] invalid file record in ${label}: ${relativePath}`);
    }
  }
}

function validateManifestShape(manifest) {
  if (
    !manifest ||
    manifest.schema !== 1 ||
    typeof manifest.buildId !== "string" ||
    manifest.buildId.length === 0 ||
    typeof manifest.version !== "string" ||
    typeof manifest.mode !== "string"
  ) {
    throw new Error("[release] invalid build manifest; run pnpm build first");
  }
  validateFileRecords(manifest.files, "build manifest");

  if (
    manifest.library !== undefined &&
    (!manifest.library ||
      manifest.library.root !== "lib" ||
      typeof manifest.library.recordedAt !== "string")
  ) {
    throw new Error("[release] invalid library artifact section in build manifest");
  }
  if (manifest.library !== undefined) {
    validateFileRecords(manifest.library.files, "library manifest");
  }

  if (
    manifest.macosSignature !== undefined &&
    (!manifest.macosSignature ||
      manifest.macosSignature.file !== "proxy-macos" ||
      manifest.macosSignature.verified !== true ||
      !["codesign", "ldid"].includes(manifest.macosSignature.verifier) ||
      typeof manifest.macosSignature.verifiedAt !== "string")
  ) {
    throw new Error("[release] invalid macOS signature record in build manifest");
  }

  // Normalize every record map to a null prototype so downstream lookups can
  // never resolve an inherited Object.prototype member as a recorded file.
  const normalized = { ...manifest, files: toNullPrototypeRecordMap(manifest.files, "build manifest") };
  if (manifest.library !== undefined) {
    normalized.library = {
      ...manifest.library,
      files: toNullPrototypeRecordMap(manifest.library.files, "library manifest"),
    };
  }
  if (manifest.binaries !== undefined) {
    if (!manifest.binaries || typeof manifest.binaries !== "object" || Array.isArray(manifest.binaries)) {
      throw new Error("[release] invalid binary artifact section in build manifest");
    }
    normalized.binaries = toNullPrototypeRecordMap(manifest.binaries, "binary");
  }
  return normalized;
}

export function readBuildManifest(distDir) {
  const manifestPath = path.join(distDir, BUILD_MANIFEST_NAME);
  if (!lstatIfExists(manifestPath)) {
    throw new Error(
      `[release] build manifest not found: ${manifestPath}; run pnpm build:all first`,
    );
  }
  let parsed;
  try {
    const captured = captureRegularFile(manifestPath, "build manifest");
    parsed = JSON.parse(captured.data.toString("utf8"));
  } catch (error) {
    throw new Error(
      `[release] cannot read build manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateManifestShape(parsed);
}

function removePathNoFollow(filePath) {
  const stat = lstatIfExists(filePath);
  if (!stat) return;
  if (isLinkLike(filePath, stat) || !stat.isDirectory()) {
    fs.unlinkSync(filePath);
    return;
  }
  fs.rmSync(filePath, { recursive: true, force: true });
}

export function writeBuildManifest(distDir, manifest) {
  const normalized = validateManifestShape(manifest);
  // Fail closed before writing: the manifest must land in the real dist tree,
  // never in a junction or a symlinked directory.
  const distBefore = ensureRealDirectory(distDir, "build manifest directory");
  const manifestPath = path.join(distDir, BUILD_MANIFEST_NAME);
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  const expected = fingerprintBuffer(Buffer.from(serialized));
  let primaryError;
  let primaryFailed = false;
  try {
    writeExclusiveRegularFileNoFollow(
      temporaryPath,
      serialized,
      "release temporary manifest",
    );
    const distAfterWrite = ensureRealDirectory(distDir, "build manifest directory");
    assertSameFileIdentity(distBefore, distAfterWrite, "build manifest directory", "while writing");
    removePathNoFollow(manifestPath);
    const distBeforeRename = ensureRealDirectory(distDir, "build manifest directory");
    assertSameFileIdentity(distBefore, distBeforeRename, "build manifest directory", "before rename");
    fs.renameSync(temporaryPath, manifestPath);
    const distAfterRename = ensureRealDirectory(distDir, "build manifest directory");
    assertSameFileIdentity(distBefore, distAfterRename, "build manifest directory", "after rename");
    const written = captureRegularFile(manifestPath, "build manifest", expected);
    if (
      written.fingerprint.size !== expected.size ||
      written.fingerprint.sha256 !== expected.sha256
    ) {
      throw new Error("[release] build manifest bytes changed after atomic write");
    }
  } catch (error) {
    primaryError = error;
    primaryFailed = true;
  }

  let cleanupError;
  let cleanupFailed = false;
  try {
    removePathNoFollow(temporaryPath);
  } catch (error) {
    cleanupError = error;
    cleanupFailed = true;
  }

  if (primaryFailed) {
    if (cleanupFailed) {
      console.error(`[release] temporary manifest cleanup failed: ${String(cleanupError)}`);
    }
    throw primaryError;
  }
  if (cleanupFailed) throw cleanupError;
}

export function removeBuildManifest(distDir) {
  const distStat = lstatIfExists(distDir);
  if (!distStat) return;
  if (isLinkLike(distDir, distStat) || !distStat.isDirectory()) {
    throw new Error(`[release] dist is not a real directory: ${distDir}`);
  }

  const errors = [];
  const exact = BUILD_MANIFEST_NAME.toLowerCase();
  for (const name of readRealDirectoryNames(distDir, "build manifest cleanup")) {
    const lower = name.toLowerCase();
    if (lower !== exact && !lower.startsWith(`${exact}.tmp`)) continue;
    try {
      removePathNoFollow(path.join(distDir, name));
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "[release] failed to remove one or more build manifests");
  }
}

/**
 * Verify both directions: every current source file belongs to the recorded
 * build, and every recorded file still has the recorded bytes. Known release
 * outputs are excluded because build-pkg records those separately.
 */
export function verifyBuildManifestFiles(distDir, manifest, requiredFiles = []) {
  const normalized = validateManifestShape(manifest);
  assertNoDisallowedEnvAssets(distDir, "build batch");
  for (const requiredFile of requiredFiles) {
    if (!hasRecorded(normalized.files, requiredFile)) {
      throw new Error(`[release] build manifest is missing required file: ${requiredFile}`);
    }
  }

  const currentFiles = collectRegularFiles(distDir);
  for (const relativePath of currentFiles) {
    if (!hasRecorded(normalized.files, relativePath)) {
      throw new Error(
        `[release] unrecorded file in build batch: ${relativePath}; rebuild before packaging`,
      );
    }
  }

  for (const [relativePath, expected] of Object.entries(normalized.files)) {
    if (!isSafeRelativePath(relativePath)) {
      throw new Error(`[release] unsafe path in build manifest: ${relativePath}`);
    }
    const actual = fingerprintFile(path.join(distDir, relativePath));
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(
        `[release] build batch file changed after build: ${relativePath}; rebuild before packaging`,
      );
    }
  }
}

export function attachLibraryArtifacts(libDir, manifest) {
  const files = snapshotTree(libDir, {
    allowRootEnvExample: false,
    label: "library build",
  });
  for (const required of ["index.js", "index.d.ts"]) {
    if (!hasRecorded(files, required)) {
      throw new Error(`[release] required library artifact is missing: lib/${required}`);
    }
  }
  return {
    ...manifest,
    library: {
      root: "lib",
      recordedAt: new Date().toISOString(),
      files,
    },
  };
}

export function verifyLibraryArtifacts(
  libDir,
  manifest,
  requiredFiles = ["index.js", "index.d.ts"],
) {
  const normalized = validateManifestShape(manifest);
  if (!normalized.library) {
    throw new Error(
      "[release] build manifest has no recorded library artifacts; run pnpm build:pkg",
    );
  }
  verifyTreeSnapshot(libDir, normalized.library.files, "library build");
  for (const requiredFile of requiredFiles) {
    if (!hasRecorded(normalized.library.files, requiredFile)) {
      throw new Error(`[release] library manifest is missing required file: ${requiredFile}`);
    }
    assertRegularFile(path.join(libDir, requiredFile), "library artifact");
  }
}

function providedBinarySnapshot(snapshots, file) {
  if (snapshots instanceof Map) return snapshots.get(file) ?? null;
  if (snapshots && typeof snapshots === "object" && Object.hasOwn(snapshots, file)) {
    return snapshots[file];
  }
  return null;
}

export function attachBinaryArtifacts(distDir, manifest, targets, metadata = {}, snapshots = null) {
  const binaries = Object.create(null);
  for (const { file, target } of targets) {
    const provided = providedBinarySnapshot(snapshots, file);
    const captured = provided ?? captureRegularFile(path.join(distDir, file), `pkg binary ${file}`);
    const fingerprint = captured.fingerprint;
    const mtimeMs = captured.mtimeMs ?? captured.stat?.mtimeMs;
    if (!Number.isFinite(mtimeMs)) {
      throw new Error(`[release] binary snapshot has no stable mtime: ${file}`);
    }
    binaries[file] = {
      ...fingerprint,
      mtimeMs,
      target,
      buildId: manifest.buildId,
    };
  }
  return {
    ...manifest,
    ...metadata,
    binaries,
    pkgCompletedAt: new Date().toISOString(),
  };
}

export function verifyBinaryArtifacts(distDir, manifest, targets) {
  if (!manifest.binaries || typeof manifest.binaries !== "object") {
    throw new Error("[release] build manifest has no completed pkg batch; run build-pkg first");
  }
  const recordedBinaries = toNullPrototypeRecordMap(manifest.binaries, "binary");
  const macTarget = targets.find(
    ({ platform, file }) => platform === "darwin" || platform === "macos" || file === "proxy-macos",
  );
  if (
    macTarget &&
    (!manifest.macosSignature ||
      manifest.macosSignature.file !== macTarget.file ||
      manifest.macosSignature.verified !== true)
  ) {
    throw new Error("[release] macOS x64 binary has no verified signature record");
  }

  for (const { file, target } of targets) {
    if (!hasRecorded(recordedBinaries, file)) {
      throw new Error(`[release] binary is not recorded for this build batch: ${file}`);
    }
    const expected = recordedBinaries[file];
    if (expected.target !== target || expected.buildId !== manifest.buildId) {
      throw new Error(`[release] binary is not recorded for this build batch: ${file}`);
    }
    const actual = captureRegularFile(path.join(distDir, file), `release binary ${file}`);
    if (
      actual.fingerprint.size !== expected.size ||
      actual.fingerprint.sha256 !== expected.sha256 ||
      actual.mtimeMs !== expected.mtimeMs
    ) {
      throw new Error(
        `[release] binary changed after build-pkg: ${file}; rebuild before packaging`,
      );
    }
  }
}

function commandAvailable(command) {
  const result = spawnSync(command, command === "codesign" ? ["--help"] : ["-h"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 3000,
    windowsHide: true,
  });
  return !result.error || result.error.code !== "ENOENT";
}

export function assertMacSignatureVerifierAvailable() {
  if (commandAvailable("codesign") || commandAvailable("ldid")) return;
  throw new Error(
    `[release] cannot verify macOS x64 signature on ${process.platform}: neither codesign nor ldid is available; refusing to register an unverified binary`,
  );
}

function verifyMacOSSignaturePath(filePath) {
  const failures = [];

  if (commandAvailable("codesign")) {
    const result = spawnSync(
      "codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", filePath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true,
      },
    );
    if (!result.error && result.status === 0) return "codesign";
    const detail =
      result.error?.message || result.stderr || result.stdout || `exit ${result.status}`;
    failures.push(`codesign: ${String(detail).trim()}`);
  }

  if (commandAvailable("ldid")) {
    const result = spawnSync("ldid", ["-h", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (
      !result.error &&
      result.status === 0 &&
      /\b(CodeDirectory|CDHash|SHA-?256|signature information)\b/i.test(output)
    ) {
      return "ldid";
    }
    const detail = result.error?.message || output.trim() || `exit ${result.status}`;
    failures.push(`ldid: ${String(detail).trim()}`);
  }

  const suffix = failures.length ? `; ${failures.join("; ")}` : "";
  throw new Error(
    `[release] macOS x64 signature verification failed for ${filePath} on ${process.platform}${suffix}; refusing to register an unsigned or invalid binary`,
  );
}

/**
 * Verify the already-captured private staging path while retaining its fd.
 * The same descriptor and bytes are re-fingerprinted immediately before and
 * after the external verifier, so a mutable dist path can never be substituted
 * between signature validation and manifest/archive registration.
 */
export function verifyMacOSSignatureSnapshot(snapshot, label = snapshot?.filePath ?? "macOS binary") {
  const before = revalidateRegularFileSnapshot(snapshot, label);
  const verifier = verifyMacOSSignaturePath(before.filePath);
  const after = revalidateRegularFileSnapshot(before, label);
  if (
    after.fingerprint.size !== before.fingerprint.size ||
    after.fingerprint.sha256 !== before.fingerprint.sha256
  ) {
    throw new Error(`[${label}] macOS binary changed while verifying its signature`);
  }
  return { verifier, snapshot: after };
}

/** Path-compatible wrapper; release callers should pass a private snapshot. */
export function verifyMacOSSignature(filePath, label = "macOS binary") {
  const snapshot = openRegularFileSnapshot(filePath, label);
  let verified;
  try {
    verified = verifyMacOSSignatureSnapshot(snapshot, label);
    return verified.verifier;
  } finally {
    closeRegularFileSnapshot(verified?.snapshot ?? snapshot);
  }
}

function isArchiveOrTemporaryArchive(name) {
  const lower = name.toLowerCase();
  return lower.startsWith("proxy-v") && (lower.endsWith(".zip") || lower.includes(".zip.tmp"));
}

function cleanupError(label, errors) {
  const details = errors
    .map((error) => (error instanceof Error ? (error.stack ?? error.message) : String(error)))
    .join("\n");
  return new AggregateError(errors, `[release] ${label} failed:\n${details}`);
}

export function cleanReleaseArchives(distDir) {
  const distStat = lstatIfExists(distDir);
  if (!distStat) return;
  if (isLinkLike(distDir, distStat) || !distStat.isDirectory()) {
    throw new Error(`[release] dist is not a real directory: ${distDir}`);
  }

  const errors = [];
  for (const name of readRealDirectoryNames(distDir, "archive cleanup")) {
    if (!isArchiveOrTemporaryArchive(name)) continue;
    try {
      removePathNoFollow(path.join(distDir, name));
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw cleanupError("archive cleanup", errors);
}

/**
 * Remove everything a finished release owns: binaries, archives, and the build
 * manifest.
 *
 * `keepManifest` exists for the in-run reset of `build-pkg`: it must drop stale
 * binaries and archives so they cannot be mistaken for this batch's output, but
 * the verified build manifest is a *product* of `pnpm build` / `build:lib`, not
 * of build-pkg. Deleting it there would destroy a verified batch (and the
 * registered `lib/`) on any pkg failure.
 */
export function removeReleaseArtifacts(distDir, { keepManifest = false } = {}) {
  const existing = lstatIfExists(distDir);
  if (existing && (isLinkLike(distDir, existing) || !existing.isDirectory())) {
    throw new Error(`[release] dist is not a real directory: ${distDir}`);
  }
  ensureRealDirectory(distDir, "release cleanup");

  const errors = [];
  const binaryNames = new Set(BINARY_OUTPUTS.map((name) => name.toLowerCase()));
  let entries = [];
  try {
    entries = readRealDirectoryNames(distDir, "release cleanup");
  } catch (error) {
    errors.push(error);
  }
  for (const name of entries) {
    if (!binaryNames.has(name.toLowerCase())) continue;
    try {
      removePathNoFollow(path.join(distDir, name));
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    cleanReleaseArchives(distDir);
  } catch (error) {
    errors.push(error);
  }
  if (!keepManifest) {
    try {
      removeBuildManifest(distDir);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length) throw cleanupError("release cleanup", errors);
}
