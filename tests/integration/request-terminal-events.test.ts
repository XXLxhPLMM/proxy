import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { FileAccountIdentity } from "@/core/identity.js";
import { EventHub } from "@/core/events/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { AppConfig } from "@/config/index.js";
import type { ProxyRuntime, RuntimeServices } from "@/runtime/index.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { makeCollector, socks5ConnectIpv4, tcConnect } from "../helpers/socks-client.js";

const TERMINAL_NAMES = ["request.completed", "request.rejected", "request.failed"] as const;
type TerminalName = (typeof TERMINAL_NAMES)[number];

interface TerminalRecord {
  name: TerminalName;
  data: unknown;
}

interface StartedRuntime {
  runtime: ProxyRuntime;
  port: number;
  events: EventHub;
}

interface LocalOrigin {
  server: http.Server;
  port: number;
}

const runtimes: ProxyRuntime[] = [];
const origins: LocalOrigin[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop().catch(() => undefined);
  }
  for (const origin of origins.splice(0)) {
    await closeOrigin(origin.server);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function collectTerminals(events: EventHub): TerminalRecord[] {
  const records: TerminalRecord[] = [];
  for (const name of TERMINAL_NAMES) {
    events.subscribe(name, (event) => {
      records.push({ name, data: event.data });
    });
  }
  return records;
}

function fieldOf(data: unknown, field: string): unknown {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  return (data as Record<string, unknown>)[field];
}

async function startOrigin(body = "origin-ok"): Promise<LocalOrigin> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });
  const port = await getFreePort();
  await listen(server, port);
  const origin = { server, port };
  origins.push(origin);
  return origin;
}

async function closeOrigin(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function startRuntime(
  config: Partial<AppConfig>,
  services?: Partial<RuntimeServices>,
): Promise<StartedRuntime> {
  const port = await getFreePort();
  const events = new EventHub({ onListenerError: () => undefined });
  const runtime = createProxyRuntime({
    config: {
      host: "127.0.0.1",
      port,
      proxyProtocol: "http",
      authEnabled: false,
      aclFile: path.join(os.tmpdir(), `proxy-terminal-missing-${process.pid}-${port}.json`),
      ...config,
    },
    events,
    ...(services !== undefined ? { services } : {}),
  });
  runtimes.push(runtime);
  await runtime.start();
  return { runtime, port, events };
}

function rawProxyRequest(port: number, requestText: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(requestText);
    });
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString();
    });
    socket.on("close", () => resolve(response));
    socket.on("error", () => {
      // close 仍会触发，结果按已收到的字节判定
    });
  });
}

function requestViaProxy(
  proxyPort: number,
  targetPort: number,
  pathName = "/ok",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://127.0.0.1:${targetPort}${pathName}`,
        headers: { Host: `127.0.0.1:${targetPort}` },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function socks5Connect(
  proxyPort: number,
  targetPort: number,
): Promise<{ socket: net.Socket; response: Buffer }> {
  const socket = await tcConnect(proxyPort);
  const collector = makeCollector(socket);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  await collector.waitFor((bytes) => bytes.length >= 2);
  socket.write(socks5ConnectIpv4("127.0.0.1", targetPort));
  const response = await collector.waitFor((bytes) => bytes.length >= 12);
  return { socket, response };
}

describe("integration/request-terminal-events", () => {
  it("HTTP 正常完成只产生一个 request.completed，status 取实际响应码", async () => {
    const origin = await startOrigin();
    const started = await startRuntime({});
    const records = collectTerminals(started.events);

    const response = await requestViaProxy(started.port, origin.port);
    await sleep(30);

    expect(response.status).toBe(200);
    expect(response.body).toBe("origin-ok");
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("request.completed");
    expect(fieldOf(records[0]?.data, "status")).toBe(200);
  });

  it("HTTP 目标解析失败只产生一个 parse/400 request.rejected（终态唯一来源是 RequestTerminal）", async () => {
    const started = await startRuntime({});
    const records = collectTerminals(started.events);

    const response = await rawProxyRequest(
      started.port,
      "GET http:// HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    await sleep(30);

    expect(response).toContain("HTTP/1.1 400");
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("request.rejected");
    expect(fieldOf(records[0]?.data, "stage")).toBe("parse");
    expect(fieldOf(records[0]?.data, "status")).toBe(400);
  });

  it("HTTP 目标名单拒绝只产生一个 access/403 request.rejected", async () => {
    const origin = await startOrigin();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-terminal-acl-"));
    tempDirs.push(dir);
    const aclPath = path.join(dir, "acl.json");
    fs.writeFileSync(aclPath, JSON.stringify({ target: { blacklist: ["127.0.0.1"] } }));
    const started = await startRuntime({ aclFile: aclPath });
    const records = collectTerminals(started.events);

    const response = await requestViaProxy(started.port, origin.port);
    await sleep(30);

    expect(response.status).toBe(403);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("request.rejected");
    expect(fieldOf(records[0]?.data, "stage")).toBe("access");
    expect(fieldOf(records[0]?.data, "status")).toBe(403);
  });

  it("HTTP 鉴权失败只产生一个 auth/407 request.rejected", async () => {
    const origin = await startOrigin();
    const identity = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [{ username: "alice", password: "secret" }],
      enableLogging: false,
    });
    const started = await startRuntime({ authEnabled: true }, { identity });
    const records = collectTerminals(started.events);

    const response = await requestViaProxy(started.port, origin.port);
    await sleep(30);

    expect(response.status).toBe(407);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("request.rejected");
    expect(fieldOf(records[0]?.data, "stage")).toBe("auth");
    expect(fieldOf(records[0]?.data, "status")).toBe(407);
  });

  it("HTTP 上游不可达只产生一个 dial/forward request.failed", async () => {
    const deadPort = await getFreePort();
    const started = await startRuntime({});
    const records = collectTerminals(started.events);

    const response = await requestViaProxy(started.port, deadPort);
    await sleep(30);

    expect(response.status).toBe(502);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("request.failed");
    expect(["dial", "forward"]).toContain(fieldOf(records[0]?.data, "stage"));
    expect(records.some((record) => record.name === "request.completed")).toBe(false);
    expect(records.some((record) => record.name === "request.rejected")).toBe(false);
  });

  it("SOCKS5 CONNECT 成功只产生一个无 status 的 request.completed", async () => {
    const origin = await startOrigin();
    const started = await startRuntime({ proxyProtocol: "socks5" });
    const records = collectTerminals(started.events);

    const { socket, response } = await socks5Connect(started.port, origin.port);
    await sleep(30);
    socket.destroy();

    expect(response[2]).toBe(0x05);
    expect(response[3]).toBe(0x00);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("request.completed");
    expect(fieldOf(records[0]?.data, "status")).toBeUndefined();
  });

  it("SOCKS5 目标名单拒绝只产生一个 access request.rejected，且不改 FAIL 字节", async () => {
    const origin = await startOrigin();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-terminal-socks-acl-"));
    tempDirs.push(dir);
    const aclPath = path.join(dir, "acl.json");
    fs.writeFileSync(aclPath, JSON.stringify({ target: { blacklist: ["127.0.0.1"] } }));
    const started = await startRuntime({ proxyProtocol: "socks5", aclFile: aclPath });
    const records = collectTerminals(started.events);

    const { socket, response } = await socks5Connect(started.port, origin.port);
    await sleep(30);
    socket.destroy();

    expect(response[2]).toBe(0x05);
    expect(response[3]).toBe(0x01);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("request.rejected");
    expect(fieldOf(records[0]?.data, "stage")).toBe("access");
  });
});
