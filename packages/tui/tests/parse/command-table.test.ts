/**
 * 命令名这一层：那张表本身、`/` 前缀那条**形状**不变量、以及名字不认识时给的那几个建议。
 *
 * @description
 * ⚠️ 「每一行命令都必须以 `/` 开头」这一组是那条不变量的**牙齿**（`src/commands/AGENTS.md`
 * 「层不变量」指的就是这里），故它在**本档内不散**：前缀那道闸被去掉、或者被改成宽容地接受
 * 不带前缀的写法，转红的只有「宽容地接受…必须转红」那一条。
 *
 * @module tests/parse
 */

import { describe, expect, it } from "vitest";
import {
  COMMAND_NAMES,
  COMMAND_PREFIX,
  COMMAND_SPECS,
  findSpec,
  parseLine,
  suggestCommands,
} from "@/commands/parse.js";
import { fails, ok } from "./_shared.js";

/* ── 命令表 ─────────────────────────────────────────────────────────────── */

describe("命令表：十八行，一行不多一行不少，**且没有组**", () => {
  it("表里的名字逐条对上", () => {
    expect(COMMAND_SPECS.map((spec) => spec.name)).toEqual([
      "help",
      "status",
      "config",
      "usage",
      "acl",
      "accounts",
      "clear",
      "new",
      "rename",
      "sessions",
      "targets",
      "users",
      "providers",
      "models",
      "batch",
      "r",
      "exit",
      "quit",
    ]);
  });

  it("⚠️ **表里没有组**：每一行都是一个完整命令名（判据是逐条重算，不是「看起来没有」）", () => {
    // ⚠️ 组会让「命令名」这件事从**一个词**变成**几个词**，而命令名跨空白的那一整套机制
    // （`palette.ts:commandPathOf` 与补全里那个循环）就是为它长的。留着它等于留一份永不生效的机制，
    // 而它失效时没有人会收到任何信号。
    expect(COMMAND_SPECS.filter((spec) => spec.subs.length > 0)).toEqual([]);
    // ⚠️ **正向对照**：闭合集与命令名集合逐字相等（否则「没有组」可能只是「表里另有第二份名字表」）
    expect(COMMAND_NAMES).toEqual(COMMAND_SPECS.map((spec) => spec.name));
    for (const name of COMMAND_NAMES) expect(name.includes(" ")).toBe(false);
  });

  it("会话与弹窗相关的那几行**挨在一起**（`help` 的呈现顺序就是这张表的顺序）", () => {
    // ⚠️ 判据是**相对次序**而不是绝对下标：绝对下标每加一条命令就要改，而这一组的功能是
    // 「打开会话与清单有关的弹窗」，而 `help` 印出来的那一列是操作者唯一能看到的那份清单。
    const at = (name: string): number => COMMAND_SPECS.findIndex((spec) => spec.name === name);
    expect(at("new")).toBeLessThan(at("rename"));
    expect(at("rename")).toBeLessThan(at("sessions"));
    expect(at("sessions")).toBeLessThan(at("targets"));
    expect(at("targets")).toBeLessThan(at("users"));
    expect(at("users")).toBeLessThan(at("providers"));
    expect(at("providers")).toBeLessThan(at("models"));
  });

  it("⚠️ 弹窗与纯界面动作那一族：零形参，且各自产出那一个 kind（它们只做界面状态）", () => {
    for (const [line, kind] of [
      ["/new", "session-new"],
      ["/targets", "targets-open"],
      // ⚠️ `/rename` 也是零形参：名字是**在框里敲**出来的，所以它不是形参而是一段界面状态
      ["/rename", "session-rename"],
      ["/sessions", "sessions-open"],
      ["/users", "users-open"],
      ["/providers", "providers-open"],
      ["/models", "models-open"],
    ] as const) {
      const parsed = parseLine(line);
      expect(parsed.kind).toBe("ok");
      if (parsed.kind !== "ok") throw new Error("解析失败");
      expect(parsed.command.kind).toBe(kind);
      // ⚠️ 用法串恒等于路径本身 —— 多写一个尖括号就是「它要形参而表里没有」
      expect(COMMAND_SPECS.find((spec) => spec.path === line)?.usage).toBe(line);
    }
  });

  it("⚠️ 弹窗那一族的 `summary` **把键位说全了**（那是屏上唯一一份键位说明）", () => {
    // ⚠️ 判据是**逐条**点名那几个键，而不是「summary 里有 `↑`」：
    // 少说一个键，操作者在弹窗里按了它而什么都没有发生 —— 而弹窗自己不会解释。
    // ⚠️ 而**删除是两次**的那一档必须写在说明里：只说「Ctrl+D 删除」的话操作者按一次，
    // 行变了个颜色而没删，他会以为坏了。（`/models` 那一格压根没有删除键，故不在这一列里。）
    for (const [path, keys] of [
      ["/sessions", ["↑↓", "Enter", "Ctrl+D", "Ctrl+R", "Esc"]],
      ["/targets", ["↑↓", "Enter", "Ctrl+A", "Ctrl+D", "Ctrl+E", "Esc", "按两次"]],
      ["/users", ["↑↓", "Ctrl+A", "Ctrl+D", "Ctrl+E", "Ctrl+P", "Esc", "按两次"]],
      ["/providers", ["↑↓", "Enter", "Ctrl+A", "Ctrl+D", "Ctrl+E", "Ctrl+M", "Esc", "按两次"]],
      ["/models", ["↑↓", "Enter", "Ctrl+F", "Ctrl+R", "Esc"]],
    ] as const) {
      const summary = findSpec(path.slice(1))?.summary ?? "";
      for (const key of keys) {
        expect(summary, `${path} 的 summary 少了 ${key}`).toContain(key);
      }
    }
    // ⚠️ **正向对照**：那一族之外的命令**不该**长出键位说明（`/status` 没有任何键位）
    expect(findSpec("status")?.summary).not.toContain("Ctrl+D");
  });

  it("⚠️ `/exit` 与 `/quit` 产出**同一个 kind**（两个名字、一条实现，退出只有一扇门）", () => {
    // ⚠️ 判据是**两串用户真会敲的输入**加活的返回档，不是「源码里某个符号在不在」——
    // 后者对「别名还没加上」恒真，而那正是这条要防的那件事。
    for (const line of ["/exit", "/quit"]) {
      const parsed = parseLine(line);
      expect(parsed.kind).toBe("ok");
      if (parsed.kind !== "ok") throw new Error(`解析失败：${parsed.kind}`);
      expect(parsed.command).toEqual({ kind: "exit" });
    }
    // ⚠️ **零形参**：用法串恒等于路径本身（多给一个参数时它判「多给了 1 个参数」）
    for (const line of ["/exit", "/quit"]) {
      expect(findSpec(line.slice(1))?.usage).toBe(line);
      expect(parseLine(`${line} now`).kind).toBe("bad-args");
    }
    // ⚠️ **反向自检**：同族里那些**真**要控制面的命令今天仍在表里，且解析得通 ——
    // 少了它，上面那两条「一个请求都不发」分不清是判据成立还是整个解析层坏了
    expect(parseLine("/status").kind).toBe("ok");
  });

  it("每一行都有说明，且用法串是从形参表推出来的", () => {
    for (const spec of COMMAND_SPECS) {
      expect(spec.summary.length).toBeGreaterThan(0);
    }
    // ⚠️ 用法串**带前缀**：它是操作者照着敲的那一串，而 `parseLine` 收带前缀的那一串。
    expect(findSpec("usage")?.usage).toBe("/usage [用户名]");
    expect(findSpec("batch")?.usage).toBe("/batch <控制面> <命令>");
    expect(findSpec("help")?.usage).toBe("/help [命令名]");
  });

  it("⚠️ `path` 逐条就是「前缀 + 名字」，而 `usage` 的第一段就是它（**不是**抄的）", () => {
    for (const spec of COMMAND_SPECS) {
      // ⚠️ 判据是**逐条**重算一遍，不是「数组里有几个带 `/`」：后者对「`path` 全带前缀但
      // `usage` 忘了」恒绿，而那正是同一屏里两句话不一致的形状（`help` 印 `usage`、
      // 错误文案印 `/usage [用户名]`）。
      expect(spec.path).toBe(`${COMMAND_PREFIX}${spec.name}`);
      expect(spec.usage.startsWith(spec.path)).toBe(true);
    }
    expect(findSpec("accounts")?.path).toBe("/accounts");
    expect(findSpec("status")?.path).toBe("/status");
  });
});

