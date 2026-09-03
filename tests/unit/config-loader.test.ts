import { describe, expect, it } from "vitest";
import { parseStartupArgs } from "@/config/loader.js";

describe("config/loader parseStartupArgs", () => {
  it("支持 --key value / --key=value / KEY=VALUE 三种写法", () => {
    expect(parseStartupArgs(["--port", "8080"]).port).toBe(8080);
    expect(parseStartupArgs(["--port=8081"]).port).toBe(8081);
    expect(parseStartupArgs(["PORT=8082"]).port).toBe(8082);
  });

  it("短横线归一为下划线大写，枚举大小写不敏感", () => {
    expect(parseStartupArgs(["--proxy-protocol", "SOCKS"]).proxyProtocol).toBe("socks");
    expect(parseStartupArgs(["--log-level=DEBUG"]).logLevel).toBe("debug");
  });

  it("无值 flag 视为 true", () => {
    expect(parseStartupArgs(["--auth-enabled"]).authEnabled).toBe(true);
  });

  it("别名首命中生效", () => {
    expect(parseStartupArgs(["--proxy-type", "tls"]).proxyProtocol).toBe("tls");
    expect(parseStartupArgs(["PROXY_TYPE=http"]).proxyProtocol).toBe("http");
  });

  it("非法 CLI 值静默忽略，不污染结果", () => {
    expect(parseStartupArgs(["--port", "not-a-number"]).port).toBeUndefined();
    expect(parseStartupArgs(["--proxy-protocol", "banana"]).proxyProtocol).toBeUndefined();
    expect(parseStartupArgs(["--port", ""]).port).toBeUndefined();
  });

  it("--mode true/1 兼容为 client", () => {
    expect(parseStartupArgs(["--mode", "true"]).proxyMode).toBe("client");
    expect(parseStartupArgs(["--mode", "1"]).proxyMode).toBe("client");
    expect(parseStartupArgs(["--mode", "server"]).proxyMode).toBe("server");
  });

  it("未知 key 直接忽略", () => {
    expect(parseStartupArgs(["--whatever", "1"])).toEqual({});
  });
});
