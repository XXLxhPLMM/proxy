import { watch, existsSync, readdirSync } from "fs";
import { spawn } from "child_process";

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

// ── 服务器进程管理 ──
let child = null;

function startServer() {
  if (child) {
    child.kill();
    child = null;
  }

  child = spawn("node", ["--env-file-if-exists=.env.development", "dist/app.js"], {
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.log(`[dev-server] exited with code ${code}`);
    }
  });

  console.log("[dev-server] server started (pid:%d)", child.pid);
}

const restart = debounce((reason) => {
  console.log("[dev-server] %s, restarting...", reason);
  startServer();
});

// ── 监听 dist/ 下 .js 变化（esbuild 重建） ──
watch("dist", { recursive: true }, (_event, filename) => {
  if (filename?.endsWith(".js")) {
    restart(`dist/${filename} changed`);
  }
});

// ── 监听根目录 .env* 文件变化 ──
const envPattern = /^\.env/;

for (const file of readdirSync(".")) {
  if (envPattern.test(file)) {
    watch(file, () => restart(`${file} changed`));
  }
}

// 监听新增的 .env* 文件
watch(".", (_event, filename) => {
  if (filename && envPattern.test(filename) && existsSync(filename)) {
    restart(`${filename} changed`);
  }
});

// ── 启动 ──
startServer();
console.log("[dev-server] watching dist/ and .env* files...");
