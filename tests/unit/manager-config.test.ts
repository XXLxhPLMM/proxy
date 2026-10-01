/**
 * 管理面（控制面）四个配置项：字段契约 + 两条 fail-closed 交叉校验 + 启动快照脱敏 + 未知键闸门
 *
 * @description
 * 这个面能改配置、重启进程、增删账号 —— 等价于主机上的 root shell。「它存在时必须是安全的」
 * 由**配置层自己**保证（fail-closed），不留给将来那个 HTTP 面去兜：等 HTTP 面写出来再补校验，
 * 中间那段时间里 `MANAGER_ENABLED=true` + 空 token 就是一扇没锁的门。
 *
 * ## ① 四行 `FIELDS` 契约，且**全部 startup 相位**
 * 否掉的是「标 runtime 让热改生效」——启动期读一次之后就再没有读取点，热改一个没人读的键
 * 只会给出「改了却什么都没发生」的错觉。锁点：`keysByPhase().startup` 逐个含四键、`.runtime`
 * 一个都不含；标成 runtime 两行当场红。
 *
 * ## ② 两个 listener 抢同一个端口 → 启动期 abort，且**不看 `managerEnabled`**
 * 否则那次 EADDRINUSE 发生在数据面已经在服务之后，运维看到的是一次运行期崩溃而不是一条配置
 * 错误；而藏到启用那天再炸，他会归因成「我今天开了个开关结果进程起不来」。
 * 锁点：`PORT=3010 MANAGER_PORT=3010` reject，且报文字面含两个键名与「改成别的空闲端口」。
 *
 * ## ③ `managerEnabled=true` + 空 token → 启动期 abort，文案给出修法
 * 空 token = 任何能连上该端口的人都是管理员。锁点：报文字面含 `MANAGER_TOKEN` 与
 * 「随机串」两个提示，**缺一即红**——只说「token 不能为空」等于让运维去猜该填什么。
 *
 * ## ④ 越界 / 非法值一律 abort，**且不因 `managerEnabled=false` 而放过**
 * 与 ② 同一判据：错配就该在启动期暴露，把「配错了」藏到启用那天是最坏的时机。
 * 锁点：`MANAGER_ENABLED` 缺席（=false）时 `MANAGER_PORT=0 / 70000 / abc` 三格仍各自 reject。
 *
 * ## ⑤ 两个缺省值不得互相撞车（判据不看 enabled ⇒ 相等的缺省会让**每次**启动都失败）
 * 这是 ② 的默认档：把 `defaults.managerPort` 改成 `defaults.port` 那一行会让整个仓库起不来，
 * 而任何「只测了显式配置」的用例都不会红。锁点：`expect(defaults.managerPort).not.toBe(defaults.port)`。
 *
 * ## ⑥ 启动快照里的 token 是 `***`，明文**一个字都不许**落到日志
 * `logConfig` 整份打印配置快照（`debug` 档进 JSONL 落盘），而日志的读者面远大于能读 `.env`
 * 的人。锁点走真实 logger 落盘：那条 `=== config ===` 记录里 `managerToken === "***"`，
 * 且全部落盘行的原文都不含明文——**只断言前者的话，把掩码改成 `""`（等于不脱敏）也能过**。
 *
 * ## ⑦ 拼错的 `MANAGER_ENABELD` 必须让启动失败并给建议
 * 这是「新增四个键之后闸门还认得它们」的正面证据：四个键一旦进了 `FIELDS`，未知键闸门会把
 * **真名**放行、**错名**拦下。锁点：argv 与 env 文件两个来源都 reject，报错逐字含错名与
 * 「最接近的合法键是 MANAGER_ENABLED」。
 *
 * ## ⑧ `useHomeConfig` 不放宽管理面监听地址
 * 它换的是「配置目录在哪」，不是「谁能连上来」；让一个改路径的开关顺带把控制面推到
 * `0.0.0.0` 是把两件无关的事绑在一根线上。锁点：`--use-home-config` 加载后 `managerHost`
 * 仍是 `127.0.0.1`。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigStore,
  FIELDS,
  defaults,
  keysByPhase,
  loadConfig,
  type ConfigContext,
  type ConfigKey,
} from "@/config/index.js";
import { assertManagerConfig } from "@/config/schema/index.js";
import { logConfig } from "@/server/log/config-log.js";
import { createLogger } from "@/utils/logger/index.js";

const TOKEN = "mgr-plaintext-canary-8f3a";

/** 取 FIELDS 里某个 key 的整行（不存在直接失败：契约变了必须显式改测试）。 */
function fieldOf(key: ConfigKey) {
  const found = FIELDS.find((f) => f.key === key);
  if (found === undefined) {
    throw new Error(`FIELDS 里没有 ${key}：新增配置项必须同时加 AppConfig + defaults + FIELDS 三处`);
  }
  return found;
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manager-config-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 只经 `loadConfig` 这一个入口；skipFileValidation 避开启动期 JSON 强校验（与本档判据无关）。 */
function load(cwd: string, options: { env?: Record<string, string>; argv?: string[] } = {}) {
  return loadConfig({
    env: options.env ?? {},
    envFiles: [],
    argv: options.argv ?? [],
    cwd,
    skipFileValidation: true,
  });
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "这一步必须让启动失败").toBeInstanceOf(Error);
  return (thrown as Error).message;
}

