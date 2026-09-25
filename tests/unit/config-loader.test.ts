import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertAuthConfig, keysByPhase, parseStartupArgs } from "@/config/fields.js";
import { loadConfig } from "@/config/load.js";
import { defaults, get } from "@/config/store.js";
import { parseUpstreamUrl, applyUpstreamUrl } from "@/utils/upstream-url.js";

/**
 * 配置解析契约：CLI 字段解析、跨字段校验与库模式显式加载。
 *
 * 纯表工具从 `fields.ts` 直引，库加载器从零副作用的 `load.ts` 直引；
 * 本文件不再动态 import CLI 初始化器，因而测试加载本身不会读取宿主配置。
 */

describe("config/fields parseStartupArgs", () => {
  it("支持 --key value / --key=value / KEY=VALUE 三种写法", () => {
    expect(parseStartupArgs(["--port", "8080"]).port).toBe(8080);
    expect(parseStartupArgs(["--port=8081"]).port).toBe(8081);
    expect(parseStartupArgs(["PORT=8082"]).port).toBe(8082);
  });

  it("KEY=VALUE 值含 '=' 时完整保留（不被 split 截断）", () => {
    expect(parseStartupArgs(["JWT_SECRET=Zm9v=="]).jwtSecret).toBe("Zm9v==");
    expect(parseStartupArgs(["--jwt-secret=Zm9v=="]).jwtSecret).toBe("Zm9v==");
    expect(parseStartupArgs(["UPSTREAM_URL=https://u:p@h:8443"]).upstreamUrl).toBe(
      "https://u:p@h:8443",
    );
  });

  it("int 字段越界同样抛错（与 initConfig 同一套校验）", () => {
    expect(() => parseStartupArgs(["--port", "70000"])).toThrow(/越界/);
    expect(() => parseStartupArgs(["--port", "0"])).toThrow(/PORT=0 越界/);
    expect(() => parseStartupArgs(["--upstream-port=70000"])).toThrow(/越界/);
    expect(parseStartupArgs(["--port", "65535"]).port).toBe(65535);
  });

  it("短横线归一为下划线大写，枚举大小写不敏感", () => {
    expect(parseStartupArgs(["--proxy-protocol", "SOCKS5"]).proxyProtocol).toBe("socks5");
    expect(parseStartupArgs(["--log-level=DEBUG"]).logLevel).toBe("debug");
  });

  it("控制台与落盘日志等级各自解析，互不影响", () => {
    expect(parseStartupArgs(["--log-file-level=WARN"]).logFileLevel).toBe("warn");
    expect(parseStartupArgs(["--log-file-level=warn"])).not.toHaveProperty("logLevel");
    expect(() => parseStartupArgs(["--log-file-level=verbose"])).toThrow(
      /LOG_FILE_LEVEL=verbose/,
    );
  });

  it("无值 flag 视为 true", () => {
    expect(parseStartupArgs(["--auth-enabled"]).authEnabled).toBe(true);
  });

  it("显式给出的非法 CLI 值直接抛错，不静默回退", () => {
    expect(() => parseStartupArgs(["--port", "not-a-number"])).toThrow(/配置校验失败/);
    expect(() => parseStartupArgs(["--proxy-protocol", "banana"])).toThrow(/配置校验失败/);
    expect(() => parseStartupArgs(["--port", ""])).toThrow(/配置校验失败/);
  });

  it("布尔拼写错误不再静默当成 false（AUTH_ENABLED=treu 会关掉鉴权）", () => {
    expect(() => parseStartupArgs(["--auth-enabled", "treu"])).toThrow(/AUTH_ENABLED=treu/);
    expect(parseStartupArgs(["--auth-enabled", "yes"]).authEnabled).toBe(true);
    expect(parseStartupArgs(["--auth-enabled", "0"]).authEnabled).toBe(false);
  });

  it("proxyMode 只认 server/client，已移除的 --mode 别名不再生效", () => {
    expect(parseStartupArgs(["--proxy-mode", "client"]).proxyMode).toBe("client");
    expect(parseStartupArgs(["--proxy-mode", "server"]).proxyMode).toBe("server");
    expect(() => parseStartupArgs(["--proxy-mode", "true"])).toThrow(/配置校验失败/);
    expect(parseStartupArgs(["--mode", "client"])).toEqual({});
  });

  it("未知 key 直接忽略", () => {
    expect(parseStartupArgs(["--whatever", "1"])).toEqual({});
  });

  it("--upstream-url 合法值保留原串，非法值抛错", () => {
    expect(parseStartupArgs(["--upstream-url", "https://u:p@h:8443"]).upstreamUrl).toBe(
      "https://u:p@h:8443",
    );
    expect(() => parseStartupArgs(["--upstream-url", "ftp://h"])).toThrow(/配置校验失败/);
    expect(() => parseStartupArgs(["--upstream-url", "not a url"])).toThrow(/配置校验失败/);
  });
});

