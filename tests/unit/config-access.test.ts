import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, get, getAll, set, type AppConfig } from "@/config/store.js";
import { configAccessorFromStore, globalConfigAccessor } from "@/core/config-access.js";
import { resolveRoute } from "@/core/proxy-helpers.js";
import { HttpProxy } from "@/core/server/http.js";
import { createAuthFromConfig } from "@/core/auth.js";
import { restoreConfig, snapshotConfig } from "../helpers/config.js";

/**
 * ConfigAccessor（core 配置读取端口）回归护栏
 *
 * 背景：本仓库要作为第三方库被嵌入，一个宿主进程里可能同时跑多份配置
 * （各自的 `ConfigStore`）。若 core 内部裸读全局 `get()`，即使外面建了私有 store，
 * 鉴权 / ACL / 路由 / 转发仍会读全局值——多实例互相串号。
 * 故 core 全链路只认 `ConfigAccessor`，缺省落到全局单例（行为与改造前逐字一致）。
 *
 * 本文件钉住四件事：
 * 1. `configAccessorFromStore` 读的是**实例值**（整件事的关键护栏）
 * 2. `globalConfigAccessor` 与既有 `get()` 逐键等值（缺省行为不变的承诺）
 * 3. 隔离：两个 store 派生访问器读同一键得不同值，且**不污染**全局 `get()`
 * 4. `ProxyOptions.config` 缺省即全局访问器（构造期归一，core 内部无需判空）
 *
 * 名单/账号文件一律指向不存在的绝对路径（与 `tests/setup-env.ts` 同款约定）：
 * `ConfigStore` 缺省种子里的 `aclFile` 是相对路径 `cfg/acl.json`，直接用会读到
 * 开发者本地的 `cfg/acl.json`，让用例依赖开发机状态。
 */
const MISSING_ACL = path.join(os.tmpdir(), "proxy-config-access-missing-acl.json");
const MISSING_USERS = path.join(os.tmpdir(), "proxy-config-access-missing-users.json");

/** 构造一份指向「空名单/空账号」的私有 store，再叠上本用例关心的键 */
function privateStore(patch: Partial<AppConfig> = {}): ConfigStore {
  return new ConfigStore({ aclFile: MISSING_ACL, authUsersFile: MISSING_USERS, ...patch });
}

