import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/config/load.js";
import { definePreset, registerPreset } from "@/config/presets.js";
import { checkClientIp } from "@/core/access-control.js";
import { EventHub } from "@/core/events/index.js";
import {
  createRequestTerminal,
  registerRequestTerminalPublisher,
  type RequestTerminalPublisher,
} from "@/core/request-terminal.js";
import type { AuthProvider, ProxyAuthEvent, ProxyProtocol } from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime, RuntimeWarning } from "@/runtime/index.js";
import { getFreePort, sleep } from "../helpers/net.js";

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
    const changed = vi.fn();
    events.subscribe("runtime.error", (event) => errors.push(event.data.error));
    events.subscribe("config.changed", ({ data }) => changed(data.keys));
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

      // 启动失败不能提前清理订阅，随后仍应收到 live store 的热改事件。
      runtime.context.store.set("authLogging", false);
      expect(changed).toHaveBeenCalledWith(["authLogging"]);
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
    expect(runtime.isRunning()).toBe(false);

    context.store.set("authEnabled", true);
    expect(changed).not.toHaveBeenCalled();

    await runtime.start();
    context.store.set("authEnabled", false);
    context.store.set("authEnabled", true);
    expect(runtime.services.auth.isEnabled).toBe(true);
    expect(changed).toHaveBeenCalledWith(["authEnabled"]);

    context.store.set("port", port + 1);
    expect(runtime.context.accessor.get("port")).toBe(port);
    expect(runtime.getStats().port).toBe(port);
    expect(restartRequired).toHaveBeenCalledWith(["port"]);
  });

  it("终态 publisher 注册表按 accessor 隔离：共享同一 store 的两个 runtime 互不顶替", async () => {
    // 保护：core/request-terminal.ts 的 publisher 注册表是模块级
    // WeakMap<ConfigAccessor, Map<protocol, publisher>>，它的隔离**只**建立在「每个 runtime 派生自己的
    // accessor 对象」这个隐含约定上（bindRuntimeContext 每次 Object.freeze 造新对象）。若哪天为了省分配
    // 改成共享 accessor，同 protocol 下后 attach 的会静默顶掉前一个，前者的 request.completed /
    // rejected / failed 会全部消失且无任何报错。本条把该约定与 unbind 保护一起锁死。
    const port = await getFreePort();
    const context = await loadConfig({
      env: { PORT: String(port), HOST: "127.0.0.1", AUTH_ENABLED: "false" },
      envFiles: [],
      argv: [],
      cwd: process.cwd(),
      skipFileValidation: true,
    });
    const first = own(createProxyRuntime({ context }));
    const second = own(createProxyRuntime({ context }));

    // 同 store（共享 live 状态）、不同 accessor（请求期隔离位，含启动键冻结快照）
    expect(first.context.store).toBe(second.context.store);
    expect(first.context.accessor).not.toBe(second.context.accessor);
    expect(first.options.config).not.toBe(second.options.config);

    const publisher = (): RequestTerminalPublisher => ({
      completed: vi.fn(),
      rejected: vi.fn(),
      failed: vi.fn(),
    });
    const firstPublisher = publisher();
    const secondPublisher = publisher();
    const unbindFirst = registerRequestTerminalPublisher(
      first.options.config,
      "http",
      firstPublisher,
    );
    const unbindSecond = registerRequestTerminalPublisher(
      second.options.config,
      "http",
      secondPublisher,
    );

    createRequestTerminal(first.options.config, "http").complete(200);
    createRequestTerminal(second.options.config, "http").complete(201);
    expect(firstPublisher.completed).toHaveBeenCalledTimes(1);
    expect(secondPublisher.completed).toHaveBeenCalledTimes(1);

    // 先退订的一方不得误删后一个仍生效的 publisher
    unbindFirst();
    createRequestTerminal(second.options.config, "http").complete(202);
    expect(firstPublisher.completed).toHaveBeenCalledTimes(1);
    expect(secondPublisher.completed).toHaveBeenCalledTimes(2);
    unbindSecond();

    // 全部退订后 createRequestTerminal 仍可作纯 guard 使用（不发布、无异常）
    expect(() => createRequestTerminal(second.options.config, "http").complete(203)).not.toThrow();
    expect(secondPublisher.completed).toHaveBeenCalledTimes(2);
  });

  it("纯内存 UPSTREAM_URL 在构造期拆解到 context.store 与 core，非法 URL 构造失败", () => {
    const runtime = own(
      createProxyRuntime({
        config: {
          upstreamUrl: "https://alice:secret@proxy.example:8443",
          upstreamHost: "ignored.example",
          upstreamPort: 9999,
        },
      }),
    );

    expect(runtime.context.store.get("upstreamProtocol")).toBe("https");
    expect(runtime.context.store.get("upstreamSecure")).toBe(true);
    expect(runtime.context.store.get("upstreamHost")).toBe("proxy.example");
    expect(runtime.context.store.get("upstreamPort")).toBe(8443);
    expect(runtime.context.store.get("upstreamUsername")).toBe("alice");
    expect(runtime.context.store.get("upstreamPassword")).toBe("secret");
    expect(runtime.getProxy().options.config.get("upstreamHost")).toBe("proxy.example");
    expect(runtime.getProxy().options.config.get("upstreamPort")).toBe(8443);

    expect(() =>
      createProxyRuntime({
        config: { upstreamUrl: "not a url" },
      }),
    ).toThrow("配置校验失败: UPSTREAM_URL=not a url 非法");
  });

  it("context store 热改启动 URL 后，旧 runtime 保持冻结，新 runtime 共享 store 并应用拆项", async () => {
    const port = await getFreePort();
    const oldUrl = "https://old.example:8443";
    const newUrl = "https://new.example:9443";
    const context = await loadConfig({
      env: { PORT: String(port), UPSTREAM_URL: oldUrl, AUTH_ENABLED: "false" },
      envFiles: [],
      argv: [],
      cwd: process.cwd(),
      skipFileValidation: true,
    });
    const events = new EventHub({ onListenerError: () => undefined });
    const restartRequired = vi.fn();
    events.subscribe("config.restart-required", ({ data }) => restartRequired(data.keys));
    const first = own(createProxyRuntime({ context, events }));

    await first.start();
    context.store.set("upstreamUrl", newUrl);

    expect(first.context.store).toBe(context.store);
    expect(first.context.accessor.get("upstreamUrl")).toBe(oldUrl);
    expect(first.context.accessor.get("upstreamHost")).toBe("old.example");
    expect(restartRequired).toHaveBeenCalledWith(["upstreamUrl"]);

    const second = own(createProxyRuntime({ context }));
    expect(second.context.store).toBe(context.store);
    expect(second.context.accessor).not.toBe(first.context.accessor);
    expect(second.context.accessor.get("upstreamUrl")).toBe(newUrl);
    expect(second.context.accessor.get("upstreamHost")).toBe("new.example");
    expect(second.context.accessor.get("upstreamPort")).toBe(9443);
    // 第二个 runtime 重建时会把新拆项写回共享 store；第一个 runtime 的 startup accessor 仍冻结旧值。
    expect(first.context.accessor.get("upstreamHost")).toBe("old.example");
    expect(first.getProxy().options.config.get("upstreamHost")).toBe("old.example");
    expect(second.getProxy().options.config.get("upstreamHost")).toBe("new.example");
    expect(second.getProxy().options.config.get("upstreamPort")).toBe(9443);
  });

  it("纯内存 configDir 捕获一次：显式相对路径全部绝对化且 chdir 后不漂移", () => {
    const originalCwd = process.cwd();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-runtime-cwd-"));
    try {
      const configDir = "runtime-config-anchor";
      const absoluteConfigDir = path.resolve(originalCwd, configDir);
      const runtime = own(
        createProxyRuntime({
          configDir,
          config: {
            authUsersFile: "users.json",
            aclFile: "acl.json",
            logFile: "logs",
            tlsKey: "keys/server.key",
            tlsCert: "keys/server.crt",
            tlsCa: "ca/client.crt",
            upstreamCa: "ca/upstream.pem",
          },
        }),
      );

      expect(runtime.context.configDir).toBe(absoluteConfigDir);
      expect(runtime.context.store.get("authUsersFile")).toBe(
        path.join(absoluteConfigDir, "users.json"),
      );
      expect(runtime.context.store.get("aclFile")).toBe(path.join(absoluteConfigDir, "acl.json"));
      expect(runtime.context.store.get("logFile")).toBe(path.join(absoluteConfigDir, "logs"));
      expect(runtime.context.store.get("tlsKey")).toBe(
        path.join(absoluteConfigDir, "keys", "server.key"),
      );
      expect(runtime.context.store.get("tlsCert")).toBe(
        path.join(absoluteConfigDir, "keys", "server.crt"),
      );
      expect(runtime.context.store.get("tlsCa")).toBe(
        path.join(absoluteConfigDir, "ca", "client.crt"),
      );
      expect(runtime.context.store.get("upstreamCa")).toBe(
        path.join(absoluteConfigDir, "ca", "upstream.pem"),
      );

      process.chdir(elsewhere);
      expect(runtime.context.configDir).toBe(absoluteConfigDir);
      expect(runtime.context.store.get("aclFile")).toBe(path.join(absoluteConfigDir, "acl.json"));
      expect(runtime.context.config.authUsersFile).toBe(path.join(absoluteConfigDir, "users.json"));
      expect(runtime.context.config.tlsKey).toBe(
        path.join(absoluteConfigDir, "keys", "server.key"),
      );
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("config.loaded 的 sourceName 按 argv 优先于 environment/env-files", async () => {
    const port = await getFreePort();
    const context = await loadConfig({
      env: { PORT: String(port + 1), AUTH_ENABLED: "false" },
      envFiles: [path.join(os.tmpdir(), "proxy-runtime-source.env")],
      argv: ["--port", String(port)],
      cwd: process.cwd(),
      skipFileValidation: true,
    });
    const events = new EventHub({ onListenerError: () => undefined });
    const sources: string[] = [];
    events.subscribe("config.loaded", ({ data }) => sources.push(data.source));
    const runtime = own(createProxyRuntime({ context, events }));

    await runtime.start();
    expect(sources).toEqual(["argv"]);
  });

  it("归一化 warning 只旁路报告本次新增项，不重复报告 loadConfig warning", async () => {
    const memoryWarning = vi.fn<(warning: RuntimeWarning) => void>();
    own(
      createProxyRuntime({
        config: {
          upstreamUrl: "https://proxy.example:8443",
          upstreamHost: "ignored.example",
        },
        onWarning: memoryWarning,
      }),
    );
    expect(memoryWarning).toHaveBeenCalledWith({
      code: "config-normalized",
      message: expect.stringContaining("UPSTREAM_URL"),
    });

    const context = await loadConfig({
      env: {
        UPSTREAM_URL: "https://proxy.example:8443",
        UPSTREAM_HOST: "ignored.example",
        AUTH_ENABLED: "false",
      },
      envFiles: [],
      argv: [],
      cwd: process.cwd(),
      skipFileValidation: true,
    });
    expect(context.warnings).toHaveLength(1);
    const contextWarning = vi.fn<(warning: RuntimeWarning) => void>();
    const fromContext = own(createProxyRuntime({ context, onWarning: contextWarning }));
    expect(contextWarning).not.toHaveBeenCalled();
    expect(fromContext.context.warnings).toHaveLength(1);
  });

  it("preset 内 URL 覆盖拆项仍报告 warning", () => {
    const unregister = registerPreset(
      definePreset({
        name: "url-warning-preset",
        config: {
          upstreamUrl: "https://proxy.example:8443",
          upstreamHost: "ignored.example",
        },
      }),
    );
    const warning = vi.fn<(value: RuntimeWarning) => void>();
    try {
      own(createProxyRuntime({ preset: "url-warning-preset", onWarning: warning }));
      expect(warning).toHaveBeenCalledWith({
        code: "config-normalized",
        message: expect.stringContaining("UPSTREAM_URL"),
      });
    } finally {
      unregister();
    }
  });

  it("options/services/accessor 是冻结视图，store 仍保持可变", () => {
    const runtime = own(createProxyRuntime());
    expect(Object.isFrozen(runtime.options)).toBe(true);
    expect(Object.isFrozen(runtime.services)).toBe(true);
    expect(Object.isFrozen(runtime.context.accessor)).toBe(true);
    expect(Object.isFrozen(runtime.options.tls)).toBe(true);
    expect(Object.isFrozen(runtime.context.store)).toBe(false);
    expect(runtime.options.config).toBe(runtime.context.accessor);

    expect(() => {
      (runtime.options as unknown as { port: number }).port = 1;
    }).toThrow(TypeError);
    expect(() => {
      (runtime.services as unknown as { auth: unknown }).auth = {};
    }).toThrow(TypeError);
    expect(() => {
      (runtime.context.accessor as unknown as { get: unknown }).get = () => 1;
    }).toThrow(TypeError);

    runtime.context.store.set("proxyMode", "client");
    expect(runtime.context.store.get("proxyMode")).toBe("client");
    expect(runtime.context.accessor.get("proxyMode")).toBe("client");
  });

  it("名单内容热加载成功：公共事件面发布 config.file-reloaded 且路径正确", async () => {
    // readJsonCached 的 stat 节流窗口是 1000ms（throttled 判定面只补 missing/error，
    // 永远不会发 reloaded），所以只能「改内容 + 等窗口过」触发，force 是启动期校验专用。
    const port = await getFreePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-runtime-acl-"));
    const aclPath = path.join(dir, "acl.json");
    fs.writeFileSync(aclPath, JSON.stringify({ target: { blacklist: ["blocked.invalid"] } }));

    const events = new EventHub({ onListenerError: () => undefined });
    const reloaded: { path: string; runtimeId: string }[] = [];
    events.subscribe("config.file-reloaded", ({ data, context }) => {
      reloaded.push({ path: data.path, runtimeId: context.runtimeId });
    });
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port, authEnabled: false, aclFile: aclPath },
        events,
      }),
    );

    try {
      // 名单观察面只在 start 期间绑定（bindAclFileEvents），所以必须先启停一轮
      await runtime.start();

      // 首次成功加载只落缓存、不发事件（启动摘要已覆盖），这里只证明读面已建立
      expect(checkClientIp("127.0.0.1", runtime.context.accessor).allowed).toBe(true);
      expect(reloaded).toHaveLength(0);

      // 内容（连带 size）变更 → 本轮真读 → reloaded：与 file-error/file-recovered 同轴的第三态
      fs.writeFileSync(
        aclPath,
        JSON.stringify({ target: { blacklist: ["blocked.invalid", "also.invalid"] } }),
      );
      await sleep(1100);
      checkClientIp("127.0.0.1", runtime.context.accessor);

      expect(reloaded).toEqual([{ path: aclPath, runtimeId: runtime.runtimeId }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("start→stop→start 重建 bridge/store 订阅，外部 hub 订阅跨 stop 保留", async () => {
    interface EmittableCore {
      emit(name: "auth", data: ProxyAuthEvent): boolean;
      listenerCount(name: "auth"): number;
    }

    const port = await getFreePort();
    const events = new EventHub({ onListenerError: () => undefined });
    const hostStarted: string[] = [];
    const hostSubscription = events.subscribe("runtime.started", (event) => {
      hostStarted.push(event.context.runtimeId);
    });
    const loaded = vi.fn();
    const changed = vi.fn();
    const restartRequired = vi.fn();
    events.subscribe("config.loaded", ({ data }) => loaded(data.source));
    events.subscribe("config.changed", ({ data }) => changed(data.keys));
    events.subscribe("config.restart-required", ({ data }) => restartRequired(data.keys));
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port },
        events,
      }),
    );
    const core = runtime.getProxy() as unknown as EmittableCore;
    const authEvent: ProxyAuthEvent = {
      passed: true,
      tag: "",
      client: "127.0.0.1",
      target: "example.com:80",
      user: "alice",
    };
    const authSeen: boolean[] = [];

    expect(core.listenerCount("auth")).toBe(0);
    await runtime.start();
    await runtime.start();
    expect(loaded).toHaveBeenCalledTimes(2);
    expect(core.emit("auth", authEvent)).toBe(true);
    events.subscribe("auth.decided", ({ data }) => authSeen.push(data.passed));
    core.emit("auth", authEvent);
    expect(authSeen).toEqual([true]);

    runtime.context.store.set("authEnabled", true);
    runtime.context.store.set("port", port + 1);
    expect(changed).toHaveBeenCalledWith(["authEnabled"]);
    expect(restartRequired).toHaveBeenCalledWith(["port"]);
    await runtime.stop();

    expect(core.listenerCount("auth")).toBe(0);
    expect(hostSubscription.disposed).toBe(false);
    const countAfterStop = events.listenerCount();
    runtime.context.store.set("authLogging", false);
    expect(changed).toHaveBeenCalledTimes(1);

    await runtime.start();
    expect(core.listenerCount("auth")).toBeGreaterThan(0);
    core.emit("auth", authEvent);
    expect(authSeen).toEqual([true, true]);
    runtime.context.store.set("authLogging", true);
    expect(changed).toHaveBeenCalledWith(["authLogging"]);
    await runtime.stop();

    expect(events.listenerCount()).toBe(countAfterStop);
    expect(hostStarted).toHaveLength(2);
  });

  it("stop-before-start 后首次 start 仍恢复 bridge 与 store 事件订阅", async () => {
    interface EmittableCore {
      emit(name: "auth", data: ProxyAuthEvent): boolean;
      listenerCount(name: "auth"): number;
    }

    const port = await getFreePort();
    const events = new EventHub({ onListenerError: () => undefined });
    const changed = vi.fn();
    events.subscribe("config.changed", ({ data }) => changed(data.keys));
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port },
        events,
      }),
    );
    const core = runtime.getProxy() as unknown as EmittableCore;

    await runtime.stop();
    expect(core.listenerCount("auth")).toBe(0);
    await runtime.start();
    expect(core.listenerCount("auth")).toBeGreaterThan(0);
    runtime.context.store.set("authLogging", false);
    expect(changed).toHaveBeenCalledWith(["authLogging"]);
    await runtime.stop();
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
