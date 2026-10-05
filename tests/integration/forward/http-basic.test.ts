/**
 * **最小可跑形态**：明文 HTTP 直转发通（200 + body）、生命周期说得对（`isRunning` /
 * `state` / `getStats`、重复 `start()` 幂等），以及另起一个带鉴权实例时的 407 / 放行。
 *
 * 这一档**不验证任何转发语义**（字节形态归 `./contract/` 与 `http-request-line`），它钉的是
 * 「`HttpProxy` 起得来、状态机说得对、最小转发通」—— 目录里其余每一档都要先有这个基线才谈别的。
 *
 * ⚠️ `access` 显式取 `openAccessControl()`（点名「不判名单」）是**这一档自己的选择**：
 * 这里要验的就是转发与状态机，接上真名单判定只会把一份 ACL 文件的读盘失败混进症状里。
 * 名单判定那一面在 `./acl/` 与 `./connector-wiring/`。
 * 主题级判据与本目录清单见 `./AGENTS.md`。
 *
 * @module tests/integration/forward
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { set, testContext } from "../../helpers/config.js";
import { HttpProxy } from "@/core/server/http.js";
import { FileAccountIdentity } from "@/core/identity.js";
import { getFreePort } from "../../helpers/net.js";
import { openAccessControl } from "../../helpers/access.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../../helpers/config.js";

function httpGetViaProxy(
  proxyPort: number,
  targetPort: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://127.0.0.1:${targetPort}/hello`,
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

describe("forward · http-basic（最小可跑形态）", () => {
  let targetPort = 0;
  let proxyPort = 0;
  let target: http.Server | null = null;
  let proxy: HttpProxy | null = null;
  const prev = snapshotConfig(["host", "port", "proxyMode", "logLevel", "logFile"]);

  beforeAll(async () => {
    targetPort = await getFreePort();
    proxyPort = await getFreePort();
    // 降噪：关闭控制台与文件日志
    silenceLogs();
    set("host", "127.0.0.1");
    set("port", proxyPort);
    set("proxyMode", "server");

    target = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello-from-target");
    });
    await new Promise<void>((resolve) => target!.listen(targetPort, "127.0.0.1", resolve));

    proxy = new HttpProxy({
      ctx: testContext,
      host: "127.0.0.1",
      port: proxyPort,
      identity: new FileAccountIdentity({ enabled: false }),
      // 基本转发/生命周期用例与名单无关 → 显式点名「不判名单」
      access: openAccessControl(),
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy?.stop().catch(() => undefined);
    await new Promise<void>((resolve) => target?.close(() => resolve()));
    restoreConfig(prev);
  });

  it("普通 HTTP 经代理转发到目标并回包", async () => {
    const { status, body } = await httpGetViaProxy(proxyPort, targetPort);
    expect(status).toBe(200);
    expect(body).toBe("hello-from-target");
  });

  it("生命周期：运行态快照正确，重复 start 幂等", async () => {
    expect(proxy!.isRunning()).toBe(true);
    expect(proxy!.state).toBe("running");
    await proxy!.start();
    expect(proxy!.state).toBe("running");
    const stats = proxy!.getStats();
    expect(stats.protocol).toBe("http");
    expect(stats.running).toBe(true);
  });

  it("鉴权开启时无凭证回 407，有凭证放行", async () => {
    // 另起一个带鉴权的代理实例，避免污染主实例
    const authPort = await getFreePort();
    set("port", authPort);
    const authed = new HttpProxy({
      ctx: testContext,
      host: "127.0.0.1",
      port: authPort,
      identity: new FileAccountIdentity({
        enabled: true,
        type: "basic",
        accounts: [{ username: "u", password: "p" }],
        enableLogging: false,
      }),
      // 鉴权用例与名单无关 → 显式点名「不判名单」
      access: openAccessControl(),
    });
    await authed.start();
    try {
      const denied = await httpGetViaProxy(authPort, targetPort);
      expect(denied.status).toBe(407);
      const b64 = Buffer.from("u:p").toString("base64");
      const allowed = await httpGetViaProxy(authPort, targetPort, {
        "Proxy-Authorization": `Basic ${b64}`,
      });
      expect(allowed.status).toBe(200);
      expect(allowed.body).toBe("hello-from-target");
    } finally {
      await authed.stop();
      set("port", proxyPort);
    }
  });
});
