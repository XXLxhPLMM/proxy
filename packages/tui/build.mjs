process.env.ESBUILD_WORKER_THREADS = "0";
/**
 * TUI 包的构建：自己的入口、自己的 esbuild 调用、自己的 `dist/`
 *
 * @description
 * ## 依赖内联（bundle）是**默认**：冷启动省 ~1.26s
 * 实测（`process.uptime()` 打到 stderr）本包启动分两段：import 阶段 ≈1.46s、插件树装载 ≈0.48s。
 * 那 1.46s 几乎全是 Node 逐个 parse/load pnpm 虚拟目录里的几百个 ESM 文件（ink / react /
 * react-reconciler / cordis / drizzle…），不是业务代码。`packages: "external"` 会把它们全留在
 * `node_modules` 由 Node 逐个加载；改成内联后 Node 只需 parse **一个** 756KB 文件，import 阶段
 * 降到 ≈0.20s（**快 7 倍**），插件树那段不变。代价：产物 21KB → 756KB（本包 `private: true`，
 * 只服务仓库内的开发与端到端验证，不分发，这个体积无所谓）。
 * ⚠️ 想要回退到 external（例如排查「某个依赖没被 bundle 进来」）：`pnpm build:ext`。
 *
 * ## 内联要补的三处（都不是可选项，少一处直接崩或静默降级）
 * 1. **banner 注入 `createRequire` / `__filename` / `__dirname`**：CJS 依赖（drizzle 等）源码里的
 *    `require("assert")` 之类被 esbuild 转成动态 require，而 ESM 产物里没有 `require`，不注入
 *    就在加载期抛 `Dynamic require of "assert" is not supported`。
 * 2. **alias 顶掉 ink 的 DEV-only devtools 路径**：`ink/build/reconciler.js` 顶层
 *    `await import('./devtools.js')`，而 `devtools.js` 静态 import `ws` 与 peer 依赖
 *    `react-devtools-core`（后者本包没装）。esbuild 会把这条动态 import 提成静态 import ⇒ 不 stub
 *    就构建失败或运行期 `ERR_MODULE_NOT_FOUND`。这条路径只在 `process.env.DEV === 'true'` 才真正
 *    干活（`ink` 的 `injectIntoDevTools()` 门控），stub 掉不影响正常渲染。
 * 3. **复制降级档的 `.wasm` 二进制到 `dist/`**：`node-sqlite3-wasm` 的胶水层 JS 能内联，
 *    但 1.2MB 的 `.wasm` **二进制 esbuild 内联不了**。emscripten 用 `__dirname` 定位它，而
 *    `__dirname` 由第 1 点的 banner 注入（= dist 目录）⇒ 复制到产物旁边即可。
 *    ⚠️ 漏了这步**不会构建失败**：走 builtin 档（Node≥22.13）一切正常，只有降级档在
 *    `WebAssembly.instantiate` 处报读不到 wasm——静默变成「旧 Node 上功能缺失」，故特别容易漏。
 *
 * ## `format: "esm"` 是**硬要求**
 * `ink` 的 `build/reconciler.js` 有一句**顶层 await**（`await import('./devtools.js')`）。
 * esbuild 的 `cjs` 输出格式**表达不了顶层 await**，实测直接构建失败：
 * `Top-level await is currently not supported with the "cjs" output format`。
 * 故本包的产物只能是 ESM，而根包 `"type": "commonjs"` 装不下它 —— 两个包分开的**技术**理由
 * 就在这一句（依赖面与分发形态那两条理由写在根 `AGENTS.md`）。
 * ⚠️ 反过来说：**TypeScript 侧没有任何障碍**，被卡住的是输出格式，不是语言。
 *
 * ## 为什么走 esbuild 而不是 `tsc`
 * `tsc` 要出 `.js` 就得逐文件保留目录，而 `src/cli.ts` 的 shebang 与 `package.json` 的
 * `bin` 目标必须逐字对上，多一层 tsc 产物映射就多一处能漂的地方。esbuild 一次调用出一个
 * 文件，`bin` 指向它，中间没有第二张表。
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, "dist");
const entry = path.join(here, "src", "cli.ts");
const out = path.join(distDir, "cli.js");

const isDev = process.argv.includes("--dev");
const isWatch = process.argv.includes("--watch");
// 回退通道：怀疑「某个依赖没被 bundle 进来」时用它对比（理由见文件头）
const useExternal = process.argv.includes("--external");

/**
 * 写 DEV-only 那条路径的 stub（见文件头第 2 点）：ink 的 devtools 静态 import 两个我们不带的东西
 * —— `ws` 与 peer 依赖 `react-devtools-core`。`ws` 只用来填 `globalThis.WebSocket`，stub 成空类即可。
 */
