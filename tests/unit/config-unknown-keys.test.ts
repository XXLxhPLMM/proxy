/**
 * 未知配置键的闸门：argv 与 env 文件里出现 `FIELDS` 之外的键一律让启动失败
 *
 * @description
 * 本档答的是「拼错的键还有没有机会静默生效」。静默回落不是小毛病：命令行里敲一个已删除的
 * 旧键名照样起服务，实际跑的是缺省档，操作者没有任何信号。
 *
 * ## ① 判据是**键名**在不在 `FIELDS` + 容忍名单里，与「这个键的值有没有被用上」无关
 * 否掉的是「只对生效的键校验」。落选的键走的是「`resolveFieldEntries` 拿不到值 → 回落
 * def/defaults」这条现成通路，正是它让拼错无声。锁点（本档「argv 里的未知键让启动失败」那条）：
 * `const message = await rejectionMessage(loadArgv(["--quota-ledger-driver", "sqlite"], cwd))`
 * 后紧跟 `expect(message).toContain("QUOTA_LEDGER_DRIVER")` ——错误文本**逐字含那个键名**，
 * 所以「探测器根本没看见这个键」不会伪装成通过。
 *
 * ## ② 报错必须可操作：点名键 + 指名来源 + 近邻时给最接近的合法键
 * 否掉的是「未知配置项」这种没头没尾的文案。锁点（本档同一条的来源/建议断言）：
 * `expect(message).toContain("来源：CLI 参数")` 与 `expect(message).toContain("最接近的合法键是 QUOTA_USAGE_DIR")`
 * ——`QUOTA_USAGE_DI` 少一个字符；`CACHE_TYPE` 这种离所有合法键都很远的键**不给**建议
 * （本档「离所有合法键都很远的键不给建议」那条），给错建议会让运维去改一个本来正确的键。
 *
 * ## ③ env 文件来源要报到**具体文件路径**，不是「某个 env 文件」
 * 锁点（本档「env 文件里的未知键点名那个文件」那条）：`expect(message).toContain(envFile)`，
 * `envFile` 是临时目录下的绝对路径。两个 env 文件各写一个不同的坏键时，报错逐个点名；
 * 同一个坏键写在两个文件里时点名后写入的那个（与合并优先级一致）。
 *
 * ## ④ 显式 `env` 入参里的未知键**不**报错（宿主环境成千上万个无关变量）
 * 否掉的是「对所有键 fail-fast」。锁点（本档「显式 env 的未知键不报错且合法键照常生效」那条）：
 * `env: { PORT: "18123", TOTALLY_UNRELATED: "1" }` 加载成功且 `port === 18123`。
 * 这条与 ① 互为正反面：把 ① 的判据改成「查所有键」就红，把 ① 整条删掉也红。
 *
 * ## ⑤ 容忍名单**恰好两个**键（NODE_ENV / NO_COLOR），且逐个证明它在 argv / env 文件两个来源都不报错
 * 名单不扩大是纪律不是偏好：多收一个键 = 多放行一类拼错。锁点（本档两条容忍断言）：
 * `NODE_ENV` / `NO_COLOR` 两个键分别在 argv 与 env 文件里都加载成功；
 * 同档「容忍名单的源码文本恰为这两个键」那条用源码级断言钉住集合（多一个就红），
 * 另配「它们的近邻拼错（`NOD_ENV` / `NO_COLORS` / `USE_HOME_CONDIG` / `MY_TOKEN`）仍然报错」——
 * 否掉的是「容忍判定退化成前缀/模糊匹配」。
 *
 * **名单与 `FIELDS` 必须零交集**（同档有专门一档）：`USE_HOME_CONFIG` 虽被 `loadConfig` 早于
 * 字段解析地单独读取，但它是 `FIELDS` 字段，键名早已合法。把它收进名单看起来是「多一份保险」，
 * 实际是**把一次字段删除掩盖成「这键本来就合法」**——闸门再也报不出那个拼错了。
 *
 * ## ⑥ **全部** `FIELDS` 的 env 名在 argv 与 env 文件里都不报错
 * 这是 ① 的反向面：只钉「坏键报错」的话，把判据改成「拒绝一切键」也能全绿。锁点：
 * `for (const f of FIELDS) { ... }` 逐个加载成功 —— 全部键逐个过一遍，任一被误判当场红。
 *
 * ## ⑦ 失败不留半份配置（与「所有成功后才一次 merge」同一条不变量）
 * 锁点（本档「未知 argv 键不半写 store」与「未知 env 文件键不半写 store」两条）：预置
 * `new ConfigStore({ port: 18100 })`，未知键加载失败后 `expect(store.get("port")).toBe(18100)`
 * ——闸门若落在 merge 之后，已被写进去的字段就留在 store 里了。
 *
 * ## ⑧ 显式 env 已有的键不归文件：同名的坏键在 `env` 里就不算文件来源
 * `readEnvFiles` 的 `explicitKeys` 决定归属：显式 env 压过文件，生效值由 env 给。
 * 锁点（本档「显式 env 里的同名未知键不按文件来源报错」那条）：`env` 给 `CACHE_TYPE`、
 * env 文件里也写 `CACHE_TYPE` ⇒ 加载成功。归属口径钉在 `fileOrigins` 只收文件带来的键。
 *
 * ## ⑨ `FIELDS` 与 `.env.example` 集合相等（两者互为对方的「全量清单」）
 * 闸门只管「运行期不认的键」，而 `.env.example` 是**用户看得见的**那份清单：少一个键 = 用户
 * 永远发现不了那个选项；多一个键 = 照着改的文件起不来。故钉**集合相等**而不钉「共 N 项」——
 * N 是会腐烂的数字（本轮实测：文案写「共 33 项」而实际 35 个键 / 36 个字段），集合相等不会。
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIELDS, ConfigStore, defaults, loadConfig, type FieldDef } from "@/config/index.js";
import { codeOf, offendingLines } from "../helpers/source-scan.js";

/** 仓根的 env 模板：用户看得见的那份配置清单 */
const ENV_EXAMPLE = path.resolve(__dirname, "..", "..", ".env.example");

