/**
 * `full-matrix-{http,socks}` 两档共用的前导段：目标源站、curl 子进程 harness 与裸 SOCKS 客户端
 *
 * @module tests/integration/upstream/full-matrix-fixture
 *
 * @description
 * **这一档是 server 模式下的鉴权真值表**（`none` / `basic` / `jwt` / `uid` ×
 * `http` / `https` / `socks5` / `socks4`），每个组合都跑两遍客户端：
 * 一遍裸 node socket，一遍 `curl` 子进程。
 *
 * ⚠️ **curl 那一半的全部价值在「curl 真的经过了被测代理」** —— 它的净化 env 不是洁癖：
 * `curl` 对**显式** `-x` / `--socks5` / `--socks4` 指定的代理同样套用 `NO_PROXY`，
 * 宿主上常见的 `no_proxy=127.0.0.1` 会让请求**绕过代理直连**目标源站，
 * 于是「不带凭证必须被拒」稳定拿到 200，症状看起来像「生产鉴权被绕过」，
 * 实际是 curl 压根没进被测代理。同一段 node 客户端仍能拿到 407，两半合起来才可区分。
 */
import { afterAll, beforeAll } from "vitest";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { spawn, spawnSync } from "node:child_process";
import { set } from "../../helpers/config.js";
import { getFreePort } from "../../helpers/net.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../../helpers/config.js";
/**
 * curl 子进程要用的净化 env：删掉「代理选择类」宿主环境变量。
 *
 * 背景（真实坑，勿删）：curl 对**显式 `-x`/`--socks5`/`--socks4` 指定的代理**同样套用 NO_PROXY 名单——
 * 名单内的目标主机（宿主/CI 上极常见的 `no_proxy=127.0.0.1,localhost`）会被**绕过代理直连**。
 * 本目录两档的断言主体恰恰是「不带凭证必须被拒（407 / socks 非成功）」：一旦被绕过，
 * 请求直达测试 target origin，稳定拿到 200 + `hello-from-target`，症状看起来像「生产鉴权被绕过」，
 * 实际是 curl 压根没经过被测代理（同一段 node socket 客户端断言仍能拿到 407，可据此区分）。
 * `*_proxy` 一并删掉：它们是宿主出口代理，泄漏进来会让用例依赖外网。
 */
