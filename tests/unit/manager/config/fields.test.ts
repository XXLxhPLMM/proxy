/**
 * 管理面五个配置键的 `FIELDS` 契约（env 名 / 整数范围 / 相位 / 五条缺省）与 env、argv 两个来源的解析
 *
 * @description
 * 目录级不变量（fail-closed 由配置层自己保证的取舍、判据不看 `managerEnabled` 的由来、
 * 正向对照组的纪律、缺省端口不得撞车为什么要单钉一条）归 `./AGENTS.md`，不复制进本文件。
 *
 * 牙齿：五键的 env 名逐个点名 · 全 `startup` 相位 · `managerPort` 整数范围与两条「刻意不给」的
 * 对照组 · 五条缺省值 · 不给 `MANAGER_*` 时读到的就是那套缺省 · env / argv 两个来源的解析
 * （kebab 与 `KEY=VALUE` 等价、含 `=` 的 token、argv 优先于 env）。
 */

import { describe, expect, it } from "vitest";
import { FIELDS, defaults, keysByPhase, type ConfigKey } from "@/config/index.js";
import { TOKEN, load, withTmpDir } from "./_manager-config.js";

/** 取 FIELDS 里某个 key 的整行（不存在直接失败：契约变了必须显式改测试）。 */
function fieldOf(key: ConfigKey) {
  const found = FIELDS.find((f) => f.key === key);
  if (found === undefined) {
    throw new Error(`FIELDS 里没有 ${key}：新增配置项必须同时加 AppConfig + defaults + FIELDS 三处`);
  }
  return found;
}

describe("管理面五键的 FIELDS 契约：键名、范围与全 startup 相位", () => {
  it("五行的 env 名与键名一一对应", () => {
    expect(fieldOf("managerEnabled").env).toBe("MANAGER_ENABLED");
    expect(fieldOf("managerHost").env).toBe("MANAGER_HOST");
    expect(fieldOf("managerPort").env).toBe("MANAGER_PORT");
    expect(fieldOf("managerToken").env).toBe("MANAGER_TOKEN");
    expect(fieldOf("managerCorsOrigins").env).toBe("MANAGER_CORS_ORIGINS");
  });

  it("五个键全是 startup：热改一个没有读取点的键只会给出「改了却什么都没发生」", () => {
    const { startup, runtime } = keysByPhase();
    for (const key of [
      "managerEnabled",
      "managerHost",
      "managerPort",
      "managerToken",
      "managerCorsOrigins",
    ] as const) {
      expect(startup, `${key} 必须落在 startup 档`).toContain(key);
      expect(runtime, `${key} 绝不能落在 runtime 档`).not.toContain(key);
      expect(fieldOf(key).phase).toBe("startup");
    }
  });

  it("managerPort 的整数范围与 port 同一档（1..65535）", () => {
    expect(fieldOf("managerPort").int).toEqual({ min: 1, max: 65535 });
    // managerHost 是**不拦**的：0.0.0.0 是合法部署选择，配置层不替运维做那个决定
    expect(fieldOf("managerHost").int).toBeUndefined();
    // managerToken 刻意不给 def（与 jwtSecret 同一档）：空串就是「没配」，由 validate 在启用时拦
    expect(fieldOf("managerToken").def).toBeUndefined();
    // 对照组：同文件里确有给 def 的字段，否则上面两条恒真
    expect(typeof fieldOf("aclFile").def).toBe("function");
  });

  it("缺省值：关着 / 只听本机 / 3010 / 空 token / 空白名单（= 一个 CORS 头都不发）", () => {
    expect(defaults.managerEnabled).toBe(false);
    expect(defaults.managerHost).toBe("127.0.0.1");
    expect(defaults.managerPort).toBe(3010);
    expect(defaults.managerToken).toBe("");
    expect(defaults.managerCorsOrigins).toBe("");
    // 缺省形态加载出来就是这套值（不显式给任何 MANAGER_* 也一样）
  });

  it("两个 listener 的缺省端口不得互相撞车（判据不看 enabled ⇒ 相等的缺省会让每次启动都失败）", async () => {
    expect(defaults.managerPort).not.toBe(defaults.port);
    await withTmpDir(async (cwd) => {
      await expect(load(cwd)).resolves.toBeDefined();
    });
  });

  it("不给 MANAGER_* 时读到的就是上面那套缺省", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd);
      expect(store.get("managerEnabled")).toBe(false);
      expect(store.get("managerHost")).toBe("127.0.0.1");
      expect(store.get("managerPort")).toBe(3010);
      expect(store.get("managerToken")).toBe("");
      expect(store.get("managerCorsOrigins")).toBe("");
    });
  });
});

describe("管理面四键的解析：env 与 argv 两个来源", () => {
  it("env 给出四键全部生效（布尔 / 字符串 / 整数 / 可含 '=' 的 token）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, {
        env: {
          MANAGER_ENABLED: "true",
          MANAGER_HOST: "0.0.0.0",
          MANAGER_PORT: "8443",
          MANAGER_TOKEN: "abc=def",
        },
      });
      expect(store.get("managerEnabled")).toBe(true);
      expect(store.get("managerHost")).toBe("0.0.0.0");
      expect(store.get("managerPort")).toBe(8443);
      // 值含 `=`：env 文件与 argv 的 KEY=VALUE 都只在第一个 `=` 处切分
      expect(store.get("managerToken")).toBe("abc=def");
    });
  });

  it("argv 的 kebab 写法与 KEY=VALUE 写法命中同一批键", async () => {
    await withTmpDir(async (cwd) => {
      const kebab = await load(cwd, {
        argv: [
          "--manager-enabled", "true",
          "--manager-host=0.0.0.0",
          "--manager-port", "8443",
          `--manager-token=${TOKEN}`,
        ],
      });
      expect(kebab.store.get("managerEnabled")).toBe(true);
      expect(kebab.store.get("managerHost")).toBe("0.0.0.0");
      expect(kebab.store.get("managerPort")).toBe(8443);
      expect(kebab.store.get("managerToken")).toBe(TOKEN);

      const upper = await load(cwd, {
        argv: [
          "MANAGER_ENABLED=true",
          "MANAGER_HOST=0.0.0.0",
          "MANAGER_PORT=8443",
          `MANAGER_TOKEN=${TOKEN}`,
        ],
      });
      expect(upper.store.getAll()).toEqual(kebab.store.getAll());
    });
  });

  it("argv 优先于 env（两个来源给同一个键时以 argv 为准）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, {
        env: { MANAGER_PORT: "1111", MANAGER_ENABLED: "true", MANAGER_TOKEN: TOKEN },
        argv: ["--manager-port=2222"],
      });
      expect(store.get("managerPort")).toBe(2222);
    });
  });
});