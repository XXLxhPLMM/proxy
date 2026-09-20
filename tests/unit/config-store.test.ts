import { describe, expect, it } from "vitest";
import { config, defaults, get, getAll, set } from "@/config/store.js";

describe("config/store", () => {
  it("defaults 初始化写入 Map，全量快照一致", () => {
    const snap = getAll();
    expect(snap.host).toBe(defaults.host);
    expect(snap.port).toBe(defaults.port);
    expect(snap.proxyProtocol).toBe("http");
  });

  it("日志两级默认：控制台 error、落盘 info", () => {
    expect(get("logLevel")).toBe("error");
    expect(get("logFileLevel")).toBe("info");
  });

  it("upstreamCa 默认空串：走系统信任库，公网 HTTPS 上游才校验得过", () => {
    // 默认值若指向 keys/ca.crt，会整体替换系统信任库 → 串联任何公网上游都 UNABLE_TO_VERIFY_LEAF_SIGNATURE
    expect(defaults.upstreamCa).toBe("");
  });

  it("get/set 类型安全读写，getAll 返回浅拷贝", () => {
    const prev = get("port");
    set("port", 18080);
    expect(get("port")).toBe(18080);
    const snap = getAll();
    snap.port = 9999;
    // 快照是拷贝，不应污染 store
    expect(get("port")).toBe(18080);
    set("port", prev);
  });

  it("config 为进程级单例 Map", () => {
    set("host", "127.0.0.1");
    expect(config.get("host")).toBe("127.0.0.1");
    set("host", defaults.host);
  });
});
