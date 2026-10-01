/**
 * 二进制打包：每个（平台 × 入口）单独跑一次 pkg，产物名由 `--output` 显式钉死
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
 *
 * ## ⚠️ 失败**必须响**（这条曾经被反向实现过）
 *
 * 这里原先有一个 `try { runPkg() } catch { console.warn(...) }`：pkg 每次都因为
 * `Config items must be strings` 抛错，而那个 catch 把它降级成一行 warn，脚本随后打印
 * `[build-pkg] done` 并**以 0 退出**。于是 `build:pkg` = `a && b && c` 里那个 `b` 永远「成功」，
 * `package-dist.mjs` 接着发现三个二进制一个都没有（它对缺失是 `continue` + warn，见那份文件
 * 的可选分支），只打出两个 Node 包，最后满屏 `done` 而**发行物少了 3/5**。
 *
 * 更糟的是它**绿得毫无破绽**：`zip-contents.test.ts` 在 `dist/` 下零个 zip 时是 `skipIf` 降级的，
 * CI 又不跑测试（`.cnb.yml` 只做 Docker build + push）—— 于是一条「二进制从来没构建成功过」的
 * 流水线，靠一行 warn 就完整地发布了出去。
 *
 * 故这里的纪律是**产物导向**：不信 pkg 的退出码，信**文件在不在**。跑完逐个 `existsSync` 核对，
 * 少一个就以非零码退出并点名是哪个。理由与 `build.mjs` 那条 Windows 已知现象的处理同源 ——
 * 「进程说成功」不如「产物在那儿」可信。⚠️ 这条核对验过：让 pkg 退 0 但不产文件，它照样退 1。
 *
 * ## 为什么不改 `package.json` 的 `pkg.targets` 再改回来
 * 旧实现是 `withPkgTargets()`：临时把 `pkg.targets` 写成三个、跑 pkg、再还原。它既没解决问题
 * （真正的原因是 `pkg.scripts` 非法），又给构建过程开了个**改仓库文件的窗口**——中途崩了就留下
 * 一个脏 `package.json`。现在 target 由命令行给，`package.json` 整个不碰（`pkg` 块已删，
 * 理由见 `./pkg-binaries.mjs` 的文件头）。
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { BINARIES } from "./pkg-binaries.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

/**
 * 跑一次 pkg
 * @description
 * 用 `execFileSync`（参数数组）而不是 `execSync`（拼串）：目标名与文件名都来自本仓的表，
 * 但参数拼串那条路会让一个空格变成两个参数 —— 而「文件名里有个空格」的失败形态是
 * *静默产出另一个名字*，正是本文件要消灭的那一类。
 */
function runPkg(entry, target, output) {
  const pkgBin = path.join(root, "node_modules", ".bin", "pkg.cmd");
  execFileSync(pkgBin, [entry, "--target", target, "--output", path.join(root, "dist", output)], {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
}

const missing = [];

for (const { target, entry, file } of BINARIES) {
  console.log(`[build-pkg] ${file}  <-  ${entry} @ ${target}`);
  runPkg(entry, target, file);
  // 产物导向的核对：pkg 的退出码不作数（见文件头「失败必须响」）
  if (!fs.existsSync(path.join(root, "dist", file))) {
    missing.push(file);
  }
}

if (missing.length > 0) {
  console.error(
    `[build-pkg] 失败：${missing.length}/${BINARIES.length} 个二进制没产出 —— ${missing.join(", ")}`,
  );
  console.error("[build-pkg] 发行 zip 会因此少掉对应的平台包。修好上面那行 pkg 的报错，别让流程继续。");
  // 刻意**非零退出**：`build:pkg` 是 `a && b && c`，这里退 0 就等于替下游的 package-dist.mjs
  // 把「二进制不存在」这件事说成「这次没这个平台」。
  process.exit(1);
}

console.log(`[build-pkg] done —— ${BINARIES.length} 个二进制全部产出`);