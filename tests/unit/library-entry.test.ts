import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { getFreePort, listen } from "../helpers/net.js";
import type {
  AppConfig,
  EventEnvelope,
  Logger,
  ProxyRuntime,
} from "@/index.js";

const activeRuntimes: ProxyRuntime[] = [];
const activeServers: Array<http.Server | net.Server> = [];

function own<T extends ProxyRuntime>(runtime: T): T {
  activeRuntimes.push(runtime);
  return runtime;
}

function ownServer<T extends http.Server | net.Server>(server: T): T {
  activeServers.push(server);
  return server;
}

async function closeServer(server: http.Server | net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function requestThroughProxy(port: number, originPort: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: `http://127.0.0.1:${originPort}/library-entry`,
        headers: {
          host: `127.0.0.1:${originPort}`,
          connection: "close",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`proxy returned HTTP ${response.statusCode ?? "unknown"}`));
            return;
          }
          resolve(body);
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  for (const runtime of activeRuntimes.splice(0)) {
    await runtime.stop().catch(() => undefined);
  }
  for (const server of activeServers.splice(0)) {
    if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    await closeServer(server).catch(() => undefined);
  }
  vi.restoreAllMocks();
});

describe("library entry", () => {
  it("importing the source entry has no import-time process, server, or file side effects", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-library-entry-"));
    const previousCwd = process.cwd();
    const envBefore = { ...process.env };
    const listenersBefore = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      uncaught: process.listenerCount("uncaughtException"),
      monitor: process.listenerCount("uncaughtExceptionMonitor"),
    };
    const readFile = vi.spyOn(fs, "readFileSync");
    const exists = vi.spyOn(fs, "existsSync");
    const stat = vi.spyOn(fs, "statSync");
    const createHttpServer = vi.spyOn(http, "createServer");
    const createNetServer = vi.spyOn(net, "createServer");

    try {
      process.chdir(cwd);
      vi.resetModules();
      await import("@/index.js");

      expect({ ...process.env }).toEqual(envBefore);
      expect(process.listenerCount("SIGINT")).toBe(listenersBefore.sigint);
      expect(process.listenerCount("SIGTERM")).toBe(listenersBefore.sigterm);
      expect(process.listenerCount("uncaughtException")).toBe(listenersBefore.uncaught);
      expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(listenersBefore.monitor);
      expect(readFile).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(createHttpServer).not.toHaveBeenCalled();
      expect(createNetServer).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("exposes the documented runtime/config/event/logger/core value and type surface", async () => {
    const entry = await import("@/index.js");

    for (const name of [
      "createProxyRuntime",
      "loadConfig",
      "ConfigStore",
      "EventHub",
      "createNoopLogger",
      "createConsoleLogger",
      "createLogger",
      "createProxy",
      "configAccessorFromStore",
      "createConfigContext",
      "ProxyServer",
      "runServer",
    ] as const) {
      expect(typeof entry[name]).toBe("function");
    }
    expect(entry.defaults).toBeTypeOf("object");
    expect(entry).not.toHaveProperty("get");
    expect(entry).not.toHaveProperty("getAll");
    expect(entry).not.toHaveProperty("set");
    expect(entry).not.toHaveProperty("globalConfigAccessor");

    expectTypeOf<ProxyRuntime["start"]>().toBeFunction();
    expectTypeOf<ProxyRuntime["stop"]>().toBeFunction();
    expectTypeOf<AppConfig["port"]>().toBeNumber();
    expectTypeOf<EventEnvelope["name"]>().toBeString();
    expectTypeOf<Logger["debug"]>().toBeFunction();
  });

  it("starts a real library runtime, forwards a request, and releases the port", async () => {
    const origin = ownServer(
      http.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("library-runtime-ok");
      }),
    );
    const originPort = await getFreePort();
    await listen(origin, originPort);

    const port = await getFreePort();
    const runtime = own(
      await entryCreateRuntime({
        config: { host: "127.0.0.1", port, proxyProtocol: "http" },
      }),
    );

    await runtime.start();
    await expect(requestThroughProxy(port, originPort)).resolves.toBe("library-runtime-ok");
    await runtime.stop();

    const probe = ownServer(net.createServer());
    await listen(probe, port);
    await closeServer(probe);
  });

  it("keeps simultaneous runtimes and their event buses isolated", async () => {
    const firstPort = await getFreePort();
    const secondPort = await getFreePort();
    const first = own(await entryCreateRuntime({ config: { host: "127.0.0.1", port: firstPort } }));
    const second = own(await entryCreateRuntime({ config: { host: "127.0.0.1", port: secondPort } }));
    const firstStarted: string[] = [];
    const secondStarted: string[] = [];
    first.events.subscribe("runtime.started", (event) => firstStarted.push(event.context.runtimeId));
    second.events.subscribe("runtime.started", (event) => secondStarted.push(event.context.runtimeId));

    expect(first.events).not.toBe(second.events);
    expect(first.runtimeId).not.toBe(second.runtimeId);
    expect(first.context.store.get("port")).toBe(firstPort);
    expect(second.context.store.get("port")).toBe(secondPort);

    await Promise.all([first.start(), second.start()]);
    expect(first.isRunning()).toBe(true);
    expect(second.isRunning()).toBe(true);
    expect(firstStarted).toEqual([first.runtimeId]);
    expect(secondStarted).toEqual([second.runtimeId]);

    await Promise.all([first.stop(), second.stop()]);
  });
});

/** Keep the public entry import in one place for the E2E cases. */
let entryPromise: Promise<typeof import("@/index.js")> | undefined;

async function entryCreateRuntime(options: {
  config: { host: string; port: number; proxyProtocol?: "http" };
}): Promise<ProxyRuntime> {
  // The dynamic import in the first test intentionally does not make this a
  // static runtime dependency; this helper is only called after that test.
  entryPromise ??= import("@/index.js");
  const entry = await entryPromise;
  return entry.createProxyRuntime(options);
}