const CURL_PROXY_ENV_KEYS = ["no_proxy", "NO_PROXY", "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"] as const;
function curlEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of CURL_PROXY_ENV_KEYS) {
    delete env[k];
  }
  return env;
}
function curlAvailable() {
  const r = spawnSync("curl", ["--version"], { encoding: "utf8", env: curlEnv() });
  return r.status === 0;
}
export const HAS_CURL = curlAvailable();
export function curlAsync(args: string[], timeout = 6000): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    const p = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"], env: curlEnv() });
    let out = "",
      err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      p.kill();
      resolve({ stdout: out, stderr: err, status: null });
    }, timeout);
    p.stdout.on("data", (c) => (out += c.toString()));
    p.stderr.on("data", (c) => (err += c.toString()));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (!killed) resolve({ stdout: out, stderr: err, status: code });
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, status: null });
    });
  });
}
export function httpGetViaProxy(proxyPort: number, targetPort: number, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, method: "GET", path: `http://127.0.0.1:${targetPort}/`, headers: { Host: `127.0.0.1:${targetPort}`, ...headers } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
export function connectViaProxy(proxyPort: number, targetPort: number, authB64?: string) {
  return new Promise<{ connectStatus: number; status?: number; body?: string }>((resolve, reject) => {
    const s = net.createConnection(proxyPort, "127.0.0.1", () => {
      const auth = authB64 ? `Proxy-Authorization: Basic ${authB64}\r\n` : "";
      s.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n${auth}Proxy-Connection: Keep-Alive\r\n\r\n`);
    });
    s.once("data", (d) => {
      const line = d.toString().split("\r\n")[0] ?? "";
      const st = parseInt(line.split(" ")[1] ?? "0", 10);
      if (st !== 200) {
        s.destroy();
        resolve({ connectStatus: st });
        return;
      }
      s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`);
      let data = "";
      s.on("data", (c) => (data += c.toString()));
      s.on("end", () => {
        const st2 = parseInt((data.split("\r\n")[0] ?? "").split(" ")[1] ?? "0", 10);
        resolve({ connectStatus: st, status: st2, body: data });
      });
      s.on("error", reject);
    });
    s.on("error", reject);
    setTimeout(() => reject(new Error("CONNECT timeout")), 5000);
  });
}
export function httpsProxyGetViaTls(proxyPort: number, targetPort: number, authB64?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port: proxyPort, rejectUnauthorized: false, servername: "127.0.0.1" }, () => {
      s.write(`GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n${authB64 ? `Proxy-Authorization: Basic ${authB64}\r\n` : ""}Connection: close\r\n\r\n`);
    });
    let data = "";
    s.on("data", (c) => (data += c.toString()));
    s.on("end", () => {
      const st = parseInt((data.split("\r\n")[0] ?? "").split(" ")[1] ?? "0", 10);
      resolve({ status: st, body: data });
    });
    s.on("error", reject);
    setTimeout(() => {
      s.destroy();
      reject(new Error("https proxy timeout"));
    }, 6000);
  });
}
export function socks5ViaOnce(proxyPort: number, targetHost: string, targetPort: number, creds: { user: string; pass: string } | null) {
  return new Promise<{ ok: boolean; stage: string; code?: number; body?: string }>((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port: proxyPort }, () => {
      const methods = creds ? Buffer.from([0x05, 0x01, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
      s.write(methods);
    });
    const timer = setTimeout(() => {
      s.destroy();
      resolve({ ok: false, stage: "timeout" });
    }, 6000);
    s.once("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stage: "error" });
    });
    s.once("data", (d1) => {
      if (!d1 || d1[0] !== 0x05) {
        clearTimeout(timer);
        s.destroy();
        resolve({ ok: false, stage: "hs-ver" });
        return;
      }
      if (creds && d1[1] === 0x02) {
        const u = Buffer.from(creds.user),
          p = Buffer.from(creds.pass);
        s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        s.once("data", (d2) => {
          if (!d2 || d2[1] !== 0x00) {
            clearTimeout(timer);
            s.destroy();
            resolve({ ok: false, stage: "auth", code: d2?.[1] });
            return;
          }
          const hb = Buffer.from(targetHost);
          s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])]));
          s.once("data", (d3) => {
            if (!d3 || d3[1] !== 0x00) {
              clearTimeout(timer);
              s.destroy();
              resolve({ ok: false, stage: "connect", code: d3?.[1] });
              return;
            }
            s.write(`GET / HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`);
            let buf = "";
            s.on("data", (c) => (buf += c.toString()));
            s.on("end", () => {
              clearTimeout(timer);
              resolve({ ok: buf.includes("hello-from-target"), stage: "ok", body: buf });
            });
            setTimeout(() => {
              clearTimeout(timer);
              s.destroy();
              resolve({ ok: buf.includes("hello-from-target"), stage: "ok-timeout", body: buf });
            }, 2000);
          });
        });
      } else if (!creds && d1[1] === 0x00) {
        const hb = Buffer.from(targetHost);
        s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])]));
        s.once("data", (d3) => {
          if (!d3 || d3[1] !== 0x00) {
            clearTimeout(timer);
            s.destroy();
            resolve({ ok: false, stage: "connect-noauth", code: d3?.[1] });
            return;
          }
          s.write(`GET / HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`);
          let buf = "";
          s.on("data", (c) => (buf += c.toString()));
          s.on("end", () => {
            clearTimeout(timer);
            resolve({ ok: buf.includes("hello-from-target"), stage: "ok", body: buf });
          });
          setTimeout(() => {
            clearTimeout(timer);
            s.destroy();
            resolve({ ok: buf.includes("hello-from-target"), stage: "ok-timeout", body: buf });
          }, 2000);
        });
      } else {
        clearTimeout(timer);
        s.destroy();
        resolve({ ok: false, stage: "method", code: d1[1] });
      }
    });
  });
}
export function socks4ViaOnce(proxyPort: number, targetHost: string, targetPort: number, userid: string) {
  return new Promise<{ ok: boolean; stage: string; code?: number; body?: string }>((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port: proxyPort }, () => {
      const uid = Buffer.from(userid || "");
      let req: Buffer;
      const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(targetHost);
      if (isIp) {
        const oct = targetHost.split(".").map(Number);
        req = Buffer.concat([Buffer.from([0x04, 0x01, (targetPort >> 8) & 0xff, targetPort & 0xff, oct[0], oct[1], oct[2], oct[3]]), uid, Buffer.from([0x00])]);
      } else {
        const dom = Buffer.from(targetHost);
        req = Buffer.concat([Buffer.from([0x04, 0x01, (targetPort >> 8) & 0xff, targetPort & 0xff, 0x00, 0x00, 0x00, 0x01]), uid, Buffer.from([0x00]), dom, Buffer.from([0x00])]);
      }
      s.write(req);
    });
    const timer = setTimeout(() => {
      s.destroy();
      resolve({ ok: false, stage: "timeout" });
    }, 6000);
    s.once("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stage: "error" });
    });
    s.once("data", (d) => {
      if (!d || d.length < 2 || d[0] !== 0x00 || d[1] !== 0x5a) {
        clearTimeout(timer);
        s.destroy();
        resolve({ ok: false, stage: "socks4-reject", code: d?.[1] });
        return;
      }
      s.write(`GET / HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`);
      let buf = "";
      s.on("data", (c) => (buf += c.toString()));
      s.on("end", () => {
        clearTimeout(timer);
        resolve({ ok: buf.includes("hello-from-target"), stage: "ok", body: buf });
      });
      setTimeout(() => {
        clearTimeout(timer);
        s.destroy();
        resolve({ ok: buf.includes("hello-from-target"), stage: "ok-timeout", body: buf });
      }, 2000);
    });
  });
}

export let targetPort = 0;
let target: http.Server | null = null;
const prev = snapshotConfig(["host", "port", "proxyMode", "logLevel", "logFile"]);

beforeAll(async () => {
  targetPort = await getFreePort();
  set("host", "127.0.0.1");
  set("proxyMode", "server");
  silenceLogs();
  target = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello-from-target");
  });
  await new Promise<void>((r) => target!.listen(targetPort, "127.0.0.1", r));
  console.log(`\n[full-matrix] target http://127.0.0.1:${targetPort} HAS_CURL=${HAS_CURL}`);
});
afterAll(async () => {
  await new Promise<void>((r) => target?.close(() => r()));
  restoreConfig(prev);
});