/* ── 每一行都必须以 `/` 开头（本层的一条**形状**不变量）─────────────────── */

/** 形参名 → 一个**真能过**的样本（判据按形参名校验，故「随便给个 x」会让对照自己先红） */
const VALID_ARG: Readonly<Record<string, string>> = {
  命令名: "status",
  键名: "AUTH_TYPE",
  用户名: "alice",
  控制面: "all",
  // ⚠️ `/batch` 第二格是 `rest`：它吃下**剩下的原文**，故样本**必须自带前缀**（递归解析走 `parseLine`）
  命令: "/help",
};

describe("⚠️ 每一行命令都必须以 `/` 开头，且不带前缀时**不许**被宽容接受", () => {
  it("加前缀就通：表里**每一个**名字都真的能被解析（反向自检）", () => {
    // ⚠️ 这一条是**对照**：少了它，下面那些负向断言可能只是「前缀那道闸把所有人都拒了」而绿。
    // 判据锚在**今天活着的形状**（`parseLine` 的返回档），不是点名某个符号。
    for (const spec of COMMAND_SPECS) {
      const bare = spec.args
        .filter((one) => one.required)
        .map((one) => VALID_ARG[one.label] ?? "x");
      expect(parseLine([spec.path, ...bare].join(" ")).kind).toBe("ok");
    }
  });

  it("不带前缀 → `missing-prefix`，而**不是** `unknown-command`", () => {
    // ⚠️ 单独一档而不是混进 `unknown-command`：两件事要修的地方不同（补一个字符 vs 改命令名），
    // 合成一档的话建议会变成「你是不是想写 `statuss`」。
    expect(parseLine("status").kind).toBe("missing-prefix");
    expect(parseLine("nope").kind).toBe("missing-prefix");
    // 首尾空白不救它、也不冤枉它（trim 之后判前缀）
    expect(parseLine("   status   ").kind).toBe("missing-prefix");
    expect(parseLine("   /status   ").kind).toBe("ok");
  });

  it("⚠️ 宽容地接受不带前缀的写法**必须转红**（变异：去掉那道闸 → 这里绿）", () => {
    // 这是本组的**核心**：判据是「不带前缀的 `status` 进不了 `ok`」。
    // 少了它，「每一条都必须以 `/` 开头」就只是一句注释 —— 而宽容分支是最容易被加回来的
    // （它看起来像「兼容老脚本」），症状是操作者有两套写法而其中一套会在下一版消失。
    expect(parseLine("status").kind).not.toBe("ok");
    expect(parseLine("accounts").kind).not.toBe("ok");
  });

  it("建议与文案都给人看的形态（带前缀），而**不回显**敲了什么", () => {
    const failed = parseLine("status");
    expect(failed.kind).toBe("missing-prefix");
    if (failed.kind !== "missing-prefix") throw new Error("档位不对");
    expect(failed.suggestions).toContain("/status");
    // ⚠️ 文案里只有闭合集与那一个前缀字符：抄进结果区的是「怎么改」，不是「你敲了什么」
    expect(failed.message).not.toContain("status");
    expect(failed.message).toContain(COMMAND_PREFIX);
  });

  it("只有一个 `/` 时是 `empty`（什么也不是），不是 `missing-prefix`", () => {
    // ⚠️ `/` 已经带了前缀，缺的是命令名 —— 那和「忘了打前缀」是两件事。
    expect(parseLine("/")).toEqual({ kind: "empty" });
    expect(parseLine("/   ")).toEqual({ kind: "empty" });
  });

  it("⚠️ 前缀**不进词**：`/batch all /status` 的内层命令名是 `status`（变异：把 `/` 一起分词 → 这里红）", () => {
    // 判据是**今天活着的形状**（`ok` 那一支的字段值），不是点名 `tokenize`：
    // 若 `/` 进了第一个词，`status` 就不是命令名了，内层解析会落 `unknown-command`。
    expect(ok("batch all /status")).toEqual({
      kind: "batch",
      targets: "all",
      command: { kind: "status" },
      line: "/status",
    });
  });
});

