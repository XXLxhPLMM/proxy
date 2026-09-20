import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaults } from "@/config/store.js";
import { parseUpstreamUrl, applyUpstreamUrl } from "@/utils/upstream-url.js";

/**
 * loader 在被 import 时会立刻执行 initConfig()。仓库的 .env.development 里仍写着
 * AUTH_ENABLED=true / AUTH_TYPE=uid，而新 loader 改为从 users.json 统计账号数，
 * 仓库中没有该文件 → 「账号表为空」的交叉校验会当场抛错，使整个测试文件无法加载。
 * 这里先把进程内的 AUTH_ENABLED/AUTH_TYPE 钉成「关闭鉴权 / none」（in-process env 会被
 * loadEnvFiles 视为已提供，不再被 .env 文件覆盖），再动态 import loader。
 * 本文件只覆盖 parseStartupArgs / assertAuthConfig 两个纯函数与上游 URL 解析，不读任何文件。
 * 结束还原，避免污染同进程复用的其它用例。
 */
let loader!: typeof import("@/config/loader.js");
const savedAuthEnabled = process.env.AUTH_ENABLED;
const savedAuthType = process.env.AUTH_TYPE;

beforeAll(async () => {
  process.env.AUTH_ENABLED = "false";
  process.env.AUTH_TYPE = "none";
  loader = await import("@/config/loader.js");
});

afterAll(() => {
  if (savedAuthEnabled === undefined) {
    delete process.env.AUTH_ENABLED;
  } else {
    process.env.AUTH_ENABLED = savedAuthEnabled;
  }
  if (savedAuthType === undefined) {
    delete process.env.AUTH_TYPE;
  } else {
    process.env.AUTH_TYPE = savedAuthType;
  }
});

describe("config/loader parseStartupArgs", () => {
  it("支持 --key value / --key=value / KEY=VALUE 三种写法", () => {
    expect(loader.parseStartupArgs(["--port", "8080"]).port).toBe(8080);
    expect(loader.parseStartupArgs(["--port=8081"]).port).toBe(8081);
    expect(loader.parseStartupArgs(["PORT=8082"]).port).toBe(8082);
  });

  it("KEY=VALUE 值含 '=' 时完整保留（不被 split 截断）", () => {
    expect(loader.parseStartupArgs(["JWT_SECRET=Zm9v=="]).jwtSecret).toBe("Zm9v==");
    expect(loader.parseStartupArgs(["--jwt-secret=Zm9v=="]).jwtSecret).toBe("Zm9v==");
    expect(loader.parseStartupArgs(["UPSTREAM_URL=https://u:p@h:8443"]).upstreamUrl).toBe(
      "https://u:p@h:8443",
    );
  });

  it("int 字段越界同样抛错（与 initConfig 同一套校验）", () => {
    expect(() => loader.parseStartupArgs(["--port", "70000"])).toThrow(/越界/);
    expect(() => loader.parseStartupArgs(["--port", "0"])).toThrow(/PORT=0 越界/);
    expect(() => loader.parseStartupArgs(["--upstream-port=70000"])).toThrow(/越界/);
    expect(loader.parseStartupArgs(["--port", "65535"]).port).toBe(65535);
  });

  it("短横线归一为下划线大写，枚举大小写不敏感", () => {
    expect(loader.parseStartupArgs(["--proxy-protocol", "SOCKS5"]).proxyProtocol).toBe("socks5");
    expect(loader.parseStartupArgs(["--log-level=DEBUG"]).logLevel).toBe("debug");
  });

  it("控制台与落盘日志等级各自解析，互不影响", () => {
    expect(loader.parseStartupArgs(["--log-file-level=WARN"]).logFileLevel).toBe("warn");
    expect(loader.parseStartupArgs(["--log-file-level=warn"])).not.toHaveProperty("logLevel");
    expect(() => loader.parseStartupArgs(["--log-file-level=verbose"])).toThrow(
      /LOG_FILE_LEVEL=verbose/,
    );
  });

  it("无值 flag 视为 true", () => {
    expect(loader.parseStartupArgs(["--auth-enabled"]).authEnabled).toBe(true);
  });

  it("显式给出的非法 CLI 值直接抛错，不静默回退", () => {
    expect(() => loader.parseStartupArgs(["--port", "not-a-number"])).toThrow(/配置校验失败/);
    expect(() => loader.parseStartupArgs(["--proxy-protocol", "banana"])).toThrow(/配置校验失败/);
    expect(() => loader.parseStartupArgs(["--port", ""])).toThrow(/配置校验失败/);
  });

  it("布尔拼写错误不再静默当成 false（AUTH_ENABLED=treu 会关掉鉴权）", () => {
    expect(() => loader.parseStartupArgs(["--auth-enabled", "treu"])).toThrow(/AUTH_ENABLED=treu/);
    expect(loader.parseStartupArgs(["--auth-enabled", "yes"]).authEnabled).toBe(true);
    expect(loader.parseStartupArgs(["--auth-enabled", "0"]).authEnabled).toBe(false);
  });

  it("proxyMode 只认 server/client，已移除的 --mode 别名不再生效", () => {
    expect(loader.parseStartupArgs(["--proxy-mode", "client"]).proxyMode).toBe("client");
    expect(loader.parseStartupArgs(["--proxy-mode", "server"]).proxyMode).toBe("server");
    expect(() => loader.parseStartupArgs(["--proxy-mode", "true"])).toThrow(/配置校验失败/);
    expect(loader.parseStartupArgs(["--mode", "client"])).toEqual({});
  });

  it("未知 key 直接忽略", () => {
    expect(loader.parseStartupArgs(["--whatever", "1"])).toEqual({});
  });

  it("--upstream-url 合法值保留原串，非法值抛错", () => {
    expect(loader.parseStartupArgs(["--upstream-url", "https://u:p@h:8443"]).upstreamUrl).toBe(
      "https://u:p@h:8443",
    );
    expect(() => loader.parseStartupArgs(["--upstream-url", "ftp://h"])).toThrow(/配置校验失败/);
    expect(() => loader.parseStartupArgs(["--upstream-url", "not a url"])).toThrow(/配置校验失败/);
  });
});

