import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http, { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as sourceEntryModule from "@/index.js";
import type {
  AppConfig,
  AppEventMap,
  AuthProvider,
  AuthResult,
  ConfigAccessor,
  ConfigContext,
  ConfigKey,
  ConfigSourceMetadata,
  EventContext,
  EventEnvelope,
  EventHubOptions,
  EventListener,
  EventName,
  EventScope,
  EventSubscription,
  LifecycleState,
  LoadConfigOptions,
  LogFields,
  Logger,
  ProxyCore,
  ProxyOptions,
  ProxyProtocol,
  ProxyRuntime,
  ProxyRuntimeOptions,
  ProxyStats,
  RuntimeServices,
  RuntimeWarning,
  TlsKeyCert,
} from "@/index.js";
import { getFreePort } from "../helpers/net.js";

/**
 * The package is the public boundary. Keep this smoke test independent of
 * whether a developer has run `build:lib` yet: a stale or absent lib/ is
 * skipped for the packaged-entry assertions, while the source entry remains
 * the fallback facade.
 */
const packageRoot = path.resolve(__dirname, "../..");
const libEntryPath = path.join(packageRoot, "lib", "index.js");
const libTypesPath = path.join(packageRoot, "lib", "index.d.ts");
const hasLibFiles = fs.existsSync(libEntryPath) && fs.existsSync(libTypesPath);
const requireFromTest = createRequire(__filename);

type Entry = Record<string, unknown>;

/** entry 上 `createProxyRuntime` 的最小结构（库消费方视角，不依赖内部类型） */
interface RuntimeFactory {
  (options: { config: { host: string; port: number } }): {
    runtimeId: string;
    context: { store: { get: (key: "port") => number } };
    events: {
      subscribe: (
        name: "runtime.started",
        listener: (e: { context: { runtimeId: string } }) => void,
      ) => unknown;
      listenerCount: (name?: string) => number;
    };
    start: () => Promise<void>;
    stop: () => Promise<void>;
  };
}

const { mkdtempSync, rmSync } = fs;
const { tmpdir } = os;

/** 启一个本地 origin 并回其端口 */
function listenOnFreePort(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** 经代理发一次绝对 form 请求，读取完整响应体 */
function getViaProxy(proxyPort: number, originPort: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: `http://127.0.0.1:${originPort}${path}`,
        method: "GET",
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          res.statusCode === 200 ? resolve(body) : reject(new Error(`status=${res.statusCode}`)),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

type PublicTypeSurface = {
  ProxyRuntime: ProxyRuntime;
  ProxyRuntimeOptions: ProxyRuntimeOptions;
  RuntimeServices: RuntimeServices;
  RuntimeWarning: RuntimeWarning;
  AppConfig: AppConfig;
  ConfigKey: ConfigKey;
  LoadConfigOptions: LoadConfigOptions;
  ConfigContext: ConfigContext;
  ConfigSourceMetadata: ConfigSourceMetadata;
  AppEventMap: AppEventMap;
  EventContext: EventContext;
  EventEnvelope: EventEnvelope;
  EventListener: EventListener<keyof AppEventMap>;
  EventName: EventName;
  EventSubscription: EventSubscription;
  EventHubOptions: EventHubOptions;
  EventScope: EventScope;
  Logger: Logger;
  LogFields: LogFields;
  ProxyCore: ProxyCore;
  ProxyOptions: ProxyOptions;
  ProxyProtocol: ProxyProtocol;
  ProxyStats: ProxyStats;
  LifecycleState: LifecycleState;
  AuthProvider: AuthProvider;
  AuthResult: AuthResult;
  ConfigAccessor: ConfigAccessor;
  TlsKeyCert: TlsKeyCert;
};

const requiredFunctionExports = [
  "createProxyRuntime",
  "ConfigStore",
  "loadConfig",
  "EventHub",
  "createRuntimeScope",
  "createConnectionScope",
  "createRequestScope",
  "createNoopLogger",
  "createConsoleLogger",
  "createLogger",
  "createProxy",
  "configAccessorFromStore",
  "createConfigContext",
  "ProxyServer",
  "runServer",
] as const;

const requiredValueExports = [...requiredFunctionExports, "defaults"] as const;

function hasCompleteValueSurface(candidate: Entry | undefined): candidate is Entry {
  return (
    candidate !== undefined &&
    requiredFunctionExports.every((name) => typeof candidate[name] === "function") &&
    typeof candidate.defaults === "object"
  );
}

let packagedEntry: Entry | undefined;
if (hasLibFiles) {
  try {
    packagedEntry = requireFromTest("@b-hole/proxy") as Entry;
  } catch {
    // A stale or partially-written lib/ is equivalent to an unbuilt library.
    packagedEntry = undefined;
  }
}

const sourceEntry = sourceEntryModule as unknown as Entry;
const packagedEntryIsReady = hasCompleteValueSurface(packagedEntry);
const sourceEntryIsReady = hasCompleteValueSurface(sourceEntry);
const entry = packagedEntryIsReady ? packagedEntry : sourceEntry;
const entryIsReady = packagedEntryIsReady || sourceEntryIsReady;

function createRuntimeFromEntry(
  currentEntry: Entry,
  port: number,
): {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
} {
  const factory = currentEntry.createProxyRuntime as (options: {
    config: { host: string; port: number; proxyProtocol: "http" };
  }) => {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    isRunning: () => boolean;
  };
  return factory({
    config: { host: "127.0.0.1", port, proxyProtocol: "http" },
  });
}

describe("@b-hole/proxy library entry", () => {
  it.skipIf(!packagedEntryIsReady)("require() resolves to the packaged lib/index.js", () => {
    const resolved = requireFromTest.resolve("@b-hole/proxy");
    expect(path.resolve(resolved)).toBe(path.resolve(libEntryPath));
  });

  it.skipIf(!packagedEntryIsReady)("package exports block internal deep imports", () => {
    expect(() => requireFromTest("@b-hole/proxy/lib/core/index.js")).toThrow();
  });

  it.skipIf(!entryIsReady)("exposes the complete public value surface", () => {
    for (const name of requiredValueExports) {
      expect(entry).toHaveProperty(name);
    }
    for (const name of requiredFunctionExports) {
      expect(typeof entry?.[name]).toBe("function");
    }
    expect(typeof entry?.defaults).toBe("object");
    for (const name of ["get", "getAll", "set", "globalConfigAccessor"]) {
      expect(entry).not.toHaveProperty(name);
    }
  });

  it.skipIf(!entryIsReady)("keeps the public type surface strongly typed", () => {
    expectTypeOf<PublicTypeSurface>().toMatchTypeOf<object>();
    expectTypeOf<AppConfig>().toMatchTypeOf<object>();
    expectTypeOf<EventEnvelope>().toMatchTypeOf<object>();
    expectTypeOf<Logger>().toMatchTypeOf<object>();
    expectTypeOf<ConfigKey>().toMatchTypeOf<keyof AppConfig>();
  });

  it.skipIf(!entryIsReady)("starts and stops a minimal HTTP runtime", async () => {
    const port = await getFreePort();
    expect(port).toBeGreaterThan(1024);

    const runtime = createRuntimeFromEntry(entry as Entry, port);
    try {
      await runtime.start();
      expect(runtime.isRunning()).toBe(true);
    } finally {
      await runtime.stop();
    }

    expect(runtime.isRunning()).toBe(false);
  });

  it.skipIf(!entryIsReady)("forwards a real request through the runtime-owned proxy", async () => {
    // 端到端护栏：库起的代理必须真能把流量送到目标，而不只是「端口在监听」
    const origin = createHttpServer((_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.end("hello-from-origin");
    });
    const originPort = await listenOnFreePort(origin);
    const proxyPort = await getFreePort();

    const runtime = createRuntimeFromEntry(entry as Entry, proxyPort);
    try {
      await runtime.start();
      expect(await getViaProxy(proxyPort, originPort, "/probe")).toBe("hello-from-origin");
    } finally {
      await runtime.stop();
      await closeServer(origin);
    }
  });

  it.skipIf(!entryIsReady)("keeps two runtimes isolated in config, events and port", async () => {
    // 多实例护栏：库模式最核心的承诺——两个代理互不串号
    const origin = createHttpServer((_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.end("ok");
    });
    const originPort = await listenOnFreePort(origin);
    const portA = await getFreePort();
    const portB = await getFreePort();

    const factory = (entry as Entry).createProxyRuntime as unknown as RuntimeFactory;
    const runtimeA = factory({ config: { host: "127.0.0.1", port: portA } });
    const listenersOnA = runtimeA.events.listenerCount();
    const runtimeB = factory({ config: { host: "127.0.0.1", port: portB } });

    const bStarted: string[] = [];
    runtimeB.events.subscribe("runtime.started", (e) => {
      bStarted.push(e.context.runtimeId);
    });

    try {
      await runtimeA.start();
      await runtimeB.start();

      // 身份与总线互相独立
      expect(runtimeA.runtimeId).not.toBe(runtimeB.runtimeId);
      expect(runtimeA.events).not.toBe(runtimeB.events);
      // 配置互相独立
      expect(runtimeA.context.store.get("port")).toBe(portA);
      expect(runtimeB.context.store.get("port")).toBe(portB);
      // 事件归属正确：B 只收到自己那条，且 context 指向 B
      expect(bStarted).toEqual([runtimeB.runtimeId]);
      // A 的总线不因 B 的启动而增加任何监听
      expect(runtimeA.events.listenerCount()).toBe(listenersOnA);
      // 两个实例都真能转发
      expect(await getViaProxy(portA, originPort, "/a")).toBe("ok");
      expect(await getViaProxy(portB, originPort, "/b")).toBe("ok");
    } finally {
      await runtimeA.stop();
      await runtimeB.stop();
      await closeServer(origin);
    }
  });

  it.skipIf(!entryIsReady)("loadConfig resolves explicit env without polluting the host", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "proxy-lib-cfg-"));
    const envBefore = JSON.stringify(Object.entries(process.env).sort());

    try {
      const load = (entry as Entry).loadConfig as unknown as (options: {
        env: Record<string, string>;
        envFiles: string[];
        argv: string[];
        cwd: string;
        skipFileValidation: boolean;
      }) => Promise<{
        store: { get: (key: "port") => number };
        accessor: { get: (key: "port") => number };
        warnings: string[];
      }>;

      const context = await load({
        env: { PORT: "19191" },
        envFiles: [],
        argv: [],
        cwd: sandbox,
        skipFileValidation: true,
      });

      expect(context.store.get("port")).toBe(19191);
      expect(context.accessor.get("port")).toBe(19191);
      expect(context.warnings).toEqual([]);
      expect(process.env.PORT).toBeUndefined();
      expect(JSON.stringify(Object.entries(process.env).sort())).toBe(envBefore);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
