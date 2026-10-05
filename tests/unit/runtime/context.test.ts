/**
 * `createProxyRuntime`：**live store 与热改**（加载后共享 store 而 startup 字段只要求重启 /
 * 三个配额项按相位分流 / 终态 publisher 注册表按 accessor 隔离 / `options`·`services`·`accessor`
 * 冻结而 `store` 可变 / 名单热加载的公共事件面）。构造期→`create`、启停→`lifecycle`、
 * 启动 URL 与 configDir→`upstream-url`、`assembly` 优先级链→`assembly`。
 * ⚠️ 主题级不变量（生命周期事件唯一来源、订阅组归属、账本目录纪律）在 `./AGENTS.md`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/config/load.js";
import { EventHub } from "@/core/events/index.js";
import {
  createRequestTerminal,
  registerRequestTerminalPublisher,
  type RequestTerminalPublisher,
} from "@/core/request-terminal.js";
import { createProxyRuntime } from "@/runtime/index.js";
import { getFreePort, sleep } from "../../helpers/net.js";
import { own, stopOwnedRuntimes } from "./_proxy-runtime.js";

// 两条账本钉值（`setup-env.ts` 的 `QUOTA_USAGE_DIR` env 与 `set("quotaUsageDir", …)`）都只对
// 走 `loadConfig` 且**读宿主 env** 的调用方有效；`loadConfig` 的 `env` 是显式入参、缺省为空，
// `store` 也是另建的一个，于是两侧全落空。剩下的缺省是「相对路径 `cfg/usage` + `configDir`
// 回落到 `process.cwd()`」，而 `start()` 里的账本 `open()` 与是否真计量无关 —— 照建。
const LEDGER_DIR = path.join(os.tmpdir(), "proxy-runtime-context-usage");

afterEach(async () => {
  await stopOwnedRuntimes();
  vi.restoreAllMocks();
});

describe("runtime/createProxyRuntime：live store、热改与冻结视图", () => {
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
        QUOTA_USAGE_DIR: LEDGER_DIR,
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
    // 「quotaUsageDir 是 startup、quotaResetHour/quotaFlushInterval 是 runtime」
    // 这条分类的后果分两种：账本目录被标成 runtime 时，
    // 运行中改目录会「看起来生效」（实际 append 句柄仍指向旧文件，改了等于没改）；
    // resetHour 被标成 startup 时，热改必须重启才生效，运维会以为配置坏了。
    const port = await getFreePort();
    const context = await loadConfig({
      env: {
        PORT: String(port),
        HOST: "127.0.0.1",
        AUTH_ENABLED: "false",
        QUOTA_USAGE_DIR: LEDGER_DIR,
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

    await runtime.start();

    // startup 键：只发 restart-required，且当前实例的读值保持原样
    context.store.set("quotaUsageDir", path.join(os.tmpdir(), "quota-ledger-moved"));
    expect(restartRequired).toHaveBeenCalledWith(["quotaUsageDir"]);
    expect(changed).not.toHaveBeenCalled();
    expect(runtime.context.accessor.get("quotaUsageDir")).toBe(LEDGER_DIR);

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
      env: {
        PORT: String(port),
        HOST: "127.0.0.1",
        AUTH_ENABLED: "false",
        QUOTA_USAGE_DIR: LEDGER_DIR,
      },
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
        config: {
          host: "127.0.0.1",
          port,
          authEnabled: false,
          aclFile: aclPath,
          quotaUsageDir: path.join(dir, "usage"),
        },
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
});