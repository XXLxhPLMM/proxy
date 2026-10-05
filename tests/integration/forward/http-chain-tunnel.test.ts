/**
 * CONNECT 串联的四条：隧道建链后双向透传、前级显式账密建链、客户端账密到前级为止（后级拒链）、
 * 以及前级只拦不代回 200 —— 每条各自起一对子进程与一个裸 TCP 回声源站。
 *
 * `SPAWN_CWD` 为什么必须在仓库之外、子进程与测试进程不共享 store 这两条，归
 * `../../helpers/child-proxy.ts` 的文件头（本目录任何档都不许复述它）；明文 absolute-form 串联那三条在
 * `http-chain-forward.test.ts`。主题级判据与本目录清单见 `./AGENTS.md`。
 *
 * @module tests/integration/forward
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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

/** 裸 TCP 发 CONNECT 建隧道，返回上游状态码与已建链 socket */
function connectViaChain(
  frontPort: number,
  targetHost: string,
  targetPort: number,
  extraHeaders: string[] = [],
): Promise<{ statusCode: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(frontPort, "127.0.0.1", () => {
      socket.write(
        [
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
          `Host: ${targetHost}:${targetPort}`,
          ...extraHeaders,
          "",
          "",
        ].join("\r\n"),
      );
    });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("CONNECT 响应超时"));
    }, 8000);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      const statusLine = buf.toString().split("\r\n")[0] ?? "";
      const rest = buf.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve({ statusCode: Number(statusLine.split(" ")[1]), socket });
    };
    socket.on("data", onData);
  });
}

/** 在已建链隧道里发一段载荷并等回声 */
function echoOnce(socket: net.Socket, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("tunnel 回包超时")), 8000);
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes(payload)) {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        resolve(out);
      }
    };
    socket.on("data", onData);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.write(payload);
  });
}