/* ── 不认识的命令 ───────────────────────────────────────────────────────── */

describe("不认识的命令：带上最接近的那几个", () => {
  it("`staus` 指向 `status`（相邻换位算一次编辑）", () => {
    const result = fails("staus", "unknown-command");
    expect(result.kind === "unknown-command" && result.suggestions).toEqual(["/status"]);
  });

  it("`usr` 的第一位是 `users` 而不是 `r`（同距离时公共前缀长的在前）", () => {
    // ⚠️ 这是排序第二判据的对照：`users` / `r` 与 `usr` 的距离都是 2，
    // 纯字典序会给 `["r","users"]`。没有前缀那一判据，操作者敲 `usr` 看到的第一项
    // 是那个一字母命令。
    expect(
      fails("usr", "unknown-command").kind === "unknown-command" &&
        (fails("usr", "unknown-command") as { suggestions: readonly string[] }).suggestions,
    ).toEqual(["/users", "/r"]);
  });

  it("建议只来自闭合集（命令名本身），且顺序只由两个字符串决定", () => {
    expect(suggestCommands("staus")).toEqual(["status"]);
    expect(suggestCommands("statuss")).toEqual(["status"]);
    expect(suggestCommands("targt")).toEqual(["targets"]);
    // 短到不可能是手滑的输入不给建议（那时候的「接近」全是噪声）
    expect(suggestCommands("xy")).toEqual([]);
    expect(suggestCommands("")).toEqual([]);
    // 完全不像的输入没有建议，但仍然是 unknown-command
    const result = fails("zzzzzzzzz", "unknown-command");
    expect(result.kind === "unknown-command" && result.suggestions).toEqual([]);
  });

  it("⚠️ 不回显敲了什么（粘贴进来的凭据不许被抄进结果区）", () => {
    const result = fails("S3CR3Ttokenvalue", "unknown-command");
    expect(JSON.stringify(result)).not.toContain("S3CR3Ttokenvalue");
    // 建议全部来自闭合集（`COMMAND_NAMES`），不是用户输入的派生
    for (const one of (result as { suggestions: readonly string[] }).suggestions) {
      expect(COMMAND_NAMES).toContain(one);
    }
  });

  it("⚠️ 零兼容：表里删掉的那一族**不留别名**，而今天存在的同族命令收得到", () => {
    // ⚠️ 锚点是**用户真会敲的那一串**加 `parseLine` 的返回档，不是某个符号名 ——
    // 点名一个已删掉的符号会让这条断言恒真（根 `AGENTS.md`「写护栏时」）。
    // 而别名是最容易被"顺手加回来"的东西（它看起来像「兼容老脚本」）。
    for (const line of [
      "/session hide bob",
      "/session show bob",
      "/session",
      // ⚠️ 逐个旧命令都收不到：增删改查全在弹窗里，而弹窗**不认命令行**
      "/user",
      "/user add bob",
      "/user set bob disabled on",
      "/user pass bob pw",
      "/target",
      "/target add prod http://127.0.0.1:3010 tok",
      "/target del prod",
      "/provider show",
      "/provider set https://x m sk-y",
      // ⚠️ 控制面清单窗口改过名，而**旧名不留**：两个名字的话 `parseLine` 与补全会说两件事
      "/managers",
    ]) {
      expect(parseLine(line).kind, line).toBe("unknown-command");
    }
    // ⚠️ **正向对照**：今天存在的同族命令收得到 —— 少了它，上面那十几条只是「全都不认识」
    for (const line of ["/users", "/targets", "/accounts", "/sessions", "/providers"]) {
      expect(parseLine(line).kind, line).toBe("ok");
    }
  });
});