function writeDevStubs() {
  const dir = path.join(here, ".build-stub");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "react-devtools-core.mjs"),
    "export default { initialize() {}, connectToDevTools() {} };\n",
  );
  fs.writeFileSync(path.join(dir, "ws.mjs"), "export default class {};\n");
  return dir;
}

/** 打一次（watch 模式由外层反复调它） */
async function buildOnce(label) {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const stubDir = writeDevStubs();
  const { default: esbuild } = await import("esbuild");
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    // external 档：依赖全留给 Node 逐个加载（冷启动 ≈1.46s）。见文件头，排查时才用。
    packages: useExternal ? "external" : undefined,
    platform: "node",
    // ⚠️ 硬要求：ink 有顶层 await，cjs 输出格式表达不了（见文件头）
    format: "esm",
    target: "node22",
    jsx: "automatic",
    minify: !isDev,
    sourcemap: isDev,
    // ⚠️ 必须与根包 build.mjs 同一条纪律：产物是 npm bin 目标，缺 shebang 等于装上就 `Bad interpreter`
    // ⚠️ 另：内联档必须注入 require / __filename / __dirname，否则 CJS 依赖的动态 require 直接崩（见文件头）
    banner: {
      js: [
        "#!/usr/bin/env node",
        "import { createRequire as __probeCreateRequire } from 'node:module';",
        "import { fileURLToPath as __probeFileUrlToPath } from 'node:url';",
        "import { dirname as __probeDirname } from 'node:path';",
        "const require = __probeCreateRequire(import.meta.url);",
        "const __filename = __probeFileUrlToPath(import.meta.url);",
        "const __dirname = __probeDirname(__filename);",
      ].join("\n"),
    },
    alias: {
      "@": path.join(here, "src"),
      "react-devtools-core": path.join(stubDir, "react-devtools-core.mjs"),
      ws: path.join(stubDir, "ws.mjs"),
    },
    define: { "process.env.APP_VERSION": JSON.stringify(readVersion()) },
    logLevel: "info",
  });
  fs.rmSync(path.join(distDir, "node-sqlite3-wasm.wasm"), { force: true });
  if (!useExternal) {
    // 降级档的 `.wasm` 二进制 esbuild 内联不了（见文件头第 3 点），复制到产物旁边；
    // emscripten 用 `__dirname` 定位它，而 `__dirname` 由 banner 注入（= dist 目录）。
    copyWasmBinary();
  }
  fs.rmSync(stubDir, { recursive: true, force: true });
  console.log(`[tui:build] ${label} -> dist/cli.js (${useExternal ? "external" : "bundled"})`);
}

/** 复制降级档的 `.wasm` 二进制到 dist/（内联档才需要；external 档由 node_modules 自己提供） */
function copyWasmBinary() {
  // ⚠️ 本文件是 ESM，没有 `require.resolve`；用 createRequire 从本包解析（依赖在 devDependencies 里）
  const require = createRequire(import.meta.url);
  const src = require.resolve("node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm");
  fs.copyFileSync(src, path.join(distDir, "node-sqlite3-wasm.wasm"));
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
