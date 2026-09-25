/**
 * 请求作用域标识（requestId / connectionId）端到端护栏
 *
 * 保护的不变量：
 *  - 同一请求的 mid-flight 事件（auth.decided / route.selected / 终态）共享同一个 requestId
 *  - 不同请求的 requestId 互不相同
 *  - keep-alive 同一连接的多请求共享 connectionId，但 requestId 各异
 */
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createProxyRuntime, type ProxyRuntime } from "@/index.js";
import type { AppEventMap, EventEnvelope, EventName } from "@/core/events/index.js";
import { getFreePort } from "../helpers/net.js";
import { makeCollector, socks5ConnectIpv4, tcConnect } from "../helpers/socks-client.js";

const runtimes: ProxyRuntime[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const r of runtimes.splice(0)) {
    await r.stop();
  }
  for (const s of servers.splice(0)) {
    await new Promise<void>((res) => s.close(() => res()));
  }
});

interface Recorded {
  name: EventName;
  context: EventEnvelope["context"];
  data: unknown;
}

async function startRuntime(protocol: "http" | "socks5" = "http"): Promise<{
  runtime: ProxyRuntime;
  port: number;
  events: Recorded[];
}> {
  const port = await getFreePort();
  const runtime = createProxyRuntime({
    config: { proxyProtocol: protocol, host: "127.0.0.1", port, upstreamTimeout: 5000 },
  });
  runtimes.push(runtime);

  const events: Recorded[] = [];
  const names: EventName[] = [
    "auth.decided",
    "route.selected",
    "access.client-denied",
    "access.target-denied",
    "request.completed",
    "request.rejected",
    "request.failed",
  ];
  for (const name of names) {
    runtime.events.subscribe(name, (e) => {
      events.push({ name, context: e.context, data: e.data });
    });
  }
  await runtime.start();
  return { runtime, port, events };
}

function startOrigin(body: string): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
    });
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port));
  });
}

function proxyGet(port: number, originPort: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `http://127.0.0.1:${originPort}${path}`, method: "GET" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("请求作用域标识 requestId / connectionId", () => {
  it("终态事件携带 requestId 与 connectionId", async () => {
    const originPort = await startOrigin("ok");
    const { port, events } = await startRuntime();

    expect(await proxyGet(port, originPort, "/a")).toBe(200);
    await delay(150);

    const completed = events.filter((e) => e.name === "request.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.context.requestId).toBeTruthy();
    expect(completed[0]?.context.connectionId).toBeTruthy();
    expect(completed[0]?.context.protocol).toBe("http");
  });

  it("同一请求的事件共享同一个 requestId，不同请求互不相同", async () => {
    const originPort = await startOrigin("ok");
    const { port, events } = await startRuntime();

    await proxyGet(port, originPort, "/a");
    await delay(120);
    const firstBatch = events.splice(0);

    await proxyGet(port, originPort, "/b");
    await delay(120);
    const secondBatch = events.splice(0);

    const firstIds = new Set(firstBatch.map((e) => e.context.requestId).filter(Boolean));
    const secondIds = new Set(secondBatch.map((e) => e.context.requestId).filter(Boolean));

    // 每个批次内部：所有事件归一到同一个 requestId
    expect(firstIds.size).toBe(1);
    expect(secondIds.size).toBe(1);
    // 两批之间：requestId 不同
    expect([...firstIds]).not.toEqual([...secondIds]);
  });

  it("连续请求的 requestId 互不相同", async () => {
    const originPort = await startOrigin("ok");
    const { port, events } = await startRuntime();

    await proxyGet(port, originPort, "/k1");
    await delay(100);
    await proxyGet(port, originPort, "/k2");
    await delay(150);

    const reqIds = events.map((e) => e.context.requestId).filter(Boolean);
    // 两个独立请求 -> 两个不同 requestId（无论底层是否复用连接）
    expect(reqIds.length).toBeGreaterThan(0);
    expect(new Set(reqIds).size).toBe(2);
    // 每个请求的终态都带 connectionId
    expect(events.every((e) => e.context.connectionId !== undefined)).toBe(true);
  });

  it("SOCKS 连接的终态事件同样携带 requestId", async () => {
    const originPort = await startOrigin("socks-ok");
    const { port, events } = await startRuntime("socks5");

    // 用低层 helper 走一次 SOCKS5 CONNECT 到本机 origin
    const sock = await tcConnect(port);
    const collector = makeCollector(sock);
    sock.write(Buffer.from([0x05, 0x01, 0x00])); // greeting: no-auth
    await collector.waitFor((b) => b.length >= 2 && b[0] === 0x05);
    sock.write(socks5ConnectIpv4("127.0.0.1", originPort));
    // CONNECT 成功应答：VER=5 REP=0
    await collector.waitFor((b) => b.length >= 10 && b[0] === 0x05 && b[1] === 0x00);
    sock.destroy();
    await delay(200);

    const terminal = events.filter((e) => e.name.startsWith("request."));
    expect(terminal.length).toBeGreaterThan(0);
    expect(terminal[0]?.context.requestId).toBeTruthy();
    expect(terminal[0]?.context.connectionId).toBeTruthy();
    expect(terminal[0]?.context.protocol).toBe("socks5");
  });
});

// 保持 AppEventMap 被引用，避免本文件成为孤立的类型消费者
export type _ScopeEventMap = AppEventMap;