/** 临时配置目录；避免任何一条用例碰到仓库根的 `.env.development` 与 `cfg/`。 */
async function withTmpConfigDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-unknown-keys-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 少数字段的缺省值**不能直接当显式值用**（那类字段各给一个明确的合法值）。
 * 这张表现在是空的：`UPSTREAM_URL` 曾经在这里占一行，因为它的空串会被判非法 ——
 * 而字段的 `def` 恰恰就是空串，于是「缺省值必须能显式写出来」这条被破坏了
 * （模板里那一行只能注释掉，照抄模板则起不来）。
 * 表留着而不是删掉：它记录着「这个分叉在今天不存在」，将来再出现一个字段时，
 * 第一个该问的问题是「能不能让缺省值本身就合法」，而不是往这儿加一行。
 */
const EXPLICIT_VALUES: Readonly<Record<string, string>> = {};

/**
 * 字段的合法取值直接取自它自己的契约（`def(configDir)` / `defaults`），不另写一张值表：
 * 那样这张表本身会与 `FIELDS` 漂移，于是「键被接受」这件事就悄悄少测了几个字段。
 */
function legalValueOf(field: FieldDef, cwd: string): string {
  const override = EXPLICIT_VALUES[field.env];
  if (override !== undefined) {
    return override;
  }
  const raw =
    field.def === undefined
      ? defaults[field.key]
      : typeof field.def === "function"
        ? field.def(cwd)
        : field.def;
  return String(raw);
}

function loadOptions(cwd: string) {
  return {
    env: { AUTH_ENABLED: "false" },
    envFiles: [] as string[],
    argv: [] as string[],
    cwd,
    skipFileValidation: true,
  };
}

/** 只经 `loadConfig` 这一个入口断言（与 argv 归一档同一纪律：不留第二个真相源）。 */
async function loadArgv(argv: string[], cwd: string) {
  return loadConfig({ ...loadOptions(cwd), argv });
}

