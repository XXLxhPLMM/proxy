/**
 * `createProxyRuntime`：**`assembly` 优先级链**（`preset` 覆盖与零副作用 / 显式 `options` >
 * `assembly` > 配置·缺省 / `services` **逐字段合并** / `connectors` 是工厂 / `protocol` 让
 * assembly 赢 / 覆盖**不豁免**配置校验）。构造期→`create`、启停→`lifecycle`、live store 与热改→
 * `context`、启动 URL 与 configDir→`upstream-url`、`presets.ts` 公开面→`presets`。
 * ⚠️ 主题级不变量（零 `process.env` 的理由、生命周期事件唯一来源、账本目录纪律）在 `./AGENTS.md`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore, createConfigContext } from "@/config/index.js";
import type { CoreContext } from "@/core/context.js";
import { createConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { AccessControl, CoreServices, IdentityProvider } from "@/core/types/proxy.js";
import {
  builtinStartupPresets,
  createProxyRuntime,
  defineStartupPreset,
  pickStartupPreset,
} from "@/runtime/index.js";
import { testContext } from "../../helpers/config.js";
import { getFreePort } from "../../helpers/net.js";
import { codeOnly, sourceOf } from "../../helpers/source-scan.js";
import { own, processSnapshot, stopOwnedRuntimes } from "./_proxy-runtime.js";

// 库模式不经 `loadConfig`，setup-env 钉的 `QUOTA_USAGE_DIR` 与 `set("quotaUsageDir", …)`
// 两侧都落空（内联 config 走 `new ConfigStore(内联)`）；而 `configDir` 缺省是 `process.cwd()`、
// `quotaUsageDir` 的 FIELDS 缺省是相对路径 `cfg/usage` —— `start()` 里的账本 `open()` 照建。
const LEDGER_DIR = path.join(os.tmpdir(), "proxy-runtime-assembly-usage");

/** 计数的身份替身（`RuntimeServices.identity` 的最小实现） */
function stubIdentity(tag: string): IdentityProvider {
  return {
    kind: tag,
    isEnabled: true,
    isOwnCredential: () => false,
    identify: async () => ({ passed: true, username: tag }),
  };
}

/** 计数的访问控制替身（`RuntimeServices.access` 的最小实现） */
function stubAccess(): AccessControl {
  return {
    checkClient: () => ({ allowed: true }),
    checkTarget: () => ({ allowed: true }),
    checkRoute: () => ({ direct: false }),
  };
}

/** 计数的流量替身（`RuntimeServices.traffic` 的最小实现） */
function stubTraffic(tag: string): CoreServices["traffic"] {
  return {
    consume: () => ({ allow: true, usage: 0, limit: 0 }),
    usage: () => 0,
    // 仅供断言「拿到的是哪一份」，不进类型
    ...({ tag } as object),
  };
}

afterEach(async () => {
  await stopOwnedRuntimes();
  vi.restoreAllMocks();
});

