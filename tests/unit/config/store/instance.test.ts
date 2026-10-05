/**
 * `ConfigStore` 的实例语义：零 IO 零校验的构造、`getAll` 拷贝、`merge` 只报实际变更
 *
 * @description
 * 本档管形状面：缺省种子、任意子集补丁、实例间隔离、浅拷贝、`merge` 的变更口径。
 * ⚠️ 逐条的「为什么」与变异锁点归**本目录 `AGENTS.md`** 的 ③ / ④；本档文件头只留
 * 「这一档管哪一段」。
 */
import { describe, expect, it } from "vitest";
import { ConfigStore, defaults } from "@/config/index.js";

describe("ConfigStore 实例化", () => {
  it("缺省构造读到的就是 defaults", () => {
    const store = new ConfigStore();
    expect(store.getAll()).toEqual(defaults);
    expect(store.get("port")).toBe(defaults.port);
    expect(store.get("proxyProtocol")).toBe("http");
    expect(store.has("authUsersFile")).toBe(true);
  });

  it("初始补丁只覆盖给出的键，其余留 defaults", () => {
    const store = new ConfigStore({ port: 18099 });
    expect(store.get("port")).toBe(18099);
    expect(store.get("host")).toBe(defaults.host);
    expect(store.get("logLevel")).toBe(defaults.logLevel);
  });

  it("两个实例互不影响", () => {
    const a = new ConfigStore();
    const b = new ConfigStore();
    a.set("port", 1111);
    a.set("host", "10.0.0.1");
    expect(b.get("port")).toBe(defaults.port);
    expect(b.get("host")).toBe(defaults.host);
    b.set("port", 2222);
    expect(a.get("port")).toBe(1111);
    expect(new ConfigStore().get("port")).toBe(defaults.port);
  });

  it("getAll 返回拷贝：外部 mutate 不影响 store", () => {
    const store = new ConfigStore();
    const snapshot = store.getAll();
    snapshot.port = 7777;
    snapshot.authEnabled = true;
    expect(store.get("port")).toBe(defaults.port);
    expect(store.get("authEnabled")).toBe(defaults.authEnabled);
    expect(store.getAll()).not.toBe(snapshot);
    expect(store.getAll()).toEqual(defaults);
  });

  it("merge 返回实际变更的键：写同值 / undefined 一律不算变更", () => {
    const store = new ConfigStore();
    expect(store.merge({ port: defaults.port })).toEqual([]);
    expect(store.merge({})).toEqual([]);
    const store2 = new ConfigStore({ port: 18099 });
    expect(store2.merge({ port: undefined })).toEqual([]);
    expect(store2.get("port")).toBe(18099);
    const changed = store.merge({ port: 18081, host: "127.0.0.2", proxyProtocol: "http" });
    expect(new Set(changed)).toEqual(new Set(["port", "host"]));
    expect(store.get("port")).toBe(18081);
    expect(store.get("proxyProtocol")).toBe("http");
  });
});