async function loadEnvFile(content: string, cwd: string, fileName = "one.env") {
  const file = path.join(cwd, fileName);
  await writeFile(file, content, "utf8");
  return loadConfig({ ...loadOptions(cwd), envFiles: [file] });
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

describe("未知 argv 键：fail-fast 且报错可操作", () => {
  it("argv 里的未知键让启动失败，错误逐字点名该键与来源", async () => {
    await withTmpConfigDir(async (cwd) => {
      const message = await rejectionMessage(
        loadArgv(["--quota-ledger-driver", "sqlite"], cwd),
      );
      expect(message).toMatch(/^配置校验失败:/);
      expect(message).toContain("QUOTA_LEDGER_DRIVER");
      expect(message).toContain("来源：CLI 参数");
    });
  });

  it("KEY=VALUE 写法的未知键同样被拦（三种 argv 写法归一后共用一个键名空间）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const message = await rejectionMessage(loadArgv(["QUOTA_LEDGER_DRIVER=sqlite"], cwd));
      expect(message).toContain("QUOTA_LEDGER_DRIVER");
    });
  });

  it("编辑距离很近时给出最接近的合法键名", async () => {
    await withTmpConfigDir(async (cwd) => {
      const message = await rejectionMessage(loadArgv(["--quota-usage-di", "cfg/usage"], cwd));
      expect(message).toContain("QUOTA_USAGE_DI");
      expect(message).toContain("最接近的合法键是 QUOTA_USAGE_DIR");
    });
  });

  it("离所有合法键都很远的键不给建议（错建议比没建议更糟）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const message = await rejectionMessage(loadArgv(["--cache-type", "memory"], cwd));
      expect(message).toContain("CACHE_TYPE");
      expect(message).not.toContain("最接近的合法键");
    });
  });

  it("多个未知键在一条错误里全部点名", async () => {
    await withTmpConfigDir(async (cwd) => {
      const message = await rejectionMessage(
        loadArgv(["--cache-type=memory", "--quota-ledger-driver=sqlite"], cwd),
      );
      expect(message).toContain("CACHE_TYPE");
      expect(message).toContain("QUOTA_LEDGER_DRIVER");
    });
  });

  it("未知 argv 键不半写 store（闸门在唯一一次 merge 之前）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const store = new ConfigStore({ port: 18100 });
      await expect(
        loadConfig({ ...loadOptions(cwd), argv: ["--cache-type=memory"], store }),
      ).rejects.toThrow(/未知配置项 CACHE_TYPE/);
      expect(store.get("port")).toBe(18100);
    });
  });
});

describe("未知 env 文件键：fail-fast 且指名具体文件", () => {
  it("env 文件里的未知键点名那个文件路径", async () => {
    await withTmpConfigDir(async (cwd) => {
      const file = path.join(cwd, ".env.development");
      await writeFile(file, "PORT=18101\nCACHE_TYPE=memory\n", "utf8");
      const message = await rejectionMessage(
        loadConfig({ ...loadOptions(cwd), envFiles: [file] }),
      );
      expect(message).toContain("CACHE_TYPE");
      expect(message).toContain(`env 文件 ${file}`);
    });
  });

  it("多个 env 文件里各一个坏键时逐个点名各自的文件", async () => {
    await withTmpConfigDir(async (cwd) => {
      const first = path.join(cwd, "first.env");
      const second = path.join(cwd, "second.env");
      await writeFile(first, "CACHE_TYPE=memory\n", "utf8");
      await writeFile(second, "QUOTA_LEDGER_DRIVER=sqlite\n", "utf8");
      const message = await rejectionMessage(
        loadConfig({ ...loadOptions(cwd), envFiles: [first, second] }),
      );
      expect(message).toContain(`env 文件 ${first}`);
      expect(message).toContain("CACHE_TYPE");
      expect(message).toContain(`env 文件 ${second}`);
      expect(message).toContain("QUOTA_LEDGER_DRIVER");
    });
  });

  it("同键写在两个文件里时归给后写入的那个（与合并优先级一致）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const first = path.join(cwd, "first.env");
      const second = path.join(cwd, "second.env");
      await writeFile(first, "CACHE_TYPE=memory\n", "utf8");
      await writeFile(second, "CACHE_TYPE=redis\n", "utf8");
      const message = await rejectionMessage(
        loadConfig({ ...loadOptions(cwd), envFiles: [first, second] }),
      );
      expect(message).toContain(`env 文件 ${second}`);
      expect(message).not.toContain(first);
    });
  });

  it("显式 env 已有的同名未知键不按文件来源报错（生效值由 env 给）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const file = path.join(cwd, "one.env");
      await writeFile(file, "CACHE_TYPE=memory\n", "utf8");
      const context = await loadConfig({
        ...loadOptions(cwd),
        env: { AUTH_ENABLED: "false", CACHE_TYPE: "redis" },
        envFiles: [file],
      });
      expect(context.store.get("port")).toBe(defaults.port);
    });
  });

  it("未知 env 文件键不半写 store（闸门也在唯一一次 merge 之前）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const file = path.join(cwd, "one.env");
      await writeFile(file, "PORT=18102\nCACHE_TYPE=memory\n", "utf8");
      const store = new ConfigStore({ port: 18100, host: "127.0.0.9" });
      await expect(
        loadConfig({ ...loadOptions(cwd), envFiles: [file], store }),
      ).rejects.toThrow(/未知配置项 CACHE_TYPE/);
      expect(store.get("port")).toBe(18100);
      expect(store.get("host")).toBe("127.0.0.9");
    });
  });
});

