import { describe, expect, it } from "vitest";
import { config, defaults, get, getAll, set } from "@/config/store.js";

describe("config/store", () => {
  it("defaults 初始化写入 Map，全量快照一致", () => {
    const snap = getAll();
    expect(snap.host).toBe(defaults.host);
    expect(snap.port).toBe(defaults.port);
    expect(snap.proxyProtocol).toBe("http");
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
