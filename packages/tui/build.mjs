process.env.ESBUILD_WORKER_THREADS = "0";
/**
 * TUI 包的构建：自己的入口、自己的 esbuild 调用、自己的 `dist/`
 *
 * @description
 * ## `format: "esm"` 是**硬要求**（唯一一条）
 * `ink` 的 `build/reconciler.js` 有一句**顶层 await**（`await import('./devtools.js')`）。
 * esbuild 的 `cjs` 输出格式**表达不了顶层 await**，实测直接构建失败：
 * `Top-level await is currently not supported with the "cjs" output format`。
 * 故本包的产物只能是 ESM，而根包 `"type": "commonjs"` 装不下它 —— 两个包分开的**技术**理由
 * 就在这一句（依赖面与分发形态那两条理由写在根 `AGENTS.md`）。
 * ⚠️ 反过来说：**TypeScript 侧没有任何障碍**，被卡住的是输出格式，不是语言。
 *
 * ## `packages: "external"` 是**选择**，不是要求
 * ⚠️ 别把它当成「Ink 不能 bundle」的硬结论 —— 实测**能** bundle 成单文件（`format: "esm"`
 * 下 1.77MB，正常）。选 `external` 的理由只有一条：bundle 会把 `ink` 的 peer 依赖
 * `react-devtools-core` 变成**产物的运行期依赖**（它被 ink 在顶层 await 里 import，而
 * esbuild 会把它从动态 import 提成静态 external import），而那是个只在 `process.env.DEV`
 * 下才真正干活的包。本包 `private: true`、产物只服务仓库内的开发与端到端验证，第三方留在
 * `node_modules` 是更简的形态。
 *
 * ## 为什么走 esbuild 而不是 `tsc`
 * `tsc` 要出 `.js` 就得逐文件保留目录，而 `src/cli.tsx` 的 shebang 与 `package.json` 的
 * `bin` 目标必须逐字对上，多一层 tsc 产物映射就多一处能漂的地方。esbuild 一次调用出一个
 * 文件，`bin` 指向它，中间没有第二张表。
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, "dist");
const entry = path.join(here, "src", "cli.tsx");
const out = path.join(distDir, "cli.js");

const isDev = process.argv.includes("--dev");
const isWatch = process.argv.includes("--watch");

/** 打一次（watch 模式由外层反复调它） */
async function buildOnce(label) {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const { default: esbuild } = await import("esbuild");
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    // 见文件头：选 external 是为了不让 react-devtools-core 变成产物的运行期依赖
    packages: "external",
    platform: "node",
    // ⚠️ 硬要求：ink 有顶层 await，cjs 输出格式表达不了（见文件头）
    format: "esm",
    target: "node22",
    jsx: "automatic",
    minify: !isDev,
    sourcemap: isDev,
    // ⚠️ 必须与根包 build.mjs 同一条纪律：产物是 npm bin 目标，缺 shebang 等于装上就 `Bad interpreter`
    banner: { js: "#!/usr/bin/env node" },
    alias: { "@": path.join(here, "src") },
    define: { "process.env.APP_VERSION": JSON.stringify(readVersion()) },
    logLevel: "info",
  });
  console.log(`[tui:build] ${label} -> dist/cli.js`);
}

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8")).version;
}

if (isWatch) {
  // watch 常驻进程绝不加载 esbuild 原生模块（与根 build.mjs 同理由：Windows 上 Node 22 退出时
  // 偶发 STATUS_STACK_BUFFER_OVERFLOW，会把 watcher 一起带走且零输出）。用一次性子进程。
  let timer = null;
  const run = (label) => {
    try {
      execFileSync(process.execPath, [path.join(here, "build.mjs"), ...(isDev ? ["--dev"] : [])], {
        stdio: "inherit",
      });
    } catch {
      console.error("[tui:build] 构建失败（watcher 继续等下一次变更）");
    }
  };
  for (const dir of ["src"]) {
    fs.watch(path.join(here, dir), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => run(dir), 200);
    });
  }
  run("initial");
  console.log("[tui:build] watch src/ ...");
} else {
  await buildOnce("build");
}
