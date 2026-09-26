/**
 * @fileoverview `HttpProxy.stop()` 排空护栏：存活的连接（含已「升级」的 CONNECT 隧道）不得让关服挂死
 * @module tests/integration/stop-drain-live-tunnel
 * @description
 * `BaseProxy.closeServer()` = `server.close(cb)` + `registry.drain(server)`。只有当**全部**
 * 连接都真的断开时 `close` 的回调才会触发，于是「排空」这一步是 `stop()` 能否 resolve 的
 * 唯一决定因素：
 *
 * - **idle keep-alive 连接**：落在 `http.Server` 原生 `closeAllConnections()` 的覆盖范围内
 *   （对照组用例）。
 * - **已「升级」的连接**（`connect` / `upgrade` 事件发出后 socket 即脱离 Node 的连接表）：
 *   **原生 `closeAllConnections()` 不覆盖它们**，只能靠 `ConnRegistry` 逐条兜底销毁。
 *   修复前 `drain()` 走完原生路径直接 `clear()`，活着的 CONNECT 隧道因此留在原地，
 *   `close(cb)` 永不回调 → `stop()` 永久挂起。本文件就是那个缺陷的回归护栏。
 *
 * 断言口径：每条用例都给 `stop()` 一个**明确的超时预算**，超时时抛出带现场诊断的错误，
 * 绝不把失败推给 vitest 的 15s 全局超时（那只会得到一句无信息的 "timed out"）。
 * 端口释放用「同端口重新 bind」从行为侧断言（`ConnRegistry.conns` 是 private，不做白盒断言）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import type { ConfigKey } from "@/config/index.js";
import { HttpProxy } from "@/core/server/http.js";
import { restoreConfig, set, silenceLogs, snapshotConfig } from "../helpers/config.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { withProxy } from "../helpers/proxy.js";
import { makeCollector, tcConnect } from "../helpers/socks-client.js";

/** stop() 的超时预算：远小于 vitest 的 15s 全局超时，超时即明确失败并打印现场 */
const STOP_BUDGET_MS = 3000;

const KEYS: readonly ConfigKey[] = [
  "aclFile",
  "authEnabled",
  "authType",
  "host",
  "port",
  "proxyMode",
  "logLevel",
  "logFile",
];

/** 裸 TCP 桩句柄（可重复关闭） */
interface TcpStub {
  port: number;
  /** 收到的全部字节 */
  received: () => Buffer;
  close: () => Promise<void>;
}

/**
 * 裸 TCP 回显桩：CONNECT 隧道的真实目标
 * @description 直连 CONNECT 隧道是**裸 TCP 直连**（不向目标发任何 CONNECT 报文），
 * 所以隧道目标必须是 `net.Server`；给 `http.Server` 的话它会把隧道里的字节当 HTTP 请求解析
 * （首个字节不是合法方法名时直接回 400），隧道随即被拆掉——那测的就不是排空而是协议解析了。
 */
async function startTcpEcho(): Promise<TcpStub & { conns: () => number }> {
  const chunks: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  let conns = 0;
  const server = net.createServer((sock) => {
    conns++;
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (c: Buffer) => {
      chunks.push(c);
      sock.write(c);
    });
  });
  const port = await getFreePort();
  await listen(server, port);
  return {
    port,
    conns: () => conns,
    received: () => Buffer.concat(chunks),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) {
          s.destroy();
        }
        server.close(() => r());
      }),
  };
}

/** HTTP 源站桩：keep-alive 对照组要的是「idle 但仍在连接表里」的 http 连接 */
async function startHttpOrigin(): Promise<TcpStub> {
  let hits = 0;
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    hits++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("origin-ok");
  });
  const port = await getFreePort();
  await listen(server, port);
  return {
    port,
    received: () => Buffer.from(String(hits)),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** 建一条真 CONNECT 隧道并确认 200 建链；**socket 交还调用方保持打开**（隧道保活的前提） */
async function openTunnel(
  proxyPort: number,
  targetPort: number,
): Promise<{ sock: net.Socket; bytes: () => Buffer; waitClose: (ms?: number) => Promise<Buffer> }> {
  const sock = await tcConnect(proxyPort);
  const c = makeCollector(sock);
  sock.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
  await c.waitFor((b) => b.includes(Buffer.from("200 Connection Established")), 3000);
  return { sock, bytes: c.bytes, waitClose: c.waitClose };
}

/** 发一次原始往返并在收到完整应答头后 resolve（socket **保持打开**，keep-alive 对照组要的就是它） */
function rawHttp(
  port: number,
  requestLine: string,
  host: string,
): Promise<{ sock: net.Socket; text: () => string }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`${requestLine}\r\nHost: ${host}\r\n\r\n`);
    });
    let buf = "";
    sock.on("error", () => {
      // close 仍会触发；结果按已收到的字节判定
    });
    sock.on("data", (c: Buffer) => {
      buf += c.toString();
      if (buf.includes("\r\n\r\n")) {
        resolve({ sock, text: () => buf });
      }
    });
  });
}

