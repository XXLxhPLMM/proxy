import { describe, expect, it } from "vitest";
import * as storeModule from "@/config/index.js";
import { ConfigStore, defaults } from "@/config/index.js";

describe("config/store", () => {
  it("只导出实例化 store 契约，不再提供模块级配置 Map/API", () => {
    expect(storeModule).not.toHaveProperty("config");
    expect(storeModule).not.toHaveProperty("get");
    expect(storeModule).not.toHaveProperty("getAll");
    expect(storeModule).not.toHaveProperty("set");
    expect(storeModule).not.toHaveProperty("defaultConfigStore");
  });

  it("defaults 保留完整默认配置", () => {
    expect(defaults.host).toBe("0.0.0.0");
    expect(defaults.port).toBe(3000);
    expect(defaults.proxyProtocol).toBe("http");
    expect(defaults.logLevel).toBe("error");
    expect(defaults.logFileLevel).toBe("info");
    expect(defaults.upstreamCa).toBe("");
    expect(defaults.tlsCa).toBe("");
  });

  it("ConfigStore 缺省以 defaults 为种子，getAll 返回独立浅拷贝", () => {
    const store = new ConfigStore();
    expect(store.getAll()).toEqual(defaults);
    expect(store.get("port")).toBe(defaults.port);

    const snapshot = store.getAll();
    snapshot.port = 19999;
    expect(store.get("port")).toBe(defaults.port);
    expect(store.getAll()).not.toBe(snapshot);
  });

  it("实例读写、merge 与变更通知彼此隔离", () => {
    const a = new ConfigStore({ port: 18081 });
    const b = new ConfigStore({ port: 18082 });
    const changes: string[][] = [];
    const unsubscribe = a.onChange((keys) => changes.push([...keys]));

    a.set("host", "127.0.0.1");
    a.merge({ port: 18083, host: "127.0.0.1" });
    b.set("port", 18084);

    expect(a.get("host")).toBe("127.0.0.1");
    expect(a.get("port")).toBe(18083);
    expect(b.get("port")).toBe(18084);
    expect(changes).toEqual([["host"], ["port"]]);

    unsubscribe();
    a.set("port", 18085);
    expect(changes).toHaveLength(2);
  });
});
