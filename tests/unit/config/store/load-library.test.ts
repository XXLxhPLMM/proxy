/**
 * `loadConfig` 的库模式：按显式 env/argv 解析进调用方给的那一个 store
 *
 * @description 本档钉**库路径**的入参契约：不传 store 就新建、路径字段按最终 `configDir` 解析、
 * CLI 压过 env、env 文件按序合并且**不改宿主**、失败不半写 store。
 * ⚠️ 与 `../../loader/load.test.ts`（服务侧那一遍）不是同一件事：那边验 `context` 的面，
 * 这边验「库调用方能自带 store」。逐条的锁点见各条断言旁的注释。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@/config/load.js";
import { ConfigStore, defaults } from "@/config/index.js";

async function withTmpConfigDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-loadconfig-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadConfig 显式加载（库模式）", () => {
  it("按显式 env 解析并返回 store/accessor/context", async () => {
    await withTmpConfigDir(async (cwd) => {
      const store = new ConfigStore();
      const context = await loadConfig({
        env: {
          PORT: "18099",
          HOST: "127.0.0.5",
          PROXY_PROTOCOL: "socks5",
          AUTH_ENABLED: "false",
        },
        envFiles: [],
        argv: [],
        cwd,
        store,
        skipFileValidation: true,
      });
      expect(context.store).toBe(store);
      expect(context.accessor.get("port")).toBe(18099);
      expect(context.accessor.get("proxyProtocol")).toBe("socks5");
      expect(context.config.host).toBe("127.0.0.5");
    });
  });

  it("不传 store 时新建实例，未提供的键回退 defaults", async () => {
    await withTmpConfigDir(async (cwd) => {
      const context = await loadConfig({
        env: { AUTH_ENABLED: "false" },
        envFiles: [],
        argv: [],
        cwd,
        skipFileValidation: true,
      });
      expect(context.store).toBeInstanceOf(ConfigStore);
      expect(context.store.get("port")).toBe(defaults.port);
    });
  });

  it("路径字段按最终 configDir 解析，context 暴露启动相位", async () => {
    await withTmpConfigDir(async (cwd) => {
      const context = await loadConfig({
        env: { AUTH_ENABLED: "false" },
        envFiles: [],
        argv: [],
        cwd,
        skipFileValidation: true,
      });
      expect(context.configDir).toBe(cwd);
      expect(context.store.get("authUsersFile")).toBe(path.join(cwd, "cfg", "users.json"));
      expect(context.store.get("aclFile")).toBe(path.join(cwd, "cfg", "acl.json"));
      expect(context.store.get("logFile")).toBe(path.join(cwd, "log"));
      expect(context.startupKeys).toContain("port");
      expect(context.startupKeys).not.toContain("logLevel");
    });
  });

  it("CLI 优先于 env，env 文件按顺序参与合并且不改宿主", async () => {
    await withTmpConfigDir(async (cwd) => {
      await writeFile(path.join(cwd, ".env.one"), "PORT=17001\nLOG_LEVEL=warn\n", "utf8");
      await writeFile(path.join(cwd, ".env.two"), "PORT=17002\n", "utf8");
      const before = { ...process.env };
      const store = new ConfigStore();
      const context = await loadConfig({
        env: { PORT: "18099", AUTH_ENABLED: "false" },
        envFiles: [".env.one", ".env.two"],
        argv: ["--port=18100"],
        cwd,
        store,
        skipFileValidation: true,
      });
      expect(context.store.get("port")).toBe(18100);
      expect(context.store.get("logLevel")).toBe("warn");
      expect({ ...process.env }).toEqual(before);
    });
  });

  it("失败时不半写 store", async () => {
    await withTmpConfigDir(async (cwd) => {
      const store = new ConfigStore({ port: 18300, host: "127.0.0.8" });
      await expect(
        loadConfig({
          env: { PORT: "70000", AUTH_ENABLED: "false" },
          envFiles: [],
          argv: [],
          cwd,
          store,
          skipFileValidation: true,
        }),
      ).rejects.toThrow(/PORT=70000 越界/);
      expect(store.get("port")).toBe(18300);
      expect(store.get("host")).toBe("127.0.0.8");
    });
  });
});