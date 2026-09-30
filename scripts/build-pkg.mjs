/**
 * 二进制打包脚本：只构建 node22 x64 三平台
 * pkg 不带 --target 时输出带平台后缀（proxy-win.exe / proxy-linux / proxy-macos）
 *
 * ## 为什么二进制只有 node22（别去试 node16，会浪费半小时）
 * 实测：点名 `-t node16-win-x64`，pkg 6.22 会打「Not found in remote cache」，
 * 然后**自动退化成从源码编译 Node.js**（拉 nodejs.org 源码、装 NASM、跑几小时），
 * 在没装 NASM 的机器上以 `ENOENT ... nodeoutRelease
ode.exe` 收场。
 * pkg-fetch 的 expected-shas.json 里确实列着 node-v16.20.2-*，但**远程镜像里没有**
 * 这些预编译二进制了（清单是陈的）。故 node16 只能走 app.js 那个 zip，见 package-dist.mjs。
 *
 * 另：两套 Node 也会撞名 —— pkg 不带 -o 时只按平台命名（proxy-win.exe），
 * node16 与 node22 的 win 产物同名。所以「一个脚本出两套二进制」这条路本身也走不通。
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// 临时修改 package.json 的 pkg.targets，构建后恢复
function withPkgTargets(targets, fn) {
  const pkgPath = path.join(root, "package.json");
  const original = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(original);
  pkg.pkg.targets = targets;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  try {
    fn();
  } finally {
    fs.writeFileSync(pkgPath, original);
  }
}

function runPkg() {
  const pkgCmd = path.join(root, "node_modules", ".bin", "pkg.cmd");
  execSync(`"${pkgCmd}" . --out-path dist`, { cwd: root, stdio: "inherit" });
}

// ── node22 x64 ──
console.log("[build-pkg] building node22...");
try {
  withPkgTargets(["node22-win-x64", "node22-linux-x64", "node22-darwin-x64"], () => {
    runPkg();
  });
  console.log("[build-pkg] node22 done");
} catch (e) {
  console.warn(`[build-pkg] node22 build failed: ${e.message}`);
}

console.log("[build-pkg] done");