describe("runtime/createProxyRuntime：preset 生效且构造与启停零副作用", () => {
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
        config: { port, quotaUsageDir: LEDGER_DIR },
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

describe("createProxyRuntime 的 assembly 优先级链：显式 options > assembly > 配置/缺省", () => {
  it("`services` 是**逐字段合并**，不是整体替换", () => {
    // 四项服务彼此正交，调用方只想换身份实现时不该连带丢掉预设声明的访问控制与流量账本。
    // 整体替换会让「显式注入某一项」与「预设声明其余项」无法同时成立。
    const identity = stubIdentity("explicit");
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: 0, authEnabled: false },
        assembly: defineStartupPreset({
          name: "svc-merge",
          services: { identity: stubIdentity("assembly"), access: stubAccess() },
        }),
        services: { identity },
      }),
    );

    // 显式那份赢
    expect(runtime.services.identity).toBe(identity);
    // 预设声明的那份被**合并**进来（而不是被整体替换丢掉）
    expect(runtime.services.access).toBe(runtime.options.access);
    expect(runtime.services.access).not.toBe(stubAccess());
    // 两侧都没声明的 traffic 走缺省解析（配置驱动的内存账本，注入替身的形状不存在）
    expect(runtime.services.traffic).toBeDefined();
  });

  it("`services` 的四个字段各自可被显式覆盖，且覆盖后原样透传到 core", () => {
    const identity = stubIdentity("i");
    const access = stubAccess();
    const traffic = stubTraffic("t");
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: 0, authEnabled: false },
        services: { identity, access, traffic },
      }),
    );

    expect(runtime.services.identity).toBe(identity);
    expect(runtime.services.access).toBe(access);
    expect(runtime.services.traffic).toBe(traffic);
    // core 侧拿到的是**同一个对象**（不是重新构造的替身）
    expect(runtime.options.identity).toBe(identity);
    expect(runtime.options.access).toBe(access);
    expect(runtime.options.traffic).toBe(traffic);
    // 注入了 traffic 替身 → 落盘账本一律不建（「这一本账归调用方管」）
    expect(runtime.services.usageSource).toBeUndefined();
  });

  it("`assembly.services` 也能被逐字段覆盖（预设声明、显式补齐其余）", () => {
    const explicit = stubTraffic("explicit");
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: 0, authEnabled: false },
        assembly: defineStartupPreset({
          name: "svc-merge-2",
          services: { identity: stubIdentity("assembly"), access: stubAccess(), traffic: stubTraffic("a") },
        }),
        services: { traffic: explicit },
      }),
    );

    // 显式那份 traffic 赢
    expect(runtime.services.traffic).toBe(explicit);
    // 预设那份 identity / access 被合并进来
    expect(runtime.services.identity.kind).toBe("assembly");
    expect(runtime.services.access).toBe(runtime.options.access);
  });

  it("`connectors`：显式 > assembly 工厂 > createConnectorSource 缺省", () => {
    // 三级链，且 `assembly.connectors` 是**工厂**（`(ctx) => ConnectorSource`）而
    // `options.connectors` 是**实例**——`ctx` 只有装配期才存在，预设要能「声明意图」
    // 而不绑死某次运行的依赖三件套。两处形状不同不是不一致，别「顺手统一」。
    const explicit = createConnectorSource(testContext);
    const fromAssembly = createConnectorSource(testContext);
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: 0, authEnabled: false, proxyMode: "client" },
        assembly: defineStartupPreset({
          name: "conn-1",
          connectors: () => fromAssembly,
        }),
        connectors: explicit,
      }),
    );

    expect(runtime.options.connectors).toBe(explicit);
    expect(runtime.options.connectors).not.toBe(fromAssembly);
  });

  it("`connectors`：没有显式时走 assembly 的工厂（且工厂收到的 ctx 是本次装配的那一个）", () => {
    const fromAssembly = createConnectorSource(testContext);
    let seen: CoreContext | undefined;
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: 0, authEnabled: false, proxyMode: "client" },
        assembly: defineStartupPreset({
          name: "conn-2",
          connectors: (ctx) => {
            seen = ctx;
            return fromAssembly;
          },
        }),
      }),
    );

    expect(runtime.options.connectors).toBe(fromAssembly);
    expect(seen, "工厂必须收到装配期的 CoreContext（否则它无从读配置）").toBeDefined();
    // 就是 core 拿到的那份 ctx（三件套同源）
    expect(seen).toBe(runtime.options.ctx);
  });

  it("`connectors`：两侧都没有时走 `createConnectorSource(ctx)` 缺省（零副作用惰性门面）", () => {
    const runtime = own(
      createProxyRuntime({ config: { host: "127.0.0.1", port: 0, authEnabled: false } }),
    );

    expect(runtime.options.connectors).toBeDefined();
    expect(typeof runtime.options.connectors.direct).toBe("function");
    expect(typeof runtime.options.connectors.upstream).toBe("function");
    // 缺省来源**在 runtime 构造期算完、且整个生命周期只算一次**（`src/runtime/runtime.ts` 在
    // `createProxy` 之前算一次 `connectors` 再冻进 `options`）。它承诺的那件事由
    // `ConnectorSource` 端口逐字写死（「`upstream()` 记忆 startup 相位的 `upstreamProtocol`」），
    // 而**经 runtime 观测**这一层是本档独有的（`core/forward/upstream/registry.test.ts` 那条
    // 记忆化断言是直接调 `createConnectorSource(testContext)`，看不到组装根）：
    const connectors = runtime.options.connectors;
    const first = connectors.upstream();
    // ① 同一实例：摘掉 `registry.ts` 的 `??=` 记忆，两次调用就会给出两个连接器
    expect(connectors.upstream(), "同一 source 的 upstream() 必须记忆同一实例").toBe(first);
    // ② 记忆取的是**本次构造**那份配置：缺省 `upstreamProtocol` = "http" ⇒ 查表给出
    //    `HttpConnectConnector`（`secure: false` ⇒ `kind` 归一到逻辑协议 "http"）。
    //    这一条证明它真的是 `createConnectorSource(ctx)` 走的那张缺省表，不是某个空壳门面。
    expect(first.kind, "缺省来源必须按 ctx.config 的 upstreamProtocol 查表").toBe("http");
    // ③ 那份记忆是**构造期快照**：热改 startup 相位字段不许把它带走（带走了就成了「协议由两处
    //    决定」的第二真相源）。正向对照先证明热改真的落进了 store —— 否则 ③ 只是「什么都没发生」。
    runtime.context.store.set("upstreamProtocol", "socks5");
    expect(runtime.context.store.get("upstreamProtocol"), "热改必须真的落进 store（否则下面那条是空断言）").toBe(
      "socks5",
    );
    expect(connectors.upstream().kind, "已记忆的协议不许被 startup 相位热改带走").toBe("http");
  });

  it("`protocol`：assembly 覆盖配置（程序化决策比声明式决策更具体）", () => {
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: 0, authEnabled: false, proxyProtocol: "http" },
        assembly: defineStartupPreset({ name: "proto-1", protocol: "sockss5" }),
      }),
    );

    expect(runtime.getProxy().protocol).toBe("sockss5");
  });

  it("`protocol`：没有 assembly 时用配置里那个", () => {
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: 0, authEnabled: false, proxyProtocol: "socks5" },
      }),
    );

    expect(runtime.getProxy().protocol).toBe("socks5");
  });

  it("`assembly` 位于 common options：context 模式（复用宿主 live store）也能叠加预设", () => {
    // 「复用宿主的 live store，但协议这一档由我在代码里点名」是成立的组合 ——
    // 故 `assembly` 不在「context / 纯内存 config」那个二选一里。
    const store = new ConfigStore({ host: "127.0.0.1", port: 0, proxyProtocol: "http" });
    const runtime = own(
      createProxyRuntime({
        context: createConfigContext({
          store,
          configDir: path.join(os.tmpdir(), "startup-preset-ctx"),
        }),
        assembly: defineStartupPreset({ name: "proto-ctx", protocol: "socks4" }),
      }),
    );

    // 预设的 protocol 覆盖了 context 里的配置值
    expect(runtime.getProxy().protocol).toBe("socks4");
    // context 模式仍与宿主共享 live store（那条不变量没有被 assembly 破坏）
    expect(runtime.context.store).toBe(store);
  });
});

