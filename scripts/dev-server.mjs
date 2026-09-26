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

// ── 杀进程树：cluster 模式会 fork 多个 worker，Windows 下 child.kill()
//     只杀得掉 master，worker 会变孤儿继续占端口，必须整树杀掉 ──
function killTree(pid) {
  return new Promise((resolve) => {
    if (pid == null) return resolve();
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("exit", finish);
      killer.on("error", () => {
        try {
          process.kill(pid);
        } catch {}
        finish();
      });
      setTimeout(finish, 3000); // 兜底，避免 taskkill 挂起卡死重启
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      finish();
    }
  });
}

// ── 服务器进程管理 ──
let child = null;
let starting = false;

async function startServer() {
  if (starting) return;
  starting = true;
  try {
    if (child) {
      const oldPid = child.pid;
      child = null;
      console.log("[dev-server] killing old server (pid:%d)...", oldPid);
      await killTree(oldPid);
      // taskkill 退出时进程已死、端口理论上已释放，这里只留 300ms 兜底
      await new Promise((r) => setTimeout(r, 300));
    }

    child = spawn("node", ["dist/app.js"], {
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "development" },
    });
    console.log("[dev-server] server started (pid:%d)", child.pid);

    // code+signal 一起打：主动 kill 是 code:null/signal:SIGTERM，
    // 原生崩溃是 code:3221226505/signal:null，一眼区分
    child.on("exit", (code, signal) => {
      console.log("[dev-server] server exited (code:%s signal:%s)", code, signal);
    });
    child.on("error", (err) => {
      console.error("[dev-server] server spawn error:", err.message);
    });
  } finally {
    starting = false;
  }
}

// dev-server 侧只收敛同一次重编产生的重复事件，150ms 足够，
// 不必和 build 侧一样等 300ms
const restart = debounce((reason) => {
  console.log("[dev-server] %s, restarting...", reason);
  startServer().catch((err) => console.error("[dev-server] restart failed:", err));
}, 150);

// dev-server 自身的 JS 层报错直接打出来（原生崩溃抓不到，但能排除法定位）
process.on("uncaughtException", (err) => {
  console.error("[dev-server] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[dev-server] unhandledRejection:", reason);
});

// ── 监听 dist/ 下 .js 变化（esbuild 重建） ──
// ⚠️ build.mjs 现在**每次构建前无条件清空 dist/**，于是每一轮重建都会先来一个
// 「app.js 被删掉」的事件。此处必须 `existsSync` 过滤：重启的理由是「新代码出现了」，
// 不是「代码不见了」—— 不过滤就会在 app.js 缺失的那几百毫秒窗口里 spawn 出一个
// MODULE_NOT_FOUND 的空跑进程。
watch("dist", { recursive: true }, (_event, filename) => {
  if (filename?.endsWith(".js") && existsSync(filename)) {
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
startServer().catch((err) => console.error("[dev-server] start failed:", err));
console.log("[dev-server] watching dist/ and .env* files...");
