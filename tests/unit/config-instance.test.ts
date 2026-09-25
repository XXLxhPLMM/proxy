import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ConfigStore, config, defaultConfigStore, defaults, get } from "@/config/store.js";
import type { ConfigChangeListener, ConfigKey } from "@/config/store.js";

/**
 * 实例化配置（库模式）回归护栏
 *
 * 背景：本仓库正在被改造成第三方库，配置需要「可实例化」——库调用方要能自己决定
 * 配置从哪来、落到哪去，且**不污染**宿主进程与全局单例。本文件覆盖两条新增能力：
 * - `store.ts:ConfigStore`：每实例一份 Map，与全局 `config` 单例彻底隔离
 * - `loader.ts:loadConfig`：显式 env/argv/cwd/store 装填，非法值照旧抛错
 *
 * loader 在 import 时执行 initConfig()（全局单例通道），故按 config-loader.test.ts
 * 的同款做法动态 import；tests/setup-env.ts 已把 AUTH_ENABLED / ACL_FILE /
 * AUTH_USERS_FILE / LOG_FILE 钉成安全值，initConfig 不会因仓库 .env.development abort。
 * 真正的隔离断言都拿「调用前/调用后」对比，不依赖任何绝对默认值。
 */
let loader!: typeof import("@/config/loader.js");

/**
 * 每个用例一份独立临时配置目录
 * @description 目录里既没有 .env.* 也没有 cfg/*.json，用例之间零顺序依赖，
 * 更不会读到仓库开发者的 .env.development / cfg/*.json
 */
function withTmpConfigDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-loadconfig-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  loader = await import("@/config/loader.js");
});

