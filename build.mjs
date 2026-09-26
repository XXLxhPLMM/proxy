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

const distDir = path.join(__dirname, "dist");

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
  // ── 构建第一步：无条件清空 dist/ ──
  // dist/ 必须是「每次构建清空重建」而不是「只进不出的抽屉」：任何「先构建、后往 dist/ 里
  // 放东西」的顺序若被原样保留（跑过服务留下的 log/*.jsonl、手动拷的证书、旧拷贝循环留下
  // 的 .env.production），而 package.json 的 files 白名单又把整个 dist/ 扫进 npm 包，
  // 明文上游凭证就是这么发出去的。
  // `!fs.existsSync` 这类守卫在这里是**反向**的：它保住的恰恰是不该存在的那一份。
  // 写法与 scripts/clean-lib.mjs 一致；清不掉就让它抛 —— 构建失败远好过产出一份脏产物。
  fs.rmSync(distDir, { recursive: true, force: true });

  // ── 构建前：自动生成 banner.ts ──
  console.log("[build] generating banner...");
  execSync(
    `node scripts/gen-banner.mjs --title "SWAIN" --subtitle "THE BEST PROXY SERVER" --name "${pkg.name}" --version "${pkg.version}" --output src/server/banner.ts --no-preview`,
    { cwd: __dirname, stdio: "inherit" },
  );

  // esbuild 只在这里动态加载，常驻 watcher 进程永远碰不到原生模块
  const { default: esbuild } = await import("esbuild");

  // 唯一受支持目标：Node 22。dist/ 已在上面清空，故不存在多目标残留可清。
  const targets = [{ target: "node22", outFile: "app.js" }];
  for (const { target, outFile } of targets) {
    await esbuild.build({
      ...buildBase,
      target,
      outfile: path.join(distDir, outFile),
    });
    console.log(`[build] ${outFile} (target=${target})`);
  }

  // ── 拷贝静态资源到 dist（面向 standalone 分发：zip / 直接以 dist/ 为 cwd 跑 app.js）──
  // 逐个显式列出，**没有通配、没有目录递归**：dist/ 里出现什么由这张表说了算，
  // 不是「目录里有什么就带走什么」。
  /** 需要拷贝到 dist 的文件列表：不存在则跳过，避免构建失败 */
  const assets = [
    ".env.example", // 环境变量示例：standalone zip 的根、pkg 资产的模板来源
    // ⚠️ 刻意**不再**拷 README.md / package.json 进 dist/：
    // ① 两者都没有消费者 —— `pkg.assets` 的路径相对**包根**（跑 `pkg .` 的 cwd），
    //    `scripts/package-dist.mjs` 打进 zip 的 package.json 是它自己 addBuffer 的最小
    //    那份、README 取自 `readme/` 目录，两处都不读 dist/ 里的副本；
    // ② README 会被 npm **强制包含**（npm-packlist 对任意深度的 readme 都收，
    //    与 `files` 白名单和 .npmignore 都无关）—— 只要 dist/ 里有一份，tarball 里
    //    就多一份 30KB 的重复文档，删都删不掉。
  ];

  for (const file of assets) {
    const src = path.join(__dirname, file);
    const dest = path.join(distDir, path.basename(file));
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`[build] copy ${file} -> dist/${path.basename(file)}`);
    }
  }

  // ⚠️ **`.env.*` 只有上面 `assets` 里那一个 `.env.example` 进产物**，其余是开发者本机状态、
  // 永不拷贝：仓库根的 `.env.production` 含**明文上游凭证**，而 files 白名单扫整个 dist/，
  // 一份这样的文件就会随 tarball 出去（v5.1.3 真发生过）。**别改成 `readdirSync` 扫 `.env.*`
  // 再逐个拷**——带 `!fs.existsSync(dest)` 守卫时，根目录那份被清空之后，dist/ 里那份旧凭证
  // 会因为「已存在」而永不刷新、永不删除。

  // 拷贝 keys 证书目录（https/sockss4/sockss5 入站自签所需；TLS_KEY/TLS_CERT 的缺省是
  // `keys/server.key` / `keys/server.crt`，按 configDir 相对解析）。
  // 消费方只有两处：① `scripts/package-dist.mjs` 打的 standalone zip 从 dist/ 取；② 以
  // dist/ 为 cwd 直接 `node app.js` 的场景。
  // **npm 消费者不该拿到这批开发用自签私钥** —— package.json 的 files 白名单不收
  // dist/keys，要跑 https 入站的部署必须自备证书（路径见 .env.example 的 TLS_KEY/TLS_CERT）。
  // ⚠️ 仓库的 keys/*.key 是**故意被 git 跟踪**的测试 PKI（clone 完 `cp` 一下就能跑
  // https/sockss5 入站），别 `git rm --cached` 掉；真正的纪律是 package.json 的 files
  // 白名单**不收** dist/keys。
  const keysSrc = path.join(__dirname, "keys");
  const keysDest = path.join(distDir, "keys");
  if (fs.existsSync(keysSrc)) {
    fs.cpSync(keysSrc, keysDest, { recursive: true });
    console.log("[build] copy keys/ -> dist/keys/");
  }

  // 拷贝 cfg 配置目录（store 默认 <配置目录>/cfg/users.json 与 cfg/acl.json）。
  // 只拷 *.example 模板：真实的 users.json / acl.json 含密码与名单，绝不能进构建产物。
  const cfgSrc = path.join(__dirname, "cfg");
  if (fs.existsSync(cfgSrc)) {
    const cfgDest = path.join(distDir, "cfg");
    fs.mkdirSync(cfgDest, { recursive: true });
    for (const f of fs.readdirSync(cfgSrc)) {
      if (!f.endsWith(".example")) continue;
      fs.copyFileSync(path.join(cfgSrc, f), path.join(cfgDest, f));
      console.log(`[build] copy cfg/${f} -> dist/cfg/${f}`);
    }
    // 空骨架，避免首次启动因账号表为空而 abort。
    // ⚠️ 这里**刻意不用 `!fs.existsSync` 守卫**：那个守卫保住的恰恰是它要防的那件事 ——
    // 上一轮构建留下的**真实** cfg/users.json / cfg/acl.json（含开发者密码与名单）会因为
    // 「已存在」被原样留下，再经 `files` 白名单原封不动进 npm 包。骨架是每次构建重建的
    // **派生物**，不是「没有就补一份」的可留存量。
    const usersFile = path.join(cfgDest, "users.json");
    fs.writeFileSync(usersFile, "[]\n");
    console.log("[build] write cfg/users.json (empty skeleton)");
    const aclFile = path.join(cfgDest, "acl.json");
    fs.writeFileSync(
      aclFile,
      JSON.stringify(
        { clientIp: { whitelist: [], blacklist: [] }, target: { whitelist: [], blacklist: [] } },
        null,
        2,
      ) + "\n",
    );
    console.log("[build] write cfg/acl.json (empty skeleton)");
  }

  // NOTE: Windows + Node22 + esbuild 退出时偶发 3221226505，原生层崩溃拦不住；
  // 但走到这里构建产物已全部落盘，调用方（watcher）只看退出码 + dist mtime。
  process.exit(0);
}
