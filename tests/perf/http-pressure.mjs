/**
 * HTTP 直连压测器 - tests/perf/http-pressure.mjs
 *
 * 单进程 N 并行，直连本地 :4000 测试服务器（tests/http-test-server.mjs）打突发，
 * 称源站本身的吞吐 + 延迟分布。与 tests/perf/socks4-pressure.mjs 口径对齐
 * （wave/rps/min/avg/p50/p95/p99/max/peakConn），两边数字可直接横比：
 * 经代理 ≈ 直连 → 代理没吃吞吐；经代理明显更差 → 再剖代理。
 * 纯 node:http，零依赖，不读 src/，无需 pnpm build，直接 node 启动。
 * 只对外建连，不拉起任何服务；源站需用户手动提前启动。
 *
 * 两种模式（与 socks4-pressure 同义）：
 * - close（默认）：每请求新建 TCP（agent:false），测源站建连+响应成本
 * - keepalive：N 条长连接各串行 K 个请求（keepAlive Agent + maxSockets=N），
 *   测源站真实吞吐上限。注意：此模式压测器本身也吃单核 CPU，
 *   同机三进程（压测器+源站+代理）抢核时测出的是系统分，不是单人分。
 *
 * 用法：
 *   node tests/perf/http-pressure.mjs --concurrency 50 --requests 100
 *   node tests/perf/http-pressure.mjs --concurrency 200
 *   node tests/perf/http-pressure.mjs --keepalive --requests 50 --concurrency 50
 *   node tests/perf/http-pressure.mjs --keepalive --concurrency 100 --requests 50 --target 127.0.0.1:4000,127.0.0.1:4001,127.0.0.1:4002,127.0.0.1:4003
 *   pnpm test:pressure:direct -- --concurrency 50 --requests 100
 *   node tests/perf/http-pressure.mjs --help
 *
 * 参数（CLI > 环境变量 > 默认值）：
 *   --target 127.0.0.1:4000  测试服务器地址（TEST_TARGET），多地址逗号分隔做扇出：
 *                            --target 127.0.0.1:4000,127.0.0.1:4001,127.0.0.1:4002,127.0.0.1:4003
 *                            （配合 4 个 --workers 1 源站各占一端口，Windows 下真·多核打压）
 *   --concurrency 50         每波并行数：close 下是并行请求数，keepalive 下是并行长连接数（TEST_CONCURRENCY）
 *   --size 10B               每请求响应大小 B/KB/MB（TEST_SIZE），透传给源站 ?size=（并发口径默认小包）
 *   --delay 0                每请求延迟 ms（TEST_DELAY），透传给源站 ?delay=，模拟慢上游
 *   --requests 1             keepalive 下每连接串行请求数（TEST_REQUESTS；开了 --keepalive 却没给则默认 50）
 *   --keepalive              keep-alive 模式开关（TEST_KEEPALIVE=true），默认 close 模式
 *   --rounds 1               跑几波，波间歇 500ms（TEST_ROUNDS）
 *   --timeout 15000          单请求超时 ms（TEST_TIMEOUT）
 */
import http from "node:http";

// ── 参数解析：--key value / --key=value（--keep-alive 与 --keepalive 等价）──
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") continue;
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

/** "200B"/"400KB"/"1MB" -> 字节数，非法返回 undefined */
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

function parseHostPort(v, defHost, defPort) {
  const [h, p] = String(v ?? "").split(":");
  return { host: h || defHost, port: p === undefined || p === "" ? defPort : Number(p) };
}

/** "--target a:4000,b:4000" -> [{host,port}]，单地址照常用 */
function parseTargets(v, defHost, defPort) {
  return String(v ?? "")
    .split(",")
    .map((s) => parseHostPort(s.trim(), defHost, defPort))
    .filter((t) => t.host && Number.isInteger(t.port));
}

