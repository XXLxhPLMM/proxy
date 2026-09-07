import { describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { HttpServer } from "@/core/server/http.js";

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

function rawServerOf(srv: HttpServer): http.Server {
  return (srv as unknown as { server: http.Server }).server;
}

describe("core/http", () => {
  it("钩子未挂时普通请求回 500 而非悬空", async () => {
    const srv = new HttpServer({ host: "127.0.0.1", port: await freePort() });
    await srv.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: srv.port, path: "/" }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(500);
    } finally {
      await srv.close();
    }
  });

  it("start 成功后不残留一次性 listening/error 监听", async () => {
    const srv = new HttpServer({ host: "127.0.0.1", port: await freePort() });
    const raw = rawServerOf(srv);
    const errBefore = raw.listenerCount("error");
    const listeningBefore = raw.listenerCount("listening");
    await srv.start();
    try {
      expect(raw.listenerCount("error")).toBe(errBefore);
      expect(raw.listenerCount("listening")).toBe(listeningBefore);
    } finally {
      await srv.close();
    }
  });
});
