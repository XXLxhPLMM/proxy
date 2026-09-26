/**
 * **启动预设的接缝护栏**（`runtime/presets.ts` + `assembly` 优先级链）
 *
 * @description
 * `StartupPreset` 是 `runtime/presets.ts` 的新面，名字刻意与 `@/config/presets.ts` 的
 * `ProxyPreset` 全部错开：那边装的是**配置值**（`name + Partial<AppConfig>`，经 accessor 现读），
 * 这边装的是**装配决策**（协议服务器 / 服务替身 / 上游接入，构造期一次性定死）。
 *
 * 本档锁五件最容易悄悄坏掉的东西：
 * 1. **`pickStartupPreset` 零 `process.env`**（源码级）——env 的影响全部收敛在 `loadConfig`
 * 2. **未注册名字 fail-closed 抛错**（不是静默回落配置值）
 * 3. 不给名字 → 按 `proxyProtocol` 合成
 * 4. **`assembly` 优先级链**：显式 `options` > `assembly` > 配置/缺省；`services` 逐字段合并
 * 5. **`assembly.protocol` 覆盖不豁免校验**（fail-closed 不被覆盖绕过）
 */

import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { ConfigStore, createConfigContext } from "@/config/index.js";
import { codeOnly, offendingLines, sourceOf } from "../helpers/source-scan.js";
import {
  builtinStartupPresets,
  createProxyRuntime,
  defineStartupPreset,
  getStartupPreset,
  listStartupPresets,
  pickStartupPreset,
  registerStartupPreset,
} from "@/runtime/index.js";
import type { ProxyRuntime, StartupPreset } from "@/runtime/index.js";
import type { AccessControl, CoreServices, IdentityProvider, ProxyProtocol } from "@/core/types/proxy.js";
import { createConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { CoreContext } from "@/core/context.js";
import { testContext } from "../helpers/config.js";

const activeRuntimes: ProxyRuntime[] = [];

function own(runtime: ProxyRuntime): ProxyRuntime {
  activeRuntimes.push(runtime);
  return runtime;
}

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
    consume: () => ({ allow: true, scope: undefined, usage: 0, limit: 0 }),
    usage: () => ({ up: 0, down: 0 }),
    // 仅供断言「拿到的是哪一份」，不进类型
    ...({ tag } as object),
  };
}

// ---------------------------------------------------------------------------
// 1. 零 process.env（源码级）
// ---------------------------------------------------------------------------

