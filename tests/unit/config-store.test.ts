import { describe, expect, it } from "vitest";
import {
  ConfigStore,
  config,
  defaultConfigStore,
  defaults,
  get,
  getAll,
  set,
} from "@/config/store.js";

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

  it("tlsCa 默认空串：默认不校验客户端证书（配了才是 mTLS 开关）", () => {
    // 默认若指向 keys/ca.crt，会拿仓库自带的测试 PKI（私钥已提交）假装安全性，并锁死所有无证书客户端
    expect(defaults.tlsCa).toBe("");
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

/**
 * 实例化 store：库模式（把本仓库当第三方库调用）用的第二套入口。
 * 与上面的全局单例并存而非替代——库调用方要「多份互不干扰的配置」时显式 new ConfigStore()。
 */
describe("config/store ConfigStore（实例化）", () => {
  it("缺省构造以 defaults 为种子，getAll 同样返回浅拷贝", () => {
    const store = new ConfigStore();
    expect(store.getAll()).toEqual(defaults);
    expect(store.get("port")).toBe(defaults.port);
    const snap = store.getAll();
    snap.port = 19999;
    expect(store.get("port")).toBe(defaults.port);
  });

  it("实例互不影响，且不与全局单例 config 共享状态", () => {
    const a = new ConfigStore();
    const b = new ConfigStore();
    a.set("port", 18081);
    b.set("port", 18082);
    expect(a.get("port")).toBe(18081);
    expect(b.get("port")).toBe(18082);
    // 实例写入既不回流全局 get()，也不改全局 Map 本体
    const globalPort = get("port");
    const globalHost = get("host");
    new ConfigStore().set("port", 18083);
    expect(get("port")).toBe(globalPort);
    expect(config.get("port")).toBe(globalPort);
    expect(config.get("host")).toBe(globalHost);
  });

  it("defaultConfigStore 是模块级默认实例，与全局单例无共享", () => {
    expect(defaultConfigStore).toBeInstanceOf(ConfigStore);
    const globalPort = get("port");
    defaultConfigStore.set("port", 18084);
    expect(defaultConfigStore.get("port")).toBe(18084);
    expect(get("port")).toBe(globalPort);
    defaultConfigStore.set("port", defaults.port);
  });
});
