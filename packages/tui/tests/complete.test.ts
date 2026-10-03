/**
 * `@/cmd/complete` 的行为面：当前这一行 + 光标位置 → 建议
 *
 * **这一档锁的是「补全吃掉用户已经敲好的东西」**。补全在句子中间被按（Tab）时，界面上看不出
 * 差别，而用户敲好的后半行 —— 一个流量上限、一条 token —— 会消失。那是本工具能造成的一类
 * 最贵的数据丢失（凭据要重敲、地址要重新找），而 `pnpm typecheck` 与 `pnpm lint` 看不见它。
 * 故本档的核心断言是「光标之后的每一个字节逐字不变」，并且**做过变异**：把补全改成按整行
 * 重建，断言必须转红。
 *
 * ## ⚠️ 本模块只管**形参的值**（命令名归 `@/cmd/palette.js` 那块命令面板）
 * @description
 * 候选只许来自两个数据源：某个形参位置上的 `choices`（组名 `target` 的下一段、`user set` 的
 * 字段名、`help` 的主题）与调用方喂进来的台账名字。任何「哪个更常用」式的排序都会让列表随
 * 实现细节漂移，故排序判据只有三个，全部是「两个字符串」的纯函数。
 * ⚠️ 「命令名」**曾经**也是候选之一，现在不是：命令名是一个 19 行、带说明、能上下走的面板，
 * 与「这一个词后面能接什么」不是同一个问题。两层都答「命令名的第一个候选」的话，`/c` 会
 * 得到两个不同的命令（这里按字典序、那里按表的顺序）。
 *
 * ## 负向断言的锚点
 * @description
 * 全部是**输入**（`/user pass bob ` / `/target add n url ` / `/user set bob quotaWindow `），
 * 不是符号名 —— 点名一个不存在的符号，断言会恒真而不是失败（根 `AGENTS.md`「写护栏时」）。
 */

import { describe, expect, it } from "vitest";
import { COMMAND_PREFIX } from "@/cmd/parse.js";
import { complete, type Completion } from "@/cmd/complete.js";

/** 台账里三个名字（乱序给出：排序不许依赖喂进来的顺序） */
const NAMES = ["staging", "prod", "dev"] as const;

/**
 * 在 `caret` 处放一个 `|` 便于读，然后把 `|` 去掉
 * @description ⚠️ **这里补上 {@link COMMAND_PREFIX}**：本档的用例写的是**命令名**（`user set …`），
 * 而「必须以 `/` 开头」由 `packages/tui/tests/parse.test.ts` 那一组断言守，不在这里重复。
 */
function at(lineWithCaret: string, targetNames: readonly string[] = NAMES): Completion {
  const caret = lineWithCaret.indexOf("|");
  const line = lineWithCaret.slice(0, caret) + lineWithCaret.slice(caret + 1);
  return complete({
    line: COMMAND_PREFIX + line,
    cursor: caret + COMMAND_PREFIX.length,
    targetNames,
  });
}

/** 一次补全的候选（`at` 的 shorthand） */
function cands(lineWithCaret: string, targetNames: readonly string[] = NAMES): readonly string[] {
  return at(lineWithCaret, targetNames).candidates;
}

/* ── 第一段：命令名**不归这里** ──────────────────────────────────────────── */

describe("第一段（命令名）：候选恒为空，而那条路归命令面板", () => {
  it("⚠️ 命令名一个候选都不给（变异：把 `TOP_LEVEL_NAMES` 加回来 → 这里红）", () => {
    // 判据锚在**今天活着的行为**（返回值）而不是某个被删掉的符号名。
    expect(cands("|")).toEqual([]);
    expect(cands("s|")).toEqual([]);
    expect(cands("user|")).toEqual([]);
    expect(cands("st|")).toEqual([]);
  });

  it("⚠️ 也不给**不认识的**那一段候选（原来 `st` → `status`）", () => {
    // 这一条与上一条是**两件不同的事**：上一条是「命令名归面板」，这一条是「一行已经错了就不提」。
    // 它们合成一条断言的话，「因为判据太宽而给了候选」与「因为该给而没给」会互相掩盖。
    expect(cands("zzz|")).toEqual([]);
    expect(cands("staus|")).toEqual([]);
  });

  it("⚠️ 排序不依赖喂进来的顺序（同一组名字给两种顺序，结果逐字相同）", () => {
    const one = complete({ line: "/target switch ", cursor: 16, targetNames: ["b", "a", "c"] });
    const two = complete({ line: "/target switch ", cursor: 16, targetNames: ["c", "a", "b"] });
    expect(one.candidates).toEqual(["a", "b", "c"]);
    expect(one.candidates).toEqual(two.candidates);
  });

  it("去重（台账里有重名时不给两条一样的）", () => {
    expect(
      complete({ line: "/target switch ", cursor: 16, targetNames: ["dev", "dev", "prod"] })
        .candidates,
    ).toEqual(["dev", "prod"]);
  });
});