/**
 * 跑一次真实 `logConfig` 并读回落盘的 JSONL 记录。
 * 控制台静音（level=silent）、落盘放行到 debug —— 断言的是**日志文件里真实写了什么**，
 * 而不是内存里某个中间对象。
 */
async function logConfigRecords(context: ConfigContext): Promise<{ records: Record<string, unknown>[]; raw: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manager-config-log-"));
  try {
    const logger = createLogger({ file: dir, level: "silent", fileLevel: "debug" });
    logConfig(context, logger);
    await logger.flush();
    const names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
    const raw = (
      await Promise.all(names.map(async (n) => readFile(path.join(dir, n), "utf8")))
    ).join("");
    const records = raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { records, raw };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

describe("端口撞车：两个 listener 抢同一个端口 → 启动期 abort（不看 managerEnabled）", () => {
  it("PORT 与 MANAGER_PORT 相等即 reject，报错点名两个键并给出修法", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(
        load(cwd, { env: { PORT: "3010", MANAGER_PORT: "3010" } }),
      );
      expect(message).toMatch(/^配置校验失败:/);
      expect(message).toContain("MANAGER_PORT=3010");
      expect(message).toContain("PORT=3010");
      expect(message).toContain("EADDRINUSE");
      expect(message).toContain("空闲端口");
    });
  });

  it("managerEnabled=false 时撞车照样 abort（把错配藏到启用那天只会更难查）", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(
        load(cwd, { env: { PORT: "3010", MANAGER_PORT: "3010", MANAGER_ENABLED: "false" } }),
      );
      expect(message).toContain("MANAGER_PORT=3010");
    });
  });

  it("两端口不同时正常加载（正向对照组：判据不是「永远报错」）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, {
        env: { PORT: "3000", MANAGER_PORT: "3010", MANAGER_ENABLED: "true", MANAGER_TOKEN: TOKEN },
      });
      expect(store.get("managerPort")).toBe(3010);
      expect(store.get("port")).toBe(3000);
    });
  });

  it("两个 0 不算冲突（listen(0) 的「由系统分配」语义：绕开 loadConfig 的 library 调用方能拿到 0）", () => {
    expect(() =>
      assertManagerConfig({ port: 0, managerEnabled: false, managerPort: 0, managerToken: "", managerCorsOrigins: "" }),
    ).not.toThrow();
    // 0 与非 0 同理：只有「两个非 0 且相等」才是撞车
    expect(() =>
      assertManagerConfig({ port: 0, managerEnabled: false, managerPort: 3010, managerToken: "", managerCorsOrigins: "" }),
    ).not.toThrow();
  });
});

/**
 * 跨源白名单的**启动期**语法判据
 * @description 锁的是「不 fail-fast 的代价」：一个永不命中的白名单与「没配」在浏览器那侧的
 * 症状**完全一样**（一句 `CORS policy`），运维没有任何线索指向那个环境变量。故这一档必须是
 * 启动中止，而不是静默忽略。
 *
 * ⚠️ 判据**只有这一份**，在 `src/config/schema/validate.ts`（`CORS_ORIGINS_SHAPE`）。
 * 运行期的 `parseCorsPolicy` 不重复语法校验——它天然 fail-closed（垃圾条目匹配不上任何真实
 * origin，见 `manager-http.test.ts` 的「白名单里是一条垃圾串时天然 fail-closed」）。
 */