describe("config/loader 账号/名单文件字段", () => {
  it("--auth-users-file / --acl-file（含 KEY=VALUE 形态）解析为对应字段", () => {
    expect(loader.parseStartupArgs(["--acl-file", "/tmp/a.json"]).aclFile).toBe("/tmp/a.json");
    expect(loader.parseStartupArgs(["--auth-users-file", "/tmp/u.json"]).authUsersFile).toBe(
      "/tmp/u.json",
    );
    expect(loader.parseStartupArgs(["ACL_FILE=/tmp/b.json"]).aclFile).toBe("/tmp/b.json");
    expect(loader.parseStartupArgs(["AUTH_USERS_FILE=/tmp/v.json"]).authUsersFile).toBe(
      "/tmp/v.json",
    );
  });

  it("默认文件名为 cfg/users.json 与 cfg/acl.json（配在 store.defaults；parseStartupArgs 不做默认填充）", () => {
    expect(defaults.authUsersFile).toBe("cfg/users.json");
    expect(defaults.aclFile).toBe("cfg/acl.json");
    // parseStartupArgs 只做显式表解析：未提供时不写入该字段
    expect(loader.parseStartupArgs(["--port", "8080"])).not.toHaveProperty("aclFile");
    expect(loader.parseStartupArgs(["--port", "8080"])).not.toHaveProperty("authUsersFile");
  });
});

describe("config/loader parseUpstreamUrl", () => {
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

describe("config/loader applyUpstreamUrl", () => {
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

describe("config/loader assertAuthConfig", () => {
  it("authEnabled + basic/uid 且账号表为空时抛错阻止启动", () => {
    expect(() =>
      loader.assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 0 }),
    ).toThrow(/配置校验失败/);
    expect(() =>
      loader.assertAuthConfig({ authEnabled: true, authType: "uid", accountCount: 0 }),
    ).toThrow(/账号表为空/);
  });

  it("authEnabled + type=none / jwt 无密钥时抛错（fail-closed）", () => {
    // 开了鉴权却不选方式 = 全部放行，属自相矛盾配置
    expect(() =>
      loader.assertAuthConfig({ authEnabled: true, authType: "none", accountCount: 0 }),
    ).toThrow(/AUTH_TYPE=none/);
    expect(() =>
      loader.assertAuthConfig({
        authEnabled: true,
        authType: "jwt",
        accountCount: 0,
        jwtSecret: "",
      }),
    ).toThrow(/JWT_SECRET/);
  });

  it("账号表非空 / authEnabled=false / jwt 带密钥 均放行", () => {
    expect(() =>
      loader.assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 1 }),
    ).not.toThrow();
    expect(() =>
      loader.assertAuthConfig({ authEnabled: true, authType: "uid", accountCount: 2 }),
    ).not.toThrow();
    expect(() =>
      loader.assertAuthConfig({ authEnabled: false, authType: "basic", accountCount: 0 }),
    ).not.toThrow();
    expect(() =>
      loader.assertAuthConfig({ authEnabled: false, authType: "none", accountCount: 0 }),
    ).not.toThrow();
    expect(() =>
      loader.assertAuthConfig({
        authEnabled: true,
        authType: "jwt",
        accountCount: 0,
        jwtSecret: "s3cr3t",
      }),
    ).not.toThrow();
  });
});