describe("显式 env 入参：未知键不报错（宿主环境的无关变量不是配置错误）", () => {
  it("显式 env 的未知键不报错且合法键照常生效", async () => {
    await withTmpConfigDir(async (cwd) => {
      const context = await loadConfig({
        ...loadOptions(cwd),
        env: { AUTH_ENABLED: "false", PORT: "18123", TOTALLY_UNRELATED: "1", PATH: "/x" },
      });
      expect(context.store.get("port")).toBe(18123);
      expect(context.sources.envKeys).toContain("TOTALLY_UNRELATED");
    });
  });
});

describe("容忍名单：恰好两个键，两个来源都不报错", () => {
  const TOLERATED = ["NODE_ENV", "NO_COLOR"] as const;

  it("两个键出现在 argv 里都不报错", async () => {
    await withTmpConfigDir(async (cwd) => {
      await expect(loadArgv(["--node-env=test", "--no-color=1"], cwd)).resolves.toBeDefined();
    });
  });

  it("两个键出现在 env 文件里都不报错", async () => {
    await withTmpConfigDir(async (cwd) => {
      await expect(
        loadEnvFile(`${TOLERATED.join("=1\n")}=1\n`, cwd),
      ).resolves.toBeDefined();
    });
  });

  it("USE_HOME_CONFIG 合法是靠它是 FIELDS 字段，不靠它进了容忍名单", async () => {
    await withTmpConfigDir(async (cwd) => {
      const context = await loadArgv(["--use-home-config=false", "--port=18124"], cwd);
      // 落到显式 cwd 而非 ~/.proxy：home 档会改掉 configDir
      expect(context.configDir).toBe(cwd);
      expect(context.store.get("port")).toBe(18124);
    });
    // 反面锚点：它**不在**容忍名单里。判据读的是「键名在不在 FIELDS」，
    // 与「这个键被早于字段解析地读取过」无关 —— 那两件事凑在一起容易被混成一条。
    expect(TOLERATED as readonly string[]).not.toContain("USE_HOME_CONFIG");
    expect(FIELDS.map((f) => f.env)).toContain("USE_HOME_CONFIG");
  });

  it("容忍名单与 FIELDS 零交集（多收一个 FIELDS 键 = 把它的删除掩盖成「本来就合法」）", () => {
    const fieldEnvs = new Set(FIELDS.map((f) => f.env));
    const overlap = TOLERATED.filter((k) => fieldEnvs.has(k));
    expect(
      overlap,
      `这些键既是 FIELDS 字段又在容忍名单里：${overlap.join(", ")}。` +
        "字段被删时名单会继续放行它，把一次删除掩盖掉。",
    ).toEqual([]);
  });

  it("容忍名单的近邻拼错仍然报错（容忍判定不是前缀/模糊匹配）", async () => {
    await withTmpConfigDir(async (cwd) => {
      for (const wrong of ["NOD_ENV", "NO_COLORS", "USE_HOME_CONDIG", "MY_TOKEN"]) {
        const message = await rejectionMessage(loadArgv([`--${wrong.toLowerCase()}=1`], cwd));
        expect(message, `${wrong} 必须被拒绝`).toContain(wrong);
      }
    });
  });

  it("容忍名单的源码文本恰为这两个键（多一个就红：不得无声扩大）", () => {
    const code = codeOf("config", "load.ts");
    const declared = code.match(/NON_CONFIG_ENV_KEYS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(declared, "load.ts 里找不到 NON_CONFIG_ENV_KEYS 的字面量集合").not.toBeNull();
    const keys = [...(declared?.[1] ?? "").matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...TOLERATED].sort());
    // 反面：每个成员都必须在本仓有唯一一处真实读取，否则它就是纯容忍噪音。
    // 锚在「今天仍存在的读取点」上（env-files.ts 的形参、cli.ts 的属性访问），
    // 不是锚一个已删符号。
    expect(offendingLines(codeOf("config", "sources", "env-files.ts"), /nodeEnv/)).not.toHaveLength(0);
    expect(offendingLines(codeOf("cli.ts"), /env\.NO_COLOR/)).toHaveLength(1);
  });
});

