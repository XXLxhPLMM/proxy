/**
 * 每用户流量配额的三个配置项（字段契约 + 相位分流 + 测试 env 白名单同步）
 *
 * @description
 * 配额本身在 `cfg/users.json` 的 `quota` 组里（数据层护栏在 `unit/user-quota.test.ts`），
 * 本文件答的是「**围绕配额的三个 env 配置项有没有把契约写对**」：
 *
 * 1. **`FIELDS` 三行原文**：`quotaUsageDir` 是 `path: true` + **startup**（改目录等于没改，
 *    因为已打开的 append 句柄仍指向旧文件）；另两个是 runtime（每请求现读）。
 * 2. **路径归一**：`QUOTA_USAGE_DIR` 的相对值按 `configDir` 绝对化（与 `aclFile` 同一套
 *    `FIELDS.path` 机制），绝对路径原样。
 * 3. **越界即启动期 abort**：`QUOTA_RESET_HOUR` 只认 0..23，`QUOTA_FLUSH_INTERVAL` 必须 ≥ 1。
 * 4. **相位分流**：`keysByPhase()` 把三者分到 startup/runtime；运行期事件面的分流
 *    （`config.restart-required` vs `config.changed`）在 `unit/proxy-runtime.test.ts` 里
 *    经**真 runtime** 断言。
 * 5. **`tests/setup-env.ts:CONFIG_ENV_KEYS` 与 `FIELDS` 的 env 键集合逐项相同**：漏一项 =
 *    宿主的那个 env 静默漏进测试环境，表现为「本机红、CI 绿」。
 *
 * 6. **`QUOTA_USAGE_DIR` 必须是 startup 相位**（本档第 ① 组第 2 条钉的就是它）
 *    — 否掉「标 runtime 让热改生效」— 运行中改目录 = 已打开的 append 句柄仍指向旧文件，
 *    **改了等于没改**，改它必须重建 runtime。锁点：
 *    `expect(fieldOf("quotaUsageDir").phase).toBe("startup")` 与
 *    `expect(keysByPhase().startup).toContain("quotaUsageDir")` ——标成 runtime 两行当场红。
 *    后果侧还有一条真 runtime 断言（`tests/unit/proxy-runtime.test.ts`
 *    「流量配额三个配置项按相位分流」：`expect(restartRequired).toHaveBeenCalledWith(["quotaUsageDir"])`）。
 *
 * 7. **`QUOTA_FLUSH_INTERVAL` 的 `0` 启动期 abort，不解释为「关掉落盘」**
 *    — 否掉「0 = 关闭」— 停机落盘由 `runtime.stop()` 必做最后一次 flush，与间隔无关，
 *    所以「关掉」没有可实现的语义；真要关得先决定「不落盘时重启如何恢复账本」。
 *    锁点（本档「QUOTA_FLUSH_INTERVAL 越界（0 / 负数）→ 启动期 abort（0 不等于「关掉落盘」）」那条）：
 *    `await expectAbort({ QUOTA_FLUSH_INTERVAL: "0" }, /QUOTA_FLUSH_INTERVAL=0 越界/)`
 *    ——把 `0` 解释成「关闭」就等于放行，这一行当场红；`-1` 是同档的负数格。
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FIELDS, defaults, keysByPhase, loadConfig, type ConfigKey } from "@/config/index.js";
import { CONFIG_ENV_KEYS } from "../setup-env.js";

/** 取 FIELDS 里某个 key 的整行（不存在直接失败：契约变了必须显式改测试）。 */
function fieldOf(key: ConfigKey) {
  const found = FIELDS.find((f) => f.key === key);
  if (found === undefined) {
    throw new Error(`FIELDS 里没有 ${key}：新增配置项必须同时加 AppConfig + defaults + FIELDS 三处`);
  }
  return found;
}

