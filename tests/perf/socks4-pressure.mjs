/**
 * SOCKS4 并发压测器 - tests/perf/socks4-pressure.mjs
 *
 * 单进程 N 并行，经 socks4 代理向本地 :4000 源站打突发请求，
 * 测代理真实同时在线连接数 + 端到端延迟分布。不起 curl 进程，
 * 消除进程创建开销，直达代理上限（curl 法 wall 时间 80% 花在建进程上）。
 * 纯 node:net，零依赖，不读 src/，无需 pnpm build，直接 node 启动。
 * 只对外建连，不拉起任何服务；代理和源站需用户手动提前启动。
 *
 * 两种模式：
 * - close（默认）：每请求独立建连（TCP+SOCKS 握手+上游拨号），测建连链路成本
 * - keepalive：每隧道串行 K 个请求（Connection: keep-alive + Content-Length 定界），
 *   建连成本被分摊，测真实用户（浏览器）体感。注意：此模式只省客户端→代理段建连，
 *   代理→上游仍按隧道建连（盲管道无协议感知，跨客户端复用有脏数据风险，故不做）。
 *
 * 用法：
 *   node tests/perf/socks4-pressure.mjs --concurrency 500 --size 200B
 *   node tests/perf/socks4-pressure.mjs --concurrency 1000 --size 200B --rounds 3
 *   node tests/perf/socks4-pressure.mjs --keepalive --requests 50 --concurrency 100 --size 200B
 *   pnpm test:pressure -- --concurrency 1000 --size 400KB
 *   pnpm test:pressure -- --keepalive --requests 50 --concurrency 100 --size 200B
 *   node tests/perf/socks4-pressure.mjs --help
 *
 * 参数（CLI > 环境变量 > 默认值）：
 *   --proxy 127.0.0.1:3000   代理地址（TEST_PROXY）
 *   --target 127.0.0.1:4000  压测目标，即本地源站（TEST_TARGET）
 *   --userid admin           SOCKS4 USERID，无密码概念（TEST_USERID）
 *   --concurrency 200        每波并行隧道数（TEST_CONCURRENCY）
 *   --size 200B              每请求响应大小 B/KB/MB（TEST_SIZE），透传给源站 ?size=
 *   --requests 1             keepalive 下每隧道串行请求数（TEST_REQUESTS；开了 --keepalive 却没给则默认 50）
 *   --keepalive              keep-alive 模式开关（TEST_KEEPALIVE=true），默认 close 模式
 *   --rounds 1               跑几波，波间歇 500ms（TEST_ROUNDS）
 *   --timeout 15000          单请求超时 ms（TEST_TIMEOUT）
 */
import net from "node:net";

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

function usage(exitCode = 0) {
  console.log(`用法: node tests/perf/socks4-pressure.mjs [选项]
  --proxy 127.0.0.1:3000   代理地址
  --target 127.0.0.1:4000  压测目标（本地源站）
  --userid admin           SOCKS4 USERID
  --concurrency 200        每波并行隧道数
  --size 200B              每请求响应大小（B/KB/MB）
  --keepalive              keep-alive 模式（同隧道串行多请求）
  --requests 50            keep-alive 下每隧道请求数
  --rounds 1               跑几波
  --timeout 15000          单请求超时 ms
  --help                   显示本帮助`);
  process.exit(exitCode);
}

const cli = parseArgv(process.argv.slice(2));
if (cli.HELP === "true" || cli.H === "true") usage(0);
const pick = (key, env) => cli[key] ?? process.env[env];

const proxy = parseHostPort(pick("PROXY", "TEST_PROXY") ?? "127.0.0.1:3000", "127.0.0.1", 3000);
const target = parseHostPort(pick("TARGET", "TEST_TARGET") ?? "127.0.0.1:4000", "127.0.0.1", 4000);
const keepalive = ((pick("KEEPALIVE", "TEST_KEEPALIVE") ?? cli.KEEP_ALIVE ?? "false") + "").toLowerCase() === "true";
const cfg = {
  userid: pick("USERID", "TEST_USERID") ?? "admin",
  concurrency: parseIntMin(pick("CONCURRENCY", "TEST_CONCURRENCY") ?? "200", 1) ?? 200,
  sizeParam: pick("SIZE", "TEST_SIZE") ?? "200B",
  requests: parseIntMin(pick("REQUESTS", "TEST_REQUESTS") ?? (keepalive ? "50" : "1"), 1) ?? 1,
  rounds: parseIntMin(pick("ROUNDS", "TEST_ROUNDS") ?? "1", 1) ?? 1,
  timeout: parseIntMin(pick("TIMEOUT", "TEST_TIMEOUT") ?? "15000", 100) ?? 15000,
};
const expectLen = parseBytes(cfg.sizeParam);
if (expectLen === undefined) {
  console.error(`[pressure] 非法 --size=${cfg.sizeParam}（示例: 200B / 400KB / 1MB）`);
  process.exit(1);
}
if (!Number.isInteger(proxy.port) || !Number.isInteger(target.port)) {
  console.error(`[pressure] 非法地址 proxy=${proxy.host}:${proxy.port} target=${target.host}:${target.port}`);
  process.exit(1);
}

