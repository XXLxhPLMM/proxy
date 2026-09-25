import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertAuthConfig, keysByPhase, parseStartupArgs } from "@/config/fields.js";
import { defaultEnvFileNames, readEnvFiles } from "@/config/config-helpers.js";
import { loadConfig } from "@/config/load.js";
import { prepareRuntimeConfigStore } from "@/config/runtime-config.js";
import { configAccessorFromStore } from "@/config/accessor.js";
import { ConfigStore, defaults } from "@/config/store.js";
import { parseUpstreamUrl, applyUpstreamUrl } from "@/utils/upstream-url.js";

async function withTmpConfigDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-loadconfig-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function restoreEnv(before: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in before)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, before);
}

describe("config/fields parseStartupArgs", () => {
  it("支持 --key value / --key=value / KEY=VALUE 三种写法", () => {
    expect(parseStartupArgs(["--port", "8080"]).port).toBe(8080);
    expect(parseStartupArgs(["--port=8081"]).port).toBe(8081);
    expect(parseStartupArgs(["PORT=8082"]).port).toBe(8082);
  });

  it("KEY=VALUE 值含 '=' 时完整保留", () => {
    expect(parseStartupArgs(["JWT_SECRET=Zm9v=="]).jwtSecret).toBe("Zm9v==");
    expect(parseStartupArgs(["--jwt-secret=Zm9v=="]).jwtSecret).toBe("Zm9v==");
    expect(parseStartupArgs(["UPSTREAM_URL=https://u:p@h:8443"]).upstreamUrl).toBe(
      "https://u:p@h:8443",
    );
  });

  it("显式非法值和越界值不静默回退", () => {
    expect(() => parseStartupArgs(["--port", "not-a-number"])).toThrow(/配置校验失败/);
    expect(() => parseStartupArgs(["--port", "70000"])).toThrow(/PORT=70000 越界/);
    expect(() => parseStartupArgs(["--auth-enabled", "treu"])).toThrow(/AUTH_ENABLED=treu/);
    expect(parseStartupArgs(["--proxy-protocol", "SOCKS5"]).proxyProtocol).toBe("socks5");
    expect(parseStartupArgs(["--auth-enabled"]).authEnabled).toBe(true);
  });
});

describe("config/fields 账号与名单字段", () => {
  it("默认文件名仍是 cfg/users.json 与 cfg/acl.json", () => {
    expect(defaults.authUsersFile).toBe("cfg/users.json");
    expect(defaults.aclFile).toBe("cfg/acl.json");
    expect(parseStartupArgs(["--acl-file", "/tmp/a.json"]).aclFile).toBe("/tmp/a.json");
    expect(parseStartupArgs(["--auth-users-file", "/tmp/u.json"]).authUsersFile).toBe(
      "/tmp/u.json",
    );
  });
});

describe("utils/upstream-url", () => {
  it("解析并应用标准 URL", () => {
    expect(parseUpstreamUrl("https://u:pppp@proxy.example.com:8443")).toBe(
      "https://u:pppp@proxy.example.com:8443",
    );
    const r: Record<string, unknown> = {};
    applyUpstreamUrl(r, "socks5://proxy.example.com");
    expect(r).toEqual({
      upstreamProtocol: "socks5",
      upstreamSecure: false,
      upstreamHost: "proxy.example.com",
      upstreamPort: 1080,
      upstreamUsername: "",
      upstreamPassword: "",
    });
  });

  it("非法 URL 被拒绝", () => {
    expect(parseUpstreamUrl("ftp://h")).toBeUndefined();
    expect(parseUpstreamUrl("http://h/path")).toBeUndefined();
    expect(parseUpstreamUrl("not a url")).toBeUndefined();
  });
});

describe("config/fields assertAuthConfig", () => {
  it("鉴权组合非法时 fail-closed", () => {
    expect(() =>
      assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 0 }),
    ).toThrow(/账号表为空/);
    expect(() =>
      assertAuthConfig({ authEnabled: true, authType: "none", accountCount: 1 }),
    ).toThrow(/AUTH_TYPE=none/);
    expect(() =>
      assertAuthConfig({ authEnabled: true, authType: "jwt", accountCount: 0, jwtSecret: "" }),
    ).toThrow(/JWT_SECRET/);
    expect(() =>
      assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 1 }),
    ).not.toThrow();
  });
});

describe("config/config-helpers env 文件", () => {
  it("按输入顺序读取、后者覆盖前者，显式 env 优先", async () => {
    await withTmpConfigDir(async (dir) => {
      const first = path.join(dir, "first.env");
      const second = path.join(dir, "second.env");
      await writeFile(first, "PORT=17001\nLOG_LEVEL=warn\n", "utf8");
      await writeFile(second, "PORT=17002\n", "utf8");

      const result = await readEnvFiles([first, second], { PORT: "18000" });
      expect(result.PORT).toBe("18000");
      expect(result.LOG_LEVEL).toBe("warn");
    });
  });

  it("缺失文件跳过，defaultEnvFileNames 只生成名称不读文件", async () => {
    await withTmpConfigDir(async (dir) => {
      const missing = path.join(dir, "missing.env");
      const result = await readEnvFiles([missing], {});
      expect(result).toEqual({});
      expect(defaultEnvFileNames("test")).toEqual([
        ".env.production",
        ".env.development",
        ".env.test",
      ]);
      expect(defaultEnvFileNames("development")).toEqual([".env.production", ".env.development"]);
    });
  });
});

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
        expect(context.sources).toEqual({ envKeys: [], envFiles: [], argvKeys: [] });
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

describe("config/runtime-config", () => {
  it("prepareRuntimeConfigStore 归一化路径并应用 URL 拆项", async () => {
    await withTmpConfigDir(async (cwd) => {
      const store = new ConfigStore({
        authUsersFile: "users.json",
        upstreamUrl: "https://proxy.example:8443",
        upstreamHost: "ignored.example",
        upstreamPort: 9999,
      });
      const result = prepareRuntimeConfigStore(
        store,
        cwd,
        new Set(["UPSTREAM_HOST", "UPSTREAM_PORT"]),
      );
      expect(result.config.authUsersFile).toBe(path.join(cwd, "users.json"));
      expect(result.config.upstreamHost).toBe("proxy.example");
      expect(result.config.upstreamPort).toBe(8443);
      expect(store.get("authUsersFile")).toBe(path.join(cwd, "users.json"));
      expect(store.get("upstreamHost")).toBe("proxy.example");
      expect(result.warnings[0]).toMatch(/UPSTREAM_HOST/);
      expect(result.warnings[0]).toMatch(/UPSTREAM_PORT/);
    });
  });

  it("非法 URL 拒绝且不半写 store", async () => {
    await withTmpConfigDir(async (cwd) => {
      const store = new ConfigStore({
        upstreamUrl: "not a url",
        upstreamHost: "keep.example",
      });
      expect(() => prepareRuntimeConfigStore(store, cwd)).toThrow(
        "配置校验失败: UPSTREAM_URL=not a url 非法",
      );
      expect(store.get("upstreamUrl")).toBe("not a url");
      expect(store.get("upstreamHost")).toBe("keep.example");
    });
  });
});
