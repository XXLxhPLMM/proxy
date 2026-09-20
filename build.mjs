process.env.ESBUILD_WORKER_THREADS = "0";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execSync, spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

const isWatch = process.argv.includes("--watch");
const isDev = process.argv.includes("--dev");
const isProd = !isWatch && !isDev;

const buildOptions = {
  entryPoints: [path.join(__dirname, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(__dirname, "dist/app.js"),
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

if (isWatch) {
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
    const before = fs.existsSync(outFile) ? fs.statSync(outFile).mtimeMs : 0;
    const childArgs = [script];
    if (isDev) childArgs.push("--dev");
    const r = spawnSync(process.execPath, childArgs, {
      cwd: __dirname,
      stdio: "inherit",
    });
    const cost = Date.now() - t0;
    const after = fs.existsSync(outFile) ? fs.statSync(outFile).mtimeMs : 0;
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
  // ── 构建前：自动生成 banner.ts ──
  console.log("[build] generating banner...");
  execSync(
    `node scripts/gen-banner.mjs --title "SWAIN" --subtitle "PROXY" --name "${pkg.name}" --version "${pkg.version}" --output src/utils/banner.ts --no-preview`,
    { cwd: __dirname, stdio: "inherit" },
  );

  // esbuild 只在这里动态加载，常驻 watcher 进程永远碰不到原生模块
  const { default: esbuild } = await import("esbuild");
  await esbuild.build(buildOptions);

  // ── 生产构建：清理残留的 source map ──
  if (isProd) {
    const mapFile = path.join(__dirname, "dist", "app.js.map");
    if (fs.existsSync(mapFile)) {
      fs.unlinkSync(mapFile);
      console.log("[build] removed stale app.js.map (production build)");
    }
  }

  // ── 拷贝静态资源到 dist（便于部署/打包） ──
  const distDir = path.join(__dirname, "dist");
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

  /** 需要拷贝到 dist 的文件列表：不存在则跳过，避免构建失败 */
  const assets = [
    ".env.example", // 环境变量示例，部署时作为模板参考
    "README.md", // 说明文档
    "package.json", // 版本信息（pkg 需要）
  ];

  for (const file of assets) {
    const src = path.join(__dirname, file);
    const dest = path.join(distDir, path.basename(file));
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`[build] copy ${file} -> dist/${path.basename(file)}`);
    }
  }

  // 可选：拷贝 .env.* 模板（若存在）
  for (const f of fs.readdirSync(__dirname)) {
    if (/^\.env\.(development|production|local|example)$/.test(f)) {
      const src = path.join(__dirname, f);
      const dest = path.join(distDir, f);
      if (src !== dest && fs.existsSync(src) && !fs.existsSync(dest)) {
        // 已在上一步处理 .env.example，避免重复
        if (f === ".env.example") continue;
        fs.copyFileSync(src, dest);
        console.log(`[build] copy ${f} -> dist/${f}`);
      }
    }
  }

  // 拷贝 keys 证书目录（https/tls 自签名所需，store 默认 keys/server.* / ca.crt）
  const keysSrc = path.join(__dirname, "keys");
  const keysDest = path.join(distDir, "keys");
  if (fs.existsSync(keysSrc)) {
    fs.cpSync(keysSrc, keysDest, { recursive: true });
    console.log(`[build] copy keys/ -> dist/keys/`);
  }

  // 拷贝 cfg 配置目录（store 默认 <配置目录>/cfg/users.json 与 cfg/acl.json）。
  // 只拷 *.example 模板：真实的 users.json / acl.json 含密码与名单，绝不能进构建产物
  const cfgSrc = path.join(__dirname, "cfg");
  if (fs.existsSync(cfgSrc)) {
    const cfgDest = path.join(distDir, "cfg");
    fs.mkdirSync(cfgDest, { recursive: true });
    for (const f of fs.readdirSync(cfgSrc)) {
      if (!f.endsWith(".example")) continue;
      fs.copyFileSync(path.join(cfgSrc, f), path.join(cfgDest, f));
      console.log(`[build] copy cfg/${f} -> dist/cfg/${f}`);
    }
  }

  // NOTE: Windows + Node22 + esbuild 退出时偶发 3221226505，原生层崩溃拦不住；
  // 但走到这里构建产物已全部落盘，调用方（watcher）只看退出码 + dist mtime。
  process.exit(0);
}