// 全局同时在线计数（TCP 建连即 +1，关闭即 -1），取峰值 = 真实同时在线
let active = 0;
let peakConn = 0;
const trackOpen = () => {
  active++;
  if (active > peakConn) peakConn = active;
};
const trackClose = () => {
  active--;
};

/** SOCKS4 CONNECT 首包：[0x04, 0x01, PORT×2 BE, IP×4, USERID, 0x00] */
function buildSocks4Req() {
  const id = Buffer.from(cfg.userid, "utf8");
  const req = Buffer.alloc(8 + id.length + 1);
  req[0] = 0x04;
  req[1] = 0x01;
  req.writeUInt16BE(target.port, 2);
  target.host.split(".").forEach((n, i) => (req[4 + i] = Number(n)));
  id.copy(req, 8);
  req[8 + id.length] = 0x00;
  return req;
}

/** 单请求（close 模式）：TCP→SOCKS4 握手→隧道里 GET ?size=→读到 end，返回计时与成败 */
function oneRequest() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const rec = { ok: false, tTotal: Date.now() - t0, err: "" };
    const fail = (err) => {
      rec.err = err;
      rec.tTotal = Date.now() - t0;
      resolve(rec);
    };
    const s = net.createConnection(proxy.port, proxy.host, () => {
      trackOpen();
      s.write(buildSocks4Req());
    });
    const timer = setTimeout(() => {
      s.destroy();
      fail("timeout");
    }, cfg.timeout);
    let stage = "handshake";
    let acc = Buffer.alloc(0);
    let bodyStart = -1;
    s.on("data", (d) => {
      acc = Buffer.concat([acc, d]);
      if (stage === "handshake") {
        if (acc.length < 8) return;
        if (acc[0] !== 0x00 || acc[1] !== 0x5a) {
          clearTimeout(timer);
          s.destroy();
          fail(`socks denied CD=${acc[1] !== undefined ? "0x" + acc[1].toString(16) : "n/a"}`);
          return;
        }
        stage = "http";
        acc = Buffer.alloc(0);
        s.write(`GET /?size=${cfg.sizeParam} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\nConnection: close\r\n\r\n`);
        return;
      }
      if (bodyStart === -1) {
        const idx = acc.indexOf("\r\n\r\n");
        if (idx !== -1) bodyStart = idx + 4;
      }
    });
    s.on("end", () => {
      clearTimeout(timer);
      const text = acc.toString("utf8");
      const status = text.split("\r\n")[0] ?? "";
      const bodyLen = bodyStart === -1 ? -1 : acc.length - bodyStart;
      rec.ok = status.includes("200 OK") && bodyLen === expectLen;
      if (!rec.ok) rec.err = `${status} body=${bodyLen}/${expectLen}`;
      rec.tTotal = Date.now() - t0;
      resolve(rec);
    });
    s.on("close", () => {
      trackClose();
      // 对端先 destroy 无 end（如 0x5B 拒绝）会在握手分支已处理；兜底：
      if (!rec.ok && !rec.err) {
        clearTimeout(timer);
        fail("closed");
      }
    });
    s.on("error", (e) => {
      clearTimeout(timer);
      fail(e.message);
    });
  });
}

/**
 * keep-alive 隧道：一次握手后串行 K 个请求（Connection: keep-alive，
 * Content-Length 定界，余字节留给下一响应）。返回逐请求记录数组。
 */
