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
const binaryMap = [
  { os: "win", file: "proxy-win.exe", zipBin: "proxy-win.exe" },
  { os: "linux", file: "proxy-linux", zipBin: "proxy-linux" },
  { os: "macos", file: "proxy-macos", zipBin: "proxy-macos" },
];

for (const { os, file, zipBin } of binaryMap) {
  const binPath = path.join(distDir, file);
  if (!fs.existsSync(binPath)) {
    continue;
  }

  const zip = new yazl.ZipFile();
  zip.addFile(binPath, zipBin, { mode: 0o755 });
  addCommonAssets(zip);
  addReadme(zip, "binary");

  const outFile = path.join(distDir, `proxy-v${version}-${os}-x64.zip`);
  await zipWrite(outFile, zip);
  const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`[package] ${path.basename(outFile)} (${size} MB)`);
}

// ── Node.js 包：按版本分开，内部统一叫 app.js ──
const nodeTargets = [
  { file: "app-v16.js", label: "node16" },
  { file: "app-v22.js", label: "node22" },
];

for (const { file, label } of nodeTargets) {
  const srcFile = path.join(distDir, file);
  if (!fs.existsSync(srcFile)) {
    console.error(`[package] skip ${label}: ${file} not found`);
    continue;
  }

  const zip = new yazl.ZipFile();
  zip.addFile(srcFile, "app.js");

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
