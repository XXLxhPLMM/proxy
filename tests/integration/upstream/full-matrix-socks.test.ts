/**
 * `full-matrix` 的 socks5 / socks4 半边：server 模式下四种鉴权 × node + curl
 *
 * @module tests/integration/upstream
 *
 * ⚠️ 断言主体是「不带凭证必须被拒」，curl 那一半的前提是它**真的经过了被测代理** ——
 * 理由（`NO_PROXY` 会让 curl 绕过显式 `--socks5` / `--socks4`）见 `./full-matrix-fixture.ts`
 * 的文件头。jwt 那一档**断言拒绝为正确**（USER/PASS 承载不是 Bearer）。
 */
import { describe, expect, it } from "vitest";
import { Socks5Proxy } from "@/core/server/socks5.js";
import { Socks4Proxy } from "@/core/server/socks4.js";
import { FileAccountIdentity } from "@/core/identity.js";
import { withProxy } from "../../helpers/proxy.js";
import {
  HAS_CURL,
  curlAsync,
  socks4ViaOnce,
  socks5ViaOnce,
  targetPort,
} from "./full-matrix-fixture.js";

describe("full-matrix socks5 / socks4 × auth × node/curl", () => {
  it("socks5: none/basic/uid/jwt(拒绝为正确) (node once + curl --socks5)", async () => {
    await withProxy(Socks5Proxy, { identity: new FileAccountIdentity({ enabled: false, enableLogging: false }) }, async (pp) => {
      const r = await socks5ViaOnce(pp, "127.0.0.1", targetPort, null);
      expect(r.ok).toBe(true);
      if (HAS_CURL) {
        const c = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "--socks5", `127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c.stdout.slice(-3)).toBe("200");
      }
    });
    await withProxy(Socks5Proxy, { identity: new FileAccountIdentity({ enabled: true, type: "basic", accounts: [{ username: "test", password: "456" }], enableLogging: false }) }, async (pp) => {
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
    // uid 账号 password 与 ok 用例发送的口令一致（socks5 RFC1929 承载 user:pass → b64 形态命中）
    await withProxy(Socks5Proxy, { identity: new FileAccountIdentity({ enabled: true, type: "uid", accounts: [{ username: "test", password: "whatever" }], enableLogging: false }) }, async (pp) => {
      const ok = await socks5ViaOnce(pp, "127.0.0.1", targetPort, { user: "test", pass: "whatever" });
      expect(ok.ok).toBe(true);
      const bad = await socks5ViaOnce(pp, "127.0.0.1", targetPort, { user: "wrong", pass: "456" });
      expect(bad.ok).toBe(false);
    });
    await withProxy(Socks5Proxy, { identity: new FileAccountIdentity({ enabled: true, type: "jwt", jwtSecret: "s", jwtVerify: async (t, s) => t === "good-token" && s === "s", enableLogging: false }) }, async (pp) => {
      const r = await socks5ViaOnce(pp, "127.0.0.1", targetPort, { user: "good-token", pass: "" });
      expect(r.ok).toBe(false); // socks5 USER_PASS 非 Bearer，拒绝为正确
    });
  });

  it("socks4: none/uid/basic(USERID)/jwt(USERID承载)", async () => {
    await withProxy(Socks4Proxy, { identity: new FileAccountIdentity({ enabled: false, enableLogging: false }) }, async (pp) => {
      const r = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "");
      expect(r.ok).toBe(true);
      if (HAS_CURL) {
        const c = await curlAsync(["-s", "-o", "-", "-w", "%{http_code}", "--max-time", "5", "--socks4", `127.0.0.1:${pp}`, `http://127.0.0.1:${targetPort}/`]);
        expect(c.stdout.slice(-3)).toBe("200");
      }
    });
    await withProxy(Socks4Proxy, { identity: new FileAccountIdentity({ enabled: true, type: "uid", accounts: [{ username: "test", password: "" }], enableLogging: false }) }, async (pp) => {
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
    await withProxy(Socks4Proxy, { identity: new FileAccountIdentity({ enabled: true, type: "basic", accounts: [{ username: "test", password: "456" }], enableLogging: false }) }, async (pp) => {
      const ok = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "test");
      expect(ok.ok).toBe(true);
      const ok2 = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "test:456");
      expect(ok2.ok).toBe(true);
      const bad = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "wrong");
      expect(bad.ok).toBe(false);
    });
    await withProxy(Socks4Proxy, { identity: new FileAccountIdentity({ enabled: true, type: "jwt", jwtSecret: "s", jwtVerify: async (t, s) => t === "good-token" && s === "s", enableLogging: false }) }, async (pp) => {
      const r = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "good-token");
      expect(r.ok).toBe(true);
      const bad = await socks4ViaOnce(pp, "127.0.0.1", targetPort, "bad-token");
      expect(bad.ok).toBe(false);
    });
  });
});
