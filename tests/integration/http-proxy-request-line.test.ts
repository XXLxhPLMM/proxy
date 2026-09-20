import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const DIST_APP = path.join(ROOT, "dist", "app.js");

/** 裸 TCP 源站收到的请求行原文，按到达顺序追加 */
const seen: string[] = [];

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** src 下最新源码 mtime：dist 比它旧说明构建过期 */
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

/** Windows+esbuild 退出码不可信，以产物 mtime 是否刷新为准（同 chain 测试） */
async function ensureDistBuilt(): Promise<void> {
  const srcMtime = Math.max(
    newestSrcMtime(path.join(ROOT, "src")),
    fs.statSync(path.join(ROOT, "build.mjs")).mtimeMs,
  );
  if (fs.existsSync(DIST_APP) && fs.statSync(DIST_APP).mtimeMs >= srcMtime) return;
  const before = fs.existsSync(DIST_APP) ? fs.statSync(DIST_APP).mtimeMs : 0;
  await new Promise<void>((resolve) => {
    spawn(process.execPath, ["build.mjs"], { cwd: ROOT, stdio: "ignore" }).once("exit", () =>
      resolve(),
    );
  });
  if (!fs.existsSync(DIST_APP) || fs.statSync(DIST_APP).mtimeMs <= before) {
    throw new Error("构建 dist/app.js 失败，request-line 回归测试无法启动子进程代理");
  }
}

/** 子进程代理：CLI 传参优先级最高；剔除终端脏环境变量，避免真实环境噪音干扰断言 */
function spawnProxy(args: string[]): ChildProcess {
  const env = { ...process.env };
  delete env.AUTH_TYPE;
  delete env.PROXY_MODE;
  delete env.UPSTREAM_PROTOCOL;
  delete env.PORT;
  return spawn(process.execPath, [DIST_APP, ...args], { cwd: ROOT, env, stdio: "ignore" });
}

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

/**
 * 经 server 模式代理发一次请求，返回源站收到的请求行原文
 * 源站是裸 TCP：http.Server 会把畸形 target 也塞进 req.url，缺陷会被它藏住
 */
function requestLineViaProxy(proxyPort: number, originPort: number, clientPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: clientPath,
        headers: { Host: `127.0.0.1:${originPort}` },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(seen.at(-1) ?? ""));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("integration/http-proxy request-line 形态", () => {
  let proxyPort = 0;
  let originPort = 0;
  let proxy: ChildProcess | null = null;
  let origin: net.Server | null = null;

  beforeAll(async () => {
    await ensureDistBuilt();
    proxyPort = await getFreePort();
    originPort = await getFreePort();

    origin = net.createServer((sock) => {
      sock.on("error", () => {});
      sock.once("data", (d) => {
        seen.push(d.toString().split("\r\n")[0] ?? "");
        sock.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      });
    });
    await new Promise<void>((r) => origin!.listen(originPort, "127.0.0.1", () => r()));

    proxy = spawnProxy([...baseArgs(proxyPort), "--proxy-mode", "server"]);
    await waitForPort(proxyPort);
  }, 30000);

  afterAll(async () => {
    if (proxy) await stopChild(proxy);
    await new Promise<void>((r) => origin?.close(() => r()));
  });

  it("server 模式：客户端 absolute-form 归一为 origin-form 交源站", async () => {
    const line = await requestLineViaProxy(
      proxyPort,
      originPort,
      `http://127.0.0.1:${originPort}/hello?x=1`,
    );
    expect(line).toBe("GET /hello?x=1 HTTP/1.1");
  });

  it("server 模式：客户端 origin-form 原样透传", async () => {
    const line = await requestLineViaProxy(proxyPort, originPort, "/plain?y=2");
    expect(line).toBe("GET /plain?y=2 HTTP/1.1");
  });
});
