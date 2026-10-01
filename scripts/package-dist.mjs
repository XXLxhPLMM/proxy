import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yazl from "yazl";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const distDir = path.join(root, "dist");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

/** 本次没装进 zip 的二进制（收齐了最后一次性抛，见文件末尾） */
const missing = [];

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
// **平台 / 入口 / 文件名三样全在 `./pkg-binaries.mjs`**（与 `build-pkg.mjs` 同源），
// 这里只负责「把哪些文件装进哪个 zip」。⚠️ 别在这里另写一份名字表：构建侧改了名而这一侧还在
// 找旧名，两者会**同时**绿，而发行物少一个入口 —— `zip-contents.test.ts` 的收敛档专钉这个。
import { BINARY_ZIPS, BINARIES } from "./pkg-binaries.mjs";

for (const { os, label } of BINARY_ZIPS) {
  const wanted = BINARIES.filter((b) => b.os === os);
  const zip = new yazl.ZipFile();
  let packed = 0;
  for (const { file } of wanted) {
    const full = path.join(distDir, file);
    // 二进制缺失**不静默**：zip 少一个可执行文件，用户下载后才发现，且发布日志里若只有 warn
    // 就会被忽略过去。故攒起来，最后一次性以非零码退出。
    if (!fs.existsSync(full)) {
      console.error(`[package] 缺 ${file}：${label} 这个 zip 装不齐（跑 build-pkg 看它的报错）`);
      missing.push(`${label}/${file}`);
      continue;
    }
    zip.addFile(full, file, { mode: 0o755 });
    packed += 1;
  }
  if (packed === 0) {
    console.error(`[package] skip ${label}: 一个二进制都没有`);
    continue;
  }
  addCommonAssets(zip);
  addReadme(zip, "binary");

  const outFile = path.join(distDir, `proxy-v${version}-${label}.zip`);
  await zipWrite(outFile, zip);
  const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`[package] ${path.basename(outFile)} (${size} MB, ${packed} 个二进制)`);
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

/**
 * Node 包这一侧的另外两个入口（sqlite 的 WASM 驱动由 `addWasmDriver` 统一带上）
 *
 * @description
 * **控制面 `manager.js` 在这条通道里，而不在二进制 zip 里**，理由是布局死结而不是定位取舍：
 * manager 的唯一职责是 spawn 并监管子进程，而它 spawn 的是 `process.execPath` + **一个
 * `app.js` 路径**（`src/manager/supervisor.ts:418`），且 `resolveAppJsPath()` 的四个候选
 * **全是 `app.js`、没有一个是 exe**（同文件 `:217-223`）。故：
 * - Node zip：`manager.js` 与 `app.js` 同级 ⇒ 第一个候选即命中 ⇒ 实测可起（监听 + spawn 子进程）。
 * - 二进制 zip：只有 exe、**没有 `app.js`** ⇒ 塞进去必然抛「找不到被监管的代理入口 dist/app.js」，
 *   即给用户一个**启动即失败**的东西。
 *
 * ⚠️ 三条通道里 `bin` 的三个入口应当**全部可得**：npm tarball（`files` 白名单，被
 * `pack-contents.test.ts` 反向断言钉住）、Node zip（本文件）、二进制 zip（**故意只有两个**，
 * 见 `pkg-binaries.mjs`）。缺一个入口在一条通道上，下载 zip 与 npm 用户的能力就不同 ——
 * 那正是「两处对不上」的最小形态。
 */
const ADMIN_CLI_FILE = "proxy-cli.js";
const MANAGER_FILE = "manager.js";

for (const { file, label } of nodeTargets) {
  const srcFile = path.join(distDir, file);
  if (!fs.existsSync(srcFile)) {
    console.error(`[package] skip ${label}: ${file} not found`);
    continue;
  }

  const zip = new yazl.ZipFile();
  zip.addFile(srcFile, "app.js");
  // 这两个入口缺失不该让整个 zip 消失（那是一次构建问题升级成「这个版本没得发」），
  // 但**必须**被说出来 —— 静默少一个入口 = 用户解压后才发现命令不存在，而发布日志里一句都没有。
  for (const optional of [ADMIN_CLI_FILE, MANAGER_FILE]) {
    const src = path.join(distDir, optional);
    if (fs.existsSync(src)) {
      zip.addFile(src, optional);
    } else {
      console.warn(`[package] WARN 缺 ${optional}：该 zip 没有这个入口`);
    }
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

// ⚠️ **「缺二进制」必须以非零码收场**（这条与 `build-pkg.mjs` 那条同源，是它曾经的反面）：
// 缺文件时只打一行 warn 就 `[package] done` + 退 0，等于把「这个平台的可执行文件没打出来」
// 说成「发布成功」—— 产物少 3/5，而发布日志里满屏 done、CI 不跑测试、zip 护栏在零产物时
// `skipIf` 降级。三道本该拦住它的机制**同时**失效，这就是那条 warn 敢存在的原因。
if (missing.length > 0) {
  console.error(
    `[package] 失败：${missing.length} 个二进制没装进任何 zip —— ${missing.join(", ")}`,
  );
  console.error("[package] 发行物不完整。先修 build-pkg 的报错，别把这一版发出去。");
  process.exit(1);
}

console.log("[package] done");
