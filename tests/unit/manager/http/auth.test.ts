/**
 * 鉴权：每一个方法都要过，且先于路由
 *
 * @description
 * 本档盯 `Authorization: Bearer` 那一条判据：七个方法 × 无 / 错 / 对 token 的真值表、
 * `WWW-Authenticate` 必须随同一次 `writeHead` 写出（之后再 `setHeader` 不生效），
 * 以及「未鉴权者拿不到 404 与 405 的区分」——那条区分本身就是一张端点清单。
 * 真 server 起在端口 0 上；共用 fixture 与主题级不变量见 `./_manager-http.ts` / `./AGENTS.md`。
 * @module tests/unit/manager/http
 */
import { describe, expect, it } from "vitest";
import { authorize, createManagerServer, MAX_BODY_BYTES, NO_CORS } from "@/manager/http/index.js";
import { TOKEN, call, logger, port, routesFor } from "./_manager-http.js";

describe("鉴权：每一个方法都要过，且先于路由", () => {
  const methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"];

  it("无 token ⇒ 401（逐个方法）", async () => {
    for (const method of methods) {
      const reply = await call(port, { method, path: "/api/status", token: null });
      expect(reply.status, `${method} 无 token 必须是 401`).toBe(401);
    }
  });

  it("错 token ⇒ 401（逐个方法）", async () => {
    for (const method of methods) {
      const reply = await call(port, { method, path: "/api/status", token: "not-the-token" });
      expect(reply.status, `${method} 错 token 必须是 401`).toBe(401);
    }
  });

  it("token 长度不等时也是 401 而不是 500（timingSafeEqual 长度不等会抛）", async () => {
    for (const wrong of ["", "m", TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.repeat(2)]) {
      const reply = await call(port, { token: wrong });
      expect(reply.status, `token=${JSON.stringify(wrong)} 必须是 401`).toBe(401);
    }
  });

  it("正确 token ⇒ 200", async () => {
    expect((await call(port)).status).toBe(200);
  });

  it("空 token 的服务一律 401（HTTP 层不依赖 loadConfig 的那条校验）", async () => {
    const s = createManagerServer({
      token: "",
      routes: routesFor(),
      logger,
      maxBodyBytes: MAX_BODY_BYTES,
      cors: NO_CORS,
    });
    await new Promise<void>((resolve) => {
      s.listen(0, "127.0.0.1", () => resolve());
    });
    const p = (s.address() as { port: number }).port;
    try {
      expect((await call(p, { token: "" })).status).toBe(401);
      expect((await call(p, { token: TOKEN })).status).toBe(401);
    } finally {
      s.closeAllConnections();
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
      });
    }
  });

  it("401 带 WWW-Authenticate，且**不回显**本次带来的凭据", async () => {
    const reply = await call(port, { token: "leaked-canary-value" });
    expect(reply.status).toBe(401);
    expect(reply.headers["www-authenticate"]).toContain("Bearer");
    expect(reply.raw).not.toContain("leaked-canary-value");
  });

  it("未鉴权者拿不到 404 与 405 的区分（那条区分本身就是端点清单）", async () => {
    const missing = await call(port, { path: "/api/nope", token: null });
    const wrongMethod = await call(port, { method: "DELETE", path: "/api/status", token: null });
    expect(missing.status).toBe(401);
    expect(wrongMethod.status).toBe(401);
    expect(missing.headers.allow).toBeUndefined();
    expect(wrongMethod.headers.allow).toBeUndefined();
  });

  it("`authorize` 是纯函数：空 token 恒 false、长度不等不抛（直接断言那个零件）", () => {
    expect(authorize("Bearer " + TOKEN, TOKEN)).toBe(true);
    expect(authorize("bearer " + TOKEN, TOKEN)).toBe(true);
    expect(authorize("Bearer " + TOKEN, "")).toBe(false);
    expect(authorize(undefined, TOKEN)).toBe(false);
    expect(authorize("Basic " + TOKEN, TOKEN)).toBe(false);
    expect(authorize("Bearer " + TOKEN, "totally-different")).toBe(false);
  });
});
