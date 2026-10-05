/**
 * `ConfigStore` 的变更通知面：changed 键口径、退订幂等、订阅者抛错隔离
 *
 * @description
 * 本档管「谁被通知、通知什么、抛错会不会连坐」。⚠️ 与「退订幂等」那条同源的实现细节在
 * **本目录 `AGENTS.md`** 的 ④（写同值就发通知会让 `config.changed` 变成噪音）。
 */
import { describe, expect, it } from "vitest";
import { ConfigStore, defaults } from "@/config/index.js";
import type { ConfigChangeListener, ConfigKey } from "@/config/index.js";

describe("ConfigStore 变更通知", () => {
  it("写同值不触发；写不同值触发且 changed 键正确、快照是变更后的", () => {
    const store = new ConfigStore();
    const calls: { changed: readonly string[]; snapshot: { port: number } }[] = [];
    store.onChange((changed, snapshot) => {
      calls.push({ changed, snapshot: { port: snapshot.port } });
    });

    store.set("port", defaults.port);
    expect(calls).toHaveLength(0);

    store.set("port", 18080);
    expect(calls).toHaveLength(1);
    expect(calls[0].changed).toEqual(["port"]);
    expect(calls[0].snapshot.port).toBe(18080);
  });

  it("merge 一次性通知所有实际变更的键", () => {
    const store = new ConfigStore();
    const seen: ConfigKey[][] = [];
    store.onChange((changed) => {
      seen.push([...changed]);
    });
    store.merge({ port: 18082, host: "127.0.0.3", logLevel: defaults.logLevel });
    expect(seen).toEqual([["port", "host"]]);
  });

  it("退订后不再触发，且退订函数幂等", () => {
    const store = new ConfigStore();
    let count = 0;
    const unsubscribe = store.onChange(() => {
      count += 1;
    });
    store.set("port", 18083);
    expect(count).toBe(1);
    unsubscribe();
    unsubscribe();
    unsubscribe();
    store.set("port", 18084);
    expect(count).toBe(1);
  });

  it("订阅者抛错不影响 store 也不影响其它订阅者", () => {
    const store = new ConfigStore();
    const bad: ConfigChangeListener = () => {
      throw new Error("boom");
    };
    let seen = 0;
    store.onChange(bad);
    store.onChange(() => {
      seen += 1;
    });
    expect(() => store.set("port", 18085)).not.toThrow();
    expect(store.get("port")).toBe(18085);
    expect(seen).toBe(1);
  });
});