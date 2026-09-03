import { describe, expect, it } from "vitest";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { HttpsServer } from "@/core/http-server.js";

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

function rawServerOf(srv: HttpsServer): https.Server {
  return (srv as unknown as { server: https.Server }).server;
}

function tlsOpts(port: number): { host: string; port: number; tls: { key: string; cert: string } } {
  return {
    host: "127.0.0.1",
    port,
    tls: {
      key: path.resolve("keys", "server.key"),
      cert: path.resolve("keys", "server.crt"),
    },
  };
}

describe("core/https-server", () => {
  it("钩子未挂时普通请求回 500 而非悬空", async () => {
    const srv = new HttpsServer(tlsOpts(await freePort()));
    await srv.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = https.request(
          { host: "127.0.0.1", port: srv.port, path: "/", rejectUnauthorized: false },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(500);
    } finally {
      await srv.close();
    }
  });

  it("start 成功后不残留一次性 listening/error 监听", async () => {
    const srv = new HttpsServer(tlsOpts(await freePort()));
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