describe("forward · http-chain-tunnel（CONNECT 串联）", () => {
  beforeAll(async () => {
    await ensureDistBuilt();
  }, 30000);

  afterAll(async () => {
    disposeSpawnCwd();
  });

  it("CONNECT串联：隧道建链后 TCP 双向透传", async () => {
    const echoPort = await getFreePort();
    const backPort2 = await getFreePort();
    const frontPort2 = await getFreePort();
    const echo = net.createServer((s) => {
      s.on("error", () => {});
      s.on("data", (c) => s.write(c));
    });
    await new Promise<void>((resolve) => echo.listen(echoPort, "127.0.0.1", resolve));
    const pair: ChildProcess[] = [];
    let tunnel: net.Socket | null = null;
    try {
      pair.push(spawnProxy([...baseArgs(backPort2), "--proxy-mode", "server"]));
      pair.push(
        spawnProxy([
          ...baseArgs(frontPort2),
          "--proxy-mode",
          "client",
          "--upstream-host",
          "127.0.0.1",
          "--upstream-port",
          String(backPort2),
        ]),
      );
      await waitForPort(backPort2);
      await waitForPort(frontPort2);

      const conn = await connectViaChain(frontPort2, "127.0.0.1", echoPort);
      expect(conn.statusCode).toBe(200);
      tunnel = conn.socket;
      const echoed = await echoOnce(tunnel, "ping-tunnel");
      expect(echoed).toContain("ping-tunnel");
    } finally {
      tunnel?.destroy();
      await Promise.all(pair.map((c) => stopChild(c)));
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  }, 30000);

  it("CONNECT串联上游鉴权：前级显式账密建链", async () => {
    const echoPort = await getFreePort();
    const backPort2 = await getFreePort();
    const frontPort2 = await getFreePort();
    const echo = net.createServer((s) => {
      s.on("error", () => {});
      s.on("data", (c) => s.write(c));
    });
    await new Promise<void>((resolve) => echo.listen(echoPort, "127.0.0.1", resolve));
    const pair: ChildProcess[] = [];
    let tunnel: net.Socket | null = null;
    try {
      pair.push(
        spawnProxy([
          ...baseArgs(backPort2),
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
          ...baseArgs(frontPort2),
          "--proxy-mode",
          "client",
          "--upstream-host",
          "127.0.0.1",
          "--upstream-port",
          String(backPort2),
          "--upstream-username",
          "u",
          "--upstream-password",
          "p",
        ]),
      );
      await waitForPort(backPort2);
      await waitForPort(frontPort2);

      // 客户端不带任何凭证，前级用自己的上游账密与后级建链
      const conn = await connectViaChain(frontPort2, "127.0.0.1", echoPort);
      expect(conn.statusCode).toBe(200);
      tunnel = conn.socket;
      expect(await echoOnce(tunnel, "ping-explicit")).toContain("ping-explicit");
    } finally {
      tunnel?.destroy();
      await Promise.all(pair.map((c) => stopChild(c)));
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  }, 30000);

  it("CONNECT串联无上游账密：客户端账密到前级为止，后级拒链", async () => {
    const echoPort = await getFreePort();
    const backPort2 = await getFreePort();
    const frontPort2 = await getFreePort();
    const echo = net.createServer((s) => {
      s.on("error", () => {});
      s.on("data", (c) => s.write(c));
    });
    await new Promise<void>((resolve) => echo.listen(echoPort, "127.0.0.1", resolve));
    const pair: ChildProcess[] = [];
    try {
      pair.push(
        spawnProxy([
          ...baseArgs(backPort2),
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
      // 前级不配上游账密：直透分支已滤 proxy 头，后级收不到凭证，建链被拒
      pair.push(
        spawnProxy([
          ...baseArgs(frontPort2),
          "--proxy-mode",
          "client",
          "--upstream-host",
          "127.0.0.1",
          "--upstream-port",
          String(backPort2),
        ]),
      );
      await waitForPort(backPort2);
      await waitForPort(frontPort2);

      const b64 = Buffer.from("u:p").toString("base64");
      const refused = await connectViaChain(frontPort2, "127.0.0.1", echoPort, [
        `Proxy-Authorization: Basic ${b64}`,
      ]);
      expect(refused.statusCode).toBe(407);
      refused.socket.destroy();

      const denied = await connectViaChain(frontPort2, "127.0.0.1", echoPort);
      expect(denied.statusCode).toBe(407);
      denied.socket.destroy();
    } finally {
      await Promise.all(pair.map((c) => stopChild(c)));
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  }, 30000);

  it("CONNECT串联前级鉴权：前级只拦不代回200，建链仍由上游说了算", async () => {
    const echoPort = await getFreePort();
    const backPort2 = await getFreePort();
    const frontPort2 = await getFreePort();
    const echo = net.createServer((s) => {
      s.on("error", () => {});
      s.on("data", (c) => s.write(c));
    });
    await new Promise<void>((resolve) => echo.listen(echoPort, "127.0.0.1", resolve));
    const pair: ChildProcess[] = [];
    let tunnel: net.Socket | null = null;
    try {
      pair.push(spawnProxy([...baseArgs(backPort2), "--proxy-mode", "server"]));
      // 前级开鉴权但不配上游账密：鉴权过后走直透，200 由后级回
      pair.push(
        spawnProxy([
          ...baseArgs(frontPort2),
          "--proxy-mode",
          "client",
          "--upstream-host",
          "127.0.0.1",
          "--upstream-port",
          String(backPort2),
          "--auth-enabled",
          "true",
          "--auth-type",
          "basic",
          "--auth-users-file",
          USERS_FILE,
        ]),
      );
      await waitForPort(backPort2);
      await waitForPort(frontPort2);

      const b64 = Buffer.from("u:p").toString("base64");
      const conn = await connectViaChain(frontPort2, "127.0.0.1", echoPort, [
        `Proxy-Authorization: Basic ${b64}`,
      ]);
      expect(conn.statusCode).toBe(200);
      tunnel = conn.socket;
      expect(await echoOnce(tunnel, "ping-front-auth")).toContain("ping-front-auth");

      // 前级鉴权失败直接 407，连上游都到不了
      const denied = await connectViaChain(frontPort2, "127.0.0.1", echoPort);
      expect(denied.statusCode).toBe(407);
      denied.socket.destroy();
    } finally {
      tunnel?.destroy();
      await Promise.all(pair.map((c) => stopChild(c)));
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  }, 30000);
});
