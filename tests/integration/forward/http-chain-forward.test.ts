/**
 * 明文串联的三条：client → front(client) → back(server) → target 的 absolute-form 转发、
 * 客户端凭证头不透传（后级只认前级显式账密）、以及前级配了上游账密时的注入放行。
 *
 * `SPAWN_CWD` 为什么必须在仓库之外、子进程与测试进程不共享 store 这两条，归
 * `../../helpers/child-proxy.ts` 的文件头（本目录任何档都不许复述它）；CONNECT 隧道那四条在
 * `http-chain-tunnel.test.ts`。主题级判据与本目录清单见 `./AGENTS.md`。
 *
 * @module tests/integration/forward
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  SPAWN_CWD,
  baseArgs,
  disposeSpawnCwd,
  ensureDistBuilt,
  spawnProxy,
  stopChild,
  waitForPort,
} from "../../helpers/child-proxy.js";
import { getFreePort } from "../../helpers/net.js";

/**
 * 鉴权账号文件：多账号配置的唯一入口（CLI 只剩 `--auth-users-file` 路径）。
 * 子进程与测试进程不共享内存，故写临时文件并传绝对路径。
 *
 * ⚠️ 写在 `SPAWN_CWD` 里而不是另开一个目录：那个目录**必须**在仓库之外（理由见
 * `helpers/child-proxy.ts` 的隔离 ①），账号表放在别处就等于又引入一个相对路径。
 */
const USERS_FILE = path.join(SPAWN_CWD, "users.json");
fs.writeFileSync(USERS_FILE, JSON.stringify([{ username: "u", password: "p" }]));

/** 经 front 代理以 absolute-form 请求目标 */
function getViaChain(
  frontPort: number,
  targetPort: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: frontPort,
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

describe("forward · http-chain-forward（明文串联）", () => {
  let targetPort = 0;
  let backPort = 0;
  let frontPort = 0;
  let target: http.Server | null = null;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    await ensureDistBuilt();
    targetPort = await getFreePort();
    backPort = await getFreePort();
    frontPort = await getFreePort();

    target = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello-via-chain");
    });
    await new Promise<void>((resolve) => target!.listen(targetPort, "127.0.0.1", resolve));

    // 后级：server 模式，直接解析 absolute URL 回源
    children.push(spawnProxy([...baseArgs(backPort), "--proxy-mode", "server"]));
    // 前级：client 模式，原样把 absolute-form 请求转给 UPSTREAM（后级代理）
    children.push(
      spawnProxy([
        ...baseArgs(frontPort),
        "--proxy-mode",
        "client",
        "--upstream-host",
        "127.0.0.1",
        "--upstream-port",
        String(backPort),
      ]),
    );
    await waitForPort(backPort);
    await waitForPort(frontPort);
  }, 30000);

  afterAll(async () => {
    await Promise.all(children.map((c) => stopChild(c)));
    await new Promise<void>((resolve) => target?.close(() => resolve()));
    disposeSpawnCwd();
  });

  it("明文串联：client -> front(client) -> back(server) -> target", async () => {
    const r = await getViaChain(frontPort, targetPort);
    expect(r.status).toBe(200);
    expect(r.body).toBe("hello-via-chain");
  });

  it("带鉴权串联：客户端头不透传，后级只认前级显式账密", async () => {
    const backAuthPort = await getFreePort();
    const frontAuthPort = await getFreePort();
    const pair: ChildProcess[] = [];
    try {
      pair.push(
        spawnProxy([
          ...baseArgs(backAuthPort),
          "--proxy-mode",
          "server",
          "--auth-enabled",
          "true",
          "--auth-type",
          "basic",
          "--auth-users-file",
          USERS_FILE,
        ]),
      );
      pair.push(
        spawnProxy([
          ...baseArgs(frontAuthPort),
          "--proxy-mode",
          "client",
          "--upstream-host",
          "127.0.0.1",
          "--upstream-port",
          String(backAuthPort),
        ]),
      );
      await waitForPort(backAuthPort);
      await waitForPort(frontAuthPort);

      const b64 = Buffer.from("u:p").toString("base64");
      // 前级未配上游账密：客户端头到前级为止，后级收不到凭证，一律 407
      const blocked = await getViaChain(frontAuthPort, targetPort, {
        "Proxy-Authorization": `Basic ${b64}`,
      });
      expect(blocked.status).toBe(407);
      const denied = await getViaChain(frontAuthPort, targetPort);
      expect(denied.status).toBe(407);
    } finally {
      await Promise.all(pair.map((c) => stopChild(c)));
    }
  }, 30000);

  it("明文串联上游鉴权：前级显式账密注入，后级放行", async () => {
    const backAuthPort = await getFreePort();
    const frontAuthPort = await getFreePort();
    const pair: ChildProcess[] = [];
    try {
      pair.push(
        spawnProxy([
          ...baseArgs(backAuthPort),
          "--proxy-mode",
          "server",
          "--auth-enabled",
          "true",
          "--auth-type",
          "basic",
          "--auth-users-file",
          USERS_FILE,
        ]),
      );
      // 前级配上游账密：客户端不带头也能过，后级看到的是前级注入的头
      pair.push(
        spawnProxy([
          ...baseArgs(frontAuthPort),
          "--proxy-mode",
          "client",
          "--upstream-host",
          "127.0.0.1",
          "--upstream-port",
          String(backAuthPort),
          "--upstream-username",
          "u",
          "--upstream-password",
          "p",
        ]),
      );
      await waitForPort(backAuthPort);
      await waitForPort(frontAuthPort);

      const ok = await getViaChain(frontAuthPort, targetPort);
      expect(ok.status).toBe(200);
      expect(ok.body).toBe("hello-via-chain");
    } finally {
      await Promise.all(pair.map((c) => stopChild(c)));
    }
  }, 30000);
});
