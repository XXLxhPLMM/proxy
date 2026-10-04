/**
 * 层边界（源码级）：`src/services/config/` 零 `console`、零 `process.*`，且内部不自我引用 barrel
 * @description
 * 这一档**读的是源码文本**（`LEDGER_DIR` 指向 `src/services/config/`），不是跑起来的东西，故它与
 * `tests/sqlite/driver.test.ts` 那一档不重叠：那边验**驱动**的行为，这边验**这一层的边界**。
 *
 * ⚠️ 「零 console / 零 process.*」是一组**负向**断言，而负向断言的经典失败模式是判据写坏了却恒绿。
 * 故每一条判据都配一条**自检**：把同一套判据喂进合成的违规文本，要求它必须判中 ——
 * 「探测器看得见」与「今天真的干净」两条合起来才叫断言。
 *
 * ⚠️ 同一条纪律还要求「锚到的符号今天还在」：不自我引用 barrel 那条的锚曾经写成一个 P0 之前就搬走的
 * 目录，于是它恒空、恒绿。
 *
 * 目录级不变量见 `AGENTS.md`。
 *
 * @module tests/ledger
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `src/services/config/` 的源码目录
 * @description ⚠️ **两个** `..`：本档在 `tests/ledger/`（比 `tests/` 深一层），一个会落到 `tests/src`
 * —— 那个目录不存在，于是 `readdirSync` 抛 ENOENT（**响亮的红**，不是空集假绿）。
 */
const LEDGER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "services",
  "config",
);

describe("层边界（源码级）", () => {
  /** 注释行整行略过：注释里点名被禁符号是在**描述**这条不变量 */
  function codeLines(text: string): string[] {
    return text.split("\n").filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"));
    });
  }

  const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
    ["console", /(^|[^.\w$])console\s*\./],
    ["process", /(^|[^.\w$])process\s*\./],
  ];

  function hits(text: string): string[] {
    const lines = codeLines(text);
    const found: string[] = [];
    for (const [what, shape] of FORBIDDEN) {
      lines.forEach((line, index) => {
        if (shape.test(line)) found.push(`${what} @ ${index + 1}: ${line.trim()}`);
      });
    }
    return found;
  }

  function sources(): ReadonlyArray<readonly [string, string]> {
    return fs
      .readdirSync(LEDGER_DIR)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(LEDGER_DIR, name), "utf8")]);
  }

  it("扫描面非空且真的覆盖到本目录的源文件（否则下面两条是空断言）", () => {
    const files = sources().map(([name]) => name);
    expect(files).toContain("store.ts");
    expect(files).toContain("validate.ts");
    // ⚠️ 新的驱动与 DDL 两块必须**在**扫描面里：不在的话「本层零 console / 零 process.*」验的是残缺的一份
    expect(files).toContain("db.ts");
    expect(files).toContain("tables.ts");
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("src/services/config 零 console、零 process.*（`homedir` 由入参注入正是为了这一条）", () => {
    const violations = sources().flatMap(([name, text]) =>
      hits(text).map((where) => `${name}: ${where}`),
    );
    expect(violations, `本层出现了呈现 / 宿主访问：\n${violations.join("\n")}`).toEqual([]);
  });

  it("判据自检：同一套判据必须能认出违规文本（否则上面那条是恒绿）", () => {
    // 「探测器看得见」与「今天真的干净」合起来才叫断言；只写后半条的话，探测器写坏了照样全绿
    const dirty = ['console.log("x");', "const x = process.env.HOME;"];
    for (const sample of dirty) {
      expect(hits(sample).length, `判据没认出：${sample}`).toBe(1);
    }
    // 且不能把成员访问误判成宿主访问（`obj.console` / `obj.process` 都只是普通字段名）
    expect(hits("const a = obj.console.log;").length).toBe(0);
    expect(hits("const a = obj.process.exit;").length).toBe(0);
  });

  it("目录对外只暴露一个 barrel，且内部不自我引用它", () => {
    const selfReferencing = sources()
      .filter(([name]) => name !== "index.ts")
      .flatMap(([name, text]) => {
        const code = codeLines(text).join("\n");
        // ⚠️ 锚是**今天还存在的**路径 `@/services/config/`：P0 之前这里写的是 `@/ledger/`，
        // 那个目录早就不存在了，于是判据恒空、这条断言恒绿。
        return /from\s+"@\/services\/config\//.test(code) || /from\s+"\.\/index\.js"/.test(code)
          ? [`${name} 引了 barrel`]
          : [];
      });
    expect(
      selfReferencing,
      `本目录内部引用了自己的 barrel（循环依赖图）：\n${selfReferencing.join("\n")}`,
    ).toEqual([]);
  });

  it("barrel 那条判据会红（自检：给本目录某个文件加一句引 barrel，判据必须抓到）", () => {
    const dirty = 'import { x } from "@/services/config/index.js";\nexport const y = x;\n';
    const code = codeLines(dirty).join("\n");
    expect(/from\s+"@\/services\/config\//.test(code)).toBe(true);
    expect(
      /from\s+"\.\/index\.js"/.test(codeLines('import { x } from "./index.js";').join("\n")),
    ).toBe(true);
  });

  it("barrel 只 export，一行逻辑都没有", () => {
    const barrel = sources().find(([name]) => name === "index.ts");
    expect(barrel).toBeDefined();
    // 口径：把所有 `export { … } from "…"` 声明整段拿掉之后，剩下的**必须**只剩空白与分号。
    // 这样「多写了一句逻辑」会留下残渣，而不是靠一张越来越长的允许清单（那清单迟早漏项）。
    const residue = barrel![1]
      .replace(/export\s*\{[^}]*\}\s*from\s*"[^"]*";/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/[\s;]/g, "");
    expect(residue, `barrel 里有非 export 的内容：${residue}`).toBe("");
  });

  it("barrel 那条判据会红（自检：给 barrel 加一句逻辑，残渣判据必须抓到）", () => {
    // 「探测器看得见」与「今天真的干净」两条合起来才叫断言
    const residueOf = (text: string) =>
      text
        .replace(/export\s*\{[^}]*\}\s*from\s*"[^"]*";/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/[\s;]/g, "");
    expect(residueOf('export { a } from "./a.js";\nconst sneaky = 1;\n')).not.toBe("");
    // 反向：干净的那一份必须**什么都不剩**，否则上面那条只是「匹配不到东西」而不是「没有逻辑」
    expect(
      residueOf('export {\n  a,\n  type B,\n} from "./a.js";\nexport { c } from "./c.js";\n'),
    ).toBe("");
  });
});
