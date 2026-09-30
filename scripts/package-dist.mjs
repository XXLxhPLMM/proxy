import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yazl from "yazl";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const distDir = path.join(root, "dist");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

// 清理旧 zip
for (const f of fs.readdirSync(distDir)) {
  if (f.startsWith("proxy-v") && f.endsWith(".zip")) {
    fs.unlinkSync(path.join(distDir, f));
  }
}

function addDir(zip, dirPath, zipBase) {
  for (const f of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      addDir(zip, full, path.join(zipBase, f));
    } else {
      zip.addFile(full, path.join(zipBase, f));
    }
  }
}

function zipWrite(zipFile, zip) {
  return new Promise((resolve, reject) => {
    zip.end();
    zip.outputStream.pipe(fs.createWriteStream(zipFile));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("close", resolve);
  });
}

function addCommonAssets(zip) {

  // .env.example
  const envExample = path.join(distDir, ".env.example");
  if (fs.existsSync(envExample)) zip.addFile(envExample, ".env.example");

  // cfg/ — .example 模板
  const cfgDir = path.join(distDir, "cfg");
  if (fs.existsSync(cfgDir)) {
    for (const f of fs.readdirSync(cfgDir)) {
      if (f.endsWith(".example")) {
        zip.addFile(path.join(cfgDir, f), path.join("cfg", f));
      }
    }
  }

  // cfg/users.json — 空数组，避免首次启动 abort
  zip.addBuffer(Buffer.from("[]\n"), "cfg/users.json");

  // cfg/acl.json — 空名单结构，不拦截任何请求
  zip.addBuffer(
    Buffer.from(JSON.stringify({ clientIp: { whitelist: [], blacklist: [] }, target: { whitelist: [], blacklist: [] } }, null, 2) + "\n"),
    "cfg/acl.json",
  );

  // keys/
  const keysDir = path.join(distDir, "keys");
  if (fs.existsSync(keysDir)) addDir(zip, keysDir, "keys");
}

/**
 * 把 `node-sqlite3-wasm` 整包塞进 zip —— **只给 Node.js 包（app.js 那个）用**。
 * @description
 * ## 为什么二进制包不需要
 * 二进制走 pkg 快照：`package.json` 的 `dependencies` 由 pkg 自动打进快照，
 * 且 node22 内置档压根不碰 WASM。所以往 23MB 的二进制包里塞 1.3MB 是纯浪费。
 *
 * ## 为什么非带不可（少一个文件都不行）
 * `app.js` 里是 `createRequire(__filename)("node-sqlite3-wasm")` —— esbuild 打不进 bundle，
 * 运行时从 node_modules 解析。**只拷 `build.mjs` 放到 dist/ 的那份 `.wasm` 是不够的**：
 * `require` 解析的是 **JS 模块**，模块内部再按**自己的 `__dirname`** 去找 `dist/*.wasm`。
 *
 * 少带时的失败形态（本仓实测，日志原文）：
 * `Cannot find module 'node-sqlite3-wasm'` → 账本 open 抛错 →
 * `[usage-write-error]` 事件 + **内存计数继续、持久化静默丢失**。
 * 危险之处不在于报错，而在于**不重启就看不出问题**：用户以为配额在持久化，
 * 哪天重启一次配额清零。
 */
function addWasmDriver(zip) {
  const pkgDir = path.join(root, "node_modules", "node-sqlite3-wasm");
  if (!fs.existsSync(pkgDir)) {
    console.error("[package] WARN 缺 node_modules/node-sqlite3-wasm：Node 16/18/20 运行时账本会失效");
    return;
  }
  // pnpm 下这里是**指向 store 的符号链接**，realpath 一次让 zip 里的条目是真实文件
  addDir(zip, fs.realpathSync(pkgDir), path.join("node_modules", "node-sqlite3-wasm"));
}

function addReadme(zip, type) {
  const readmeDir = path.join(root, "readme");
  // 中英文 README
  const zhReadme = path.join(readmeDir, "README.zh-CN.md");
  const enReadme = path.join(readmeDir, "README.en.md");
  if (fs.existsSync(zhReadme)) zip.addFile(zhReadme, "README.zh-CN.md");
  if (fs.existsSync(enReadme)) zip.addFile(enReadme, "README.en.md");
  // 中英文使用指南
  const zhUsage = path.join(readmeDir, "usage", `${type}.zh-CN.md`);
  const enUsage = path.join(readmeDir, "usage", `${type}.en.md`);
  if (fs.existsSync(zhUsage)) zip.addFile(zhUsage, "USAGE.zh-CN.md");
  if (fs.existsSync(enUsage)) zip.addFile(enUsage, "USAGE.en.md");
}

