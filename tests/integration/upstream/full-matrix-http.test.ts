/**
 * `full-matrix` 的 http / https 半边：server 模式下四种鉴权（none/basic/jwt/uid）× node + curl
 *
 * @module tests/integration/upstream
 *
 * ⚠️ 断言主体是「不带凭证必须被拒」，curl 那一半的前提是它**真的经过了被测代理** ——
 * 理由（`NO_PROXY` 会让 curl 绕过显式 `-x`）见 `./full-matrix-fixture.ts` 的文件头。
 * 共用的目标源站 / curl harness 在 `./full-matrix-fixture.ts`。
 */
import { describe, expect, it } from "vitest";
import tls from "node:tls";
import { HttpProxy } from "@/core/server/http.js";
import { HttpsProxy } from "@/core/server/https.js";
import { FileAccountIdentity } from "@/core/identity.js";
import { TEST_TLS_PATHS } from "../../helpers/certs.js";
import { withProxy } from "../../helpers/proxy.js";
import {
  HAS_CURL,
  connectViaProxy,
  curlAsync,
  httpGetViaProxy,
  httpsProxyGetViaTls,
  targetPort,
} from "./full-matrix-fixture.js";

describe("full-matrix http / https × auth × node/curl", () => {
  it("http: none/basic/jwt/uid (node+curl, CONNECT 200/407)", async () => {
    // none
    await withProxy(HttpProxy, { identity: new FileAccountIdentity({ enabled: false, enableLogging: false }) }, async (pp) => {
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
    await withProxy(HttpProxy, { identity: new FileAccountIdentity({ enabled: true, type: "basic", accounts: [{ username: "test", password: "456" }], enableLogging: false }) }, async (pp) => {
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
    await withProxy(HttpProxy, { identity: new FileAccountIdentity({ enabled: true, type: "jwt", jwtSecret: "s", jwtVerify: async (t, s) => t === "good-token" && s === "s", enableLogging: false }) }, async (pp) => {
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
    // uid 账号的 password 取本用例实际发送的凭证口令：uid 命中账号表（裸用户名或 user:pass/b64 形态）
    await withProxy(HttpProxy, { identity: new FileAccountIdentity({ enabled: true, type: "uid", accounts: [{ username: "test", password: "456" }], enableLogging: false }) }, async (pp) => {
      const ok = await httpGetViaProxy(pp, targetPort, { "Proxy-Authorization": "test" });
      expect(ok.status).toBe(200);
      const ok2 = await httpGetViaProxy(pp, targetPort, { "Proxy-Authorization": `Basic ${Buffer.from("test:456").toString("base64")}` });
      expect(ok2.status).toBe(200);
      const bad = await httpGetViaProxy(pp, targetPort, { "Proxy-Authorization": "wrong" });
      expect(bad.status).toBe(407);
    });
  });

  it("https: none/basic/jwt/uid (TLS + curl -k --proxy-insecure)", async () => {
    await withProxy(HttpsProxy, { identity: new FileAccountIdentity({ enabled: false, enableLogging: false }), tls: TEST_TLS_PATHS }, async (pp) => {
      const r = await httpsProxyGetViaTls(pp, targetPort);
      expect(r.status).toBe(200);
      if (HAS_CURL) {
        const c = await curlAsync(["-k", "--proxy-insecure", "-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "-x", `https://127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c.stdout.slice(-3)).toBe("200");
      }
    });
    await withProxy(HttpsProxy, { identity: new FileAccountIdentity({ enabled: true, type: "basic", accounts: [{ username: "test", password: "456" }], enableLogging: false }), tls: TEST_TLS_PATHS }, async (pp) => {
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
    await withProxy(HttpsProxy, { identity: new FileAccountIdentity({ enabled: true, type: "jwt", jwtSecret: "s", jwtVerify: async (t, s) => t === "good-token" && s === "s", enableLogging: false }), tls: TEST_TLS_PATHS }, async (pp) => {
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
    await withProxy(HttpsProxy, { identity: new FileAccountIdentity({ enabled: true, type: "uid", accounts: [{ username: "test", password: "" }], enableLogging: false }), tls: TEST_TLS_PATHS }, async (pp) => {
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
});
