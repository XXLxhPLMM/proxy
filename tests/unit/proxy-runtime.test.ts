import fs from "node:fs";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/config/load.js";
import { EventHub } from "@/core/events/index.js";
import type { AuthProvider, ProxyProtocol } from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime, RuntimeWarning } from "@/runtime/index.js";
import { getFreePort } from "../helpers/net.js";

const activeRuntimes: ProxyRuntime[] = [];

function own(runtime: ProxyRuntime): ProxyRuntime {
  activeRuntimes.push(runtime);
  return runtime;
}

async function listen(server: net.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function processSnapshot(): {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  eventNames: string[];
} {
  return {
    env: { ...process.env },
    argv: [...process.argv],
    eventNames: process
      .eventNames()
      .map((name) => String(name))
      .sort(),
  };
}

afterEach(async () => {
  const runtimes = activeRuntimes.splice(0);
  for (const runtime of runtimes) {
    await runtime.stop().catch(() => undefined);
  }
  vi.restoreAllMocks();
});

describe("runtime/createProxyRuntime", () => {
  it("构造阶段零副作用：不读 env/argv/文件、不写输出、不注册 process 监听", async () => {
    const port = await getFreePort();
    const before = processSnapshot();
    const readFile = vi.spyOn(fs, "readFileSync");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port },
      }),
    );

    expect({ ...process.env }).toEqual(before.env);
    expect([...process.argv]).toEqual([...before.argv]);
    expect(
      process
        .eventNames()
        .map((name) => String(name))
        .sort(),
    ).toEqual(before.eventNames);
    expect(readFile).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(runtime.isRunning()).toBe(false);
    expect(runtime.getProxy().isRunning()).toBe(false);
    expect(runtime.options.config).toBe(runtime.context.accessor);
    expect(runtime.getProxy().options.config).toBe(runtime.context.accessor);
  });

  it("配置实例彼此隔离，不存在可被隐式污染的全局 store", async () => {
    const portA = await getFreePort();
    const portB = await getFreePort();
    const first = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: portA, authEnabled: false },
      }),
    );
    const second = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: portB, authEnabled: true },
      }),
    );

    expect(first.context).not.toBe(second.context);
    expect(first.context.store).not.toBe(second.context.store);
    expect(first.context.accessor).not.toBe(second.context.accessor);
    expect(first.context.store.get("port")).toBe(portA);
    expect(second.context.store.get("port")).toBe(portB);
    expect(first.services.auth.isEnabled).toBe(false);
    expect(second.services.auth.isEnabled).toBe(true);
  });

  it("事件总线默认按 runtime 隔离，显式注入时保持同一实例", () => {
    const first = own(createProxyRuntime());
    const second = own(createProxyRuntime());
    const external = new EventHub();
    const attached = own(createProxyRuntime({ events: external }));

    expect(first.events).not.toBe(second.events);
    expect(first.runtimeId).not.toBe(second.runtimeId);
    expect(attached.events).toBe(external);
    expect(attached.runtimeId).toBe(external.runtimeId);
  });

  it("默认 logger 是零输出端口，显式 logger 原样注入", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runtime = own(createProxyRuntime());

    runtime.logger.debug("debug");
    runtime.logger.info("info");
    runtime.logger.warn("warn");
    runtime.logger.error("error");

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();

    const injected = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const withLogger = own(createProxyRuntime({ logger: injected }));
    expect(withLogger.logger).toBe(injected);
  });

  it("按配置选择协议；明文协议忽略不存在的 TLS 路径", async () => {
    const port = await getFreePort();
    const runtime = own(
      createProxyRuntime({
        config: {
          host: "127.0.0.1",
          port,
          proxyProtocol: "socks5",
          tlsKey: "missing-runtime.key",
          tlsCert: "missing-runtime.crt",
          tlsCa: "missing-runtime-ca.crt",
        },
      }),
    );

    expect(runtime.getProxy().protocol).toBe("socks5");
    expect(runtime.options.tls).toEqual({});
    await expect(runtime.start()).resolves.toBeUndefined();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("未知协议在构造阶段给出清晰错误", () => {
    expect(() =>
      createProxyRuntime({
        config: { proxyProtocol: "ftp" as ProxyProtocol },
      }),
    ).toThrow("未知代理协议: ftp");
  });

  it("start/stop 幂等，停止释放端口与事件订阅，并发布生命周期事实", async () => {
    const port = await getFreePort();
    const events = new EventHub();
    const names: string[] = [];
    const subscriptions = [
      events.subscribe("runtime.starting", () => names.push("runtime.starting")),
      events.subscribe("runtime.started", () => names.push("runtime.started")),
      events.subscribe("runtime.stopping", () => names.push("runtime.stopping")),
      events.subscribe("runtime.stopped", () => names.push("runtime.stopped")),
      events.subscribe("lifecycle.changed", (event) => {
        names.push(`lifecycle:${event.data.next}`);
      }),
    ];
    expect(subscriptions).toHaveLength(5);

    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port },
        events,
      }),
    );
    const proxy = runtime.getProxy();

    await runtime.start();
    await runtime.start();
    expect(runtime.isRunning()).toBe(true);
    expect(runtime.getStats().running).toBe(true);

    const client = net.connect({ host: "127.0.0.1", port });
    client.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });

    await runtime.stop();
    client.destroy();
    await runtime.stop();

    expect(runtime.isRunning()).toBe(false);
    expect(runtime.getStats().running).toBe(false);
    expect(runtime.getProxy()).toBe(proxy);
    // 外部 EventHub 归调用方所有；runtime.stop 不得清掉宿主订阅。
    expect(events.listenerCount()).toBe(5);
    expect(names).toEqual([
      "runtime.starting",
      "lifecycle:starting",
      "runtime.started",
      "lifecycle:running",
      "runtime.stopping",
      "lifecycle:stopping",
      "runtime.stopped",
      "lifecycle:stopped",
    ]);

    const probe = net.createServer();
    await listen(probe, port);
    await close(probe);
  });

  it("启动失败通过 runtime.error 与 onWarning 上报，不退出宿主进程", async () => {
    const port = await getFreePort();
    const blocker = net.createServer();
    await listen(blocker, port);
    const warning = vi.fn<(w: RuntimeWarning) => void>();
    const events = new EventHub();
    const errors: unknown[] = [];
    events.subscribe("runtime.error", (event) => errors.push(event.data.error));
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port },
        events,
        onWarning: warning,
      }),
    );

    try {
      await expect(runtime.start()).rejects.toThrow();
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith({
        code: "start-failed",
        message: expect.any(String),
      });
      expect(errors).toHaveLength(1);
    } finally {
      await runtime.stop();
      await close(blocker);
    }
  });

  it("服务注入优先于默认 auth 装配", () => {
    const auth: AuthProvider = {
      authenticate: async () => ({ passed: true, username: "injected" }),
    };
    const runtime = own(createProxyRuntime({ services: { auth } }));

    expect(runtime.services.auth).toBe(auth);
    expect(runtime.options.auth).toBe(auth);
  });

  it("事件 listener 抛错不会穿透 runtime 生命周期", async () => {
    const port = await getFreePort();
    const events = new EventHub({ onListenerError: () => undefined });
    events.subscribe("runtime.starting", () => {
      throw new Error("observer failed");
    });
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port },
        events,
      }),
    );

    await expect(runtime.start()).resolves.toBeUndefined();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("加载后的 context 与 runtime 共享 live store，startup 字段只要求重启", async () => {
    const port = await getFreePort();
    const context = await loadConfig({
      env: { PORT: String(port), HOST: "127.0.0.1", AUTH_ENABLED: "false" },
      envFiles: [],
      argv: [],
      cwd: process.cwd(),
      skipFileValidation: true,
    });
    const events = new EventHub({ onListenerError: () => undefined });
    const restartRequired = vi.fn();
    const changed = vi.fn();
    events.subscribe("config.restart-required", ({ data }) => restartRequired(data.keys));
    events.subscribe("config.changed", ({ data }) => changed(data.keys));
    const runtime = own(createProxyRuntime({ context, events }));

    expect(runtime.context.store).toBe(context.store);
    expect(runtime.context.accessor).not.toBe(context.accessor);

    context.store.set("authEnabled", true);
    expect(runtime.services.auth.isEnabled).toBe(true);
    expect(changed).toHaveBeenCalledWith(["authEnabled"]);

    context.store.set("port", port + 1);
    expect(runtime.context.accessor.get("port")).toBe(port);
    expect(runtime.getStats().port).toBe(port);
    expect(restartRequired).toHaveBeenCalledWith(["port"]);
  });

  it("preset 提供默认场景，显式 config 覆盖 preset 且构造与启停保持零副作用", async () => {
    const port = await getFreePort();
    const before = processSnapshot();
    const readFile = vi.spyOn(fs, "readFileSync");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // 不变量：preset 生效、显式 port 获胜；整个过程不读 env/文件/监听器，也不输出日志。
    const runtime = own(
      createProxyRuntime({
        preset: "development",
        config: { port },
      }),
    );
    expect(runtime.context.store.get("port")).toBe(port);
    expect(runtime.context.store.get("host")).toBe("0.0.0.0");
    expect(runtime.context.store.get("proxyProtocol")).toBe("http");
    expect(runtime.context.store.get("authEnabled")).toBe(false);
    expect(runtime.context.store.get("logLevel")).toBe("debug");
    expect(processSnapshot()).toEqual(before);
    expect(readFile).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.isRunning()).toBe(true);
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(runtime.isRunning()).toBe(false);
    expect(processSnapshot()).toEqual(before);
    expect(readFile).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
