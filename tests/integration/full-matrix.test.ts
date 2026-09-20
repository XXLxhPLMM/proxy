import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { spawn, spawnSync } from "node:child_process";
import { set } from "@/config/store.js";
import { HttpProxy } from "@/core/server/http.js";
import { HttpsProxy } from "@/core/server/https.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import { Socks4Proxy } from "@/core/server/socks4.js";
import { Auth } from "@/core/auth.js";
import { getFreePort } from "../helpers/net.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";
import { TEST_TLS_PATHS } from "../helpers/certs.js";
import { withProxy } from "../helpers/proxy.js";
function curlAvailable() {
  const r = spawnSync("curl", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}
const HAS_CURL = curlAvailable();
function curlAsync(args: string[], timeout = 6000): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    const p = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
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
function httpGetViaProxy(proxyPort: number, targetPort: number, headers: Record<string, string> = {}) {
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
function connectViaProxy(proxyPort: number, targetPort: number, authB64?: string) {
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
function httpsProxyGetViaTls(proxyPort: number, targetPort: number, authB64?: string) {
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
function socks5ViaOnce(proxyPort: number, targetHost: string, targetPort: number, creds: { user: string; pass: string } | null) {
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
function socks4ViaOnce(proxyPort: number, targetHost: string, targetPort: number, userid: string) {
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

describe("full-matrix http/https/socks4/socks5 × auth × node/curl", () => {
  let targetPort = 0;
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

  it("http: none/basic/jwt/uid (node+curl, CONNECT 200/407)", async () => {
    // none
    await withProxy(HttpProxy, { auth: new Auth({ enabled: false, enableLogging: false }) }, async (pp) => {
      const r = await httpGetViaProxy(pp, targetPort);
      expect(r.status).toBe(200);
      expect(r.body).toContain("hello-from-target");
      if (HAS_CURL) {
        const c = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "-x", `http://127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c.stdout.slice(-3)).toBe("200");
        expect(c.stdout).toContain("hello-from-target");
      }
    });
    // basic
    await withProxy(HttpProxy, { auth: new Auth({ enabled: true, type: "basic", username: "test", password: "456", enableLogging: false }) }, async (pp) => {
      const b64 = Buffer.from("test:456").toString("base64");
      const ok = await httpGetViaProxy(pp, targetPort, { "Proxy-Authorization": `Basic ${b64}` });
      expect(ok.status).toBe(200);
      const bad = await httpGetViaProxy(pp, targetPort, { "Proxy-Authorization": `Basic ${Buffer.from("test:123").toString("base64")}` });
      expect(bad.status).toBe(407);
      const miss = await httpGetViaProxy(pp, targetPort);
      expect(miss.status).toBe(407);
      if (HAS_CURL) {
        const c1 = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "--proxy-user", "test:456", "-x", `http://127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c1.stdout.slice(-3)).toBe("200");
        const c2 = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "-x", `http://127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c2.stdout.slice(-3)).toBe("407");
      }
      const t1 = await connectViaProxy(pp, targetPort, b64);
      expect(t1.connectStatus).toBe(200);
      expect(t1.status).toBe(200);
      const t2 = await connectViaProxy(pp, targetPort);
      expect(t2.connectStatus).toBe(407);
    });
    // jwt
    await withProxy(HttpProxy, { auth: new Auth({ enabled: true, type: "jwt", jwtSecret: "s", jwtVerify: async (t, s) => t === "good-token" && s === "s", enableLogging: false }) }, async (pp) => {
      const ok = await httpGetViaProxy(pp, targetPort, { "Proxy-Authorization": "Bearer good-token" });
      expect(ok.status).toBe(200);
      const bad = await httpGetViaProxy(pp, targetPort, { "Proxy-Authorization": "Bearer bad-token" });
      expect(bad.status).toBe(407);
      const miss = await httpGetViaProxy(pp, targetPort);
      expect(miss.status).toBe(407);
      if (HAS_CURL) {
        const c1 = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "-H", "Proxy-Authorization: Bearer good-token", "-x", `http://127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c1.stdout.slice(-3)).toBe("200");
      }
    });
    // uid
    await withProxy(HttpProxy, { auth: new Auth({ enabled: true, type: "uid", username: "test", enableLogging: false }) }, async (pp) => {
      const ok = await httpGetViaProxy(pp, targetPort, { "Proxy-Authorization": "test" });
      expect(ok.status).toBe(200);
      const ok2 = await httpGetViaProxy(pp, targetPort, { "Proxy-Authorization": `Basic ${Buffer.from("test:456").toString("base64")}` });
      expect(ok2.status).toBe(200);
      const bad = await httpGetViaProxy(pp, targetPort, { "Proxy-Authorization": "wrong" });
      expect(bad.status).toBe(407);
    });
  });

  it("https: none/basic/jwt/uid (TLS + curl -k --proxy-insecure)", async () => {
    await withProxy(HttpsProxy, { auth: new Auth({ enabled: false, enableLogging: false }), tls: TEST_TLS_PATHS }, async (pp) => {
      const r = await httpsProxyGetViaTls(pp, targetPort);
      expect(r.status).toBe(200);
      if (HAS_CURL) {
        const c = await curlAsync(["-k", "--proxy-insecure", "-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "-x", `https://127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c.stdout.slice(-3)).toBe("200");
      }
    });
    await withProxy(HttpsProxy, { auth: new Auth({ enabled: true, type: "basic", username: "test", password: "456", enableLogging: false }), tls: TEST_TLS_PATHS }, async (pp) => {
      const b64 = Buffer.from("test:456").toString("base64");
      const ok = await httpsProxyGetViaTls(pp, targetPort, b64);
      expect(ok.status).toBe(200);
      const miss = await httpsProxyGetViaTls(pp, targetPort);
      expect(miss.status).toBe(407);
      if (HAS_CURL) {
        const c1 = await curlAsync(["-k", "--proxy-insecure", "-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "--proxy-user", "test:456", "-x", `https://127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c1.stdout.slice(-3)).toBe("200");
        const c2 = await curlAsync(["-k", "--proxy-insecure", "-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "-x", `https://127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c2.stdout.slice(-3)).toBe("407");
      }
    });
    await withProxy(HttpsProxy, { auth: new Auth({ enabled: true, type: "jwt", jwtSecret: "s", jwtVerify: async (t, s) => t === "good-token" && s === "s", enableLogging: false }), tls: TEST_TLS_PATHS }, async (pp) => {
      const raw: any = await new Promise((res, rej) => {
        const s = tls.connect({ host: "127.0.0.1", port: pp, rejectUnauthorized: false }, () => {
          s.write(`GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nProxy-Authorization: Bearer good-token\r\nConnection: close\r\n\r\n`);
        });
        let d = "";
        s.on("data", (c) => (d += c.toString()));
        s.on("end", () => res({ status: parseInt((d.split("\r\n")[0] ?? "").split(" ")[1] ?? "0", 10), body: d }));
        s.on("error", rej);
        setTimeout(() => {
          s.destroy();
          rej(new Error("timeout"));
        }, 5000);
      });
      expect(raw.status).toBe(200);
    });
    await withProxy(HttpsProxy, { auth: new Auth({ enabled: true, type: "uid", username: "test", enableLogging: false }), tls: TEST_TLS_PATHS }, async (pp) => {
      const raw: any = await new Promise((res, rej) => {
        const s = tls.connect({ host: "127.0.0.1", port: pp, rejectUnauthorized: false }, () => {
          s.write(`GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nProxy-Authorization: test\r\nConnection: close\r\n\r\n`);
        });
        let d = "";
        s.on("data", (c) => (d += c.toString()));
        s.on("end", () => res({ status: parseInt((d.split("\r\n")[0] ?? "").split(" ")[1] ?? "0", 10), body: d }));
        s.on("error", rej);
        setTimeout(() => {
          s.destroy();
          rej(new Error("timeout"));
        }, 5000);
      });
      expect(raw.status).toBe(200);
    });
  });

  it("socks5: none/basic/uid/jwt(拒绝为正确) (node once + curl --socks5)", async () => {
    await withProxy(Socks5Proxy, { auth: new Auth({ enabled: false, enableLogging: false }) }, async (pp) => {
      const r = await socks5ViaOnce(pp, "127.0.0.1", targetPort, null);
      expect(r.ok).toBe(true);
      if (HAS_CURL) {
        const c = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "--socks5", `127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c.stdout.slice(-3)).toBe("200");
      }
    });
    await withProxy(Socks5Proxy, { auth: new Auth({ enabled: true, type: "basic", username: "test", password: "456", enableLogging: false }) }, async (pp) => {
      const ok = await socks5ViaOnce(pp, "127.0.0.1", targetPort, { user: "test", pass: "456" });
      expect(ok.ok).toBe(true);
      const bad = await socks5ViaOnce(pp, "127.0.0.1", targetPort, { user: "test", pass: "123" });
      expect(bad.ok).toBe(false);
      const miss = await socks5ViaOnce(pp, "127.0.0.1", targetPort, null);
      expect(miss.ok).toBe(false);
      if (HAS_CURL) {
        const c1 = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "--socks5", `test:456@127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c1.stdout.slice(-3)).toBe("200");
        const c2 = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "--socks5", `127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c2.stdout.slice(-3) !== "200").toBe(true);
      }
    });
    await withProxy(Socks5Proxy, { auth: new Auth({ enabled: true, type: "uid", username: "test", enableLogging: false }) }, async (pp) => {
      const ok = await socks5ViaOnce(pp, "127.0.0.1", targetPort, { user: "test", pass: "whatever" });
      expect(ok.ok).toBe(true);
      const bad = await socks5ViaOnce(pp, "127.0.0.1", targetPort, { user: "wrong", pass: "456" });
      expect(bad.ok).toBe(false);
    });
    await withProxy(Socks5Proxy, { auth: new Auth({ enabled: true, type: "jwt", jwtSecret: "s", jwtVerify: async (t, s) => t === "good-token" && s === "s", enableLogging: false }) }, async (pp) => {
      const r = await socks5ViaOnce(pp, "127.0.0.1", targetPort, { user: "good-token", pass: "" });
      expect(r.ok).toBe(false); // socks5 USER_PASS 非 Bearer，拒绝为正确
    });
  });

  it("socks4: none/uid/basic兼容/jwt(USERID承载)", async () => {
    await withProxy(Socks4Proxy, { auth: new Auth({ enabled: false, enableLogging: false }) }, async (pp) => {
      const r = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "");
      expect(r.ok).toBe(true);
      if (HAS_CURL) {
        const c = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "--socks4", `127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c.stdout.slice(-3)).toBe("200");
      }
    });
    await withProxy(Socks4Proxy, { auth: new Auth({ enabled: true, type: "uid", username: "test", enableLogging: false }) }, async (pp) => {
      const ok = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "test");
      expect(ok.ok).toBe(true);
      const bad = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "wrong");
      expect(bad.ok).toBe(false);
      const empty = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "");
      expect(empty.ok).toBe(false);
      if (HAS_CURL) {
        const c1 = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "--socks4", `test@127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c1.stdout.slice(-3)).toBe("200");
        const c2 = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "--socks4", `wrong@127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c2.stdout.slice(-3) !== "200").toBe(true);
      }
    });
    await withProxy(Socks4Proxy, { auth: new Auth({ enabled: true, type: "basic", username: "test", password: "456", enableLogging: false }) }, async (pp) => {
      const ok = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "test");
      expect(ok.ok).toBe(true);
      const ok2 = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "test:456");
      expect(ok2.ok).toBe(true);
      const bad = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "wrong");
      expect(bad.ok).toBe(false);
    });
    await withProxy(Socks4Proxy, { auth: new Auth({ enabled: true, type: "jwt", jwtSecret: "s", jwtVerify: async (t, s) => t === "good-token" && s === "s", enableLogging: false }) }, async (pp) => {
      const r = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "good-token");
      expect(r.ok).toBe(true);
      const bad = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "bad-token");
      expect(bad.ok).toBe(false);
    });
  });
});
