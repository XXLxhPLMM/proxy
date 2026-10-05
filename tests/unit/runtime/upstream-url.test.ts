/**
 * `createProxyRuntime`：**启动 URL 与 configDir 捕获**（`UPSTREAM_URL` 构造期拆解到 store 与 core /
 * 热改后新旧 runtime 的冻结与共享 / 相对路径全绝对化且 chdir 后不漂移 / `config.loaded` 来源优先级 /
 * 归一化 warning 只报本次新增项）。构造期→`create`、启停→`lifecycle`、live store 与热改→`context`、
 * `assembly` 优先级链→`assembly`。
 * ⚠️ 主题级不变量（生命周期事件唯一来源、订阅组归属、账本目录纪律）在 `./AGENTS.md`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/config/load.js";
import { definePreset, registerPreset } from "@/config/presets.js";
import { EventHub } from "@/core/events/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { RuntimeWarning } from "@/runtime/index.js";
import { getFreePort } from "../../helpers/net.js";
import { own, stopOwnedRuntimes } from "./_proxy-runtime.js";

// `loadConfig` 的 `env` 是显式入参、缺省为空，`store` 也是另建的一个 ⇒ `setup-env.ts` 钉的
// `QUOTA_USAGE_DIR` env 与 `set("quotaUsageDir", …)` 两侧全落空；剩下的缺省是「相对路径
// `cfg/usage` + `configDir` 回落到 `process.cwd()`」，而 `start()` 里的账本 `open()` 与是否
// 真计量无关 —— 照建。
const LEDGER_DIR = path.join(os.tmpdir(), "proxy-runtime-upstream-url-usage");

afterEach(async () => {
  await stopOwnedRuntimes();
  vi.restoreAllMocks();
});

describe("runtime/createProxyRuntime：启动 URL、configDir 与来源优先级", () => {
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
      env: {
        PORT: String(port),
        UPSTREAM_URL: oldUrl,
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
      env: {
        PORT: String(port + 1),
        AUTH_ENABLED: "false",
        QUOTA_USAGE_DIR: LEDGER_DIR,
      },
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
});