describe("ConfigStore 实例化", () => {
  it("缺省构造读到的就是 defaults（与全局单例同一起点）", () => {
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

  it("两个实例互不影响（不再有全局共享）", () => {
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

  it("实例写入不回流到全局单例 Map（库模式多份配置并存的前提）", () => {
    const prevGlobal = get("port");
    const store = new ConfigStore();
    store.set("port", 19999);
    store.merge({ host: "127.0.0.9" });
    expect(get("port")).toBe(prevGlobal);
    expect(config.get("host")).toBe(get("host"));
  });

  it("getAll 返回拷贝：外部 mutate 不影响 store", () => {
    const store = new ConfigStore();
    const snap = store.getAll();
    snap.port = 7777;
    snap.authEnabled = true;
    expect(store.get("port")).toBe(defaults.port);
    expect(store.get("authEnabled")).toBe(defaults.authEnabled);
    // 两次调用返回不同对象：不存在「把内部 Map 直接交出去」的漏口
    expect(store.getAll()).not.toBe(snap);
    expect(store.getAll()).toEqual(defaults);
  });

  it("merge 返回实际变更的键：写同值 / undefined 一律不算变更", () => {
    const store = new ConfigStore();
    expect(store.merge({ port: defaults.port })).toEqual([]);
    expect(store.merge({})).toEqual([]);
    // undefined = 显式「未提供」，保留现值
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
      // changed 是只读视图，落断言前拷成普通数组
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

  it("defaultConfigStore 是独立实例，与全局单例无共享", () => {
    expect(defaultConfigStore).toBeInstanceOf(ConfigStore);
    const prevPort = defaultConfigStore.get("port");
    const prevGlobal = get("port");
    defaultConfigStore.set("port", 18086);
    expect(defaultConfigStore.get("port")).toBe(18086);
    expect(get("port")).toBe(prevGlobal);
    defaultConfigStore.set("port", prevPort);
  });
});

describe("loadConfig 显式加载（库模式）", () => {
  it("按显式 env 解析出值，落进目标 store", () => {
    withTmpConfigDir((cwd) => {
      const store = new ConfigStore();
      const loaded = loader.loadConfig({
        env: {
          PORT: "18099",
          HOST: "127.0.0.5",
          PROXY_PROTOCOL: "socks5",
          AUTH_ENABLED: "false",
        },
        argv: [],
        cwd,
        writeProcessEnv: false,
        store,
      });
      expect(loaded.store).toBe(store);
      expect(store.get("port")).toBe(18099);
      expect(store.get("host")).toBe("127.0.0.5");
      expect(store.get("proxyProtocol")).toBe("socks5");
      // 缺省 env 源的字段回退 defaults
      expect(store.get("logLevel")).toBe(defaults.logLevel);
    });
  });

  it("不传 store 时新建一个实例；未提供的键回退 defaults", () => {
    withTmpConfigDir((cwd) => {
      const loaded = loader.loadConfig({
        env: { AUTH_ENABLED: "false" },
        argv: [],
        cwd,
        writeProcessEnv: false,
      });
      expect(loaded.store).toBeInstanceOf(ConfigStore);
      expect(loaded.store.get("port")).toBe(defaults.port);
    });
  });

  it("CLI 优先于 env（同一张 FIELDS 表解析）", () => {
    withTmpConfigDir((cwd) => {
      const store = new ConfigStore();
      loader.loadConfig({
        env: { PORT: "18099", AUTH_ENABLED: "false" },
        argv: ["--port", "18100", "--log-level=debug"],
        cwd,
        writeProcessEnv: false,
        store,
      });
      expect(store.get("port")).toBe(18100);
      expect(store.get("logLevel")).toBe("debug");
    });
  });

  it("路径类字段按 configDir 解析成绝对路径，configDir 与启动相位键随返回", () => {
    withTmpConfigDir((cwd) => {
      const loaded = loader.loadConfig({
        env: { AUTH_ENABLED: "false" },
        argv: [],
        cwd,
        writeProcessEnv: false,
      });
      expect(loaded.configDir).toBe(cwd);
      expect(loaded.store.get("authUsersFile")).toBe(path.join(cwd, "cfg", "users.json"));
      expect(loaded.store.get("aclFile")).toBe(path.join(cwd, "cfg", "acl.json"));
      expect(loaded.store.get("logFile")).toBe(path.join(cwd, "log"));
      expect(loaded.startupKeys).toEqual(loader.keysByPhase().startup);
      expect(loaded.startupKeys).toContain("port");
      expect(loaded.startupKeys).toContain("proxyProtocol");
      // runtime 键不在启动相位清单里
      expect(loaded.startupKeys).not.toContain("logLevel");
    });
  });

  it("writeProcessEnv:false 时 env 文件参与解析但绝不写回 process.env", () => {
    withTmpConfigDir((cwd) => {
      // 低 -> 高：.env.production 先读、.env.development 覆盖同名键
      fs.writeFileSync(path.join(cwd, ".env.production"), "PORT=17001\nLOG_LEVEL=warn\n", "utf8");
      fs.writeFileSync(path.join(cwd, ".env.development"), "PORT=17002\n", "utf8");
      const envBefore = { ...process.env };

      // env 源 > env 文件：显式 env 里给了 PORT，文件里的 17002 不生效
      const store = new ConfigStore();
      loader.loadConfig({
        env: { PORT: "18099", AUTH_ENABLED: "false" },
        argv: [],
        cwd,
        writeProcessEnv: false,
        store,
      });
      expect(store.get("port")).toBe(18099);
      // 文件之间仍是低 -> 高覆盖（.env.production 独有的键保留）
      expect(store.get("logLevel")).toBe("warn");

      // 换成空 env 源：值全部来自 env 文件
      const fromFiles = loader.loadConfig({ env: {}, argv: [], cwd, writeProcessEnv: false });
      expect(fromFiles.store.get("port")).toBe(17002);
      expect(fromFiles.store.get("logLevel")).toBe("warn");

      // 关键护栏：整个过程 process.env 一个字节都没动
      expect({ ...process.env }).toEqual(envBefore);
      expect(process.env.PORT).toBe(envBefore.PORT);
      expect(process.env.LOG_LEVEL).toBe(envBefore.LOG_LEVEL);
    });
  });

  it("loadConfig 不污染全局单例（get() 读到的是 CLI 那份配置）", () => {
    withTmpConfigDir((cwd) => {
      const snapshot = () => ({
        port: get("port"),
        host: get("host"),
        logLevel: get("logLevel"),
        logFileLevel: get("logFileLevel"),
        authUsersFile: get("authUsersFile"),
      });
      const globalBefore = snapshot();
      const store = new ConfigStore();
      loader.loadConfig({
        env: {
          PORT: "18200",
          HOST: "127.0.0.6",
          LOG_LEVEL: "debug",
          LOG_FILE_LEVEL: "error",
          AUTH_ENABLED: "false",
        },
        argv: [],
        cwd,
        writeProcessEnv: false,
        store,
      });
      expect(store.get("port")).toBe(18200);
      expect(store.get("logLevel")).toBe("debug");
      // 全局单例逐项原样：既没被 loadConfig 写，也没被实例写
      expect(snapshot()).toEqual(globalBefore);
    });
  });

  it("skipFileValidation:true 时完全不碰 users.json / acl.json", () => {
    withTmpConfigDir((cwd) => {
      // 鉴权开启 + basic 却指向不存在的账号表：默认会 fail-fast 抛错，跳过校验则放行
      const args = {
        env: {
          AUTH_ENABLED: "true",
          AUTH_TYPE: "basic",
          AUTH_USERS_FILE: path.join(cwd, "nope-users.json"),
          ACL_FILE: path.join(cwd, "nope-acl.json"),
        },
        argv: [],
        cwd,
        writeProcessEnv: false,
      };
      expect(() => loader.loadConfig(args)).toThrow(/配置校验失败/);
      const loaded = loader.loadConfig({ ...args, skipFileValidation: true });
      expect(loaded.store.get("authEnabled")).toBe(true);
      expect(loaded.store.get("authUsersFile")).toBe(path.join(cwd, "nope-users.json"));
    });
  });
});

describe("loadConfig 非法值仍抛错（绝不静默回退默认值）", () => {
  it("int 越界与布尔拼写错误都抛错，错误信息与 initConfig 同风格", () => {
    withTmpConfigDir((cwd) => {
      expect(() =>
        loader.loadConfig({
          env: { PORT: "70000", AUTH_ENABLED: "false" },
          argv: [],
          cwd,
          writeProcessEnv: false,
        }),
      ).toThrow(/配置校验失败: PORT=70000 越界/);
      expect(() =>
        loader.loadConfig({
          env: { PORT: "0", AUTH_ENABLED: "false" },
          argv: [],
          cwd,
          writeProcessEnv: false,
        }),
      ).toThrow(/PORT=0 越界/);
      expect(() =>
        loader.loadConfig({
          env: { AUTH_ENABLED: "treu" },
          argv: [],
          cwd,
          writeProcessEnv: false,
        }),
      ).toThrow(/AUTH_ENABLED=treu/);
      expect(() =>
        loader.loadConfig({
          env: { PROXY_PROTOCOL: "banana", AUTH_ENABLED: "false" },
          argv: [],
          cwd,
          writeProcessEnv: false,
        }),
      ).toThrow(/配置校验失败/);
    });
  });

  it("users.json / acl.json 内容非法即抛错，且失败不留半份配置", () => {
    withTmpConfigDir((cwd) => {
      fs.mkdirSync(path.join(cwd, "cfg"), { recursive: true });
      const badUsers = path.join(cwd, "cfg", "users.json");
      const badAcl = path.join(cwd, "cfg", "acl.json");
      // users.json 出现未知键 user（应为 username）
      fs.writeFileSync(badUsers, JSON.stringify([{ user: "alice", password: "pw" }]), "utf8");
      // acl.json 的 clientIp 只收 IP/CIDR，域名属配置错误
      fs.writeFileSync(badAcl, JSON.stringify({ clientIp: { whitelist: ["not-an-ip"] } }), "utf8");
      expect(() =>
        loader.loadConfig({
          env: { AUTH_ENABLED: "false" },
          argv: [],
          cwd,
          writeProcessEnv: false,
        }),
      ).toThrow(/AUTH_USERS_FILE=/);
      // users.json 合法后剩下 ACL 报错：两处校验的报错口径互不吞掉
      fs.writeFileSync(badUsers, JSON.stringify([{ username: "alice", password: "pw" }]), "utf8");
      expect(() =>
        loader.loadConfig({
          env: { AUTH_ENABLED: "false" },
          argv: [],
          cwd,
          writeProcessEnv: false,
        }),
      ).toThrow(/ACL_FILE=/);
      // 校验没过就不落库：目标 store 仍是 defaults，绝不留下半份配置
      const store = new ConfigStore();
      expect(() =>
        loader.loadConfig({
          env: { PORT: "18300", AUTH_ENABLED: "false" },
          argv: [],
          cwd,
          writeProcessEnv: false,
          store,
        }),
      ).toThrow(/ACL_FILE=/);
      expect(store.get("port")).toBe(defaults.port);
    });
  });

  it("auth 交叉非法抛错（开启 basic 但账号表为空）", () => {
    withTmpConfigDir((cwd) => {
      expect(() =>
        loader.loadConfig({
          env: {
            AUTH_ENABLED: "true",
            AUTH_TYPE: "basic",
            // 两个文件都指向不存在的路径：账号表=空表、ACL=空名单，只让 auth 交叉校验这一项爆
            AUTH_USERS_FILE: path.join(cwd, "cfg", "empty-users.json"),
            ACL_FILE: path.join(cwd, "cfg", "empty-acl.json"),
          },
          argv: [],
          cwd,
          writeProcessEnv: false,
        }),
      ).toThrow(/账号表为空/);
    });
  });
});
