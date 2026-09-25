/**
 * HTTP 压测源站 - tests/http-test-server.mjs
 *
 * 一个纯 http 服务器，给代理做吞吐压测用的本地目标站。
 * 替代 example.com 等公网目标，消除公网 RTT 抖动 + 终端 HTTP_PROXY 环境污染。
 * 纯 node:http + node:cluster，不依赖 src/，无需 pnpm build，直接 node 启动。
 *
 * 启动（CLI > 环境变量 > 默认值，唯一入口 pnpm test:server）：
 *   pnpm test:server -- --port 4000 --size 2KB             # 固定 2KB（小包口径）
 *   pnpm test:server -- --port 4000 --size 400KB           # 固定 400KB（大包口径）
 *   pnpm test:server -- --port 4000 --min 2KB --max 400KB  # 随机 2KB~400KB
 *   pnpm test:server -- --port 4000 --size 1MB --workers 0 # 0=CPU 核数
 *   pnpm test:server -- --port 4000 --size 2KB --verbose          # 打开逐请求日志（默认关闭，排查时用）
 *   pnpm test:server -- --port 4000 --size 2KB --reuse-port      # Windows 多核分发修复：各 worker 独立 socket 内核分发
 *   node tests/http-test-server.mjs --help
 *
 * 参数一览：
 *   --port 4000              监听端口（TEST_PORT）
 *   --host 0.0.0.0           监听地址（TEST_HOST）
 *   --size 4KB               固定响应体大小，支持 B/KB/MB/GB（TEST_SIZE）
 *   --min / --max            随机响应范围，同时 >0 时每请求在 [min,max] 内均匀随机，覆盖 --size
 *                            （TEST_MIN / TEST_MAX，同样支持 KB/MB 单位）
 *   --delay 0                固定延迟 ms，发送响应前先睡一会，模拟慢上游（TEST_DELAY）
 *   --delay-min/--delay-max  随机延迟范围 ms（TEST_DELAY_MIN / TEST_DELAY_MAX）
 *   --chunk 64KB             分块发送大小，大响应拆块写避免单次巨 Buffer（TEST_CHUNK）
 *   --max-size 100MB         单响应上限，防误配打爆内存（TEST_MAX_SIZE）
 *   --fill x                 填充字符（取首字符）
 *   --workers 1              进程数：默认 1（单进程），0=CPU 核数，N=多进程（TEST_WORKERS）
 *                            （Windows 下 cluster RR 不分发，多核请加 --reuse-port，否则等同单核）
 *   --reuse-port             各 worker 独立 socket 内核分发（TEST_REUSE_PORT，默认关闭；
 *                            不支持的系统自动降级为共享监听并警告）
 *   --verbose                逐请求打日志（TEST_VERBOSE）：默认关闭；--verbose 打开
 *                            （排查问题时开，极高并发压测时保持关闭，免 console 拖吞吐）
 *
 * 单请求覆盖（curl 压测矩阵用）：
 *   curl http://127.0.0.1:4000/?size=1MB
 *   curl "http://127.0.0.1:4000/?size=4KB&delay=20"
 *   curl http://127.0.0.1:4000/health
 *
 * 经代理压测示例（PROXY_PROTOCOL=http）：
 *   curl -x http://127.0.0.1:3000 http://127.0.0.1:4000/?size=1MB -o NUL -w "%{http_code} %{time_total}s %{size_download}B\n"
 */
import cluster from "node:cluster";
import http from "node:http";
import os from "node:os";

// ── 参数解析：--key value / --key=value / KEY=VALUE ──
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") continue;
    if (!arg.startsWith("-") && arg.includes("=")) {
      const idx = arg.indexOf("=");
      out[arg.slice(0, idx).replace(/^-+/, "").replace(/-/g, "_").toUpperCase()] = arg.slice(idx + 1);
      continue;
    }
    if (!arg.startsWith("-")) continue;
    arg = arg.replace(/^-+/, "");
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(0, eq).replace(/-/g, "_").toUpperCase()] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out[arg.replace(/-/g, "_").toUpperCase()] = next;
        i++;
      } else {
        out[arg.replace(/-/g, "_").toUpperCase()] = "true";
      }
    }
  }
  return out;
}

