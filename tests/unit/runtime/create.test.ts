/**
 * `createProxyRuntime`：**构造期**（零副作用 / 配置实例隔离 / `isEnabled` 口径 / 总线隔离 /
 * 缺省 logger / 协议选择与构造期失败）。启停→`lifecycle`、live store 与热改→`context`、
 * 启动 URL 与 configDir→`upstream-url`、`assembly` 优先级链→`assembly`、`presets.ts` 公开面→`presets`。
 * ⚠️ 主题级不变量（生命周期事件唯一来源与派生顺序、订阅组归属、账本目录纪律）在 `./AGENTS.md`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "@/core/events/index.js";
import type { ProxyProtocol } from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import { getFreePort } from "../../helpers/net.js";
import { own, processSnapshot, stopOwnedRuntimes } from "./_proxy-runtime.js";

// 库模式不经 `loadConfig`，setup-env 钉的 `QUOTA_USAGE_DIR` 与 `set("quotaUsageDir", …)`
// 两侧都落空（内联 config 走 `new ConfigStore(内联)`）；而 `configDir` 缺省是 `process.cwd()`、
// `quotaUsageDir` 的 FIELDS 缺省是相对路径 `cfg/usage` —— `start()` 里的账本 `open()` 照建。
const LEDGER_DIR = path.join(os.tmpdir(), "proxy-runtime-create-usage");

afterEach(async () => {
  await stopOwnedRuntimes();
  vi.restoreAllMocks();
});

describe("runtime/createProxyRuntime：构造期零副作用与缺省解析", () => {
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
    // 得到的答案是 false。判据「两份 store 各读各的」
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
          quotaUsageDir: LEDGER_DIR,
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
});