describe("MANAGER_CORS_ORIGINS：语法非法即启动期 abort（判据不看 enabled）", () => {
  /** 通过校验的基准组合（端口错开、token 非空） */
  const ok = {
    port: 3000,
    managerEnabled: true,
    managerPort: 3010,
    managerToken: TOKEN,
  };

  it("逐条非法形态全部 abort，且报错逐字点名那个键", () => {
    const bad = [
      "*",                                  // 通配：等于对任意网页开放
      "null",                               // file:// 与 sandbox iframe 的 origin
      "http://a.com/",                      // 尾斜杠：URL 规范化会去掉它，于是永不命中
      "http://a.com/panel",                 // 带路径：origin 压根没有路径这一段
      "http://u:pw@a.com",                  // 带凭据
      "file:///srv/gui/index.html",          // 本地文件
      "ws://a.com",                         // 非 http(s) scheme
      "http://a.com:99999",                 // 端口越界
      "http://a.com:0",                     // 端口 0 不是 origin 的合法端口
      "http://a.com:08080",                 // 前导零：URL 规范化成 8080，于是永不命中
      "http://a.example,http://b.example/", // 列表里混进一条非法的
      "a.com",                              // 缺 scheme
      "://a.com",
    ];
    for (const value of bad) {
      expect(
        () => assertManagerConfig({ ...ok, managerCorsOrigins: value }),
        `MANAGER_CORS_ORIGINS=${JSON.stringify(value)} 应当 abort`,
      ).toThrow(/MANAGER_CORS_ORIGINS/);
    }
  });

  it("⚠️ 判据**不看** `managerEnabled`（藏着它 = 开关打开那天才炸，运维会归因成「我今天开了个开关」）", () => {
    expect(() =>
      assertManagerConfig({ ...ok, managerEnabled: false, managerCorsOrigins: "*" }),
    ).toThrow(/MANAGER_CORS_ORIGINS/);
  });

  it("合法形态放行：空 / 单条 / 多条 / 逗号周围带空白 / 大小写混写 / IPv6 / 端口边界", () => {
    const good = [
      "",                                    // 缺省 = 不放行（合法）
      "   ",
      "http://127.0.0.1:5173",
      "https://ops.example.com",
      "http://a.com:1",                     // 端口下界
      "http://a.com:65535",                 // 端口上界
      "http://a.com,https://b.com",
      " http://a.com , https://b.com ",     // 空白容忍（startup 与运行期各切一次、trim 一次）
      "HTTP://A.Example",                   // origin 没有大小写敏感的成分（RFC 6454）
      "http://[::1]:5173",                  // IPv6 字面量
    ];
    for (const value of good) {
      expect(
        () => assertManagerConfig({ ...ok, managerCorsOrigins: value }),
        `MANAGER_CORS_ORIGINS=${JSON.stringify(value)} 应当放行`,
      ).not.toThrow();
    }
  });

  it("报错逐字给出修法与一条可抄的示例（「不能为空/不合法」等于让运维猜）", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(
        load(cwd, { env: { MANAGER_CORS_ORIGINS: "*" } }),
      );
      expect(message).toContain("MANAGER_CORS_ORIGINS");
      expect(message).toContain("MANAGER_CORS_ORIGINS=http://127.0.0.1:5173,https://ops.example.com");
      // 三条最容易被踩的形态各自点名（不是一句「格式不对」）
      expect(message).toContain("*");
      expect(message).toContain("null");
      expect(message).toContain("http://a.com/");
    });
  });

  it("通过 loadConfig 时合法值逐字落到 store（运行期拿到的就是运维写的那串）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, {
        env: { MANAGER_CORS_ORIGINS: "http://127.0.0.1:5173, https://ops.example.com" },
      });
      expect(store.get("managerCorsOrigins")).toBe("http://127.0.0.1:5173, https://ops.example.com");
    });
  });
});