describe("assembly.protocol 覆盖不豁免配置校验：fail-closed 不被绕过", () => {
  it("`proxyProtocol: \"ftp\"` + `assembly.protocol: \"http\"` → 仍然抛「未知代理协议: ftp」", () => {
    // 覆盖只改变**用哪个值**，不改变**是否校验**。`ConfigStore` 零校验，库路径能把
    // "ftp" 塞进来，而 `ConfigContext.config` 快照 / `logConfig` 仍会原样打印它 ——
    // 一个「配了、没生效、也不报错」的值比启动报错坏得多（与 core 侧 `upstreamProtocol`
    // fail-closed 同源）。故 `protocolFor(config)` 无论是否被覆盖都**先跑**。
    let thrown: unknown;

    try {
      own(
        createProxyRuntime({
          config: { host: "127.0.0.1", port: 0, authEnabled: false, proxyProtocol: "ftp" as never },
          assembly: defineStartupPreset({ name: "bypass", protocol: "http" }),
        }),
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("未知代理协议: ftp");
  });

  it("没有 assembly 时同样抛（对照组：证明上条不是「怎么都不通」）", () => {
    expect(() =>
      own(
        createProxyRuntime({
          config: { host: "127.0.0.1", port: 0, authEnabled: false, proxyProtocol: "ftp" as never },
        }),
      ),
    ).toThrow(/未知代理协议: ftp/);
  });

  it("合法协议 + 合法覆盖 → 正常构造（对照组 2）", () => {
    const runtime = own(
      createProxyRuntime({
        config: { host: "127.0.0.1", port: 0, authEnabled: false, proxyProtocol: "socks5" },
        assembly: defineStartupPreset({ name: "ok", protocol: "https" }),
      }),
    );

    expect(runtime.getProxy().protocol).toBe("https");
  });

  it("源码级：`protocolFor(config)` 的调用点在 `assembly?.protocol` 判定**之前**", () => {
    // 这一条把「先校验后覆盖」的**次序**钉死：把两行对调，功能面看不出差别
    // （覆盖生效时两种写法都返回 assembly 那个值），但非法配置就会从「启动报错」
    // 变成「静默用覆盖值跑起来」——那正是 fail-closed 被绕过的那条路。
    const code = codeOnly(sourceOf("runtime", "runtime.ts"));
    const atValidate = code.indexOf("protocolFor(config)");
    const atPick = code.indexOf("assembly?.protocol ??");

    expect(atValidate, "runtime.ts 必须真的调 protocolFor(config)").toBeGreaterThan(-1);
    expect(atPick, "runtime.ts 必须真的读 assembly?.protocol").toBeGreaterThan(-1);
    expect(atValidate, "校验必须排在覆盖之前（fail-closed 不被 assembly 绕过）").toBeLessThan(atPick);
  });

  it("`startup` 预设真的能被 `createProxyRuntime({ assembly })` 直接吃掉", () => {
    // 端到端串一次：`pickStartupPreset` 的产物就是 `assembly` 的类型 ——
    // 「选预设」与「用预设」是同一个形状，故不需要转换层。
    const preset = pickStartupPreset({ accessor: { get: () => "sockss4" } } as never);

    expect(preset.protocol).toBe("sockss4");
    // 内置预设**只**声明 protocol + description（用排序比较而非逐字序：键序不是契约）
    const builtin = builtinStartupPresets.get("sockss4");

    expect(Object.keys(builtin ?? {}).sort()).toEqual(["description", "name", "protocol"]);
    // 且它原样可作 `assembly` 用（类型层由 `StartupPreset` 保证，这里钉运行期可行）
    const runtime = own(
      createProxyRuntime({ config: { host: "127.0.0.1", port: 0, authEnabled: false }, assembly: preset }),
    );

    expect(runtime.getProxy().protocol).toBe("sockss4");
  });
});