/**
 * `config/load loadConfig`：把「显式来源 → 目标 store → 完整 context」这一条装填路径钉住
 *
 * @description
 * 本档管：原子装填与 context 面、优先级链（CLI > 显式 env > env 文件 > defaults）、
 * 「不读宿主来源」、以及成功与失败**都不写 `process.env`**。
 * ⚠️ 逐条的「为什么」与变异锁点归**本目录 `AGENTS.md`** 的 ⑤ / ⑨ / ⑩ 与那张对照表。
 */
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { keysByPhase } from "@/config/schema/index.js";
import { loadConfig } from "@/config/load.js";
import { configAccessorFromStore } from "@/config/index.js";
import { ConfigStore, defaults } from "@/config/index.js";
import { withTmpConfigDir } from "./_config-loader.js";

function restoreEnv(before: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in before)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, before);
}

describe("config/load loadConfig", () => {
  it("显式 env/argv 原子装填目标 store，并返回完整 context", async () => {
    await withTmpConfigDir(async (cwd) => {
      const store = new ConfigStore();
      const context = await loadConfig({
        env: { PORT: "18100", AUTH_ENABLED: "false" },
        argv: ["--log-level=debug"],
        envFiles: [],
        cwd,
        store,
        skipFileValidation: true,
      });

      expect(context.store).toBe(store);
      expect(context.accessor.get("port")).toBe(18100);
      expect(context.accessor).not.toBe(configAccessorFromStore(store));
      expect(context.config.port).toBe(18100);
      expect(context.config).not.toBe(store.getAll());
      expect(context.configDir).toBe(cwd);
      expect(context.startupKeys).toEqual(keysByPhase().startup);
      expect(context.sources).toEqual({
        envKeys: ["PORT", "AUTH_ENABLED"],
        envFiles: [],
        argvKeys: ["LOG_LEVEL"],
        // 没给 envFiles ⇒ 没有任何键来自文件（Map 而非普通对象：它是 `readEnvFiles` 那一份的
        // 逐键归属，判据只能按 `toEqual` 的 Map 语义比）
        fileOrigins: new Map(),
      });
      expect(context.warnings).toEqual([]);
    });
  });

  it("显式 env 的相对路径字段也按最终 configDir 绝对化", async () => {
    await withTmpConfigDir(async (cwd) => {
      const context = await loadConfig({
        env: {
          AUTH_ENABLED: "false",
          AUTH_USERS_FILE: "users.json",
          ACL_FILE: "acl.json",
          LOG_FILE: "logs",
          TLS_KEY: "keys/server.key",
          TLS_CERT: "keys/server.crt",
          UPSTREAM_CA: "certs/upstream.pem",
        },
        envFiles: [],
        argv: [],
        cwd,
        skipFileValidation: true,
      });
      expect(context.store.get("authUsersFile")).toBe(path.join(cwd, "users.json"));
      expect(context.store.get("aclFile")).toBe(path.join(cwd, "acl.json"));
      expect(context.store.get("logFile")).toBe(path.join(cwd, "logs"));
      expect(context.store.get("tlsKey")).toBe(path.join(cwd, "keys/server.key"));
      expect(context.store.get("tlsCert")).toBe(path.join(cwd, "keys/server.crt"));
      expect(context.store.get("upstreamCa")).toBe(path.join(cwd, "certs/upstream.pem"));
    });
  });

  it("省略 env/envFiles/argv 不读取宿主来源，也不扫描默认文件", async () => {
    await withTmpConfigDir(async (cwd) => {
      const envBefore = { ...process.env };
      const argvBefore = [...process.argv];
      await writeFile(path.join(cwd, ".env.production"), "PORT=19999\n", "utf8");
      process.env.PORT = "not-a-number";
      process.env.AUTH_ENABLED = "treu";
      process.env.UPSTREAM_URL = "not a url";
      const hostileEnv = { ...process.env };
      process.argv.push("--port", "19998");

      try {
        const store = new ConfigStore();
        const context = await loadConfig({
          cwd,
          store,
          skipFileValidation: true,
        });
        expect(context.store.get("port")).toBe(defaults.port);
        expect(context.store.get("authEnabled")).toBe(defaults.authEnabled);
        expect(context.store.get("upstreamUrl")).toBe(defaults.upstreamUrl);
        expect(context.sources).toEqual({
          envKeys: [],
          envFiles: [],
          argvKeys: [],
          fileOrigins: new Map(),
        });
        expect({ ...process.env }).toEqual(hostileEnv);
      } finally {
        process.argv.splice(0, process.argv.length, ...argvBefore);
        restoreEnv(envBefore);
      }
    });
  });

  it("相对 envFiles 相对最终 configDir，后文件覆盖前文件，绝对路径原样使用", async () => {
    await withTmpConfigDir(async (cwd) => {
      const nested = path.join(cwd, "nested");
      await mkdir(nested);
      const first = path.join(cwd, "first.env");
      const second = path.join(nested, "second.env");
      const absolute = path.join(cwd, "absolute.env");
      await writeFile(first, "PORT=17001\nLOG_LEVEL=warn\n", "utf8");
      await writeFile(second, "PORT=17002\n", "utf8");
      await writeFile(absolute, "HOST=10.0.0.9\n", "utf8");

      const context = await loadConfig({
        env: { AUTH_ENABLED: "false" },
        envFiles: ["first.env", "nested/second.env", absolute],
        cwd,
        skipFileValidation: true,
      });
      expect(context.store.get("port")).toBe(17002);
      expect(context.store.get("logLevel")).toBe("warn");
      expect(context.store.get("host")).toBe("10.0.0.9");
      expect(context.sources.envFiles).toEqual([first, second, absolute]);
    });
  });

  it("CLI > 显式 env > env 文件 > defaults", async () => {
    await withTmpConfigDir(async (cwd) => {
      await writeFile(path.join(cwd, "one.env"), "PORT=17001\nHOST=10.0.0.1\n", "utf8");
      const context = await loadConfig({
        env: { PORT: "18000", AUTH_ENABLED: "false" },
        argv: ["--port=19000"],
        envFiles: ["one.env"],
        cwd,
        skipFileValidation: true,
      });
      expect(context.store.get("port")).toBe(19000);
      expect(context.store.get("host")).toBe("10.0.0.1");
    });
  });

  it("成功和失败都不写 process.env；失败不半写 store", async () => {
    await withTmpConfigDir(async (cwd) => {
      await writeFile(path.join(cwd, "one.env"), "PORT=17001\n", "utf8");
      const before = { ...process.env };
      const store = new ConfigStore({ port: 17500, host: "127.0.0.9" });

      const success = await loadConfig({
        env: { AUTH_ENABLED: "false" },
        envFiles: ["one.env"],
        cwd,
        store,
        skipFileValidation: true,
      });
      expect(success.store).toBe(store);
      expect({ ...process.env }).toEqual(before);
      const afterSuccess = store.getAll();

      await expect(
        loadConfig({
          env: { PORT: "70000", AUTH_ENABLED: "false" },
          envFiles: [],
          cwd,
          store,
          skipFileValidation: true,
        }),
      ).rejects.toThrow(/PORT=70000 越界/);
      expect(store.getAll()).toEqual(afterSuccess);
      expect({ ...process.env }).toEqual(before);
    });
  });

  it("非法 env 文件读取错误 reject，且不触碰 store", async () => {
    await withTmpConfigDir(async (cwd) => {
      const notFile = path.join(cwd, "env-directory");
      await mkdir(notFile);
      const store = new ConfigStore({ port: 17600 });
      await expect(
        loadConfig({
          env: {},
          envFiles: [notFile],
          cwd,
          store,
          skipFileValidation: true,
        }),
      ).rejects.toBeDefined();
      expect(store.getAll()).toEqual(new ConfigStore({ port: 17600 }).getAll());
    });
  });

  it("启动期 JSON 非法时失败，store 保持原样", async () => {
    await withTmpConfigDir(async (cwd) => {
      const cfg = path.join(cwd, "cfg");
      await mkdir(cfg);
      await writeFile(
        path.join(cfg, "acl.json"),
        JSON.stringify({ clientIp: { whitelist: ["not-an-ip"] } }),
        "utf8",
      );
      const store = new ConfigStore({ port: 17700 });
      await expect(
        loadConfig({ env: { AUTH_ENABLED: "false" }, envFiles: [], cwd, store }),
      ).rejects.toThrow(/ACL_FILE=/);
      expect(store.get("port")).toBe(17700);
    });
  });

  it("UPSTREAM_URL 覆盖拆项只进入 context.warnings", async () => {
    await withTmpConfigDir(async (cwd) => {
      const context = await loadConfig({
        env: {
          AUTH_ENABLED: "false",
          UPSTREAM_URL: "https://proxy.example:8443",
          UPSTREAM_HOST: "ignored.example",
        },
        envFiles: [],
        cwd,
        skipFileValidation: true,
      });
      expect(context.store.get("upstreamHost")).toBe("proxy.example");
      expect(context.store.get("upstreamPort")).toBe(8443);
      expect(context.warnings).toHaveLength(1);
      expect(context.warnings[0]).toMatch(/UPSTREAM_URL/);
      expect(context.warnings[0]).toMatch(/UPSTREAM_HOST/);
    });
  });
});