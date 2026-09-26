process.env.ESBUILD_WORKER_THREADS = "0";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execSync, spawnSync } from "child_process";
import {
  assertNoDisallowedEnvAssets,
  assertNoSymlinks,
  assertRegularFile,
  captureRegularFile,
  copyRegularFileNoFollow,
  copyTreeWithoutEnv,
  createBuildManifest,
  ensureRealDirectory,
  isEnvLikeName,
  isLinkLikePath,
  readRealDirectoryNames,
  statRegularFileNoFollow,
  writeBuildManifest,
  writeExclusiveRegularFileNoFollow,
} from "./scripts/release-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageSnapshot = captureRegularFile(
  path.join(__dirname, "package.json"),
  "build project package",
);
const pkg = JSON.parse(packageSnapshot.data.toString("utf8"));

const isWatch = process.argv.includes("--watch");
const isDev = process.argv.includes("--dev");
const isProd = !isWatch && !isDev;
const buildMode = isWatch ? "watch" : isProd ? "production" : "development";

const buildBase = {
  entryPoints: [path.join(__dirname, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  minify: isProd,
  sourcemap: !isProd,
  banner: {
    js: "#!/usr/bin/env node",
  },
  alias: {
    "@": path.join(__dirname, "src"),
  },
  define: {
    "process.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  logLevel: "info",
};

// ── 防抖：delay 毫秒内重复调用只执行最后一次 ──
function debounce(fn, delay = 300) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
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

function readWatchMtimeNoFollow(filePath) {
  const stat = lstatIfExists(filePath);
  if (!stat) return 0;
  if (isLinkLikePath(filePath, stat) || !stat.isFile()) {
    throw new Error(`[build] watch output is not a regular file: ${filePath}`);
  }
  return statRegularFileNoFollow(filePath, "watch output").mtimeMs;
}

if (isWatch) {
  // Keep the watch target present before the first one-shot child starts.
  // mkdir -p would happily follow an existing dist symlink/junction and let
  // every watch artifact land outside the tree, so the directory is verified
  // (and created without following links) before anything writes into it.
  ensureRealDirectory(path.join(__dirname, "dist"), "watch dist");
  // watch 常驻进程绝不加载 esbuild 原生模块：实测 Windows + Node22 下 esbuild
  // 进程退出时偶发 STATUS_STACK_BUFFER_OVERRUN 3221226505（构建产物已落盘照样崩，
  // 连 process.exit(0) 都保不住），会把 watcher 一起带走且零输出。
  // 采用“一次性子进程构建”：每次变化起一个 `node build.mjs` 做完即走，
  // 子进程崩了只是一行日志，watcher 本体不受影响。
  const script = path.join(__dirname, "build.mjs");
  const outFile = path.join(__dirname, "dist", "app.js");

  const runBuild = (reason) => {
    const t0 = Date.now();
    console.log(`[build] build started (${reason})...`);
    const before = readWatchMtimeNoFollow(outFile);
    // Watch builds are development artifacts; never let their manifest become
    // a release batch for a later standalone build-pkg invocation.
    const childArgs = [script, "--dev"];
    const r = spawnSync(process.execPath, childArgs, {
      cwd: __dirname,
      stdio: "inherit",
    });
    const cost = Date.now() - t0;
    const after = readWatchMtimeNoFollow(outFile);
    if (r.status === 0) {
      console.log(`[build] build finished in ${cost}ms`);
      return true;
    }
    // 子进程原生崩溃（3221226505）但产物已落盘：当成功处理，dev-server 照常重启
    if (after > before) {
      console.log(
        `[build] build finished in ${cost}ms (child exited code:${r.status}, dist updated)`,
      );
      return true;
    }
    console.error(`[build] build failed (code:${r.status ?? r.signal}), dist unchanged`);
    return false;
  };

  const schedule = debounce((reason) => {
    if (!runBuild(reason)) {
      console.log("[build] retrying once...");
      runBuild(`retry after ${reason}`);
    }
  });

  const srcDir = path.join(__dirname, "src");
  const watcher = fs.watch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (!/\.(ts|tsx|js|jsx|json)$/.test(filename)) return;
    // banner.ts 是构建时自动生成的，监听它会无限自激
    if (filename.endsWith("banner.ts")) return;
    schedule(filename);
  });

  console.log("[build] watch: src -> dist/app.js (fs.watch + one-shot child per change)");
  schedule("initial");

  const shutdown = () => {
    watcher.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // JS 层报错直接打出来（原生崩溃抓不到，但能排除法定位到人）
  process.on("uncaughtException", (err) => {
    console.error("[build] uncaughtException:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[build] unhandledRejection:", reason);
  });
} else {
  // A build owns the whole dist tree. Clearing it first prevents old env
  // files, binaries, source maps, and archives from surviving a failed build.
  const distDir = path.join(__dirname, "dist");
  const existingDist = lstatIfExists(distDir);
  if (existingDist) {
    if (isLinkLikePath(distDir, existingDist)) {
      throw new Error(`[build] dist is a symlink or junction: ${distDir}`);
    }
    if (!existingDist.isDirectory()) {
      removePathNoFollow(distDir);
    } else {
      assertNoSymlinks(distDir, "existing dist");
      for (const entry of readRealDirectoryNames(distDir, "existing dist")) {
        removePathNoFollow(path.join(distDir, entry));
      }
    }
  }
  ensureRealDirectory(distDir, "build dist");

  // ── 构建前：自动生成 banner.ts ──
  console.log("[build] generating banner...");
  execSync(
    `node scripts/gen-banner.mjs --title "SWAIN" --subtitle "THE BEST PROXY SERVER" --name "${pkg.name}" --version "${pkg.version}" --output src/server/banner.ts --no-preview`,
    { cwd: __dirname, stdio: "inherit" },
  );

  // esbuild 只在这里动态加载，常驻 watcher 进程永远碰不到原生模块
  const { default: esbuild } = await import("esbuild");

  // ── 多目标构建：仅生成与 package engines 一致的 Node >=22.6 产物 ──
  // app.js 是源码构建/CLI 默认入口；app-v22.js 是发布归档的明确 node22 入口。
  const targets = [
    { target: "node22", outFile: "app.js" },
    { target: "node22", outFile: "app-v22.js" },
  ];
  for (const { target, outFile } of targets) {
    await esbuild.build({
      ...buildBase,
      target,
      outfile: path.join(__dirname, "dist", outFile),
    });
    console.log(`[build] ${outFile} (target=${target})`);
  }

  // 旧版本曾生成虚假的 Node 16 产物；构建时主动清理，避免残留文件被误发布。
  for (const stale of ["app-v16.js", "app-v16.js.map"]) {
    const stalePath = path.join(__dirname, "dist", stale);
    if (lstatIfExists(stalePath)) {
      fs.unlinkSync(stalePath);
      console.log(`[build] removed unsupported ${stale}`);
    }
  }

  // ── 生产构建：清理残留的 source map ──
  if (isProd) {
    for (const f of ["app.js", "app-v22.js"]) {
      const mapFile = path.join(__dirname, "dist", `${f}.map`);
      if (lstatIfExists(mapFile)) {
        fs.unlinkSync(mapFile);
        console.log(`[build] removed stale ${f}.map (production build)`);
      }
    }
  }

  // ── 拷贝静态资源到 dist（便于部署/打包） ──
  // The dist directory was recreated above; keep this recursive guard for
  // callers that add generated files between build phases. It must assert,
  // never clean: a build refuses to continue on a link or a stray env file
  // instead of silently deleting a tree it does not own.
  assertNoDisallowedEnvAssets(distDir, "build");

  /** 需要拷贝到 dist 的文件列表：不存在则跳过，避免构建失败 */
  const assets = [".env.example", "README.md", "package.json"];

  for (const file of assets) {
    const src = path.join(__dirname, file);
    const dest = path.join(distDir, path.basename(file));
    const srcStat = lstatIfExists(src);
    if (!srcStat) continue;
    assertRegularFile(src, `build ${file} source`);
    copyRegularFileNoFollow(src, dest, `build ${file}`);
    console.log(`[build] copy ${file} -> dist/${path.basename(file)}`);
  }

  // 拷贝 keys 证书目录（https/tls 自签名所需，store 默认 keys/server.* / ca.crt）
  const keysSrc = path.join(__dirname, "keys");
  const keysDest = path.join(distDir, "keys");
  const keysStat = lstatIfExists(keysSrc);
  if (keysStat) {
    if (isLinkLikePath(keysSrc, keysStat) || !keysStat.isDirectory()) {
      throw new Error(`[build] keys source is not a real directory: ${keysSrc}`);
    }
    assertNoSymlinks(keysSrc, "build keys source");
    removePathNoFollow(keysDest);
    const result = copyTreeWithoutEnv(keysSrc, keysDest, "build keys");
    console.log(`[build] copy keys/ -> dist/keys/ (${result.copied} files)`);
  }

  // 拷贝 cfg 配置目录（store 默认 <配置目录>/cfg/users.json 与 cfg/acl.json）。
  // 只拷 *.example 模板：真实的 users.json / acl.json 含密码与名单，绝不能进构建产物
  const cfgSrc = path.join(__dirname, "cfg");
  const cfgStat = lstatIfExists(cfgSrc);
  if (cfgStat) {
    if (isLinkLikePath(cfgSrc, cfgStat) || !cfgStat.isDirectory()) {
      throw new Error(`[build] cfg source is not a real directory: ${cfgSrc}`);
    }
    assertNoDisallowedEnvAssets(cfgSrc, "build cfg source", { allowEnvExample: false });
    assertNoSymlinks(cfgSrc, "build cfg source");
    const cfgDest = path.join(distDir, "cfg");
    removePathNoFollow(cfgDest);
    ensureRealDirectory(cfgDest, "build cfg destination");
    for (const f of readRealDirectoryNames(cfgSrc, "build cfg source")) {
      if (isEnvLikeName(f)) {
        throw new Error(`[build] forbidden environment asset in cfg/: ${f}`);
      }
      if (!f.endsWith(".example")) continue;
      const source = path.join(cfgSrc, f);
      assertRegularFile(source, `build cfg/${f} source`);
      copyRegularFileNoFollow(source, path.join(cfgDest, f), `build cfg/${f}`);
      console.log(`[build] copy cfg/${f} -> dist/cfg/${f}`);
    }
    // 空 users.json / acl.json：避免首次启动因账号表为空而 abort
    const usersFile = path.join(cfgDest, "users.json");
    if (!lstatIfExists(usersFile)) {
      writeExclusiveRegularFileNoFollow(usersFile, "[]\n", "build cfg/users.json");
      console.log("[build] create cfg/users.json (empty)");
    }
    const aclFile = path.join(cfgDest, "acl.json");
    if (!lstatIfExists(aclFile)) {
      writeExclusiveRegularFileNoFollow(
        aclFile,
        JSON.stringify(
          { clientIp: { whitelist: [], blacklist: [] }, target: { whitelist: [], blacklist: [] } },
          null,
          2,
        ) + "\n",
        "build cfg/acl.json",
      );
      console.log("[build] create cfg/acl.json (empty)");
    }
  }

  // The manifest is the handoff between build, pkg, and archive creation.
  // It is written only after every source/asset copy and recursive env check
  // has completed, so a failed build cannot leave a packageable batch.
  assertNoDisallowedEnvAssets(distDir, "build");
  const manifest = createBuildManifest({
    distDir,
    version: pkg.version,
    mode: buildMode,
  });
  writeBuildManifest(distDir, manifest);
  console.log(`[build] recorded ${buildMode} batch ${manifest.buildId}`);

  // NOTE: Windows + Node22 + esbuild 退出时偶发 3221226505，原生层崩溃拦不住；
  // 但走到这里构建产物已全部落盘，调用方（watcher）只看退出码 + dist mtime。
  process.exit(0);
}
