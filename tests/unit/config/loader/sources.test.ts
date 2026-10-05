/**
 * `config/sources` 的外部输入采集 + `config/schema` 的字段解析原语（全部经 `loadConfig` 唯一入口）
 *
 * @description
 * 本档管五段：argv 三种写法 → 账号/名单路径字段 → `UPSTREAM_URL` 拆项 → `assertAuthConfig`
 * fail-closed → env 文件合并与默认文件名。⚠️ 逐条的「为什么」与变异锁点归**本目录
 * `AGENTS.md`** 的 ①–⑪ 与那张对照表；文件头只留「这一档管哪一段」，否则拆一次档就抄成 N 份。
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { assertAuthConfig } from "@/config/schema/index.js";
import { defaultEnvFileNames, readEnvFiles } from "@/config/sources/index.js";
import { loadConfig } from "@/config/load.js";
import { defaults } from "@/config/index.js";
import { parseUpstreamUrl, applyUpstreamUrl } from "@/config/schema/upstream-url.js";
import { withTmpConfigDir } from "./_config-loader.js";

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