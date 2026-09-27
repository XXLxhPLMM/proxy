/**
 * `ConfigStore` 实例语义 + `createConfigContext` 的冻结快照 + `loadConfig` 的库模式
 *
 * @description
 * ## ① `context.config` 是**创建时复制并 `Object.freeze` 的初始快照**，不是 live store 的替代品
 * 否掉的是「让消费方直接读它」。热读必须经 `context.accessor` 或 `context.store`，
 * 否则热加载的配置改动永远看不到。锁点（本档「createConfigContext 为每次创建生成独立快照与 accessor」那条）：
 * `expect(Object.isFrozen(first.config)).toBe(true)`
 * ——改成 live store（活引用或 getter 门面）就不可能是冻结对象，当场红。
 * 同档的 `expect(first.accessor).not.toBe(second.accessor)` 与「每次派生都是独立且稳定的单键访问器」里
 * `expect(Object.keys(first)).toEqual(["get"])` 一起锁住「读配置的面只有 accessor 一个」。
 *
 * ## ② `startupKeys` 恒取**完整的** `keysByPhase().startup`，**不是** `createConfigContext` 的入参
 * 否掉的是「让调用方传」。调用方一传就能删减，那道门（「startup 相位必须重启才生效」）就形同虚设。
 * 锁点（本档「Context 工厂始终使用完整 startup 集合」那条，两行缺一不可）：
 * `expect(context.startupKeys).toEqual(keysByPhase().startup)` ——**逐项**相等，
 * 开一个 `startupKeys` 形参并在某处传子集就红；
 * `expect(context.startupKeys).toContain("upstreamUrl")` ——那条 URL 四件套是 startup 相位的具体见证。
 *
 * ## ③ `ConfigStore` 零 IO 零校验：库调用方 `new ConfigStore(partial)` 能用**任意子集**
 * 否掉的是「构造期跑一遍 FIELDS 解析 / 范围校验 / 文件校验 / auth 交叉校验」。
 * **本档只锁「任意子集」这一半**：锁点是本档「初始补丁只覆盖给出的键，其余留 defaults」那条——
 * `const store = new ConfigStore({ port: 18099 })` 之后 `expect(store.get("logLevel")).toBe(defaults.logLevel)`。
 * 构造期**要求全字段齐备**（缺一个就抛）会让这一行当场红；全仓还有几十处单键构造
 * （`new ConfigStore({ authUsersFile })` / `new ConfigStore({ quotaResetHour: 7 })` …）同样会红。
 * ⚠️ **但「零**校验**」那一半的牙齿不在本档**——「合并在 `defaults` 之上」与「不校验」是两件事，
 * 一个「存在即校验、缺席即容忍」的构造器同样能让上面这些全绿。真正的牙齿在**消费侧**：
 * - `tests/unit/proxy-runtime.test.ts`「未知协议在构造阶段给出清晰错误」：
 *   `expect(() => createProxyRuntime({ config: { proxyProtocol: "ftp" as ProxyProtocol } })).toThrow("未知代理协议: ftp")`
 *   ——构造期跑 `FIELDS.parseEnum` 的话，抛的是 `配置校验失败: PROXY_PROTOCOL=ftp 非法`，
 *   **不含** `未知代理协议: ftp` 这个子串，红。
 * - `tests/integration/upstream-protocol-fail-closed.test.ts` 整档：它经
 *   `createProxyRuntime({ config: { upstreamProtocol: "ftp" } })`（走 `runtime.ts:new ConfigStore(initialConfig)`）
 *   注入非法值并断言**请求期** fail-closed。抛点一旦前移到构造期，那一档在 `startRuntime(...)` 那一行就炸。
 * - ⚠️ **代价是明说的**：库路径能把非法值塞进 store，兜底在**消费侧**那两个 fail-closed 出口上。
 *
 * ## ④ `getAll()` 恒返回**新对象**（浅拷贝），调用方 mutate 不得影响 store；`merge` 返回**实际变更**的键
 * 这是「配置状态只有 `ConfigStore`」的形状面：没有可被外部 mutate 的内部引用，也没有
 * 「写同值也算变更」这种会误报订阅者的口径。锁点（本档「getAll 返回拷贝」与「merge 返回实际变更的键」两条）：
 * `expect(store.getAll()).not.toBe(snapshot)`（拷贝）与
 * `expect(store2.merge({ port: undefined })).toEqual([])`（同值 / undefined 一律不算变更）。
 * 写同值就发通知会让 `config.changed` 变成噪音，订阅方无从判断「到底改了什么」。
 *
 * ## ⑤ `resolveConfigPaths` 只按 `FIELDS` 的 `path: true` 判，**不按字段名硬编码**
 * 否掉的是「在归一层维护第二张路径字段表」。那张表一漂就出现「某个路径字段忘了绝对化」，
 * 而症状是相对路径被解释到进程 cwd。锁点（本档「相对路径字段在 context 创建时按 configDir 归一化」那条）：
 * 六个字段（`authUsersFile` / `aclFile` / `logFile` / `tlsKey` / `tlsCert` / `upstreamCa`）逐个
 * `toBe(path.join(configDir, …))` ——归一层改成字段名白名单而漏掉任何一个，红的就是它；
 * 把「哪些字段是路径」从 `FIELDS` 挪到归一层，这六个断言也全都不成立。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configAccessorFromStore, createConfigContext } from "@/config/index.js";
import { keysByPhase } from "@/config/schema/index.js";
import { loadConfig } from "@/config/load.js";
import { ConfigStore, defaults } from "@/config/index.js";
import type { ConfigChangeListener, ConfigKey } from "@/config/index.js";

async function withTmpConfigDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-loadconfig-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
    const changed = store.merge({ port: 18081, host: "127.0.0.2", cacheType: "memory" });
    expect(new Set(changed)).toEqual(new Set(["port", "host"]));
    expect(store.get("port")).toBe(18081);
    expect(store.get("cacheType")).toBe("memory");
  });
});

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

describe("config/accessor", () => {
  it("每次派生都是独立且稳定的单键访问器", () => {
    const store = new ConfigStore({ port: 9101, proxyMode: "client" });
    const first = configAccessorFromStore(store);
    const second = configAccessorFromStore(store);
    expect(first).not.toBe(second);
    expect(first.get("port")).toBe(9101);
    expect(first.get("proxyMode")).toBe("client");
    store.set("port", 9102);
    expect(first.get("port")).toBe(9102);
    expect(Object.keys(first)).toEqual(["get"]);
  });

  it("createConfigContext 为每次创建生成独立快照与 accessor", () => {
    const store = new ConfigStore({ port: 9200 });
    const first = createConfigContext({
      store,
      configDir: "C:/config",
      sources: {
        envKeys: ["PORT"],
        envFiles: ["C:/config/a.env"],
        argvKeys: [],
      },
    });
    const second = createConfigContext({ store, configDir: "C:/config" });
    expect(first).not.toBe(second);
    expect(first.accessor).not.toBe(second.accessor);
    expect(first.config.port).toBe(9200);
    expect(first.sources.envKeys).toEqual(["PORT"]);
    expect(first.sources.envFiles).toEqual(["C:/config/a.env"]);
    expect(Object.isFrozen(first.config)).toBe(true);
  });

  it("Context 工厂始终使用完整 startup 集合", () => {
    const context = createConfigContext({
      store: new ConfigStore(),
      configDir: "C:/config",
    });
    expect(context.startupKeys).toEqual(keysByPhase().startup);
    expect(context.startupKeys).toContain("upstreamUrl");
    expect(context.startupKeys).toContain("upstreamHost");
    expect(context.startupKeys).toContain("upstreamPort");
    expect(context.startupKeys).toContain("upstreamProtocol");
  });

  it("相对 configDir 本身也归一为绝对路径", () => {
    const store = new ConfigStore();
    const context = createConfigContext({ store, configDir: path.join("relative", "config") });
    expect(context.configDir).toBe(path.resolve("relative", "config"));
    expect(path.isAbsolute(context.store.get("aclFile"))).toBe(true);
  });

  it("相对路径字段在 context 创建时按 configDir 归一化", () => {
    const configDir = path.resolve("C:/config");
    const store = new ConfigStore({
      authUsersFile: "users.json",
      aclFile: "acl.json",
      logFile: "logs",
      tlsKey: "keys/server.key",
      tlsCert: "keys/server.crt",
      upstreamCa: "certs/upstream.pem",
    });
    const context = createConfigContext({ store, configDir });
    expect(context.store.get("authUsersFile")).toBe(path.join(configDir, "users.json"));
    expect(context.store.get("aclFile")).toBe(path.join(configDir, "acl.json"));
    expect(context.store.get("logFile")).toBe(path.join(configDir, "logs"));
    expect(context.store.get("tlsKey")).toBe(path.join(configDir, "keys/server.key"));
    expect(context.store.get("tlsCert")).toBe(path.join(configDir, "keys/server.crt"));
    expect(context.store.get("upstreamCa")).toBe(path.join(configDir, "certs/upstream.pem"));
    expect(context.config.authUsersFile).toBe(context.store.get("authUsersFile"));
  });
});

describe("loadConfig 显式加载（库模式）", () => {
  it("按显式 env 解析并返回 store/accessor/context", async () => {
    await withTmpConfigDir(async (cwd) => {
      const store = new ConfigStore();
      const context = await loadConfig({
        env: {
          PORT: "18099",
          HOST: "127.0.0.5",
          PROXY_PROTOCOL: "socks5",
          AUTH_ENABLED: "false",
        },
        envFiles: [],
        argv: [],
        cwd,
        store,
        skipFileValidation: true,
      });
      expect(context.store).toBe(store);
      expect(context.accessor.get("port")).toBe(18099);
      expect(context.accessor.get("proxyProtocol")).toBe("socks5");
      expect(context.config.host).toBe("127.0.0.5");
    });
  });

  it("不传 store 时新建实例，未提供的键回退 defaults", async () => {
    await withTmpConfigDir(async (cwd) => {
      const context = await loadConfig({
        env: { AUTH_ENABLED: "false" },
        envFiles: [],
        argv: [],
        cwd,
        skipFileValidation: true,
      });
      expect(context.store).toBeInstanceOf(ConfigStore);
      expect(context.store.get("port")).toBe(defaults.port);
    });
  });

  it("路径字段按最终 configDir 解析，context 暴露启动相位", async () => {
    await withTmpConfigDir(async (cwd) => {
      const context = await loadConfig({
        env: { AUTH_ENABLED: "false" },
        envFiles: [],
        argv: [],
        cwd,
        skipFileValidation: true,
      });
      expect(context.configDir).toBe(cwd);
      expect(context.store.get("authUsersFile")).toBe(path.join(cwd, "cfg", "users.json"));
      expect(context.store.get("aclFile")).toBe(path.join(cwd, "cfg", "acl.json"));
      expect(context.store.get("logFile")).toBe(path.join(cwd, "log"));
      expect(context.startupKeys).toContain("port");
      expect(context.startupKeys).not.toContain("logLevel");
    });
  });

  it("CLI 优先于 env，env 文件按顺序参与合并且不改宿主", async () => {
    await withTmpConfigDir(async (cwd) => {
      await writeFile(path.join(cwd, ".env.one"), "PORT=17001\nLOG_LEVEL=warn\n", "utf8");
      await writeFile(path.join(cwd, ".env.two"), "PORT=17002\n", "utf8");
      const before = { ...process.env };
      const store = new ConfigStore();
      const context = await loadConfig({
        env: { PORT: "18099", AUTH_ENABLED: "false" },
        envFiles: [".env.one", ".env.two"],
        argv: ["--port=18100"],
        cwd,
        store,
        skipFileValidation: true,
      });
      expect(context.store.get("port")).toBe(18100);
      expect(context.store.get("logLevel")).toBe("warn");
      expect({ ...process.env }).toEqual(before);
    });
  });

  it("失败时不半写 store", async () => {
    await withTmpConfigDir(async (cwd) => {
      const store = new ConfigStore({ port: 18300, host: "127.0.0.8" });
      await expect(
        loadConfig({
          env: { PORT: "70000", AUTH_ENABLED: "false" },
          envFiles: [],
          argv: [],
          cwd,
          store,
          skipFileValidation: true,
        }),
      ).rejects.toThrow(/PORT=70000 越界/);
      expect(store.get("port")).toBe(18300);
      expect(store.get("host")).toBe("127.0.0.8");
    });
  });
});