function usage(exitCode = 0) {
  console.log(`用法: node tests/perf/http-pressure.mjs [选项]
  --target 127.0.0.1:4000  测试服务器地址
  --concurrency 50         每波并行数（close=并行请求，keepalive=并行长连接）
  --size 10B               每请求响应大小（B/KB/MB）
  --delay 0                每请求延迟 ms（透传 ?delay=）
  --keepalive              keep-alive 模式（同连接串行多请求）
  --requests 50            keep-alive 下每连接请求数
  --rounds 1               跑几波
  --timeout 15000          单请求超时 ms
  --help                   显示本帮助`);
  process.exit(exitCode);
}

const cli = parseArgv(process.argv.slice(2));
if (cli.HELP === "true" || cli.H === "true") usage(0);
const pick = (key, env) => cli[key] ?? process.env[env];

const targets = parseTargets(pick("TARGET", "TEST_TARGET") ?? "127.0.0.1:4000", "127.0.0.1", 4000);
const keepalive = ((pick("KEEPALIVE", "TEST_KEEPALIVE") ?? cli.KEEP_ALIVE ?? "false") + "").toLowerCase() === "true";
const cfg = {
  concurrency: parseIntMin(pick("CONCURRENCY", "TEST_CONCURRENCY") ?? "50", 1) ?? 50,
  sizeParam: pick("SIZE", "TEST_SIZE") ?? "10B",
  delay: parseIntMin(pick("DELAY", "TEST_DELAY") ?? "0", 0) ?? 0,
  requests: parseIntMin(pick("REQUESTS", "TEST_REQUESTS") ?? (keepalive ? "50" : "1"), 1) ?? 1,
  rounds: parseIntMin(pick("ROUNDS", "TEST_ROUNDS") ?? "1", 1) ?? 1,
  timeout: parseIntMin(pick("TIMEOUT", "TEST_TIMEOUT") ?? "15000", 100) ?? 15000,
};
const expectLen = parseBytes(cfg.sizeParam);
if (expectLen === undefined) {
  console.error(`[pressure:direct] 非法 --size=${cfg.sizeParam}（示例: 200B / 400KB / 1MB）`);
  process.exit(1);
}
if (targets.length === 0) {
  console.error(`[pressure:direct] 非法地址 target=${pick("TARGET", "TEST_TARGET")}`);
  process.exit(1);
}
// 扇出轮询：close 按请求轮，keepalive 按连接轮，保证多目标雨露均沾
let targetSeq = 0;
const pickTarget = () => targets[(targetSeq++) % targets.length];
const perTarget = new Map(); // "host:port" -> 完成请求数
const countTarget = (t) => {
  const k = `${t.host}:${t.port}`;
  perTarget.set(k, (perTarget.get(k) ?? 0) + 1);
};
const path = `/?size=${encodeURIComponent(cfg.sizeParam)}${cfg.delay > 0 ? `&delay=${cfg.delay}` : ""}`;

// 同时在线计数：close 下 1 请求 = 1 连接；keepalive 下 1 任务 = 1 长连接
let active = 0;
let peakConn = 0;
const trackOpen = () => {
  active++;
  if (active > peakConn) peakConn = active;
};
const trackClose = () => {
  active--;
};

/** 单请求（close 模式）：agent:false 每请求新建 TCP，读到 end 记时 */
function oneRequest(agent, t) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    trackOpen();
    const done = (rec) => {
      trackClose();
      countTarget(t);
      rec.tTotal = Date.now() - t0;
      resolve(rec);
    };
    const q = http.get({ host: t.host, port: t.port, path, agent }, (res) => {
      let n = 0;
      res.on("data", (d) => (n += d.length));
      res.on("end", () => {
        const ok = res.statusCode === 200 && n === expectLen;
        done({ ok, err: ok ? "" : `${res.statusCode} body=${n}/${expectLen}` });
      });
    });
    q.on("error", (e) => done({ ok: false, err: e.message }));
    q.setTimeout(cfg.timeout, () => q.destroy(new Error("timeout")));
  });
}

/** keep-alive 长连接：同连接串行 K 个请求，返回逐请求记录数组 */
async function keepaliveConn(agent, t) {
  const recs = [];
  trackOpen();
  try {
    for (let i = 0; i < cfg.requests; i++) {
      const r = await oneRequestNoTrack(agent, t);
      countTarget(t);
      recs.push(r);
    }
  } finally {
    trackClose();
  }
  return recs;
}