// ── 二进制包：只出 node22 x64 ──
//
// 两个入口各出一个二进制（`proxy` 起服务 / `proxy-cli` 管数据），名字由 package.json 的
// `pkg.scripts[].name` 钉死 —— **不钉的话** pkg 会按入口文件名重新推导，`dist/app.js`
// 会被改名成 `proxy-app-win.exe`，而下游下载页与 `zip-contents.test.ts` 都指着旧名。
const binaryMap = [
  { os: "win", file: "proxy-win.exe", zipBin: "proxy-win.exe", cli: "proxy-cli-win.exe" },
  { os: "linux", file: "proxy-linux", zipBin: "proxy-linux", cli: "proxy-cli-linux" },
  { os: "macos", file: "proxy-macos", zipBin: "proxy-macos", cli: "proxy-cli-macos" },
];

for (const { os, file, zipBin, cli } of binaryMap) {
  const binPath = path.join(distDir, file);
  if (!fs.existsSync(binPath)) {
    continue;
  }

  const zip = new yazl.ZipFile();
  zip.addFile(binPath, zipBin, { mode: 0o755 });
  // 管理 CLI 的二进制是**可选**的：它没构建出来时只打服务那一个并在日志里说清，
  // 而不是让整个发布产物消失（那是一次 pkg 缓存问题升级成「这个版本没得发」）。
  const cliPath = path.join(distDir, cli);
  if (fs.existsSync(cliPath)) {
    zip.addFile(cliPath, cli, { mode: 0o755 });
  } else {
    console.warn(`[package] WARN 缺 ${cli}：该 zip 只有服务端二进制，没有管理 CLI`);
  }
  addCommonAssets(zip);
  addReadme(zip, "binary");

  const outFile = path.join(distDir, `proxy-v${version}-${os}-x64.zip`);
  await zipWrite(outFile, zip);
  const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`[package] ${path.basename(outFile)} (${size} MB)`);
}

// ── Node.js 包：app.js 在 Node 16 与 Node 22 上都验过能跑，故出两套标签 ──
//
// 为什么是「同一个 app.js 打两个标签」而不是两套产物：
//   - **二进制做不到**。pkg 6.22 的远程 cache 里没有 node16 的预编译基础二进制，
//     点名 node16-win-x64 会退化成「从源码编译 Node.js」（要 NASM + 数小时，实测直接失败）。
//     所以 pkg.targets 只能是 node22，那是**工具链的上限**，不是本项目的选择。
//   - 而 app.js 本身与 Node 版本无关：esbuild 产物在 Node 16 上 `--check` 通过，
//     16/18/20 走 WASM 档、22.13+ 走内置档，分流判据是 require 得不得到 node:sqlite。
//     同一份字节在两个区间都能跑，标签的作用是告诉用户「这份包在哪些 Node 上验过」。
const nodeTargets = [
  { file: "app.js", label: "node16" },
  { file: "app.js", label: "node22" },
];

/** 管理 CLI 的入口文件（Node 包这一侧只有它；sqlite 的 WASM 驱动由 addWasmDriver 统一带上） */
const ADMIN_CLI_FILE = "proxy-cli.js";

for (const { file, label } of nodeTargets) {
  const srcFile = path.join(distDir, file);
  if (!fs.existsSync(srcFile)) {
    console.error(`[package] skip ${label}: ${file} not found`);
    continue;
  }

  const zip = new yazl.ZipFile();
  zip.addFile(srcFile, "app.js");
  const adminFile = path.join(distDir, ADMIN_CLI_FILE);
  if (fs.existsSync(adminFile)) {
    zip.addFile(adminFile, ADMIN_CLI_FILE);
  } else {
    // 同 binaryMap 那条：管理 CLI 缺失不该让整个 zip 消失，但它**必须**被说出来 ——
    // 静默少一个入口 = 用户 npm i 之后发现命令不存在，而发布日志里一句都没有。
    console.warn(`[package] WARN 缺 ${ADMIN_CLI_FILE}：该 zip 只有服务端入口，没有管理 CLI`);
  }
  addWasmDriver(zip);

  const minimalPkg = JSON.stringify({ name: pkg.name, version }, null, 2);
  zip.addBuffer(Buffer.from(minimalPkg + "\n"), "package.json");

  addCommonAssets(zip);
  addReadme(zip, "node");

  const outFile = path.join(distDir, `proxy-v${version}-${label}.zip`);
  await zipWrite(outFile, zip);
  const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`[package] ${path.basename(outFile)} (${size} MB)`);
}

console.log("[package] done");