describe("FIELDS ↔ .env.example 集合相等（用户看得见的那份清单不许缺键或多键）", () => {
  /** `.env.example` 里真正生效的赋值行（跳过注释行；`KEY=` 空值也算一条） */
  function exampleKeys(): string[] {
    return readFileSync(ENV_EXAMPLE, "utf8")
      .split("\n")
      .map((line) => /^\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
      .filter((k): k is string => k !== undefined);
  }

  it("`.env.example` 的键集合恰好等于 FIELDS 的 env 名集合", () => {
    const inExample = new Set(exampleKeys());
    const inFields = new Set(FIELDS.map((f) => f.env));
    const missing = [...inFields].filter((k) => !inExample.has(k)).sort();
    const extra = [...inExample].filter((k) => !inFields.has(k)).sort();
    expect(
      { missing, extra },
      missing.length
        ? `FIELDS 里有而 .env.example 没写：${missing.join(", ")} —— 用户永远发现不了这些选项`
        : extra.length
          ? `.env.example 里有而 FIELDS 没有：${extra.join(", ")} —— 照着改的文件一定起不来`
          : "",
    ).toEqual({ missing: [], extra: [] });
  });

  it("零重复键（同一个键写两遍 = 后一行静默覆盖前一行，模板读者看不出谁赢）", () => {
    const keys = exampleKeys();
    const dup = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))].sort();
    expect(dup, `这些键在 .env.example 里出现了多次：${dup.join(", ")}`).toEqual([]);
  });

  it("文案里不再写「共 N 项」（那是会腐烂的数字，对应关系由上面那档钉）", () => {
    // 锚在**今天仍存在的形状**上：仓库任何地方都不该再出现这种会漂的计数文案。
    const offenders = offendingLines(readFileSync(ENV_EXAMPLE, "utf8"), /共\s*\d+\s*项/);
    expect(offenders, "`.env.example` 又开始声明项数了：项数会漂，集合相等才是不变量").toEqual([]);
  });
});

describe("合法键一个都不误伤（探测器不是「拒绝一切」）", () => {
  it("全部 FIELDS 的 env 名逐个作为 argv 键都加载成功", async () => {
    await withTmpConfigDir(async (cwd) => {
      for (const f of FIELDS) {
        await expect(
          loadArgv([`${f.env}=${legalValueOf(f, cwd)}`], cwd),
          `${f.env} 是合法键，不该被未知键闸门拦下`,
        ).resolves.toBeDefined();
      }
    });
  });

  it("全部 FIELDS 的 env 名写进同一个 env 文件也加载成功", async () => {
    await withTmpConfigDir(async (cwd) => {
      const content = `${FIELDS.map((f) => `${f.env}=${legalValueOf(f, cwd)}`).join("\n")}\n`;
      await expect(loadEnvFile(content, cwd)).resolves.toBeDefined();
    });
  });
});