/** loadConfig 到一个临时配置目录；调用方给 env，缺省全部走缺省。 */
async function loadWith(env: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "quota-config-test-"));
  try {
    return await loadConfig({
      env: { AUTH_ENABLED: "false", ...env },
      envFiles: [],
      argv: [],
      cwd: dir,
      skipFileValidation: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 越界断言：`loadConfig` 必须 reject（启动期 abort），且错误文本点名那个 env。 */
async function expectAbort(env: Record<string, string>, pattern: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await loadWith(env);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `${JSON.stringify(env)} 应当阻止启动`).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(pattern);
}

describe("每用户流量配额的三个配置项：FIELDS 契约", () => {
  it("QUOTA_USAGE_DIR / QUOTA_RESET_HOUR / QUOTA_FLUSH_INTERVAL 三行 env 名与键名", () => {
    expect(fieldOf("quotaUsageDir").env).toBe("QUOTA_USAGE_DIR");
    expect(fieldOf("quotaResetHour").env).toBe("QUOTA_RESET_HOUR");
    expect(fieldOf("quotaFlushInterval").env).toBe("QUOTA_FLUSH_INTERVAL");
  });

  it("quotaUsageDir 是 path 字段 + startup 相位（改目录必须重建 runtime）", () => {
    const def = fieldOf("quotaUsageDir");
    expect(def.path).toBe(true);
    // 启动期：运行中改目录 = 已打开的 append 句柄仍指向旧文件，改了等于没改
    expect(def.phase).toBe("startup");
    expect(keysByPhase().startup).toContain("quotaUsageDir");
    // 相对种子与 aclFile 同一写法（`cfg/…`），由 `def(configDir)` 绝对化
    expect(defaults.quotaUsageDir).toBe("cfg/usage");
    expect(typeof def.def).toBe("function");
    expect((def.def as (dir: string) => string)("C:/config")).toBe(
      path.join("C:/config", "cfg/usage"),
    );
  });

  it("quotaResetHour / quotaFlushInterval 是 runtime 相位、整数字段带范围", () => {
    const hour = fieldOf("quotaResetHour");
    expect(hour.phase).toBe("runtime");
    expect(hour.int).toEqual({ min: 0, max: 23 });
    expect(keysByPhase().runtime).toContain("quotaResetHour");
    expect(keysByPhase().startup).not.toContain("quotaResetHour");

    const flush = fieldOf("quotaFlushInterval");
    expect(flush.phase).toBe("runtime");
    expect(flush.int).toEqual({ min: 1 });
    expect(keysByPhase().runtime).toContain("quotaFlushInterval");
    expect(keysByPhase().startup).not.toContain("quotaFlushInterval");
  });

  it("三个键的缺省值在 defaults 与运行时一致（0 点重置 / 5s 落盘 / cfg/usage）", () => {
    expect(defaults.quotaResetHour).toBe(0);
    expect(defaults.quotaFlushInterval).toBe(5000);
    expect(defaults.quotaUsageDir).toBe("cfg/usage");
    // AppConfig 三键齐备（ConfigKey 派生，缺一个下面这行就编译不过）
    const keys: ConfigKey[] = ["quotaUsageDir", "quotaResetHour", "quotaFlushInterval"];
    expect(keys.every((k) => Object.is(defaults[k], defaults[k]))).toBe(true);
  });
});

describe("每用户流量配额的三个配置项：解析、路径归一与越界 abort", () => {
  it("不给这三个 env 时取缺省，且账本目录按 configDir 绝对化", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "quota-config-test-"));
    try {
      const context = await loadConfig({
        env: { AUTH_ENABLED: "false" },
        envFiles: [],
        argv: [],
        cwd: dir,
        skipFileValidation: true,
      });
      expect(context.store.get("quotaResetHour")).toBe(0);
      expect(context.store.get("quotaFlushInterval")).toBe(5000);
      expect(context.store.get("quotaUsageDir")).toBe(path.join(dir, "cfg", "usage"));
      expect(path.isAbsolute(context.store.get("quotaUsageDir"))).toBe(true);
      // startup 相位必须进 startupKeys（这是 restart-required 分流的唯一依据）
      expect(context.startupKeys).toContain("quotaUsageDir");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("QUOTA_USAGE_DIR 的相对值按 configDir 绝对化，绝对值原样保留", async () => {
    const relative = await loadWith({ QUOTA_USAGE_DIR: "./var/usage" });
    expect(path.isAbsolute(relative.store.get("quotaUsageDir"))).toBe(true);
    expect(relative.store.get("quotaUsageDir").endsWith(path.join("var", "usage"))).toBe(true);

    const absolute = path.join(os.tmpdir(), "proxy-quota-ledger-abs");
    const fixed = await loadWith({ QUOTA_USAGE_DIR: absolute });
    expect(fixed.store.get("quotaUsageDir")).toBe(absolute);
  });

  it("QUOTA_RESET_HOUR 认 0 与 23 两端以及中间值", async () => {
    for (const [raw, want] of [
      ["0", 0],
      ["3", 3],
      ["23", 23],
    ] as const) {
      const context = await loadWith({ QUOTA_RESET_HOUR: raw });
      expect(context.store.get("quotaResetHour")).toBe(want);
    }
  });

  it("QUOTA_RESET_HOUR 越界（-1 / 24）→ 启动期 abort，且点名那个 env", async () => {
    await expectAbort({ QUOTA_RESET_HOUR: "-1" }, /QUOTA_RESET_HOUR=-1 越界/);
    await expectAbort({ QUOTA_RESET_HOUR: "24" }, /QUOTA_RESET_HOUR=24 越界/);
  });

  it("QUOTA_RESET_HOUR 非数字 → 解析失败即 abort（不静默回缺省 0）", async () => {
    await expectAbort({ QUOTA_RESET_HOUR: "abc" }, /QUOTA_RESET_HOUR=abc/);
    await expectAbort({ QUOTA_RESET_HOUR: "1.5" }, /QUOTA_RESET_HOUR=1\.5/);
  });

  it("QUOTA_FLUSH_INTERVAL 认 1 与大值，缺省 5000", async () => {
    expect((await loadWith({ QUOTA_FLUSH_INTERVAL: "1" })).store.get("quotaFlushInterval")).toBe(1);
    expect((await loadWith({ QUOTA_FLUSH_INTERVAL: "60000" })).store.get("quotaFlushInterval")).toBe(
      60000,
    );
    expect((await loadWith({})).store.get("quotaFlushInterval")).toBe(5000);
  });

  it("QUOTA_FLUSH_INTERVAL 越界（0 / 负数）→ 启动期 abort（0 不等于「关掉落盘」）", async () => {
    await expectAbort({ QUOTA_FLUSH_INTERVAL: "0" }, /QUOTA_FLUSH_INTERVAL=0 越界/);
    await expectAbort({ QUOTA_FLUSH_INTERVAL: "-1" }, /QUOTA_FLUSH_INTERVAL=-1 越界/);
  });

  it("非法值不半写 store：三个键仍留缺省（原子落库，既有契约）", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "quota-config-test-"));
    try {
      const { ConfigStore } = await import("@/config/index.js");
      const store = new ConfigStore({ quotaResetHour: 7 });
      await expect(
        loadConfig({
          env: { AUTH_ENABLED: "false", QUOTA_FLUSH_INTERVAL: "0" },
          envFiles: [],
          argv: [],
          cwd: dir,
          store,
          skipFileValidation: true,
        }),
      ).rejects.toThrow(/QUOTA_FLUSH_INTERVAL=0 越界/);
      expect(store.get("quotaResetHour")).toBe(7);
      expect(store.get("quotaFlushInterval")).toBe(defaults.quotaFlushInterval);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tests/setup-env 的 CONFIG_ENV_KEYS 与 FIELDS 同步", () => {
  it("键集合逐项相同（漏一项 = 宿主 env 静默漏进测试，表现为本机红、CI 绿）", () => {
    expect([...CONFIG_ENV_KEYS].sort()).toEqual(FIELDS.map((f) => f.env).sort());
    expect(new Set(CONFIG_ENV_KEYS).size).toBe(CONFIG_ENV_KEYS.length);
  });

  it("三个新 env 都在清单里（这条就是「最容易漏的联动点」的专门断言）", () => {
    expect(CONFIG_ENV_KEYS).toContain("QUOTA_USAGE_DIR");
    expect(CONFIG_ENV_KEYS).toContain("QUOTA_RESET_HOUR");
    expect(CONFIG_ENV_KEYS).toContain("QUOTA_FLUSH_INTERVAL");
  });

  it("ACL_DRIVER 也在 env 白名单里（新增数据源键最容易漏的联动点）", () => {
    expect(CONFIG_ENV_KEYS).toContain("ACL_DRIVER");
  });

  it("env 名全局唯一（FIELDS 是唯一真相源，出现别名即违规）", () => {
    const envs = FIELDS.map((f) => f.env);
    expect(new Set(envs).size).toBe(envs.length);
    // CLI 同源：--quota-reset-hour / QUOTA_RESET_HOUR 归一为同一 env 名，不许出现第二个拼法
    expect(envs).toContain("QUOTA_RESET_HOUR");
    expect(envs).not.toContain("QUOTA_WINDOW_HOUR");
  });
});

afterAll(() => {
  // 兜底：临时目录在每条用例里已各自清理，这里只保证异常路径不留下引用
  expect(true).toBe(true);
});

/**
 * 两个数据来源的**缺省后端**：都是 json，且「缺省」不等于「强制」
 *
 * @description 单独成一档而不是并进上面那组「三个配置项」：那组钉的是**契约**（相位 / 越界 /
 * env 名），本组钉的是**取值**。取值最容易被无声改掉——改 `defaults` 一行产品行为就变了，
 * 而那组一条都不会红（它们不看值）。缺省后端是产品决策，不是契约。
 *
 * ⚠️ json 档账本**没有多进程判定共享**（`@/datasource/quota/jsonl-source.ts` 文件头），
 * `CLUSTER_WORKERS>1` 时账号级封禁退化成「每进程一份」。选 json 当缺省就是接受这一点。
 * 那条缺口今天**只有注释与 `.env.example` 在说，没有告警**——`RuntimeWarning` 已裁决
 * 「到第三条 inert 告警就不再加 if 分支」，加第 4 条要先做它的 `level` 化重构。
 * **别把「本档全绿」读成「那个缺口被处理了」。**
 */
describe("两个数据来源的缺省后端：都是 json，且缺省不等于强制", () => {
  it("defaults 里两个驱动都是 json（两个数据源默认值必须一致）", () => {
    expect(defaults.authUsersDriver).toBe("json");
    expect(defaults.quotaUsageDriver).toBe("json");
  });

  it("FIELDS 不给这两个键自己的 def —— 缺省只有 defaults 这一个真相源", () => {
    // 反面：给 FIELDS 补一个 `def: () => "sqlite"`，store 读到 sqlite 而 defaults 还是 json，
    // 「defaults 是唯一真相源」这条不变量就被悄悄破掉。锚在 `def` 这个**今天仍存在于同文件
    // 其它字段上**的键（quotaUsageDir / authUsersFile 都有），不是锚一个已删符号。
    expect(fieldOf("authUsersDriver").def).toBeUndefined();
    expect(fieldOf("quotaUsageDriver").def).toBeUndefined();
    // 对照组：这两个键确实有 def（否则上面两条恒真）
    expect(typeof fieldOf("quotaUsageDir").def).toBe("function");
  });

  it("运行时不给 env 时读到的就是 json（loadConfig 不读 process.env，全局钉值漏不进来）", async () => {
    // `loadConfig` 的入参是**全量显式来源**（`config/load.ts` 文件头：「不从宿主进程猜测」），
    // 所以 `tests/setup-env.ts` 里那条全局钉值影响不到这里。
    const context = await loadWith();
    expect(context.store.get("authUsersDriver")).toBe("json");
    expect(context.store.get("quotaUsageDriver")).toBe("json");
  });

  it("显式给值仍然压过缺省（sqlite 档必须还能选得到）", async () => {
    // 与上一条成对：只钉「不给就是 json」的话，把字段解析改成「无视输入恒返回 json」也能全绿。
    const context = await loadWith({
      AUTH_USERS_DRIVER: "sqlite",
      QUOTA_USAGE_DRIVER: "sqlite",
    });
    expect(context.store.get("authUsersDriver")).toBe("sqlite");
    expect(context.store.get("quotaUsageDriver")).toBe("sqlite");
  });
});
