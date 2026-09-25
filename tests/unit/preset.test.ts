import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, ConfigKey } from "@/config/index.js";
import type { ProxyPreset } from "@/config/presets.js";

const BUILTIN_PRESET_NAMES = [
  "development",
  "socks5-basic",
  "secure-http-auth",
  "https-tls",
] as const;

type PresetModule = typeof import("@/config/presets.js");

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