/* ── 多级命令 ───────────────────────────────────────────────────────────── */

describe("多级命令：下一段在组之后才出", () => {
  it("`user ` 之后出六个子命令（按字典序）", () => {
    expect(cands("user |")).toEqual(["add", "del", "off", "on", "pass", "set"]);
  });

  it("`target ` 之后出三个子命令", () => {
    expect(cands("target |")).toEqual(["add", "del", "switch"]);
  });

  it("组的那一段上补全：按已敲的前缀收窄", () => {
    expect(cands("user |")).toEqual(["add", "del", "off", "on", "pass", "set"]);
    expect(cands("user a|")).toEqual(["add"]);
    expect(cands("user o|")).toEqual(["off", "on"]);
    expect(cands("target s|")).toEqual(["switch"]);
    expect(cands("target zz|")).toEqual([]);
  });

  it("`user set <用户名> ` 之后才出字段名（就是命令表里那七个）", () => {
    // ⚠️ 判据是**位置**：紧跟 `user set` 的那一格是**用户名**（没有候选），
    // 字段名在用户名**之后**。少写一个 `bob` 而期望这里出字段名，是把形参次序记反了。
    expect(cands("user set |")).toEqual([]);
    expect(cands("user set bob |")).toEqual([
      "disabled",
      "expiresAt",
      "password",
      "quotaBytes",
      "quotaWindow",
      "targetBlacklist",
      "targetWhitelist",
    ]);
    // ⚠️ 对照：前缀 `t` 只剩那两条名单，而 `q` 出的是**配额那两条** ——
    // 少一条都会让「按 t 想输名单」变成一个空列表（而一个空列表看不出是「没有」还是「有但没匹配」）
    expect(cands("user set bob t|")).toEqual(["targetBlacklist", "targetWhitelist"]);
    expect(cands("user set bob q|")).toEqual(["quotaBytes", "quotaWindow"]);
    expect(cands("user set bob p|")).toEqual(["password"]);
  });

  it("`help ` 之后出**命令名**（两级命令的完整名字也算一个候选）", () => {
    // 带空白的候选在插入时会被加引号（`render`），所以 `user add` 是一个合法的候选而不是两个词
    expect(cands("help |")).toEqual([
      "acl",
      "clear",
      "config",
      "help",
      "managers",
      "new",
      "r",
      "status",
      "target",
      "target add",
      "target del",
      "target switch",
      "usage",
      "user",
      "user add",
      "user del",
      "user off",
      "user on",
      "user pass",
      "user set",
      "users",
    ]);
    expect(cands("help st|")).toEqual(["status"]);
  });
});

/* ── 没有候选的那些位置 ─────────────────────────────────────────────────── */

describe("没有候选的那些位置：返回空列表，不瞎猜", () => {
  it("用户名与用量名：本层手里没有账号清单", () => {
    expect(cands("user add |")).toEqual([]);
    expect(cands("user on |")).toEqual([]);
    expect(cands("user del |")).toEqual([]);
    expect(cands("usage |")).toEqual([]);
  });

  it("⚠️ 值那一格**不给**任何候选（那是用户自己知道的东西）", () => {
    // `user set <用户名> <字段> <值>`：值是第 3 格，字段名已经过了
    expect(cands("user set bob quotaBytes |")).toEqual([]);
    expect(cands("user set bob disabled |")).toEqual([]);
    expect(cands("user set bob password |")).toEqual([]);
    expect(cands("user add bob |")).toEqual([]);
  });

  it("⚠️ 凭据那一格**永不给**候选（token 与新密码不是能补出来的东西）", () => {
    expect(cands("target add prod http://127.0.0.1:8080 |")).toEqual([]);
    expect(cands("user pass bob |")).toEqual([]);
    expect(cands("target add prod http://127.0.0.1:8080 tok |")).toEqual([]);
  });

  it("命令已经用满了形参：后面再多一个词也不提候选", () => {
    expect(cands("status |")).toEqual([]);
    expect(cands("clear extra |")).toEqual([]);
    expect(cands("user add bob 1g |")).toEqual([]);
  });

  it("第一段就不认识：整行已经错了，不提任何候选", () => {
    expect(cands("nope |")).toEqual([]);
    expect(cands("nope su|")).toEqual([]);
    // 组的后一段不在闭合集里：同样不提（提了等于让人在一行错话上继续敲）
    expect(cands("user nope |")).toEqual([]);
  });

  it("没有候选时那一行**逐字不变**（一次「按了 Tab 什么都没发生」是可观察的）", () => {
    const line = "/user set bob quotaBytes 1g";
    const result = complete({ line, cursor: line.length });
    expect(result.candidates).toEqual([]);
    expect(result.line).toBe(line);
    expect(result.cursor).toBe(line.length);
  });
});