describe("空 token：MANAGER_ENABLED=true 且没有 token → 启动期 abort", () => {
  it("reject 且报文字面给出 `MANAGER_TOKEN=<随机串>` 这个修法", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(load(cwd, { env: { MANAGER_ENABLED: "true" } }));
      expect(message).toMatch(/^配置校验失败:/);
      expect(message).toContain("MANAGER_ENABLED=true");
      expect(message).toContain("MANAGER_TOKEN");
      // 只说「不能为空」等于让运维去猜填什么：修法必须逐字在报错里
      expect(message).toContain("MANAGER_TOKEN=<随机串>");
      expect(message).toContain("MANAGER_ENABLED=false");
    });
  });

  it("显式写成空串同样被拒（`MANAGER_TOKEN=` 与「不配」在配置里是同一个事实）", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(
        load(cwd, { env: { MANAGER_ENABLED: "true", MANAGER_TOKEN: "" } }),
      );
      expect(message).toContain("MANAGER_TOKEN 为空");
    });
  });

  it("给了 token 就放行（正向对照组：判据不是「开启即失败」）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, {
        env: { MANAGER_ENABLED: "true", MANAGER_TOKEN: TOKEN },
      });
      expect(store.get("managerEnabled")).toBe(true);
      expect(store.get("managerToken")).toBe(TOKEN);
    });
  });

  it("关着时 token 为空合法（默认形态必须能加载出来）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, { env: { MANAGER_ENABLED: "false" } });
      expect(store.get("managerToken")).toBe("");
    });
  });

  it("纯函数档逐条覆盖：撞车与空 token 是两条独立判据，谁先命中都不放行", () => {
    const ok = {
      port: 3000,
      managerEnabled: true,
      managerPort: 3010,
      managerToken: TOKEN,
      managerCorsOrigins: "",
    };
    expect(() => assertManagerConfig(ok)).not.toThrow();
    expect(() => assertManagerConfig({ ...ok, managerPort: 3000 })).toThrow(/MANAGER_PORT=3000/);
    expect(() => assertManagerConfig({ ...ok, managerToken: "" })).toThrow(/MANAGER_TOKEN 为空/);
  });
});

describe("MANAGER_PORT 越界 / 非法：即使 managerEnabled=false 也 abort", () => {
  it("0 / 70000 越界即 reject（0 是 listen(0) 的系统分配语义，不是可写进配置的取值）", async () => {
    await withTmpDir(async (cwd) => {
      for (const raw of ["0", "70000"]) {
        const message = await rejectionMessage(load(cwd, { env: { MANAGER_PORT: raw } }));
        expect(message, `MANAGER_PORT=${raw} 应当被拒`).toContain(`MANAGER_PORT=${raw} 越界`);
      }
    });
  });

  it("非数字 / 小数 → 解析失败即 abort（不静默回落缺省 3010）", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(load(cwd, { env: { MANAGER_PORT: "abc" } }));
      expect(message).toContain("MANAGER_PORT=abc");
      await expect(load(cwd, { env: { MANAGER_PORT: "1.5" } })).rejects.toThrow(/MANAGER_PORT=1\.5/);
    });
  });

  it("两端合法值认（1 与 65535）", async () => {
    await withTmpDir(async (cwd) => {
      expect((await load(cwd, { env: { MANAGER_PORT: "1" } })).store.get("managerPort")).toBe(1);
      expect((await load(cwd, { env: { MANAGER_PORT: "65535" } })).store.get("managerPort")).toBe(65535);
    });
  });

  it("非法值不半写 store（既有原子落库契约：失败不留半份配置）", async () => {
    await withTmpDir(async (cwd) => {
      const store = new ConfigStore({ port: 18100 });
      await expect(
        loadConfig({
          env: { MANAGER_PORT: "70000" },
          envFiles: [],
          argv: [],
          cwd,
          store,
          skipFileValidation: true,
        }),
      ).rejects.toThrow(/MANAGER_PORT=70000 越界/);
      expect(store.get("managerPort")).toBe(defaults.managerPort);
      expect(store.get("port")).toBe(18100);
    });
  });
});

