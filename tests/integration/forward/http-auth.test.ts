/**
 * 鉴权层本身的判定面（**不走真实 CLI 装配**）：总开关 `enabled` 优先于 `type`、
 * basic 与 jwt 各自「凭证对 → 放行 / 错 · 缺 → 407」，以及 jwt 未注入 `verify` 时**拒而不崩**。
 *
 * 为什么是**直构 `FileAccountIdentity`**：这一档要验的是「判定层拿到什么就判什么」，所以
 * `verify` 那类只由装配层注入的回调能被单独造出来（误配那一档就是这么造的）；走完整装配的
 * 那一面 —— 含代理起停与入站形态 —— 在 `http-client-node.test.ts`（那里也钉 basic 三格，
 * 但钉的是**装配之后**的行为）。⚠️ 两处「basic 三格」不是重复：换一份装配就换一份会被漏掉的
 * 中间态，故两档各留一份。
 *
 * 起停真 `HttpProxy` 的装配面归 `./client-node-fixture.ts`；主题级判据与本目录清单见 `./AGENTS.md`。
 *
 * @module tests/integration/forward
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { FileAccountIdentity } from "@/core/identity.js";
import { getFreePort } from "../../helpers/net.js";
import { restoreConfig, snapshotConfig } from "../../helpers/config.js";
import { KEYS, serverBaseConfig, startProxy } from "./client-node-fixture.js";

function httpGetViaProxy(
  proxyPort: number,
  targetPort: number,
  pathSuffix = "/hello",
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://127.0.0.1:${targetPort}${pathSuffix}`,
        headers: { Host: `127.0.0.1:${targetPort}`, ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("forward · http-auth（鉴权层判定面）", () => {
  let targetPort = 0;
  let target: http.Server | null = null;
  const prev = snapshotConfig(KEYS);

  beforeAll(async () => {
    targetPort = await getFreePort();

    serverBaseConfig();

    target = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello-from-target");
    });
    await new Promise<void>((resolve) => target!.listen(targetPort, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => target?.close(() => resolve()));
    restoreConfig(prev);
  });

  it("无鉴权：enabled=false 直接放行", async () => {
    const { proxy, port } = await startProxy(new FileAccountIdentity({ enabled: false, enableLogging: false }));
    try {
      const r = await httpGetViaProxy(port, targetPort);
      expect(r.status).toBe(200);
      expect(r.body).toBe("hello-from-target");
    } finally {
      await proxy.stop();
    }
  });

  it("总开关优先：enabled=false + type=basic，带错凭证也放行", async () => {
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({
        enabled: false,
        type: "basic",
        accounts: [{ username: "u", password: "p" }],
        enableLogging: false,
      }),
    );
    try {
      const r = await httpGetViaProxy(port, targetPort, "/hello", {
        "Proxy-Authorization": "Basic d3Jvbmc=",
      });
      expect(r.status).toBe(200);
    } finally {
      await proxy.stop();
    }
  });

  it("basic经Header：正确放行 / 错误407 / 缺失407", async () => {
    const b64 = Buffer.from("u:p").toString("base64");
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({
        enabled: true,
        type: "basic",
        accounts: [{ username: "u", password: "p" }],
        enableLogging: false,
      }),
    );
    try {
      const ok = await httpGetViaProxy(port, targetPort, "/hello", {
        "Proxy-Authorization": `Basic ${b64}`,
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toBe("hello-from-target");
      const wrong = await httpGetViaProxy(port, targetPort, "/hello", {
        "Proxy-Authorization": "Basic d3Jvbmc=",
      });
      expect(wrong.status).toBe(407);
      const missing = await httpGetViaProxy(port, targetPort);
      expect(missing.status).toBe(407);
    } finally {
      await proxy.stop();
    }
  });

  it("jwt：合法token放行 / 非法407 / 缺失407", async () => {
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({
        enabled: true,
        type: "jwt",
        jwtSecret: "s",
        jwtVerify: async (t, s) => t === "good-token" && s === "s",
        enableLogging: false,
      }),
    );
    try {
      const ok = await httpGetViaProxy(port, targetPort, "/hello", {
        Authorization: "Bearer good-token",
      });
      expect(ok.status).toBe(200);
      const bad = await httpGetViaProxy(port, targetPort, "/hello", {
        Authorization: "Bearer bad-token",
      });
      expect(bad.status).toBe(407);
      const missing = await httpGetViaProxy(port, targetPort);
      expect(missing.status).toBe(407);
    } finally {
      await proxy.stop();
    }
  });

  it("jwt误配（未注入verify）：拒绝407且服务不崩", async () => {
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({ enabled: true, type: "jwt", jwtSecret: "s", enableLogging: false }),
    );
    try {
      const first = await httpGetViaProxy(port, targetPort, "/hello", {
        Authorization: "Bearer anything",
      });
      expect(first.status).toBe(407);
      // 服务仍存活，可继续拒绝下一个请求
      const second = await httpGetViaProxy(port, targetPort);
      expect(second.status).toBe(407);
      expect(proxy.isRunning()).toBe(true);
    } finally {
      await proxy.stop();
    }
  });
});
