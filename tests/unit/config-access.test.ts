import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configAccessorFromStore } from "@/config/index.js";
import { ConfigStore, type AppConfig } from "@/config/index.js";
import { createIdentityFromConfig } from "@/core/identity.js";
import { createFileAccessControl } from "@/core/access-control.js";
import { resolveRoute } from "@/core/helpers/index.js";
import { HttpProxy } from "@/core/server/http.js";
import { testConfigStore } from "../helpers/config.js";
import { testContextFor } from "../helpers/config.js";
import { openAccessControl } from "../helpers/access.js";

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

  it("ProxyOptions 只接受显式 ctx，并原样传到 core", () => {
    const accessor = configAccessorFromStore(privateStore({ port: 31002 }));
    // 本例只验 ctx 的显式绑定，与名单无关 → 显式点名「不判名单」
    const proxy = new HttpProxy({
      ctx: testContextFor(accessor),
      port: 31002,
      host: "127.0.0.1",
      access: openAccessControl(),
    });
    expect(proxy.options.ctx.config).toBe(accessor);
    expect(proxy.options.ctx.config.get("port")).toBe(31002);
  });

  it("createIdentityFromConfig 必须显式绑定实例", () => {
    // 形参是 CoreContext（三件套整体注入）：隔离性判据仍是「换掉 ctx.config 就换掉真相源」。
    const identity = createIdentityFromConfig(
      testContextFor(configAccessorFromStore(privateStore({ authEnabled: true, authType: "basic" }))),
    );
    expect(identity.isEnabled).toBe(true);
    expect(identity.kind).toBe("basic");
  });

  it("createFileAccessControl 必须显式绑定实例", () => {
    // 判定面收成端口之后，「显式绑定」这条纪律对访问控制同样成立：工厂闭包捕获哪个
    // accessor，就只读那份 accessor 指向的 aclFile / authUsersFile。
    const access = createFileAccessControl(
      configAccessorFromStore(privateStore({ proxyMode: "server" })),
    );
    expect(access.checkClient({ client: "1.2.3.4" })).toEqual({ allowed: true });
    expect(access.checkTarget({ host: "example.com" })).toEqual({ allowed: true });
    expect(access.checkRoute({ host: "example.com" })).toEqual({ direct: false });
  });

  it("resolveRoute 按注入的 proxyMode 分流", () => {
    // resolveRoute 不再收 ConfigAccessor，改收 `RoutePolicy = { access, mode }`：
    // `access` 是注入的端口、`mode` 是配置事实，二者并列、不合并成「什么都能读」的访问器。
    // 两档各建自己的 access（尽管 MISSING_ACL 让判定结果相同），证明分流只由 mode 决定。
    const server = {
      access: createFileAccessControl(
        configAccessorFromStore(privateStore({ proxyMode: "server" })),
      ),
      mode: "server" as const,
    };
    const client = {
      access: createFileAccessControl(
        configAccessorFromStore(privateStore({ proxyMode: "client" })),
      ),
      mode: "client" as const,
    };

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
