import esbuild from "esbuild";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
);

const isWatch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [path.join(__dirname, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(__dirname, "dist/app.js"),
  alias: {
    "@": path.join(__dirname, "src"),
  },
  define: {
    "process.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  logLevel: "info",
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("[build] watch: src -> dist/app.js");
} else {
  await esbuild.build(buildOptions);
}

// ── 拷贝静态资源到 dist（便于部署/打包） ──
const distDir = path.join(__dirname, "dist");
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

/** 需要拷贝到 dist 的文件列表：不存在则跳过，避免构建失败 */
const assets = [
  ".env.example", // 环境变量示例，供部署时 cp 为 .env
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
