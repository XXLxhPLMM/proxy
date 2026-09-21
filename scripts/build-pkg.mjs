/**
 * 二进制打包脚本：只构建 node22 x64 三平台
 * pkg 不带 --target 时输出带平台后缀（proxy-win.exe / proxy-linux / proxy-macos）
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