/** "1KB"/"1.5MB"/"512" -> 字节数，非法返回 undefined */
function parseBytes(v) {
  if (v === undefined) return undefined;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!m) return undefined;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[(m[2] || "B").toUpperCase()];
  const n = Math.floor(Number(m[1]) * mult);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseIntMin(v, min) {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? n : undefined;
}

function usage(exitCode = 0) {
  console.log(`用法: node tests/http-test-server.mjs [选项]
  --port 4000              监听端口
  --host 0.0.0.0           监听地址
  --size 4KB               固定响应体大小（B/KB/MB/GB）
  --min/--max              随机响应范围（覆盖 --size）
  --delay 0                固定延迟 ms
  --delay-min/--delay-max  随机延迟范围 ms
  --chunk 64KB             分块发送大小
  --max-size 100MB         单响应上限
  --fill x                 填充字符
  --workers 1              进程数：默认 1（单进程），0=CPU 核数，N=多进程
  --reuse-port             各 worker 独立 socket 内核分发（Windows 多核用）
  --verbose                逐请求日志（默认关闭，--verbose 打开）
  --help                   显示本帮助`);
  process.exit(exitCode);
}

const cli = parseArgv(process.argv.slice(2));
if (cli.HELP === "true" || cli.H === "true") usage(0);

const pick = (key, env) => cli[key] ?? process.env[env];

function requiredBytes(raw, name) {
  const n = parseBytes(raw);
  if (n === undefined) {
    console.error(`[test-server] 非法参数 ${name}=${raw}（示例: 512 / 4KB / 1MB）`);
    process.exit(1);
  }
  return n;
}

