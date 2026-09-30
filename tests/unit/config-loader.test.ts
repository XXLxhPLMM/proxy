/**
 * `config/sources` 的外部输入采集 + `config/schema` 的字段解析原语，**全部经 `loadConfig` 这一个入口**
 *
 * @description
 * argv 的回归护栏一律经 `loadConfig` 断言（本档没有一条绕开加载器直调 `parseRawArgv` 的用例）：
 * 加载器是 argv 变成配置的**唯一**路径，绕开它就等于给 argv 归一留了第二个真相源。
 *
 * ## ① env 文件候选是**固定三档**，不是「按 `NODE_ENV` 拼一个文件名」
 * 否掉的是「拼一个」。固定三档让「我在哪个文件里改的」永远是可预测的，`.env.<NODE_ENV>` 只是覆盖项。
 * `defaultEnvFileNames` **只产名字**（去重保留最后一次），**不扫描目录、不读文件**——调用方（CLI）才决定读哪些。
 * 锁点（本档「缺失文件跳过，defaultEnvFileNames 只生成名称不读文件」那条）：
 * `expect(defaultEnvFileNames("test")).toEqual([".env.production", ".env.development", ".env.test"])`
 * ——把三档改成「只拼一个」或少一档，这行当场红。
 *
 * ## ② `readEnvFiles` 里**显式 `baseEnv` 的键恒优先于文件值**
 * 否掉的是「文件覆盖显式 env」。显式 env 是调用方的**本次意图**，文件是落盘残留；反过来会让
 * 「我明明传了 `env` 却读到了旧文件里的值」无法排查。
 * 锁点（本档「按输入顺序读取、后者覆盖前者，显式 env 优先」那条）：`expect(result.merged.PORT).toBe("18000")`
 * ——`first.env`/`second.env` 里都写了 `PORT`，而显式的 `18000` 赢；把优先级调个个儿就红。
 * 同条另钉归属口径：`expect([...result.fileOrigins]).toEqual([["LOG_LEVEL", first]])` ——
 * 显式 env 已有的 `PORT` 不归任何文件（生效值不是文件给的）。
 *
 * ## ③ 相对 env 文件路径相对**最终 `configDir`** 解析，绝对路径原样
 * 否掉的是「相对调用方 cwd」。同一个 `envFiles` 列表在不同 cwd 下必须得到同一份配置；
 * `configDir` 已经是所有相对路径的锚。
 * 锁点（本档「相对 envFiles 相对最终 configDir…」那条）：
 * `expect(context.sources.envFiles).toEqual([first, second, absolute])`
 * ——`first.env` / `nested/second.env` 两个相对路径与一个绝对路径并列，元数据逐字给出解析结果。
 *
 * ## ④ `parseRawArgv` 归一 `--key value`、`--key=value`、`KEY=VALUE` **三种**写法
 * 否掉的是「只支持 `--key=value`」。手敲起服时 `--auth-enabled=false` 是最常见形态，
 * 支持它就省掉「必须记得用等号」这条隐性要求。`KEY=VALUE` 在**第一个 `=`** 切分，值可含 `=`。
 * 锁点（本档「支持三种写法」与「KEY=VALUE 值含 '=' 时完整保留」两条）：
 * `expect((await loadArgv(["--port", "8080"], cwd)).get("port")).toBe(8080)` 与
 * `expect((await loadArgv(["JWT_SECRET=Zm9v=="], cwd)).get("jwtSecret")).toBe("Zm9v==")`。
 *
 * ## ⑤ `readEnvFiles` **缺失跳过、其它错误抛出**
 * 否掉的是「缺失也当空、错误也吞掉」。缺失是合法的「没配」；读取/解析错误若吞掉，配错的部署会带着
 * 半份 env 静默起来。锁点两条互为正反面：`expect(result).toEqual({})`（缺失）+
 * 本档「非法 env 文件读取错误 reject，且不触碰 store」那条（`envFiles: [notFile]` 指向一个目录 ⇒
 * `rejects.toBeDefined()`）。把错误也吞掉，后一条当场红。
 *
 * ## ⑥ `UPSTREAM_URL` **禁掉 path / query / hash / fragment 与越界端口**，非法即阻止启动
 * 否掉的是「容忍后取其 query」。拆项只有 host/port/protocol/secure/username/password **六项**，
 * 静默丢掉 path 就是「配了但没生效」。空串 = 未配置（合法）；`::ffff:` 形态与 IPv6 字面量剥括号。
 * 锁点（本档「非法 URL 被拒绝」那条）：`expect(parseUpstreamUrl("http://h/path")).toBeUndefined()`
 * ——容忍 path 而只取其 host 就会红。`ftp://h`（未知 scheme）与 `not a url` 是同档的另两格。
 *
 * ## ⑦ `resolveFieldEntries` 把「未提供」与「解析失败」**分成两路**（`{ resolved, bad }`）
 * 否掉的是「解析失败即当未提供」。那会让一条写错的 `PORT` 静默回落到 `defaults`，
 * 配置看起来生效而实际没生效。锁点（本档「显式非法值和越界值不静默回退」那条）：
 * `await expect(loadArgv(["--port", "not-a-number"], cwd)).rejects.toThrow(/配置校验失败/)`
 * ——当成「未提供」就等于拿到 `defaults.port`，这一行当场红。`--port 70000`（越界）与
 * `--auth-enabled treu`（枚举非法）是同档的另两格。
 *
 * ## ⑧ `assertAuthConfig` **fail-closed**（`authEnabled` 且 `basic|uid` 但账号表为空 → abort）
 * 否掉的是「放行、启动后再报」。无账号的鉴权服务起起来就是一个永远 407 的进程，先失败比先假成功便宜。
 * 锁点（本档「鉴权组合非法时 fail-closed」那条）：
 * `expect(() => assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 0 })).toThrow(/账号表为空/)`
 * ——改成放行就红；同档还有 `AUTH_TYPE=none` 与空 `JWT_SECRET` 两格。
 *
 * ## ⑨ `ConfigSourceMetadata` **只含** `envKeys` / `argvKeys` / 已绝对化的 `envFiles`
 * 否掉的是「把来源值带进诊断信息」——那会让密码 / JWT secret 被诊断来源复制一份。
 * 锁点（本档「显式 env/argv 原子装填目标 store」那条）：
 * `expect(context.sources).toEqual({ envKeys: ["PORT", "AUTH_ENABLED"], envFiles: [], argvKeys: ["LOG_LEVEL"] })`
 * ——`toEqual` 是**逐键**比较，任何多出来的键（哪怕值是 undefined）当场红。
 *
 * ## ⑩ `applyUpstreamUrlToConfig` **返回 warning 列表**而不是自己记日志
 * 否掉的是「在配置层 `logger.warn`」——配置层零日志（core 零日志禁区同源纪律），由调用方
 * （CLI / runtime）决定如何呈现。锁点（本档「UPSTREAM_URL 覆盖拆项只进入 context.warnings」那条）：
 * `expect(context.warnings).toHaveLength(1)` 且两条 `toMatch(/UPSTREAM_URL/)` / `toMatch(/UPSTREAM_HOST/)`
 * ——改成自己 `logger.warn` 就不该再有这个返回值，两行当场红。
 *
 * ## ⑪ **先 parse 再触碰 target**，非法 URL 抛错且**不部分改写**
 * 否掉的是「边解析边写」。半份拆项写进去之后，错误消失、配置看起来合法却指向错误的上游；宁可整个失败。
 * 锁点（本档「非法 URL 拒绝且不半写 store」那条）：
 * `expect(store.get("upstreamHost")).toBe("keep.example")` ——`upstreamUrl` 非法抛错后，
 * target 里那个显式给的 host **逐字没动**；边解析边写会把它清成半份产物。
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertAuthConfig, keysByPhase } from "@/config/schema/index.js";
import { defaultEnvFileNames, readEnvFiles } from "@/config/sources/index.js";
import { loadConfig } from "@/config/load.js";
import { prepareRuntimeConfigStore } from "@/config/normalize/index.js";
import { configAccessorFromStore } from "@/config/index.js";
import { ConfigStore, defaults } from "@/config/index.js";
import { parseUpstreamUrl, applyUpstreamUrl } from "@/config/schema/upstream-url.js";

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

describe("config/sources argv 归一 + schema 字段解析（经 loadConfig 唯一入口）", () => {
  /** 走唯一加载器解析 argv，返回生效配置；skipFileValidation 避开启动期 JSON 强校验。 */
  async function loadArgv(argv: string[], cwd: string) {
    const context = await loadConfig({
      env: {},
      envFiles: [],
      argv,
      cwd,
      skipFileValidation: true,
    });
    return context.accessor;
  }

  it("支持 --key value / --key=value / KEY=VALUE 三种写法", async () => {
    await withTmpConfigDir(async (cwd) => {
      expect((await loadArgv(["--port", "8080"], cwd)).get("port")).toBe(8080);
      expect((await loadArgv(["--port=8081"], cwd)).get("port")).toBe(8081);
      expect((await loadArgv(["PORT=8082"], cwd)).get("port")).toBe(8082);
    });
  });

  it("KEY=VALUE 值含 '=' 时完整保留", async () => {
    await withTmpConfigDir(async (cwd) => {
      expect((await loadArgv(["JWT_SECRET=Zm9v=="], cwd)).get("jwtSecret")).toBe("Zm9v==");
      expect((await loadArgv(["--jwt-secret=Zm9v=="], cwd)).get("jwtSecret")).toBe("Zm9v==");
      expect((await loadArgv(["UPSTREAM_URL=https://u:p@h:8443"], cwd)).get("upstreamUrl")).toBe(
        "https://u:p@h:8443",
      );
    });
  });

  it("显式非法值和越界值不静默回退", async () => {
    await withTmpConfigDir(async (cwd) => {
      await expect(loadArgv(["--port", "not-a-number"], cwd)).rejects.toThrow(/配置校验失败/);
      await expect(loadArgv(["--port", "70000"], cwd)).rejects.toThrow(/PORT=70000 越界/);
      await expect(loadArgv(["--auth-enabled", "treu"], cwd)).rejects.toThrow(/AUTH_ENABLED=treu/);
      expect((await loadArgv(["--proxy-protocol", "SOCKS5"], cwd)).get("proxyProtocol")).toBe(
        "socks5",
      );
      expect((await loadArgv(["--auth-enabled"], cwd)).get("authEnabled")).toBe(true);
    });
  });
});