describe("启动快照脱敏：logConfig 落盘里 token 是 ***，明文一个字都不许出现", () => {
  it("=== config === 那条记录里 managerToken 是 ***，且全部落盘行不含明文", async () => {
    await withTmpDir(async (cwd) => {
      const context = await load(cwd, {
        env: { MANAGER_ENABLED: "true", MANAGER_TOKEN: TOKEN },
      });
      const { records, raw } = await logConfigRecords(context);

      const snapshot = records.find((r) => r.msg === "=== config ===");
      expect(snapshot, "logConfig 必须真的打印了配置快照").toBeDefined();
      expect(snapshot?.managerToken).toBe("***");
      // 明文泄漏检查覆盖**整份落盘**：只看上面那个字段的话，把掩码改成 ""（等于不脱敏）也能过
      expect(raw).not.toContain(TOKEN);
      // 对照组：同一份快照里的非密字段照常打印（否则「什么都没打」也能满足上面两条）
      expect(snapshot?.managerEnabled).toBe(true);
      expect(snapshot?.managerPort).toBe(3010);
    });
  });

  it("token 为空时那一项仍是空串（不打码成 ***，否则「没配」与「配了」在快照里长得一样）", async () => {
    await withTmpDir(async (cwd) => {
      const context = await load(cwd);
      const { records } = await logConfigRecords(context);
      const snapshot = records.find((r) => r.msg === "=== config ===");
      expect(snapshot?.managerToken).toBe("");
      // 对照组：真的配了非空 token 时那一项就不是空串（否则上一条恒真）
      const filled = await loadConfig({
        env: { MANAGER_ENABLED: "true", MANAGER_TOKEN: TOKEN },
        envFiles: [],
        argv: [],
        cwd,
        skipFileValidation: true,
      });
      const filledRecords = await logConfigRecords(filled);
      expect(filledRecords.records.find((r) => r.msg === "=== config ===")?.managerToken).toBe("***");
    });
  });

  it("脱敏与 jwtSecret 同档（两组 secret 都打码，快照里没有任何一档明文）", async () => {
    await withTmpDir(async (cwd) => {
      const context = await load(cwd, {
        env: {
          MANAGER_ENABLED: "true",
          MANAGER_TOKEN: TOKEN,
          JWT_SECRET: "jwt-plaintext-canary",
          TLS_PASSPHRASE: "passphrase-canary",
        },
      });
      const { raw } = await logConfigRecords(context);
      expect(raw).not.toContain("jwt-plaintext-canary");
      expect(raw).not.toContain("passphrase-canary");
    });
  });
});

describe("未知键闸门：拼错的 MANAGER_ENABELD 必须让启动失败", () => {
  it("argv 里的错名 reject，并逐字点名错名与最接近的合法键", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(load(cwd, { argv: ["MANAGER_ENABELD=1"] }));
      expect(message).toMatch(/^配置校验失败:/);
      expect(message).toContain("MANAGER_ENABELD");
      expect(message).toContain("最接近的合法键是 MANAGER_ENABLED");
    });
  });

  it("env 文件里的错名同样 reject（闸门管的是两个「显式用户意图」来源）", async () => {
    await withTmpDir(async (cwd) => {
      const file = path.join(cwd, "one.env");
      await writeFile(file, "MANAGER_ENABELD=1\n", "utf8");
      const message = await rejectionMessage(
        loadConfig({
          env: {},
          envFiles: [file],
          argv: [],
          cwd,
          skipFileValidation: true,
        }),
      );
      expect(message).toContain("MANAGER_ENABELD");
      expect(message).toContain(file);
    });
  });

  it("真名在 argv / env 文件两个来源都不报错（闸门不是「拒绝一切」的反面）", async () => {
    await withTmpDir(async (cwd) => {
      await expect(load(cwd, { argv: ["MANAGER_ENABLED=false"] })).resolves.toBeDefined();
      const file = path.join(cwd, "ok.env");
      await writeFile(file, "MANAGER_ENABLED=false\nMANAGER_PORT=3010\n", "utf8");
      await expect(
        loadConfig({ env: {}, envFiles: [file], argv: [], cwd, skipFileValidation: true }),
      ).resolves.toBeDefined();
    });
  });
});

describe("useHomeConfig 不放宽管理面监听地址", () => {
  it("--use-home-config 下 managerHost 仍是 127.0.0.1（它换的是配置目录，不是谁能连上来）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, { argv: ["--use-home-config"] });
      expect(store.get("useHomeConfig")).toBe(true);
      expect(store.get("managerHost")).toBe("127.0.0.1");
      // 对照组：确实能显式改宽（拦它等于把一种合法部署写死成不可表达）
      const widened = await load(cwd, {
        env: { MANAGER_HOST: "0.0.0.0", MANAGER_ENABLED: "true", MANAGER_TOKEN: TOKEN },
      });
      expect(widened.store.get("managerHost")).toBe("0.0.0.0");
    });
  });
});
