import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configAccessorFromStore } from "@/config/accessor.js";
import { ConfigStore, type AppConfig } from "@/config/store.js";
import { createAuthFromConfig } from "@/core/auth.js";
import { resolveRoute } from "@/core/proxy-helpers.js";
import { HttpProxy } from "@/core/server/http.js";
import { testConfigStore } from "../helpers/config.js";

const MISSING_ACL = path.join(os.tmpdir(), "proxy-config-access-missing-acl.json");
const MISSING_USERS = path.join(os.tmpdir(), "proxy-config-access-missing-users.json");

function privateStore(patch: Partial<AppConfig> = {}): ConfigStore {
  return new ConfigStore({ aclFile: MISSING_ACL, authUsersFile: MISSING_USERS, ...patch });
}

describe("config/accessor — 无全局状态的实例读取端口", () => {
  it("从 store 派生的 accessor 永远读取该实例", () => {
    const accessor = configAccessorFromStore(new ConfigStore({ port: 9999 }));
    expect(Object.isFrozen(accessor)).toBe(true);
    expect(accessor.get("port")).toBe(9999);
    expect(accessor.get("port")).not.toBe(testConfigStore.get("port"));
  });

  it("两个 accessor 同键互不串号，也不写任何隐式全局状态", () => {
    const a = configAccessorFromStore(privateStore({ port: 9101, proxyMode: "client" }));
    const b = configAccessorFromStore(privateStore({ port: 9102, proxyMode: "server" }));
    const testPortBefore = testConfigStore.get("port");

    expect(a.get("port")).toBe(9101);
    expect(b.get("port")).toBe(9102);
    expect(a.get("proxyMode")).toBe("client");
    expect(b.get("proxyMode")).toBe("server");
    expect(testConfigStore.get("port")).toBe(testPortBefore);
  });

  it("accessor 每次现读 store：热改后下一次读取即生效", () => {
    const store = privateStore({ upstreamHost: "10.0.0.1", upstreamPort: 1111 });
    const accessor = configAccessorFromStore(store);
    expect(accessor.get("upstreamHost")).toBe("10.0.0.1");

    store.set("upstreamHost", "10.0.0.2");
    expect(accessor.get("upstreamHost")).toBe("10.0.0.2");
  });

  it("ProxyOptions 只接受显式 config，并原样传到 core", () => {
    const accessor = configAccessorFromStore(privateStore({ port: 31002 }));
    const proxy = new HttpProxy({ config: accessor, port: 31002, host: "127.0.0.1" });
    expect(proxy.options.config).toBe(accessor);
    expect(proxy.options.config.get("port")).toBe(31002);
  });

  it("createAuthFromConfig 必须显式绑定实例", () => {
    const auth = createAuthFromConfig(
      configAccessorFromStore(privateStore({ authEnabled: true, authType: "basic" })),
    );
    expect(auth.isEnabled).toBe(true);
    expect(auth.authType).toBe("basic");
  });

  it("resolveRoute 按注入的 proxyMode 分流", () => {
    const server = configAccessorFromStore(privateStore({ proxyMode: "server" }));
    const client = configAccessorFromStore(privateStore({ proxyMode: "client" }));

    expect(resolveRoute({ host: "example.com", port: 443 }, server)).toEqual({
      mode: "server",
      route: "direct",
    });
    expect(resolveRoute({ host: "example.com", port: 443 }, client)).toEqual({
      mode: "client",
      route: "upstream",
    });
  });
});