describe("config 账号与名单字段", () => {
  it("默认文件名仍是 cfg/users.json 与 cfg/acl.json，CLI 可显式覆盖", async () => {
    expect(defaults.authUsersFile).toBe("cfg/users.json");
    expect(defaults.aclFile).toBe("cfg/acl.json");
    await withTmpConfigDir(async (cwd) => {
      const context = await loadConfig({
        env: {},
        envFiles: [],
        argv: ["--acl-file", "/tmp/a.json", "--auth-users-file", "/tmp/u.json"],
        cwd,
        skipFileValidation: true,
      });
      expect(context.accessor.get("aclFile")).toBe("/tmp/a.json");
      expect(context.accessor.get("authUsersFile")).toBe("/tmp/u.json");
    });
  });
});

describe("config/schema/upstream-url", () => {
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

  /**
   * 报错文案**点名实际生效的那个键**。
   * @description `AUTH_USERS_FILE` 与 `AUTH_USERS_DB` 互斥生效（驱动选哪个就读哪个），而
   * 「账号表为空」这条文案恒定点名 `AUTH_USERS_FILE` —— sqlite 档下运维会去检查一个**根本没被读**
   * 的文件，改它，然后发现毫无变化。把运维指到无关文件比不报错更坏。
   * 锁点：两条消息各自**不出现**对方的键名。负向断言必须两边都写，只写一条就成了单向检查。
   */
  it("账号表为空的文案跟着驱动走：sqlite 档点名 AUTH_USERS_DB，且绝不含 AUTH_USERS_FILE", () => {
    const msg = (usersDriver?: string): string => {
      try {
        assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 0, usersDriver });
        throw new Error("本该抛");
      } catch (e) {
        return (e as Error).message;
      }
    };
    const sqlite = msg("sqlite");
    expect(sqlite).toMatch(/AUTH_USERS_DB/);
    expect(sqlite, "sqlite 档下不许出现那个没被读的键").not.toMatch(/AUTH_USERS_FILE/);
    const json = msg("json");
    expect(json).toMatch(/AUTH_USERS_FILE/);
    expect(json).not.toMatch(/AUTH_USERS_DB/);
    // 缺省（调用方忘了传驱动）必须落在**已知的那一个**行为上，而不是第三种
    expect(msg()).toBe(json);
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
      expect(result.merged.PORT).toBe("18000");
      expect(result.merged.LOG_LEVEL).toBe("warn");
      expect([...result.fileOrigins]).toEqual([["LOG_LEVEL", first]]);
    });
  });

  it("缺失文件跳过，defaultEnvFileNames 只生成名称不读文件", async () => {
    await withTmpConfigDir(async (dir) => {
      const missing = path.join(dir, "missing.env");
      const result = await readEnvFiles([missing], {});
      expect(result.merged).toEqual({});
      expect([...result.fileOrigins]).toEqual([]);
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

  /**
   * **缺省值必须能显式写出来**：`UPSTREAM_URL` 的缺省就是空串，故空串是**合法**值。
   * @description 这条曾经反过来：空串被判非法，于是「照抄配置模板就起不来」成为实测事实
   * （`配置校验失败: UPSTREAM_URL= 非法`），而模板里那一行又不能写成生效行 —— 用户就看不见这个
   * 选项（`config-unknown-keys.test.ts` 的「集合相等」会报缺键）。两个后果同源。
   * 锁点三格：**空串合法**、**空串与不写等价**、**真非法值仍然拒**（第三格防「为了放过空串
   * 把整个校验放松」）。
   */
  it("空串是合法值：与「不写」完全等价，而真非法值仍然拒", async () => {
    await withTmpConfigDir(async (cwd) => {
      expect(parseUpstreamUrl(""), "空串 = 没配（合法）").toBe("");
      expect(parseUpstreamUrl("   "), "纯空白同样 = 没配").toBe("");
      // 「显式空串」与「压根没写」逐字段同值：这一格是本档的核心（不变量是**缺省值必须能显式
      // 写出来**，症状正是这两个形状分叉）。
      //
      // ⚠️ **必须走 `loadConfig` + argv 这条用户真实路径**，不能拿 `new ConfigStore({ upstreamUrl: "" })`
      // 去比：那个构造会经 `inferExplicitlyProvided` 把「显式给了空串」判成「没提供」并回落缺省 ——
      // 于是本档会在**实现其实分叉着**的情况下照样绿（假绿）。argv 里那个 `UPSTREAM_URL=` 才是
      // 模板复制到 `.env` / 命令行之后的真实形状。
      const viaArgv = async (argv: string[]) =>
        (
          await loadConfig({ env: {}, envFiles: [], argv, cwd, skipFileValidation: true })
        ).accessor;
      const absent = await viaArgv([]);
      const blank = await viaArgv(["UPSTREAM_URL="]);
      expect(blank.get("upstreamUrl"), "显式空串的落库值与缺省逐字相同").toBe(
        absent.get("upstreamUrl"),
      );
      expect(blank.get("upstreamHost"), "下游拆项不受影响").toBe(absent.get("upstreamHost"));
      // 反向：显式空串不许**顺带**把真值也放过（同一次调用里两个形状必须给出不同结论）
      expect(await viaArgv(["UPSTREAM_URL=http://h:3128"]).then((a) => a.get("upstreamUrl"))).toBe(
        "http://h:3128",
      );
      expect(() =>
        prepareRuntimeConfigStore(new ConfigStore({ upstreamUrl: "not a url" }), cwd),
      ).toThrow(/UPSTREAM_URL=not a url 非法/);
      expect(() =>
        prepareRuntimeConfigStore(new ConfigStore({ upstreamUrl: "http://h/path" }), cwd),
      ).toThrow(/UPSTREAM_URL/);
    });
  });
});