describe("config/fields 账号/名单文件字段", () => {
  it("--auth-users-file / --acl-file（含 KEY=VALUE 形态）解析为对应字段", () => {
    expect(parseStartupArgs(["--acl-file", "/tmp/a.json"]).aclFile).toBe("/tmp/a.json");
    expect(parseStartupArgs(["--auth-users-file", "/tmp/u.json"]).authUsersFile).toBe(
      "/tmp/u.json",
    );
    expect(parseStartupArgs(["ACL_FILE=/tmp/b.json"]).aclFile).toBe("/tmp/b.json");
    expect(parseStartupArgs(["AUTH_USERS_FILE=/tmp/v.json"]).authUsersFile).toBe(
      "/tmp/v.json",
    );
  });

  it("默认文件名为 cfg/users.json 与 cfg/acl.json（配在 store.defaults；parseStartupArgs 不做默认填充）", () => {
    expect(defaults.authUsersFile).toBe("cfg/users.json");
    expect(defaults.aclFile).toBe("cfg/acl.json");
    // parseStartupArgs 只做显式表解析：未提供时不写入该字段
    expect(parseStartupArgs(["--port", "8080"])).not.toHaveProperty("aclFile");
    expect(parseStartupArgs(["--port", "8080"])).not.toHaveProperty("authUsersFile");
  });
});

describe("utils/upstream-url parseUpstreamUrl", () => {
  it("合法形式：scheme 白名单 + 缺省 host/port 均通过", () => {
    expect(parseUpstreamUrl("http://example.com")).toBe("http://example.com");
    expect(parseUpstreamUrl("https://uuuu:pppp@xxxx.xxxx:8443")).toBe(
      "https://uuuu:pppp@xxxx.xxxx:8443",
    );
    expect(parseUpstreamUrl("socks5://h:1080")).toBe("socks5://h:1080");
    expect(parseUpstreamUrl("  http://h  ")).toBe("http://h");
  });

  it("非法形式：坏 scheme / 空 host / 携带 path/query/hash / 端口越界 / 非法 URL", () => {
    expect(parseUpstreamUrl("ftp://h")).toBeUndefined();
    expect(parseUpstreamUrl("tls://h")).toBeUndefined();
    expect(parseUpstreamUrl("http://")).toBeUndefined();
    expect(parseUpstreamUrl("http://h/path")).toBeUndefined();
    expect(parseUpstreamUrl("http://h?q=1")).toBeUndefined();
    expect(parseUpstreamUrl("http://h#frag")).toBeUndefined();
    expect(parseUpstreamUrl("http://h:0")).toBeUndefined();
    expect(parseUpstreamUrl("http://h:70000")).toBeUndefined();
    expect(parseUpstreamUrl("::::")).toBeUndefined();
    expect(parseUpstreamUrl("")).toBeUndefined();
  });
});

describe("utils/upstream-url applyUpstreamUrl", () => {
  it("拆项写回：scheme 映射协议/TLS/缺省端口，userinfo 百分号解码", () => {
    const r: Record<string, unknown> = {};
    applyUpstreamUrl(r, "https://u%40x:p%21@proxy.example.com:8443");
    expect(r).toEqual({
      upstreamProtocol: "https",
      upstreamSecure: true,
      upstreamHost: "proxy.example.com",
      upstreamPort: 8443,
      upstreamUsername: "u@x",
      upstreamPassword: "p!",
    });
  });

  it("缺省端口按 scheme 补齐（http:80 / socks5:1080 / sockss5:443）", () => {
    const http: Record<string, unknown> = {};
    applyUpstreamUrl(http, "http://h");
    expect(http.upstreamProtocol).toBe("http");
    expect(http.upstreamSecure).toBe(false);
    expect(http.upstreamPort).toBe(80);
    expect(http.upstreamUsername).toBe("");

    const socks: Record<string, unknown> = {};
    applyUpstreamUrl(socks, "socks5://h");
    expect(socks.upstreamProtocol).toBe("socks5");
    expect(socks.upstreamPort).toBe(1080);

    const sockss: Record<string, unknown> = {};
    applyUpstreamUrl(sockss, "sockss5://h");
    expect(sockss.upstreamProtocol).toBe("sockss5");
    expect(sockss.upstreamSecure).toBe(true);
    expect(sockss.upstreamPort).toBe(443);
  });

  it("IPv6 字面量：解析通过，存储时剥掉方括号（[::1] -> ::1）", () => {
    expect(parseUpstreamUrl("socks5://[::1]:1080")).toBe("socks5://[::1]:1080");
    const r: Record<string, unknown> = {};
    applyUpstreamUrl(r, "socks5://[::1]:1080");
    expect(r.upstreamHost).toBe("::1");
    expect(r.upstreamPort).toBe(1080);
    expect(r.upstreamProtocol).toBe("socks5");
    expect(r.upstreamSecure).toBe(false);

    const r2: Record<string, unknown> = {};
    applyUpstreamUrl(r2, "sockss5://[2001:db8::1]:1080");
    expect(r2.upstreamHost).toBe("2001:db8::1");
    expect(r2.upstreamPort).toBe(1080);
  });
});