/* ── 目标名字来自台账 ───────────────────────────────────────────────────── */

describe("`target switch` / `target del` 的参数是台账里的名字（由调用方喂进来）", () => {
  it("两个位置都给名字清单", () => {
    expect(cands("target switch |")).toEqual(["dev", "prod", "staging"]);
    expect(cands("target del |")).toEqual(["dev", "prod", "staging"]);
  });

  it("按前缀收窄", () => {
    expect(cands("target switch st|")).toEqual(["staging"]);
    expect(cands("target del p|")).toEqual(["prod"]);
  });

  it("喂进来的清单是空的 = 没有名字可补（不许自己去读台账）", () => {
    expect(complete({ line: "target switch ", cursor: 15 }).candidates).toEqual([]);
    expect(complete({ line: "target switch ", cursor: 15, targetNames: [] }).candidates).toEqual(
      [],
    );
  });

  it("补全之后那一行真的能被解析成同一条命令（闭包：补全不许造出解析不了的行）", () => {
    const result = at("target switch |");
    expect(result.line).toBe("/target switch dev");
  });
});

/* ── 只动光标所在那个词 ─────────────────────────────────────────────────── */

describe("⚠️ 只动光标所在那个词：后面的内容一个字节都不许变", () => {
  it("光标在词中间：补全那个词，光标之后的词逐字保留", () => {
    // `target switch pr|od extra keep` —— 后半行是用户已经敲好的
    const result = at("target switch pr|od extra keep");
    expect(result.candidates).toEqual(["prod"]);
    expect(result.line).toBe("/target switch prod extra keep");
    expect(result.cursor).toBe(19);
  });

  it("光标在词中间、且那个词正是命令表里的字段名：尾部的值保留", () => {
    const result = at("user set bob quotaB|ytes 1g");
    expect(result.candidates).toEqual(["quotaBytes"]);
    expect(result.line).toBe("/user set bob quotaBytes 1g");
    expect(result.cursor).toBe(24);
  });

  it("光标在词中间、那一格有台账名字：尾部保留", () => {
    const result = at("target switch de|v 1g");
    expect(result.line).toBe("/target switch dev 1g");
  });

  it("光标落在**空白**上：它是一个空词，后面的词一个字节都不动", () => {
    // 光标压在那个空格上（不是压在 `prod` 的第一个字符上），故空词在光标处、
    // `prod` 完整地留在后面 —— 结果是四个词，那**不是**本层要管的事：
    // 本层只承诺「不吞字」，接不接受由界面层决定。
    const result = at("target switch | prod");
    expect(result.candidates).toEqual(["dev", "prod", "staging"]);
    expect(result.line).toBe("/target switch dev prod");
    expect(result.cursor).toBe(18);
  });

  it("行尾的空白：空词在行尾，插进去就行", () => {
    const result = at("target switch   |");
    expect(result.line).toBe("/target switch   dev");
  });

  it("光标紧跟空白、后面已经有一个词：那个词**就是**光标词（与 shell 的 complete-word 一致）", () => {
    // 判据写清是因为它和上一条**故意相反**：光标在某个词的第一个字符上时，
    // 候选替换的是那个词（否则同一行会多出一个词）
    const result = at("target switch |prod");
    expect(result.candidates).toEqual(["dev", "prod", "staging"]);
    expect(result.line).toBe("/target switch dev");
    expect(result.cursor).toBe(18);
  });

  it("光标在**命令名**那一段上、行后面还有内容：一个候选都不给（那归命令面板）", () => {
    // ⚠️ 这一条曾经断言「`sta|` → `/status`」。现在命令名归 `@/cmd/palette.js`：
    // 本层在一个**已经被面板接管**的位置上再给一次答案，就是两个答案（且排序不同）。
    const result = at("sta| extra-words here");
    expect(result.candidates).toEqual([]);
    expect(result.line).toBe("/sta extra-words here");
    expect(result.cursor).toBe(4);
  });

  it("没有候选时那一行与光标都不动（哪怕光标在词中间）", () => {
    const result = at("user set bob quotaBytes t| 1g");
    expect(result.candidates).toEqual([]);
    expect(result.line).toBe("/user set bob quotaBytes t 1g");
    expect(result.cursor).toBe(26);
  });
});

/* ── 插入形态 ───────────────────────────────────────────────────────────── */