function keepaliveConn(k) {
  return new Promise((resolve) => {
    const recs = [];
    let buf = Buffer.alloc(0);
    let waiter = null; // { res, rej }，等更多字节
    let finished = false;
    const s = net.createConnection(proxy.port, proxy.host, () => {
      trackOpen();
      s.write(buildSocks4Req());
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      s.removeAllListeners();
      s.destroy();
      resolve(recs);
    };
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.res();
      }
    });
    s.on("error", (e) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.rej(e);
      }
    });
    s.on("close", () => {
      trackClose();
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.rej(new Error("closed"));
      }
    });
    const awaitData = () =>
      new Promise((res, rej) => {
        const timer = setTimeout(() => {
          waiter = null;
          rej(new Error("timeout"));
        }, cfg.timeout);
        waiter = {
          res: () => {
            clearTimeout(timer);
            res();
          },
          rej: (e) => {
            clearTimeout(timer);
            rej(e);
          },
        };
      });
    const awaitBytes = async (n) => {
      while (buf.length < n) await awaitData();
    };
    // 读一个 framed 响应：头定界 → Content-Length → 取足 body，余字节保留
    const readFramed = async () => {
      const t0 = Date.now();
      try {
        let idx = buf.indexOf("\r\n\r\n");
        while (idx === -1) {
          await awaitData();
          idx = buf.indexOf("\r\n\r\n");
        }
        const head = buf.subarray(0, idx).toString("utf8");
        const m = head.match(/content-length:\s*(\d+)/i);
        if (!m) throw new Error("no content-length");
        const bodyLen = Number(m[1]);
        const need = idx + 4 + bodyLen;
        await awaitBytes(need);
        const status = head.split("\r\n")[0] ?? "";
        buf = Buffer.from(buf.subarray(need)); // 拷贝余部，防底层 slab 常驻内存
        const ok = status.includes("200 OK") && bodyLen === expectLen;
        return { ok, tTotal: Date.now() - t0, err: ok ? "" : `${status} body=${bodyLen}/${expectLen}`, transport: true };
      } catch (e) {
        return { ok: false, tTotal: Date.now() - t0, err: (e && e.message) || "unknown", transport: false };
      }
    };
    (async () => {
      try {
        await awaitBytes(8);
        if (buf[0] !== 0x00 || buf[1] !== 0x5a) {
          const cd = buf[1] !== undefined ? "0x" + buf[1].toString(16) : "n/a";
          for (let i = 0; i < k; i++) recs.push({ ok: false, tTotal: 0, err: `socks denied CD=${cd}` });
          finish();
          return;
        }
        buf = Buffer.from(buf.subarray(8));
        for (let i = 0; i < k; i++) {
          s.write(`GET /?size=${cfg.sizeParam} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\nConnection: keep-alive\r\n\r\n`);
          const r = await readFramed();
          recs.push(r);
          if (!r.transport) {
            // 传输层断了，剩下没法发，全记失败
            for (let j = i + 1; j < k; j++) recs.push({ ok: false, tTotal: 0, err: r.err });
            break;
          }
        }
      } catch (e) {
        while (recs.length < k) recs.push({ ok: false, tTotal: 0, err: (e && e.message) || "unknown" });
      }
      finish();
    })();
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function runWave(w, rounds) {
  const t0 = Date.now();
  let recs;
  if (keepalive) {
    recs = (await Promise.all(Array.from({ length: cfg.concurrency }, () => keepaliveConn(cfg.requests)))).flat();
  } else {
    recs = await Promise.all(Array.from({ length: cfg.concurrency }, () => oneRequest()));
  }
  const wall = Date.now() - t0;
  const oks = recs.filter((r) => r.ok).map((r) => r.tTotal).sort((a, b) => a - b);
  const fails = recs.filter((r) => !r.ok);
  const errSample = [...new Set(fails.map((r) => r.err))].slice(0, 3).join(" | ");
  const sum = oks.reduce((a, b) => a + b, 0);
  const scope = keepalive ? `tunnels=${cfg.concurrency} req/conn=${cfg.requests} N(reqs)=${recs.length}` : `N=${recs.length}`;
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
    `[pressure] proxy=${proxy.host}:${proxy.port} userid=${cfg.userid} -> target=${target.host}:${target.port} ` +
      `size=${cfg.sizeParam} mode=${keepalive ? `keepalive(req/conn=${cfg.requests})` : "close"} ` +
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
  if (totalOk === 0) {
    console.log(`提示：全失败多半是服务没起，请先执行 pnpm dev 启动代理 + pnpm test:server -- --port 4000 --size 2KB 启动源站`);
  }
  console.log(`overall: ${totalFail === 0 ? "ALL PASS" : "SOME FAIL"}`);
  process.exit(totalFail === 0 ? 0 : 1);
}
main();
