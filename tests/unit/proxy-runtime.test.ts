import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/config/load.js";
import { definePreset, registerPreset } from "@/config/presets.js";
import { EventHub } from "@/core/events/index.js";
import {
  createRequestTerminal,
  registerRequestTerminalPublisher,
  type RequestTerminalPublisher,
} from "@/core/request-terminal.js";
import type { IdentityProvider, PipeEvent, ProxyProtocol } from "@/core/types/proxy.js";
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
    expect(runtime.options.ctx.config).toBe(runtime.context.accessor);
    expect(runtime.getProxy().options.ctx.config).toBe(runtime.context.accessor);
  });

  it("配置实例彼此隔离，不存在可被隐式污染的全局 store", async () => {
    const portA = await getFreePort();
    const portB = await getFreePort();
    const first = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: portA, authEnabled: false, authType: "basic" },
      }),
    );
    const second = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: portB, authEnabled: true, authType: "basic" },
      }),
    );

    expect(first.context).not.toBe(second.context);
    expect(first.context.store).not.toBe(second.context.store);
    expect(first.context.accessor).not.toBe(second.context.accessor);
    expect(first.context.store.get("port")).toBe(portA);
    expect(second.context.store.get("port")).toBe(portB);
    // `authType` 必须显式给成会判人的模式：`isEnabled` 的口径是
    // `enabled && type !== "none"`（`authType` 缺省是 `none`），只给 `authEnabled: true`
    // 得到的答案是 false —— 那不是隔离性回归，是口径变了。判据「两份 store 各读各的」
    // 要求两份的 `type` 相同、只让 `enabled` 分岔。
    expect(first.services.identity.isEnabled).toBe(false);
    expect(second.services.identity.isEnabled).toBe(true);
  });

  it("isEnabled 口径收紧：enabled=true 但 authType=none 时恒为 false（不判人 = 不启用识别）", () => {
    // 这条锁的是 `isEnabled` 的口径本身：它是「本实例会不会拒绝任何人」，
    // 于是 `type === "none"` 并进了这个字段。**只读 `enabled` 是不够的**——
    // `AUTH_ENABLED=true` + `AUTH_TYPE=none` 这组配置会报「启用」而实际从不判人 ——
    // 消费方若据此走进鉴权握手分支，就是一次「不判人的模式在握手
    // 上装作要判」的错配。现在它只有一个答案：false。
    const judging = own(createProxyRuntime({ config: { authEnabled: true, authType: "basic" } }));
    const inert = own(createProxyRuntime({ config: { authEnabled: true, authType: "none" } }));

    expect(judging.services.identity.isEnabled).toBe(true);
    expect(inert.services.identity.isEnabled).toBe(false);
    // 两者的 kind 仍如实透出（审计与 SOCKS 方法协商要看它）
    expect(judging.services.identity.kind).toBe("basic");
    expect(inert.services.identity.kind).toBe("none");
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
    // 这条断言同时锁住「runtime 自己在 start 轮次里加的 `lifecycle.changed`
    // 订阅已随 stop 释放」——否则这里会是 6（5 宿主 + 1 残留）。
    expect(events.listenerCount()).toBe(5);
    // `lifecycle.changed` 由 core 直接发布（唯一来源），runtime 只派生 `runtime.*`：
    // 每个跃迁恰好一条，且**先于**它派生出的 `runtime.*`（core 是发布方，runtime 是观察方）。
    expect(names).toEqual([
      "lifecycle:starting",
      "runtime.starting",
      "lifecycle:running",
      "runtime.started",
      "lifecycle:stopping",
      "runtime.stopping",
      "lifecycle:stopped",
      "runtime.stopped",
    ]);
    // 计数护栏：4 次跃迁 → 4 条 lifecycle.changed + 4 条 runtime.*，没有重复发布。
    expect(names.filter((name) => name === "lifecycle:starting")).toHaveLength(1);
    expect(names.filter((name) => name.startsWith("lifecycle:"))).toHaveLength(4);
    expect(names.filter((name) => name.startsWith("runtime."))).toHaveLength(4);

    // stop 之后 runtime 的订阅已摘：再人为发一条 `lifecycle.changed` 不得派生任何 `runtime.*`
    // （宿主自己的 `lifecycle.changed` 订阅照旧收得到，故只断言 `runtime.*` 这一侧归零）。
    events.publish("lifecycle.changed", { next: "starting", prev: "stopped" });
    expect(names.filter((name) => name.startsWith("runtime."))).toHaveLength(4);

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

  it("服务注入优先于默认 identity 装配（原样透传到 core）", () => {
    const identity: IdentityProvider = {
      kind: "stub",
      isEnabled: true,
      isOwnCredential: () => false,
      identify: async () => ({ passed: true, username: "injected" }),
    };
    const runtime = own(createProxyRuntime({ services: { identity } }));

    expect(runtime.services.identity).toBe(identity);
    expect(runtime.options.identity).toBe(identity);
  });

  it("服务注入优先于默认 access 装配（原样透传到 core）", () => {
    // 访问控制端口与身份服务同构：显式注入的替身**原样生效**，`services.ts:buildDefaultServices`
    // 里的 `?? createFileAccessControl(ctx.config)` 因此永不触发（装配期缺省解析只做一次）。
    const access = {
      checkClient: () => ({ allowed: true }),
      checkTarget: () => ({ allowed: true }),
      checkRoute: () => ({ direct: false }),
    };
    const runtime = own(createProxyRuntime({ services: { access } }));

    expect(runtime.services.access).toBe(access);
    expect(runtime.options.access).toBe(access);
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
      env: {
        PORT: String(port),
        HOST: "127.0.0.1",
        AUTH_ENABLED: "false",
        // `isEnabled` 口径是 `enabled && type !== "none"`（`authType` 缺省
        // 是 `none`），故本条要观察「热改 authEnabled 让身份服务从关闭翻到开启」就必须把
        // type 钉成会判人的模式，否则断言会挂在口径变化上而不是隔离性上。
        AUTH_TYPE: "basic",
      },
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
    expect(runtime.services.identity.isEnabled).toBe(true);
    expect(changed).toHaveBeenCalledWith(["authEnabled"]);

    context.store.set("port", port + 1);
    expect(runtime.context.accessor.get("port")).toBe(port);
    expect(runtime.getStats().port).toBe(port);
    expect(restartRequired).toHaveBeenCalledWith(["port"]);
  });

  it("流量配额三个配置项按相位分流：账本目录要重启，另两个热改即生效", async () => {
    // 锁的是本仓既有契约（`runtime.startupKeys` 按 FIELDS 的 phase 分流），而
    // 「quotaLedgerDir 是 startup、quotaResetHour/quotaFlushInterval 是 runtime」
    // 这条分类的后果分两种：账本目录被标成 runtime 时，
    // 运行中改目录会「看起来生效」（实际 append 句柄仍指向旧文件，改了等于没改）；
    // resetHour 被标成 startup 时，热改必须重启才生效，运维会以为配置坏了。
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

    await runtime.start();

    // startup 键：只发 restart-required，且当前实例的读值保持原样
    context.store.set("quotaLedgerDir", path.join(os.tmpdir(), "quota-ledger-moved"));
    expect(restartRequired).toHaveBeenCalledWith(["quotaLedgerDir"]);
    expect(changed).not.toHaveBeenCalled();
    expect(runtime.context.accessor.get("quotaLedgerDir")).toBe(
      path.join(process.cwd(), "cfg", "quota"),
    );

    // runtime 键：只发 changed，且现读立刻拿到新值（restartRequired 的调用数不增）
    context.store.set("quotaResetHour", 3);
    expect(changed).toHaveBeenCalledWith(["quotaResetHour"]);
    expect(restartRequired).toHaveBeenCalledTimes(1);
    expect(runtime.context.accessor.get("quotaResetHour")).toBe(3);

    context.store.set("quotaFlushInterval", 1234);
    expect(changed).toHaveBeenLastCalledWith(["quotaFlushInterval"]);
    expect(restartRequired).toHaveBeenCalledTimes(1);
    expect(runtime.context.accessor.get("quotaFlushInterval")).toBe(1234);
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
    expect(first.options.ctx.config).not.toBe(second.options.ctx.config);

    const publisher = (): RequestTerminalPublisher => ({
      completed: vi.fn(),
      rejected: vi.fn(),
      failed: vi.fn(),
    });
    const firstPublisher = publisher();
    const secondPublisher = publisher();
    const unbindFirst = registerRequestTerminalPublisher(
      first.options.ctx.config,
      "http",
      firstPublisher,
    );
    const unbindSecond = registerRequestTerminalPublisher(
      second.options.ctx.config,
      "http",
      secondPublisher,
    );

    createRequestTerminal(first.options.ctx.config, "http").complete(200);
    createRequestTerminal(second.options.ctx.config, "http").complete(201);
    expect(firstPublisher.completed).toHaveBeenCalledTimes(1);
    expect(secondPublisher.completed).toHaveBeenCalledTimes(1);

    // 先退订的一方不得误删后一个仍生效的 publisher
    unbindFirst();
    createRequestTerminal(second.options.ctx.config, "http").complete(202);
    expect(firstPublisher.completed).toHaveBeenCalledTimes(1);
    expect(secondPublisher.completed).toHaveBeenCalledTimes(2);
    unbindSecond();

    // 全部退订后 createRequestTerminal 仍可作纯 guard 使用（不发布、无异常）
    expect(() => createRequestTerminal(second.options.ctx.config, "http").complete(203)).not.toThrow();
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
    expect(runtime.getProxy().options.ctx.config.get("upstreamHost")).toBe("proxy.example");
    expect(runtime.getProxy().options.ctx.config.get("upstreamPort")).toBe(8443);

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
    expect(first.getProxy().options.ctx.config.get("upstreamHost")).toBe("old.example");
    expect(second.getProxy().options.ctx.config.get("upstreamHost")).toBe("new.example");
    expect(second.getProxy().options.ctx.config.get("upstreamPort")).toBe(9443);
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
    expect(runtime.options.ctx.config).toBe(runtime.context.accessor);

    expect(() => {
      (runtime.options as unknown as { port: number }).port = 1;
    }).toThrow(TypeError);
    expect(() => {
      (runtime.services as unknown as { identity: unknown }).identity = {};
    }).toThrow(TypeError);
    expect(() => {
      (runtime.services as unknown as { access: unknown }).access = {};
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

      // 首次成功加载只落缓存、不发事件（启动摘要已覆盖），这里只证明读面已建立。
      // 判定面收成端口后走 `runtime.services.access`（与 core 拿到的是同一份实现）。
      expect(runtime.services.access.checkClient({ client: "127.0.0.1" }).allowed).toBe(true);
      expect(reloaded).toHaveLength(0);

      // 内容（连带 size）变更 → 本轮真读 → reloaded：与 file-error/file-recovered 同轴的第三态
      fs.writeFileSync(
        aclPath,
        JSON.stringify({ target: { blacklist: ["blocked.invalid", "also.invalid"] } }),
      );
      await sleep(1100);
      runtime.services.access.checkClient({ client: "127.0.0.1" });

      expect(reloaded).toEqual([{ path: aclPath, runtimeId: runtime.runtimeId }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("start→stop→start 重建 bridge/store 订阅，外部 hub 订阅跨 stop 保留", async () => {
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
    // core 不经自带 EventEmitter 抛 `auth`/`pipe` 事实，直接发布到
    // `ctx.events`（本 runtime 的 events）。故「bridge 订阅随 start 建立、随 stop 解除」这条
    // 不变式改由它**唯一还在桥接的 `pipe` 事实**验证：hub 上 `pipe` 的 listenerCount 即 core 订阅数。
    // `lifecycle.changed` 订阅同样进 start/stop 循环，故一起断言。
    // ⚠️ **「基线 + 1」已改成「基线 + 2」**（2026-09，`[lifecycle] state …` 那一族落盘绑定
    // 整体搬进 `runtime/event-log.ts` 之后）：现在 `lifecycle.changed` 上有**两条** runtime 自己
    // 的订阅 —— ① `runtime.*` 派生（1.3b 起）与 ② `[lifecycle] state …` 落盘
    // （`bindLifecycleLog`，随 `eventLogs` 缺省 `true` 一起装上；本用例没传 `logger`，走的是
    // `createNoopLogger()` 缺省档，**绑定照样装**——「logger 是 noop」关的是 IO，不是订阅）。
    // 这条断言因此比原来**更强**：它现在同时证明两条订阅都被 start 建立、被 stop 摘掉、
    // 幂等 start 不叠加。
    const ipDenied: PipeEvent = {
      type: "ip-denied",
      client: "10.0.0.9",
      reason: "blacklist",
      protocol: "http",
    };
    const denied: string[] = [];
    const startedStates: string[] = [];
    events.subscribe("lifecycle.changed", ({ data }) => startedStates.push(data.next));
    // 宿主自己那条 `lifecycle.changed` 订阅是基线；runtime 的订阅必须是「基线 + 2」。
    const lifecycleBase = events.listenerCount("lifecycle.changed");
    const RUNTIME_LIFECYCLE_SUBSCRIPTIONS = 2;

    expect(events.listenerCount("pipe")).toBe(0);
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase);
    await runtime.start();
    await runtime.start();
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase + RUNTIME_LIFECYCLE_SUBSCRIPTIONS);
    expect(loaded).toHaveBeenCalledTimes(2);
    events.publish("pipe", ipDenied, { protocol: "http" });
    events.subscribe("access.client-denied", ({ data }) => denied.push(data.client));
    events.publish("pipe", ipDenied, { protocol: "http" });
    expect(denied).toEqual(["10.0.0.9"]);

    runtime.context.store.set("authEnabled", true);
    runtime.context.store.set("port", port + 1);
    expect(changed).toHaveBeenCalledWith(["authEnabled"]);
    expect(restartRequired).toHaveBeenCalledWith(["port"]);
    await runtime.stop();

    expect(events.listenerCount("pipe")).toBe(0);
    // 生命周期订阅随 stop 释放（否则就是停机后监听残留）
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase);
    expect(hostSubscription.disposed).toBe(false);
    const countAfterStop = events.listenerCount();
    runtime.context.store.set("authLogging", false);
    expect(changed).toHaveBeenCalledTimes(1);

    await runtime.start();
    expect(events.listenerCount("pipe")).toBeGreaterThan(0);
    // 重新 start 后这条订阅必须恢复（否则 runtime.started 之类的派生事实会静默断供）
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase + RUNTIME_LIFECYCLE_SUBSCRIPTIONS);
    events.publish("pipe", ipDenied, { protocol: "http" });
    expect(denied).toEqual(["10.0.0.9", "10.0.0.9"]);
    runtime.context.store.set("authLogging", true);
    expect(changed).toHaveBeenCalledWith(["authLogging"]);
    await runtime.stop();

    expect(events.listenerCount()).toBe(countAfterStop);
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase);
    expect(hostStarted).toHaveLength(2);
    // 两轮 start→stop：每轮恰好 4 条跃迁（幂等的第二次 start 不发），共 8 条、无重复。
    expect(startedStates).toEqual([
      "starting",
      "running",
      "stopping",
      "stopped",
      "starting",
      "running",
      "stopping",
      "stopped",
    ]);
  });

  it("stop-before-start 后首次 start 仍恢复 bridge、lifecycle 与 store 事件订阅", async () => {
    const port = await getFreePort();
    const events = new EventHub({ onListenerError: () => undefined });
    const changed = vi.fn();
    events.subscribe("config.changed", ({ data }) => changed(data.keys));
    const startedStates: string[] = [];
    events.subscribe("lifecycle.changed", ({ data }) => startedStates.push(data.next));
    // 同上：runtime 自己两条（`runtime.*` 派生 + `[lifecycle] state …` 落盘），见上一条用例的注释
    const lifecycleBase = events.listenerCount("lifecycle.changed");
    const RUNTIME_LIFECYCLE_SUBSCRIPTIONS = 2;
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port },
        events,
      }),
    );

    await runtime.stop();
    expect(events.listenerCount("pipe")).toBe(0);
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase);
    await runtime.start();
    expect(events.listenerCount("pipe")).toBeGreaterThan(0);
    // stop-before-start 之后这条订阅也必须恢复
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase + RUNTIME_LIFECYCLE_SUBSCRIPTIONS);
    runtime.context.store.set("authLogging", false);
    expect(changed).toHaveBeenCalledWith(["authLogging"]);
    expect(startedStates).toEqual(["starting", "running"]);
    await runtime.stop();
    expect(events.listenerCount("lifecycle.changed")).toBe(lifecycleBase);
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
