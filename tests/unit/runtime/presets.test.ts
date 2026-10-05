/**
 * `src/runtime/presets.ts` 的**全部公开面**（选预设 / 注册表 / 零 `process.env` / 零 `process.argv`）
 * **加** `@/config/presets.ts` 的配置值预设。两个模块都叫 preset、装的东西不同，故并档而不是
 * 拆成两个目录。`assembly` 优先级链与覆盖不豁免校验在 `assembly.test.ts`，启停在 `lifecycle.test.ts`。
 * ⚠️ 「零 `process.env`」「未注册名字 fail-closed」「`ConfigStore` 零校验 → 非法枚举的两个出口」
 * 这几条的**为什么**在 `./AGENTS.md`。
 */
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, ConfigKey } from "@/config/index.js";
import type { ProxyPreset } from "@/config/presets.js";
import type { ProxyProtocol } from "@/core/types/proxy.js";
import {
  builtinStartupPresets,
  defineStartupPreset,
  getStartupPreset,
  listStartupPresets,
  pickStartupPreset,
  registerStartupPreset,
} from "@/runtime/index.js";
import type { StartupPreset } from "@/runtime/index.js";
import { testContext } from "../../helpers/config.js";
import { codeOnly, offendingLines, sourceOf } from "../../helpers/source-scan.js";

const BUILTIN_PRESET_NAMES = [
  "development",
  "socks5-basic",
  "secure-http-auth",
  "https-tls",
] as const;

type PresetModule = typeof import("@/config/presets.js");