// ── 生效配置 ──
const cfg = {
  port: parseIntMin(pick("PORT", "TEST_PORT") ?? "4000", 1) ?? 4000,
  host: pick("HOST", "TEST_HOST") ?? "0.0.0.0",
  size: requiredBytes(pick("SIZE", "TEST_SIZE") ?? "4KB", "--size"),
  min: parseBytes(pick("MIN", "TEST_MIN") ?? "0") ?? 0,
  max: parseBytes(pick("MAX", "TEST_MAX") ?? "0") ?? 0,
  delay: parseIntMin(pick("DELAY", "TEST_DELAY") ?? "0", 0) ?? 0,
  delayMin: parseIntMin(pick("DELAY_MIN", "TEST_DELAY_MIN") ?? "0", 0) ?? 0,
  delayMax: parseIntMin(pick("DELAY_MAX", "TEST_DELAY_MAX") ?? "0", 0) ?? 0,
  chunk: requiredBytes(pick("CHUNK", "TEST_CHUNK") ?? "64KB", "--chunk") || 65536,
  maxSize: requiredBytes(pick("MAX_SIZE", "TEST_MAX_SIZE") ?? "100MB", "--max-size"),
  fill: String(pick("FILL", "TEST_FILL") ?? "x")[0] ?? "x",
  workers: parseIntMin(pick("WORKERS", "TEST_WORKERS") ?? "1", 0) ?? 1,
  verbose: (pick("VERBOSE", "TEST_VERBOSE") ?? "false").toLowerCase() === "true",
  // Windows 下 cluster 的 SCHED_RR 分发不干活（连接全堆一个 worker），
  // 开此开关让各 worker 独立建 socket 走内核 SO_REUSEPORT 分发；不支持的系统会直接报错
  reusePort: (pick("REUSE_PORT", "TEST_REUSE_PORT") ?? "false").toLowerCase() === "true",
};
if (cfg.port > 65535) {
  console.error(`[test-server] 非法端口 ${cfg.port}`);
  process.exit(1);
}
if (cfg.chunk < 1) cfg.chunk = 65536;
const randomSize = cfg.min > 0 && cfg.max > 0;
if (randomSize && cfg.min > cfg.max) {
  console.error("[test-server] --min 不得大于 --max");
  process.exit(1);
}
const randomDelay = cfg.delayMax > 0 && cfg.delayMax >= cfg.delayMin;
const workerCount = cfg.workers === 0 ? Math.max(1, os.cpus().length) : cfg.workers;
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── worker：http 服务 ──
function runWorker() {
  const pid = process.pid;
  const wid = cluster.worker?.id ?? 0;
  const piece = Buffer.alloc(cfg.chunk, cfg.fill);
  let served = 0;
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    if (u.pathname === "/health") {
      const body = JSON.stringify({
        ok: true,
        pid,
        worker: wid,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        served,
      });
      if (cfg.verbose) console.log(`[test-server] worker=${wid} ${req.method} /health -> 200 health`);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    // 单请求覆盖：?size= / ?delay=
    let size = randomSize ? randInt(cfg.min, cfg.max) : cfg.size;
    let delay = randomDelay ? randInt(cfg.delayMin, cfg.delayMax) : cfg.delay;
    const qSize = u.searchParams.get("size");
    const qDelay = u.searchParams.get("delay");
    if (qSize !== null) {
      const n = parseBytes(qSize);
      if (n === undefined) {
        if (cfg.verbose) console.log(`[test-server] worker=${wid} ${req.method} ${u.pathname}${u.search} -> 400 bad size`);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`bad size: ${qSize}`);
        return;
      }
      size = n;
    }
    if (qDelay !== null) {
      const n = parseIntMin(qDelay, 0);
      if (n === undefined || n > 60000) {
        if (cfg.verbose) console.log(`[test-server] worker=${wid} ${req.method} ${u.pathname}${u.search} -> 400 bad delay`);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`bad delay: ${qDelay}`);
        return;
      }
      delay = n;
    }
    if (size > cfg.maxSize) {
      if (cfg.verbose) console.log(`[test-server] worker=${wid} ${req.method} ${u.pathname}${u.search} -> 400 exceeds max-size`);
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`size ${size} exceeds --max-size ${cfg.maxSize}`);
      return;
    }
    if (cfg.verbose) console.log(`[test-server] worker=${wid} ${req.method} ${u.pathname}${u.search} -> ${size}B delay=${delay}ms`);

    const send = () => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": size });
      if (req.method === "HEAD" || size === 0) {
        res.end();
        return;
      }
      for (let off = 0; off < size; off += piece.length) {
        const end = Math.min(off + piece.length, size);
        res.write(off === 0 && end === size ? piece.subarray(0, end) : piece.subarray(0, end - off));
      }
      res.end();
    };
    res.on("finish", () => served++);
    if (delay > 0) {
      sleep(delay).then(send);
    } else {
      send();
    }
  });

  server.on("clientError", (_err, socket) => socket.destroy());
  let listening = false;
  server.on("listening", () => {
    listening = true;
  });
  server.listen({ port: cfg.port, host: cfg.host, reusePort: cfg.reusePort }, () => {
    console.log(`[test-server] worker pid=${pid} listening on http://${cfg.host}:${cfg.port} size=${randomSize ? `${cfg.min}-${cfg.max}` : cfg.size}B reusePort=${cfg.reusePort}`);
  });
  server.on("error", (err) => {
    // reusePort 不被系统支持（ENOTSUP 等）时自动降级为共享监听，免得无限重启刷屏
    if (cfg.reusePort && (err.code === "ENOTSUP" || err.code === "EINVAL" || err.code === "EAFNOSUPPORT")) {
      console.error(`[test-server] worker pid=${pid} reusePort 不被支持，降级为共享监听（Windows 下连接仍会堆单 worker）`);
      cfg.reusePort = false;
      server.listen({ port: cfg.port, host: cfg.host });
      return;
    }
    console.error(`[test-server] worker pid=${pid} error:`, err.message);
    process.exit(1);
  });

  // 没监听成功就别调 server.close（回调永不触发会卡住退出），直接退
  const graceful = () => {
    if (!listening) process.exit(0);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", graceful);
  process.on("SIGTERM", graceful);
  if (cluster.isWorker) {
    process.on("disconnect", () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

// ── primary：fork + 守护 ──
function runPrimary() {
  cluster.schedulingPolicy = cluster.SCHED_RR;
  console.log(`[test-server] primary pid=${process.pid} forking ${workerCount} workers on ${cfg.host}:${cfg.port}`);
  let shuttingDown = false;
  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) return;
    console.log(`[test-server] worker pid=${worker.process.pid} exited (code=${code} signal=${signal}), restarting`);
    cluster.fork();
  });
  for (let i = 0; i < workerCount; i++) cluster.fork();
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[test-server] shutting down...");
    for (const w of Object.values(cluster.workers ?? {})) w?.disconnect();
    setTimeout(() => {
      for (const w of Object.values(cluster.workers ?? {})) w?.kill("SIGKILL");
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.platform === "win32") process.on("SIGBREAK", shutdown);
}

if (workerCount > 1 && cluster.isPrimary) {
  runPrimary();
} else {
  runWorker();
}