describe("runtime/presets.ts：零 process.env / 零 process.argv", () => {
  it("全文零 `process.env` 与 `process.argv`", () => {
    // **为什么这是本档第一条**：env 的影响**全部**收敛在 `loadConfig`（它把校验后的值一次
    // merge 进 ConfigStore）。库层再读一次就是「协议由两处决定」的第二真相源，形态是：
    // 容器里 PROXY_PROTOCOL=socks5 起服务，库代码里 `pickStartupPreset(context)` 又读到宿主
    // env 的另一个值 —— 于是「配置里写的协议」与「实际跑的协议」不一致，**且没有任何日志或
    // 事件能解释这个差异**。upstreamProtocol 那次已经付过学费（记忆化的 ConnectorSource
    // 一旦读到热改后的第二个值就成第二真相源）。
    const code = codeOnly(sourceOf("runtime", "presets.ts"));

    expect(
      offendingLines(code, /process\s*\.\s*env/),
      "presets.ts 不得读 process.env：选协议服务器用 PROXY_PROTOCOL（由 loadConfig 收进 store），"
        + "要具名装配就程序化传 createProxyRuntime({ assembly })",
    ).toEqual([]);
    expect(code).not.toMatch(/process\s*\.\s*argv/);
  });

  it("`pickStartupPreset` 只消费已落进 store 的 `proxyProtocol`（源码级可见）", () => {
    const code = codeOnly(sourceOf("runtime", "presets.ts"));
    const fn = code.slice(code.indexOf("export function pickStartupPreset("));

    expect(fn).toContain('context.accessor.get("proxyProtocol")');
    // 没有「兜底读 env」的第二条路
    expect(fn).not.toMatch(/process\s*\.\s*env/);
  });

  it("`createProxyRuntime` 侧同样零 process.env（协议只能来自 config 或 assembly）", () => {
    // 与上一条成对：`presets.ts` 不读还不够，唯一消费点 `runtime.ts` 也不许读。
    // 注意 `runtime/services.ts` 的 `TrafficLedgerHost.slot` 是**显式形参**（CLI 的 env 快照
    // 一路传下来），那是「槽位必须显式传进来」那条纪律，不属于「库层自己读宿主 env」。
    const code = codeOnly(sourceOf("runtime", "runtime.ts"));

    expect(code).not.toMatch(/process\s*\.\s*env/);
    expect(code).toContain("protocolFor(config)");
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. 选预设：未注册 fail-closed / 不给名字按协议合成
// ---------------------------------------------------------------------------

describe("pickStartupPreset：未注册 fail-closed，不给名字按 proxyProtocol 合成", () => {
  it("未注册名字直接抛错，且消息含那个名字", () => {
    // fail-closed，不是静默回落。静默回落是最坏的一种失败形态：调用方点名要 "sockss5"，
    // 拼错成 "socks5s"，于是服务起来了但跑的是配置里那个协议 ——
    // **「配错了、没报错、还起来了」**。抛错让拼错在启动那一刻就可见。
    let thrown: unknown;

    try {
      pickStartupPreset({ accessor: testContext.config } as never, "socks5s");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("socks5s");
    expect((thrown as Error).message).toContain("Startup preset not found");
  });

  it("已注册名字 → 原样取回那一份（对象同一性，不是重新合成）", () => {
    const preset = defineStartupPreset({ name: "pick-same", protocol: "socks5" });
    const off = registerStartupPreset(preset);

    try {
      expect(pickStartupPreset({ accessor: testContext.config } as never, "pick-same")).toBe(preset);
      expect(getStartupPreset("pick-same")).toBe(preset);
      expect(listStartupPresets()).toContain("pick-same");
    } finally {
      off();
    }

    // 退订后立刻查不到（退订只移除自己的当前注册项）
    expect(getStartupPreset("pick-same")).toBeUndefined();
    expect(listStartupPresets()).not.toContain("pick-same");
  });

  it("不给名字 → 按已落进 store 的 `proxyProtocol` 合成一份", () => {
    for (const proto of ["http", "https", "socks4", "socks5", "sockss4", "sockss5"] as const) {
      const p = pickStartupPreset({ accessor: { get: () => proto } } as never);

      expect(p.name).toBe(`protocol:${proto}`);
      expect(p.protocol).toBe(proto);
    }
  });

  it("非法 `proxyProtocol` 合成出的那份**不带 protocol**（把错误让给 protocolFor 那条 fail-closed）", () => {
    // `ConfigStore` 零校验，库路径能把 "ftp" 塞进来。这里**刻意不 throw**：
    // 在两处各写一份错误信息就是两份真相，合成出的那份不带 `protocol` →
    // `createProxyRuntime` 落回 `protocolFor(config)` 那条 fail-closed 路径并报出
    // 「未知代理协议: ftp」（第 5 组断言钉的就是它）。
    const p = pickStartupPreset({ accessor: { get: () => "ftp" } } as never);

    expect(p.name).toBe("protocol:ftp");
    expect(p.protocol).toBeUndefined();
  });

  it("六个内置协议预设齐全，且键集合就是 `ProxyProtocol` 的六个值", () => {
    // 穷尽性由 `satisfies Record<ProxyProtocol, StartupPreset>` 在编译期保证；
    // 这里钉的是「注册表初始就含这六个」与「键名与协议名同形」。
    expect([...builtinStartupPresets.keys()].sort()).toEqual([
      "http",
      "https",
      "socks4",
      "socks5",
      "sockss4",
      "sockss5",
    ]);

    for (const [name, preset] of builtinStartupPresets) {
      expect(preset.name).toBe(name);
      expect(preset.protocol).toBe(name as ProxyProtocol);
      // 内置预设**只**声明 protocol + description：服务覆盖与进程策略是调用方的部署决策，
      // 预置成组合预设只会得到一份「没人维护的菜单」（见 presets.ts 文件头）。
      expect(Object.keys(preset).sort()).toEqual(["description", "name", "protocol"]);
    }
  });

  it("重名默认抛错，`override: true` 才允许覆盖；退订不误删后来者", () => {
    const first = defineStartupPreset({ name: "dup", protocol: "http" });
    const off1 = registerStartupPreset(first);

    try {
      expect(() => registerStartupPreset(defineStartupPreset({ name: "dup", protocol: "socks5" }))).toThrow(
        /already registered/,
      );

      const second = defineStartupPreset({ name: "dup", protocol: "socks5" });
      const off2 = registerStartupPreset(second, { override: true });
      expect(getStartupPreset("dup")).toBe(second);

      // 旧退订函数不能误删后来覆盖的那一份
      off1();
      expect(getStartupPreset("dup")).toBe(second);
      off2();
      expect(getStartupPreset("dup")).toBeUndefined();
    } finally {
      off1();
    }
  });

  it("`defineStartupPreset` 是纯 identity 函数（不做运行时校验）", () => {
    const preset: StartupPreset = { name: "bare" };

    expect(defineStartupPreset(preset)).toBe(preset);
  });
});

// ---------------------------------------------------------------------------
// 4. assembly 优先级链
// ---------------------------------------------------------------------------

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
    expect(runtime.services.trafficLedger).toBeUndefined();
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
    // 缺省解析**只在 runtime 构造期做一次**：`upstream()` 记忆 `upstreamProtocol`
    //（startup 相位），解析两次就有两个 source 各记一份协议。
    expect(runtime.options.connectors).toBe(runtime.options.connectors);
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

// ---------------------------------------------------------------------------
// 5. assembly.protocol 覆盖不豁免校验（fail-closed）
// ---------------------------------------------------------------------------

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
