/**
 * 未知配置键闸门的**容忍面**：恰好两个容忍键、`FIELDS` ↔ `.env.example` 集合相等、合法键零误伤
 *
 * @description
 * 本档是 `rejection.test.ts` 的正反面：**只钉「坏键报错」的话，把判据改成「拒绝一切」也能全绿**，
 * 而把 `FIELDS` 某个键删掉、把容忍名单悄悄扩大、把模板与字段表漂开，也只有这里会红。
 * ⚠️ 逐条的「为什么」与变异锁点归**本目录 `AGENTS.md`** 的 ⑤ / ⑥ / ⑨。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { FIELDS, defaults, loadConfig, type FieldDef } from "@/config/index.js";
import { REPO_ROOT, codeOf, offendingLines } from "../../../helpers/source-scan.js";
import {
  loadArgv,
  loadOptions,
  rejectionMessage,
  withTmpConfigDir,
} from "./_config-unknown-keys.js";

/** 仓根的 env 模板：用户看得见的那份配置清单 */
const ENV_EXAMPLE = path.join(REPO_ROOT, ".env.example");

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

async function loadEnvFile(content: string, cwd: string, fileName = "one.env") {
  const file = path.join(cwd, fileName);
  await writeFile(file, content, "utf8");
  return loadConfig({ ...loadOptions(cwd), envFiles: [file] });
}

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