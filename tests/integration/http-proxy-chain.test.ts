import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const DIST_APP = path.join(ROOT, "dist", "app.js");

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** src 下最新源码 mtime，dist 比它旧就说明构建过期了 */
function newestSrcMtime(dir: string): number {
  let max = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      max = Math.max(max, newestSrcMtime(p));
    } else if (entry.name.endsWith(".ts")) {
      max = Math.max(max, fs.statSync(p).mtimeMs);
    }
  }
  return max;
}
/**
 * 子进程就是独立进程，不与测试进程共享 store，这正是生产串联的真实形态。
 * dist 产物不存在或比 src 下任意源码旧时先构建；Windows+esbuild 退出码异常是已知坑，
 * 以 dist/app.js 的 mtime 是否刷新为准，不迷信 exit code。
 */
async function ensureDistBuilt(): Promise<void> {
  const srcMtime = Math.max(
    newestSrcMtime(path.join(ROOT, "src")),
    fs.statSync(path.join(ROOT, "build.mjs")).mtimeMs,
  );
  if (fs.existsSync(DIST_APP) && fs.statSync(DIST_APP).mtimeMs >= srcMtime) return;
  const before = fs.existsSync(DIST_APP) ? fs.statSync(DIST_APP).mtimeMs : 0;
  await new Promise<void>((resolve) => {
    execFile(process.execPath, ["build.mjs"], { cwd: ROOT }, () => resolve());
  });
  if (!fs.existsSync(DIST_APP) || fs.statSync(DIST_APP).mtimeMs <= before) {
    throw new Error("构建 dist/app.js 失败，串联测试无法启动子进程代理");
  }
}

/**
 * 子进程就是独立进程，不与测试进程共享 store，这正是生产串联的真实形态。
 * 传参一律走 CLI（--port/--proxy-mode/...）：CLI 优先级最高，
 * 不会被 .env.development 之类的 env 文件干扰。
 */
function spawnProxy(args: string[]): ChildProcess {
  const child = spawn(process.execPath, [DIST_APP, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: "ignore",
  });
  return child;
}

/** 公共 CLI 前缀：单进程 + 静音 + 关鉴权，避免 .env.development 的 workers/日志/鉴权配置污染 */
function baseArgs(port: number): string[] {
  return [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--proxy-protocol",
    "http",
    "--cluster-workers",
    "1",
    "--log-level",
    "silent",
    "--log-file",
    "",
    "--auth-enabled",
    "false",
  ];
}

/** 轮询端口直至能连上（代理监听成功），超时抛错 */
function waitForPort(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`等待端口 ${port} 超时`));
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

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

describe("integration/http-proxy-chain", () => {
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
          "--auth-username",
          "u",
          "--auth-password",
          "p",
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
          "--auth-username",
          "u",
          "--auth-password",
          "p",
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
          "--auth-username",
          "u",
          "--auth-password",
          "p",
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
          "--auth-username",
          "u",
          "--auth-password",
          "p",
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
          "--auth-username",
          "u",
          "--auth-password",
          "p",
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