/** keepalive 内部单请求：不碰连接计数（整条连接只算 1 个在线） */
function oneRequestNoTrack(agent, t) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const q = http.get({ host: t.host, port: t.port, path, agent }, (res) => {
      let n = 0;
      res.on("data", (d) => (n += d.length));
      res.on("end", () => {
        const ok = res.statusCode === 200 && n === expectLen;
        resolve({ ok, tTotal: Date.now() - t0, err: ok ? "" : `${res.statusCode} body=${n}/${expectLen}`, transport: true });
      });
    });
    q.on("error", (e) => resolve({ ok: false, tTotal: Date.now() - t0, err: e.message, transport: false }));
    q.setTimeout(cfg.timeout, () => q.destroy(new Error("timeout")));
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function runWave(w, rounds) {
  const t0 = Date.now();
  let recs;
  // close 用无复用 agent（每请求新 TCP）；keepalive 用共享长连接池
  const agent = keepalive ? new http.Agent({ keepAlive: true, maxSockets: cfg.concurrency }) : false;
  try {
    if (keepalive) {
      // 每条连接固定打一个目标，连接按目标轮分（conns >= 目标数时均匀）
      recs = (
        await Promise.all(
          Array.from({ length: cfg.concurrency }, (_, i) => keepaliveConn(agent, targets[i % targets.length])),
        )
      ).flat();
    } else {
      recs = await Promise.all(Array.from({ length: cfg.concurrency }, () => oneRequest(agent, pickTarget())));
    }
  } finally {
    if (agent) agent.destroy();
  }
  const wall = Date.now() - t0;
  const oks = recs.filter((r) => r.ok).map((r) => r.tTotal).sort((a, b) => a - b);
  const fails = recs.filter((r) => !r.ok);
  const errSample = [...new Set(fails.map((r) => r.err))].slice(0, 3).join(" | ");
  const sum = oks.reduce((a, b) => a + b, 0);
  const scope = keepalive ? `conns=${cfg.concurrency} req/conn=${cfg.requests} N(reqs)=${recs.length}` : `N=${recs.length}`;
  console.log(
    `[wave ${w}/${rounds}] mode=${keepalive ? "keepalive" : "close"} ${scope} ok=${oks.length} fail=${fails.length}` +
      (errSample ? ` err=[${errSample}]` : "") +
      ` wall=${wall}ms rps=${Math.round((oks.length / wall) * 1000)}/s` +
      ` total[min/avg/p50/p95/p99/max]=${oks[0] ?? 0}/${oks.length ? Math.round(sum / oks.length) : 0}` +
      `/${percentile(oks, 50)}/${percentile(oks, 95)}/${percentile(oks, 99)}/${oks[oks.length - 1] ?? 0}ms`,
  );
  return { ok: oks.length, fail: fails.length };
}

async function main() {
  console.log(
    `[pressure:direct] target=[${targets.map((t) => `${t.host}:${t.port}`).join(",")}] size=${cfg.sizeParam} delay=${cfg.delay}ms ` +
      `mode=${keepalive ? `keepalive(req/conn=${cfg.requests})` : "close"} ` +
      `concurrency=${cfg.concurrency} rounds=${cfg.rounds}`,
  );
  let totalOk = 0;
  let totalFail = 0;
  for (let w = 1; w <= cfg.rounds; w++) {
    const r = await runWave(w, cfg.rounds);
    totalOk += r.ok;
    totalFail += r.fail;
    if (w < cfg.rounds) await new Promise((r2) => setTimeout(r2, 500));
  }
  console.log(`\n=== SUMMARY ===`);
  console.log(`total ok=${totalOk} fail=${totalFail} peakConn=${peakConn}`);
  console.log(`perTarget: ${[...perTarget.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (totalOk === 0) {
    console.log(`提示：全失败多半是源站没起，请先执行 pnpm test:server -- --port 4000 --size 2KB 启动测试服务器`);
  }
  console.log(`overall: ${totalFail === 0 ? "ALL PASS" : "SOME FAIL"}`);
  process.exit(totalFail === 0 ? 0 : 1);
}
main();