/** 比 `./_proxy-runtime.ts` 那份多一个 `cwd`：库入口那一档要断言进程工作目录也不变。 */
function processSnapshot(): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  eventNames: string[];
} {
  return {
    cwd: process.cwd(),
    env: { ...process.env },
    argv: [...process.argv],
    eventNames: process
      .eventNames()
      .map((name) => String(name))
      .sort(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configuration presets", () => {
  it("模块 import 只创建内存注册表：env/argv/cwd/进程监听/文件 IO/输出均不变", async () => {
    // 不变量：库入口引入 preset 时不能触发任何进程级或 IO 副作用。
    const before = processSnapshot();
    const readFile = vi.spyOn(fs, "readFileSync");
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const exists = vi.spyOn(fs, "existsSync");
    const stat = vi.spyOn(fs, "statSync");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    vi.resetModules();
    const presets: PresetModule = await import("@/config/presets.js");

    expect(process.cwd()).toBe(before.cwd);
    expect({ ...process.env }).toEqual(before.env);
    expect([...process.argv]).toEqual([...before.argv]);
    expect(
      process
        .eventNames()
        .map((name) => String(name))
        .sort(),
    ).toEqual(before.eventNames);
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(presets.builtinPresets).toBeInstanceOf(Map);
  });

  it("definePreset 是 identity，返回入参本身的同一引用", async () => {
    const { definePreset } = await import("@/config/presets.js");
    const preset: ProxyPreset = {
      name: "identity-test",
      config: { port: 31001 },
    };

    // 不变量：类型辅助函数不得偷偷复制、冻结或改写调用方对象。
    expect(definePreset(preset)).toBe(preset);
  });

  it("内置 preset 齐全，且每项 config 都是只含已知键的 Partial", async () => {
    const presets = await import("@/config/presets.js");
    const { defaults } = await import("@/config/index.js");
    const names = presets.listPresets();

    // 不变量：公开内置场景必须始终可发现、可取得，且不能退化成全量配置快照。
    expect(names).toEqual(expect.arrayContaining([...BUILTIN_PRESET_NAMES]));
    for (const name of BUILTIN_PRESET_NAMES) {
      const preset = presets.getPreset(name);
      expect(preset).toBeDefined();
      expect(preset?.name).toBe(name);
      expect(preset?.config).toBeTypeOf("object");
      expect(Object.keys(preset?.config ?? {}).length).toBeGreaterThan(0);
      expect(Object.keys(preset?.config ?? {}).length).toBeLessThan(Object.keys(defaults).length);
      for (const key of Object.keys(preset?.config ?? {})) {
        expect(Object.prototype.hasOwnProperty.call(defaults, key)).toBe(true);
      }
    }
  });

  it("applyPreset 严格按 base → preset → overrides 合并并返回新对象", async () => {
    const { applyPreset } = await import("@/config/presets.js");
    const base: Partial<AppConfig> = {
      host: "127.0.0.1",
      port: 31000,
      proxyProtocol: "http",
      logLevel: "silent",
      upstreamTimeout: 12000,
    };
    const overrides: Partial<AppConfig> = {
      port: 32000,
      authEnabled: true,
      logLevel: "info",
    };

    const merged = applyPreset("development", base, overrides);

    // 不变量：preset 赢 base、显式 overrides 赢 preset，base 独有键保留；三份入参均不被改写。
    expect(merged).toEqual({
      host: "0.0.0.0",
      port: 32000,
      proxyProtocol: "http",
      logLevel: "info",
      authEnabled: true,
      upstreamTimeout: 12000,
    });
    expect(merged).not.toBe(base);
    expect(merged).not.toBe(overrides);
    expect(base).toEqual({
      host: "127.0.0.1",
      port: 31000,
      proxyProtocol: "http",
      logLevel: "silent",
      upstreamTimeout: 12000,
    });
    expect(overrides).toEqual({ port: 32000, authEnabled: true, logLevel: "info" });
  });

  it("applyPreset 遇到未知名称立即抛出含名称的清晰错误", async () => {
    const { applyPreset } = await import("@/config/presets.js");

    // 不变量：库模式必须 fail-fast，不能静默落回 defaults/base。
    expect(() => applyPreset("missing-preset")).toThrow("Preset not found: missing-preset");
  });

  it("registerPreset 支持覆盖、拒绝重名，退订幂等且退订后不可再取", async () => {
    const { definePreset, getPreset, registerPreset } = await import("@/config/presets.js");
    const name = "unit-test-custom-preset";
    const original = definePreset({ name, config: { port: 33001 } });
    const replacement = definePreset({ name, config: { port: 33002 } });
    const unregisterOriginal = registerPreset(original);
    let unregisterReplacement: (() => void) | undefined;

    try {
      expect(getPreset(name)).toBe(original);
      expect(() => registerPreset(original)).toThrow(`Preset already registered: ${name}`);

      unregisterReplacement = registerPreset(replacement, { override: true });
      expect(getPreset(name)).toBe(replacement);

      // 不变量：退订只移除自己的当前注册项，重复调用无副作用。
      unregisterReplacement();
      unregisterReplacement();
      expect(getPreset(name)).toBeUndefined();

      unregisterOriginal();
      unregisterOriginal();
      expect(getPreset(name)).toBeUndefined();
    } finally {
      unregisterReplacement?.();
      unregisterOriginal();
    }
  });

  it("内置 preset 的合并结果可直接灌入 ConfigStore，键名与值类型保持合法", async () => {
    const presets = await import("@/config/presets.js");
    const { ConfigStore, defaults } = await import("@/config/index.js");

    // 不变量：preset 不另造校验 schema，但 Partial 片段必须与 ConfigStore/AppConfig 契约兼容。
    for (const name of BUILTIN_PRESET_NAMES) {
      const merged = presets.applyPreset(name);
      const store = new ConfigStore(merged);
      const keys = Object.keys(merged) as ConfigKey[];
      expect(keys.length).toBeGreaterThan(0);

      for (const key of keys) {
        expect(Object.prototype.hasOwnProperty.call(defaults, key)).toBe(true);
        expect(store.get(key)).toBe(merged[key]);
        expect(typeof store.get(key)).toBe(typeof defaults[key]);
      }
    }
  });
});

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
    // 注意 `runtime/services.ts` 的 `usageSource` 接线是**显式形参**（CLI 的 env 快照
    // 一路传下来），那是「槽位必须显式传进来」那条纪律，不属于「库层自己读宿主 env」。
    const code = codeOnly(sourceOf("runtime", "runtime.ts"));

    expect(code).not.toMatch(/process\s*\.\s*env/);
    expect(code).toContain("protocolFor(config)");
  });
});

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
    // 「未知代理协议: ftp」（`assembly.test.ts` 钉的就是它）。
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