/** 带明确超时预算的 `stop()`：超时抛带现场诊断的错误（而不是让用例挂到 vitest 全局超时） */
async function stopWithin(proxy: HttpProxy, port: number, ms = STOP_BUDGET_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          [
            `stop() 未在 ${ms} ms 内完成 —— drain 未销毁 upgraded socket：`,
            "活着的 CONNECT 隧道不在 Node 的连接表里，原生 closeAllConnections() 覆盖不到，",
            "server.close(cb) 因此永不回调。",
            `现场：state=${proxy.state} / isRunning=${proxy.isRunning()} / port=${port}`,
          ].join(""),
        ),
      );
    }, ms);
  });
  try {
    await Promise.race([proxy.stop(), budget]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 端口已释放的最强可观测断言：同端口能重新 bind
 * （`ConnRegistry.conns` 是 private，不做白盒断言；close 后监听句柄即时释放，仍留重试窗口）
 */
async function expectPortReleased(port: number, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const probe = net.createServer();
    const outcome = await new Promise<{ ok: boolean; err: string }>((resolve) => {
      probe.once("error", (e: NodeJS.ErrnoException) => {
        resolve({ ok: false, err: `${e.code ?? e.message}` });
      });
      probe.listen(port, "127.0.0.1", () => {
        resolve({ ok: true, err: "" });
      });
    });
    if (outcome.ok) {
      await new Promise<void>((r) => probe.close(() => r()));
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`stop() 之后仍无法重新 bind ${port}（${outcome.err}）：连接登记表可能未排空`);
    }
    await sleep(50);
  }
}

/** 轮询等待条件成立，超时抛错（避免固定 sleep 抖动） */
async function waitFor(cond: () => boolean, timeoutMs = 3000, label = ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`waitFor 超时${label ? `：${label}` : ""}`);
}

describe("integration/stop-drain-live-tunnel", () => {
  let snap: Record<string, unknown>;
  let echo: TcpStub & { conns: () => number };
  let httpOrigin: TcpStub;

  beforeEach(async () => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    set("authEnabled", false);
    set("authType", "none");
    set("proxyMode", "server");
    set("host", "127.0.0.1");
    // 哨兵端口：确保 isSelfLoop 不会把测试内的随机临时端口误判为自环
    set("port", 1);
    echo = await startTcpEcho();
    httpOrigin = await startHttpOrigin();
  });

  afterEach(async () => {
    await echo.close();
    await httpOrigin.close();
    restoreConfig(snap);
  });

  it("活着的 CONNECT 隧道：stop() 在预算内完成，隧道被拆、端口释放", async () => {
    await withProxy(HttpProxy, {}, async (port, proxy) => {
      const tunnel = await openTunnel(port, echo.port);
      try {
        // 先证明隧道确实活着（回显可用），且客户端那一端在 stop 之前**保持打开**
        tunnel.sock.write("probe-before-stop");
        await waitFor(
          () => tunnel.bytes().includes(Buffer.from("probe-before-stop")),
          3000,
          "隧道回显",
        );
        expect(echo.conns()).toBe(1);
        expect(tunnel.sock.destroyed).toBe(false);

        await stopWithin(proxy, port);
        expect(proxy.state).toBe("stopped");
        expect(proxy.isRunning()).toBe(false);

        // drain 必须销毁「已升级」的隧道 socket：客户端侧随后必须收到 close
        await tunnel.waitClose(2000);
        await expectPortReleased(port);
      } finally {
        tunnel.sock.destroy();
      }
    });
  });

  it("对照组：只有 idle keep-alive 连接（无隧道）时 stop() 同样在预算内完成", async () => {
    await withProxy(HttpProxy, {}, async (port, proxy) => {
      // keep-alive（不写 Connection: close）：连接会一直挂在源站上，正是原生路径负责的那一类
      const keepAlive = await rawHttp(
        port,
        `GET http://127.0.0.1:${httpOrigin.port}/keepalive HTTP/1.1`,
        `127.0.0.1:${httpOrigin.port}`,
      );
      try {
        expect(keepAlive.text().startsWith("HTTP/1.1 200")).toBe(true);
        expect(keepAlive.text()).toContain("origin-ok");

        await stopWithin(proxy, port);
        expect(proxy.state).toBe("stopped");
        expect(proxy.isRunning()).toBe(false);

        await expectPortReleased(port);
      } finally {
        keepAlive.sock.destroy();
      }
    });
  });

  it("对照组：零连接时 stop() 立即完成（幂等面不被排空逻辑拖慢）", async () => {
    await withProxy(HttpProxy, {}, async (port, proxy) => {
      const t0 = Date.now();
      await stopWithin(proxy, port);
      expect(Date.now() - t0).toBeLessThan(STOP_BUDGET_MS);
      expect(proxy.state).toBe("stopped");
      await expectPortReleased(port);
    });
  });
});