describe("config/fields assertAuthConfig", () => {
  it("authEnabled + basic/uid 且账号表为空时抛错阻止启动", () => {
    expect(() =>
      assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 0 }),
    ).toThrow(/配置校验失败/);
    expect(() =>
      assertAuthConfig({ authEnabled: true, authType: "uid", accountCount: 0 }),
    ).toThrow(/账号表为空/);
  });

  it("authEnabled + type=none / jwt 无密钥时抛错（fail-closed）", () => {
    // 开了鉴权却不选方式 = 全部放行，属自相矛盾配置
    expect(() =>
      assertAuthConfig({ authEnabled: true, authType: "none", accountCount: 0 }),
    ).toThrow(/AUTH_TYPE=none/);
    expect(() =>
      assertAuthConfig({
        authEnabled: true,
        authType: "jwt",
        accountCount: 0,
        jwtSecret: "",
      }),
    ).toThrow(/JWT_SECRET/);
  });

  it("账号表非空 / authEnabled=false / jwt 带密钥 均放行", () => {
    expect(() =>
      assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 1 }),
    ).not.toThrow();
    expect(() =>
      assertAuthConfig({ authEnabled: true, authType: "uid", accountCount: 2 }),
    ).not.toThrow();
    expect(() =>
      assertAuthConfig({ authEnabled: false, authType: "basic", accountCount: 0 }),
    ).not.toThrow();
    expect(() =>
      assertAuthConfig({ authEnabled: false, authType: "none", accountCount: 0 }),
    ).not.toThrow();
    expect(() =>
      assertAuthConfig({
        authEnabled: true,
        authType: "jwt",
        accountCount: 0,
        jwtSecret: "s3cr3t",
      }),
    ).not.toThrow();
  });
});

/**
 * loadConfig：库模式的显式加载入口，与 initConfig 共用同一张 FIELDS 表与同一套校验，
 * 但落点是调用方给的 ConfigStore，不碰全局单例。回归护栏见 config-instance.test.ts。
 */
describe("config/load loadConfig", () => {
  /**
   * 每用例一份独立临时配置目录
   * @description 目录里没有 .env.* / cfg/*.json，用例既不读仓库开发者的本地配置、彼此也无顺序依赖
   */
  function withTmpConfigDir<T>(fn: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-loadconfig-"));
    try {
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("按显式 env/argv 装填目标 store，返回 configDir 与启动相位键", () => {
    withTmpConfigDir((cwd) => {
      const loaded = loadConfig({
        env: { PORT: "18100", AUTH_ENABLED: "false" },
        argv: ["--log-level=debug"],
        cwd,
        writeProcessEnv: false,
      });
      expect(loaded.store.get("port")).toBe(18100);
      expect(loaded.store.get("logLevel")).toBe("debug");
      // 未提供的键回退 defaults（与 initConfig 同一口径）
      expect(loaded.store.get("host")).toBe(defaults.host);
      expect(loaded.configDir).toBe(cwd);
      expect(loaded.startupKeys).toEqual(keysByPhase().startup);
    });
  });

  it("loadConfig 不写全局单例，也不改 process.env（writeProcessEnv:false）", () => {
    withTmpConfigDir((cwd) => {
      const globalBefore = { port: get("port"), host: get("host"), logLevel: get("logLevel") };
      const envBefore = { ...process.env };
      loadConfig({
        env: { PORT: "18101", HOST: "127.0.0.7", LOG_LEVEL: "warn", AUTH_ENABLED: "false" },
        argv: [],
        cwd,
        writeProcessEnv: false,
      });
      expect({ port: get("port"), host: get("host"), logLevel: get("logLevel") }).toEqual(
        globalBefore,
      );
      expect({ ...process.env }).toEqual(envBefore);
    });
  });

  it("非法值与 initConfig 同样抛错（int 越界 / 布尔拼写错 / 枚举非法）", () => {
    withTmpConfigDir((cwd) => {
      const base = { argv: [], cwd, writeProcessEnv: false };
      expect(() => loadConfig({ ...base, env: { PORT: "70000" } })).toThrow(
        /配置校验失败: PORT=70000 越界/,
      );
      expect(() => loadConfig({ ...base, env: { AUTH_ENABLED: "treu" } })).toThrow(
        /AUTH_ENABLED=treu/,
      );
      expect(() => loadConfig({ ...base, env: { PROXY_MODE: "true" } })).toThrow(
        /PROXY_MODE=true/,
      );
      // CLI 侧同样不静默回退
      expect(() => loadConfig({ ...base, env: {}, argv: ["--port", "0"] })).toThrow(
        /PORT=0 越界/,
      );
    });
  });

  it("skipFileValidation 跳过 users.json/acl.json 强校验（鉴权组合由调用方保证）", () => {
    withTmpConfigDir((cwd) => {
      const base = {
        argv: [],
        cwd,
        writeProcessEnv: false,
        env: {
          AUTH_ENABLED: "true",
          AUTH_TYPE: "basic",
          AUTH_USERS_FILE: path.join(cwd, "nope-users.json"),
          ACL_FILE: path.join(cwd, "nope-acl.json"),
        },
      };
      expect(() => loadConfig(base)).toThrow(/配置校验失败/);
      expect(
        loadConfig({ ...base, skipFileValidation: true }).store.get("authEnabled"),
      ).toBe(true);
    });
  });
});