describe("core/config-access — ConfigAccessor 端口", () => {
  it("globalConfigAccessor 逐键等值于既有 get()（缺省行为不变的承诺）", () => {
    const prev = snapshotConfig(["port", "host", "proxyMode", "upstreamHost", "upstreamPort"]);
    try {
      for (const key of Object.keys(prev) as (keyof typeof prev)[]) {
        expect(globalConfigAccessor.get(key)).toBe(get(key));
      }
      // 全量快照同样等值（getAll 是浅拷贝，按键比对即可）
      expect(globalConfigAccessor.getAll()).toEqual(getAll());
      // 全局 store 热改后访问器立即可见：每次现读，不缓存快照
      set("port", 7654);
      expect(globalConfigAccessor.get("port")).toBe(7654);
      expect(globalConfigAccessor.get("port")).toBe(get("port"));
    } finally {
      restoreConfig(prev);
    }
  });

  it("configAccessorFromStore 读的是实例值，不是全局值", () => {
    const prev = snapshotConfig(["port"]);
    try {
      set("port", 3000);
      const accessor = configAccessorFromStore(new ConfigStore({ port: 9999 }));
      expect(accessor.get("port")).toBe(9999);
      // 关键断言：实例值与全局值此刻不同 —— 若读成全局，这条会立刻红
      expect(accessor.get("port")).not.toBe(get("port"));
    } finally {
      restoreConfig(prev);
    }
  });

  it("隔离护栏：两个 store 读同一键得不同值，且不污染全局 get()", () => {
    const prev = snapshotConfig(["port", "proxyMode", "upstreamHost"]);
    try {
      set("port", 3000);
      const before = get("port");
      const beforeMode = get("proxyMode");
      const beforeUpstream = get("upstreamHost");

      const a = configAccessorFromStore(privateStore({ port: 9101, proxyMode: "client" }));
      const b = configAccessorFromStore(privateStore({ port: 9102, proxyMode: "server" }));

      // 同键不同值
      expect(a.get("port")).toBe(9101);
      expect(b.get("port")).toBe(9102);
      expect(a.get("port")).not.toBe(b.get("port"));
      // 交叉读也不会串号（访问器之间互不影响）
      expect(a.get("proxyMode")).toBe("client");
      expect(b.get("proxyMode")).toBe("server");
      expect(a.get("proxyMode")).toBe("client");

      // 全局值前后不变
      expect(get("port")).toBe(before);
      expect(get("proxyMode")).toBe(beforeMode);
      expect(get("upstreamHost")).toBe(beforeUpstream);
      expect(globalConfigAccessor.get("port")).toBe(before);
    } finally {
      restoreConfig(prev);
    }
  });

  it("派生访问器现读 store：热改后下一次读即生效（与全局 set() 热改同源）", () => {
    const store = privateStore({ upstreamHost: "10.0.0.1", upstreamPort: 1111 });
    const accessor = configAccessorFromStore(store);
    expect(accessor.get("upstreamHost")).toBe("10.0.0.1");
    expect(accessor.get("upstreamPort")).toBe(1111);

    store.set("upstreamHost", "10.0.0.2");
    expect(accessor.get("upstreamHost")).toBe("10.0.0.2");

    // getAll 恒返回新对象：mutate 返回值不得影响 store
    const defaultPort = new ConfigStore().get("port");
    const snap = accessor.getAll();
    snap.port = 1;
    expect(accessor.get("port")).toBe(defaultPort);
  });

  it("ProxyOptions.config 缺省即全局访问器（构造期归一，core 无需判空）", () => {
    // 缺省：不传 config → 归一为 globalConfigAccessor，行为与改造前一致
    const dflt = new HttpProxy({ port: 31001, host: "127.0.0.1" });
    expect(dflt.options.config).toBe(globalConfigAccessor);

    // 显式注入：原样透传到 core 内部各读取点
    const store = privateStore({ port: 31002 });
    const injected = new HttpProxy({ config: configAccessorFromStore(store) });
    expect(injected.options.config).not.toBe(globalConfigAccessor);
    expect(injected.options.config.get("port")).toBe(31002);
  });

  it("createAuthFromConfig 缺省读全局单例、注入后只认私有 store", () => {
    const prev = snapshotConfig(["authEnabled", "authType"]);
    try {
      // 全局关闭鉴权、私有 store 开启 basic：两个 provider 必须各读各的
      set("authEnabled", false);
      set("authType", "none");
      const store = privateStore({ authEnabled: true, authType: "basic" });

      const scoped = createAuthFromConfig(configAccessorFromStore(store));
      expect(scoped.isEnabled).toBe(true);
      expect(scoped.authType).toBe("basic");

      const global = createAuthFromConfig();
      expect(global.isEnabled).toBe(false);
      expect(global.authType).toBe("none");
    } finally {
      restoreConfig(prev);
    }
  });

  it("resolveRoute 真的读了注入的 proxyMode：全局 server 与私有 client 分走出游/直连", () => {
    const prev = snapshotConfig(["proxyMode"]);
    try {
      // 全局维持 server：走 globalConfigAccessor 必得直连
      set("proxyMode", "server");
      expect(resolveRoute({ host: "example.com", port: 443 })).toEqual({
        mode: "server",
        route: "direct",
      });

      // 私有 store 声明 client，且 aclFile 指向不存在路径（名单全空 → 走上游）
      const accessor = configAccessorFromStore(privateStore({ proxyMode: "client" }));
      expect(resolveRoute({ host: "example.com", port: 443 }, accessor)).toEqual({
        mode: "client",
        route: "upstream",
      });

      // 关键护栏：路由判定走的是注入值，全局 proxyMode 全程未被改写
      expect(get("proxyMode")).toBe("server");
    } finally {
      restoreConfig(prev);
    }
  });
});