describe("带空白的候选必须加引号（否则补全会把一个名字变成两个参数）", () => {
  it("名字里有空格：插入后加双引号，光标落在收尾引号之后", () => {
    const result = at("target switch my|", ["my target", "prod"]);
    expect(result.line).toBe('/target switch "my target"');
    expect(result.cursor).toBe(26);
  });

  it("⚠️ 名字里有引号或反斜杠：也要加引号并转义（否则读回来就不是同一个名字）", () => {
    // 字典序：`back\slash` < `we"ird`
    const result = at("target del |", ['we"ird', "back\\slash"]);
    expect(result.line).toBe('/target del "back\\\\slash"');
    const quoted = at("target switch |", ['we"ird']);
    expect(quoted.line).toBe('/target switch "we\\"ird"');
  });
});

/* ── 边界 ───────────────────────────────────────────────────────────────── */

describe("光标越界：夹住，不抛", () => {
  it("光标在行尾之后按行尾算", () => {
    const result = complete({ line: "/status", cursor: 999 });
    expect(result.candidates).toEqual([]);
    expect(result.line).toBe("/status");
    expect(result.cursor).toBe(7);
  });

  it("光标在行首之前当 0，而 0 处**还没有成型的行**（一个候选都不给）", () => {
    // ⚠️ 夹到 0 之后光标落在前缀 `/` **之前** —— 那一格连「命令名」都还没开始敲，
    // 给候选就是在一个注定要改的行上诱导。夹的职责是「不抛」，不是「凑一个答案」。
    const result = complete({ line: "/status", cursor: -3 });
    expect(result.candidates).toEqual([]);
    expect(result.line).toBe("/status");
    expect(result.cursor).toBe(0);
  });

  it("非有限坐标：NaN 当 0，+∞ 当行尾（`NaN` 落进 `slice` 会静默变成 0 那一侧）", () => {
    const nan = complete({ line: "/target switch ", cursor: Number.NaN, targetNames: NAMES });
    expect(nan.candidates).toEqual([]);
    expect(nan.line).toBe("/target switch ");
    expect(nan.cursor).toBe(0);
    const inf = complete({ line: "/status", cursor: Number.POSITIVE_INFINITY });
    expect(inf.line).toBe("/status");
    expect(inf.cursor).toBe(7);
    expect(complete({ line: "/status", cursor: Number.NEGATIVE_INFINITY }).line).toBe("/status");
  });

  it("小数坐标夹成整数", () => {
    // 6.5 → 6，而 `/` 之后那一段是 `user `（已出那个空格，故这一格是**子命令**而不是命令名）
    expect(complete({ line: "/user ", cursor: 2.7 }).candidates).toEqual([]);
    expect(complete({ line: "/user ", cursor: 6.5 }).candidates).toEqual([
      "add",
      "del",
      "off",
      "on",
      "pass",
      "set",
    ]);
  });

  it("⚠️ 空行 / 不带前缀的行：一个候选都不给（变异：去掉前缀那道闸 → 这里红）", () => {
    // 这两条**曾经**会给 10 个第一段命令名，于是**空输入行**上凭空浮出一截幽灵文本与一句
    // 「Tab 补全：acl clear …」。而那正是「底部那条提示栏一直列着有哪些命令」的来源。
    expect(complete({ line: "", cursor: 0 }).candidates).toEqual([]);
    expect(complete({ line: "", cursor: 0 }).line).toBe("");
    expect(complete({ line: "st", cursor: 2 }).candidates).toEqual([]);
    expect(complete({ line: "/", cursor: 1 }).candidates).toEqual([]);
    // ⚠️ **这一条才真的咬住那道闸**：前面几条去掉闸门之后仍然给零候选（命令名不归本层，
    // 而空行光标就在 0 处），于是一个「前缀那道闸可以删」的结论会从它们上溜过去。
    // 而这里光标在行尾 —— 不带 `/` 的多词行本来能拿到字段名 / 名字候选。
    expect(complete({ line: "user set bob ", cursor: 13 }).candidates).toEqual([]);
    expect(complete({ line: "target switch ", cursor: 15 }).candidates).toEqual([]);
    // ⚠️ **退格删掉那个 `/` 之后**的那一行（`" user set bob "`）：去掉闸门之后
    // `line.slice(1, …)` 恰好把 `user` 放回第一段，于是**真的会**给出七个字段名 ——
    // 症状是「我明明删了斜杠，补全还在按 `user set` 给候选」。
    expect(complete({ line: " user set bob ", cursor: 14 }).candidates).toEqual([]);
  });

  it("多个空格 / 制表符都是词边界（切词按空白，不按「恰好一个空格」）", () => {
    expect(at("user   |", NAMES).candidates).toEqual(["add", "del", "off", "on", "pass", "set"]);
    expect(at("user\t|", NAMES).candidates).toEqual(["add", "del", "off", "on", "pass", "set"]);
  });
});
