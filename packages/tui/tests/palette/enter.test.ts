/**
 * `Enter` 那一档的结论：`enterOutcomeOf` —— 接受高亮能改**这一行**就补全，改不了就提交。
 *
 * @description
 * 不变量 ⑥（`Enter` 也接受面板的高亮）有两条判据，**都不是**「命令名有没有被完整敲对」：
 * ① 接受之后**这一行**变没变（`/help` 敲全了高亮就是它自己，按「敲全了就提交」判的话这条命令
 * 按多少次回车都跑不了，而那正是需求的反面）；② **光标不算**（「挪一下插入符」不是一次补全 ——
 * 而 `paletteFill` 的游标算式对它自己刚补出来的尾随空格不自洽）。
 *
 * ⚠️ 本档**不复述**接受逻辑：它只断言 `enterOutcomeOf` 的结论与 {@link paletteFill} 逐字一致，
 * 于是「另抄一份接受逻辑」这件事在类型与断言两侧都不成立。
 *
 * 六条不变量与 N1–N29 / M1–M29 变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/palette
 */

import { describe, expect, it } from "vitest";

import {
  PALETTE_ROWS,
  enterOutcomeOf,
  paletteFill,
  paletteOf,
  type EnterOutcome,
} from "@/commands/palette.js";
import { complete } from "@/commands/complete.js";
import { COMMAND_SPECS, parseLine } from "@/commands/parse.js";

/** 面板里那一行的下标（`paletteOf` 的返回在类型上给不出这个断言要的东西，故这里取一行） */
function rowAt(line: string, index: number): string {
  const palette = paletteOf(line);
  const row = palette.rows[index];
  if (row === undefined) throw new Error(`面板里没有第 ${String(index)} 行（共 ${palette.rows.length} 行）`);
  return row.path;
}

/** 从 `line` 起按 `Enter`，数按了几下才交出 `submit`（`99` = 不动点判据破了） */
function pressesTo(line: string, cursor: number): number {
  let at = cursor;
  let text = line;
  for (let n = 1; n <= 8; n += 1) {
    const got = enterOutcomeOf(text, at);
    if (got.kind === "submit") return n;
    text = got.line;
    at = got.cursor;
  }
  return 99;
}

/* ── 真值表 ───────────────────────────────────────────────────────────────── */

describe("不变量 ⑥：`Enter` 的结论 —— 真值表逐档", () => {
  /**
   * 真值表：**一个分支一行**，第三格是**期望逐字**的出参而不是一句理由
   * @description 判据用 `toEqual` 而不是「`kind` 对不对」：后者对「`fill` 那一支带了一个错的
   * 光标」恒绿，而错的光标会让界面把插入符放到别处（症状是「补完之后敲的形参跑到前面去了」）。
   */
  const TRUTH: ReadonlyArray<readonly [string, number, EnterOutcome]> = [
    // ⚠️ 面板**关着**的那三行（判据：整行不以 `/` 开头 —— 与 `paletteOpen` 同一条）
    ["", 0, { kind: "submit" }],
    ["hello", 5, { kind: "submit" }],
    ["  /help", 7, { kind: "submit" }],
    // 面板开着而**没有高亮**（敲的东西表里没有）：交回解析层去报「不认识的命令」
    ["/zzz", 4, { kind: "submit" }],
    // 接受**改得了**这一行 ⇒ `fill`（`/` 落在第一行 `/help` 上，`/ses` 落在 `/sessions` 上）
    ["/", 1, { kind: "fill", line: "/help", cursor: 5 }],
    ["/ses", 4, { kind: "fill", line: "/sessions", cursor: 9 }],
    ["/user a", 7, { kind: "fill", line: "/user add ", cursor: 10 }],
    // ⚠️ 接受**改不了**这一行 ⇒ `submit`（这就是需求要的那一档）
    ["/help", 5, { kind: "submit" }],
    ["/sessions", 9, { kind: "submit" }],
    ["/user", 5, { kind: "submit" }],
    // ⚠️ 而**敲全了的两段命令名**同样是「命令名没变」⇒ 一下就提交：那个尾随空格是 `Tab` / `↑↓`
    // 给形参留位的（`/user addalice` 那个坑），而 `Enter` 是「跑掉」那一下 —— 按一次却只多一个空格，
    // 屏上就是「按了回车没反应」，那正是 `/help` 此前的症状
    ["/user add", 9, { kind: "submit" }],
    ["/provider show", 14, { kind: "submit" }],
    // ⚠️ **行没变就是 `submit`，与光标在哪儿无关**：同一个 `/user add `，两个光标，同一个结论
    ["/user add ", 10, { kind: "submit" }],
    ["/user add ", 9, { kind: "submit" }],
    // ⚠️ 而**带形参的完整命令**同样是「行没变」⇒ 一下就提交（插入符在行尾这一格不算数）
    ["/user add alice", 14, { kind: "submit" }],
    ["/target switch prod", 18, { kind: "submit" }],
  ];

  it("每一行输入各归一档，且出参逐字相等", () => {
    for (const [line, cursor, want] of TRUTH) {
      expect(enterOutcomeOf(line, cursor), `输入 ${JSON.stringify([line, cursor])}`).toEqual(want);
    }
  });

  it("⚠️ 三档 `submit` 各自**为什么**是 `submit`（不然它们只是一张表，反例时不会转红）", () => {
    // 面板关着：判据是那一整个开头字符，不是「没有高亮」（高亮在关着时恒为 -1，两件事会互相掩盖）
    expect(paletteOf("hello").open).toBe(false);
    expect(paletteOf("hello").at).toBe(-1);
    // 面板开着而没有高亮：这是**两件不同的事**，故两档分开钉
    expect(paletteOf("/zzz").open).toBe(true);
    expect(paletteOf("/zzz").at).toBe(-1);
    // 接受改不了：`/help` 的高亮**就是它自己**，所以「有没有高亮」这一条区分不出这两档
    expect(rowAt("/help", paletteOf("/help").at)).toBe("/help");
    expect(enterOutcomeOf("/help", 5).kind).toBe("submit");
  });
});

/* ── 判据落在「这一行变没变」，不是「敲全了没」也不是「光标动没动」 ───────────── */

describe("不变量 ⑥：判据落在**这一行**，不是「敲全了没」，也不是「光标动没动」", () => {
  it("⚠️ `/help` 敲全了按 Enter 就提交（变异：拿「敲全了」当判据 → 这里红）", () => {
    // 这是本档的核心之一：屏上那一帧是「按了回车没有反应，按一百次也没有反应」——
    // 而 `parseLine("/help")` 明明收它。少这条，需求就只剩「敲一半能补」这一半。
    expect(enterOutcomeOf("/help", "/help".length).kind).toBe("submit");
    // ⚠️ **反向自检**：短一个字母就归 `fill`。少了它，上面那一条也可能只是「面板一律 submit」。
    expect(enterOutcomeOf("/hel", 4).kind).toBe("fill");
  });

  it("**每一条**命令名敲全了都是 `submit`（判据是全表逐条重算，不是抽一个样本）", () => {
    // ⚠️ **全表**而不是「挑几档」：`/user add` 与 `/provider show`（两段）与 `/help`（单段）都在里面，
    // 而「只多一个尾随空格不算补全」那条判据正是靠它们**同时**在表里才立得住 ——
    // 漏掉两段那几行的话，这条判据退化成「单段一律 submit」而两段那一族零鉴别力。
    expect(PALETTE_ROWS.length).toBeGreaterThan(20);
    for (const row of PALETTE_ROWS) {
      expect(enterOutcomeOf(row.path, row.path.length), row.path).toEqual({ kind: "submit" });
    }
  });

  it("⚠️ **同一个行、两个光标、同一个结论**（判据是「行」而不是「行 + 光标」的那唯一一条）", () => {
    // `/user add ` 补出来的那个尾随空格让 `paletteFill` 在 cursor=10 与 cursor=9 上给出**不同**的游标，
    // 而两个下标的**行**是同一个 ⇒ 结论必须也是同一个。判据锚在「同一行 + 两个光标 + 一个结论」，
    // 它是「只比行」这件事唯一的牙齿：把它换成「比对里含光标」的话这一条立刻红。
    expect(enterOutcomeOf("/user add ", 10)).toEqual({ kind: "submit" });
    expect(enterOutcomeOf("/user add ", 9)).toEqual({ kind: "submit" });
    // ⚠️ **反向自检**：同一段命令名**没敲全**时行确实变了 ⇒ 必须是 `fill`。
    // 少了它，上面那两条也可能在「一律 `submit`」的形状上绿。
    expect(enterOutcomeOf("/user ad", 8)).toEqual({ kind: "fill", line: "/user add ", cursor: 10 });
  });

  it("⚠️ 两段命令名**没敲全**时先补出那个尾随空格，补完那一下就提交（故半截名字按两下）", () => {
    // 真链：`/user ad` → 补出 `/user add `（光标 10，落在空格**前**）→ 第二次：命令名没变 ⇒ 提交。
    // 少了这条，「每一条都 submit」会写成一句对两段命令名**恒假**的话。
    expect(enterOutcomeOf("/user ad", 8)).toEqual({
      kind: "fill",
      line: "/user add ",
      cursor: 10,
    });
    expect(pressesTo("/user ad", 8)).toBe(2);
    // ⚠️ 而**敲全了**的那一条一下就提交：它零形参/形参可选时那个空格毫无用处，
    // 而 `/provider show` 是全表**唯一**一条「两段 + 零形参」的命令 —— 它曾因此要按两下
    expect(pressesTo("/user add", 9)).toBe(1);
    expect(pressesTo("/provider show", 14)).toBe(1);
    expect(PALETTE_ROWS.find((row) => row.path === "/provider show")?.needsSpace).toBe(true);
  });

  it("组那一行填不出东西 ⇒ 交回解析层（`/user` 走的是 `bad-args`，不是「组不产生命令」）", () => {
    // ⚠️ 真链是三步：组的名字里**没有空格**，故 `needsSpace` 为假、补不出那个尾随空格 ⇒
    // 「这一行没变」⇒ 提交 ⇒ 解析层报「少一个子命令」。而 `/user a` 补得出尾随空格 ⇒ 先 `fill`。
    expect(enterOutcomeOf("/user", 5).kind).toBe("submit");
    const parsed = parseLine("/user");
    expect(parsed.kind).toBe("bad-args");
    expect(parsed.kind === "bad-args" ? parsed.message : "").toContain("少一个子命令");
    expect(enterOutcomeOf("/user a", 7)).toEqual({ kind: "fill", line: "/user add ", cursor: 10 });
  });

  it("⚠️ `Enter` **不做形参的值补全**（变异：顺手调 `complete` → 这里红）", () => {
    // 光标那个词 `t` 在 `/user set` 的字段名那一格上，而 Tab 在这一行**确实**会给候选 ——
    // 少了这条对照，「Enter 不补值」就分不清是判据成立还是那一行本来就没东西可补。
    expect(complete({ line: "/user set bob t", cursor: 16 }).candidates.length).toBeGreaterThan(0);
    expect(enterOutcomeOf("/user set bob t", 16)).toEqual({ kind: "submit" });
    // ⚠️ 而**光标右边的形参逐字留着**（补全不许造出一行读回来意思变了的话）
    expect(parseLine("/user set bob t").kind).not.toBe("ok");
  });

  it("共用 {@link paletteFill}：每一条 `fill` 的产出都与它对高亮那一行逐字相同", () => {
    // ⚠️ 判据是**逐条重算**而不是「看起来对」：`Tab` / `↑↓` / 鼠标点 / `Enter` 共用同一个接受
    // 实现，另抄一份的后果是「四处的补全各不相同」而屏上没有任何一处会报错。
    for (const line of ["/", "/ses", "/user a", "/target sw x", "/st x"]) {
      const at = paletteOf(line).at;
      const got = enterOutcomeOf(line, line.length);
      if (got.kind !== "fill") continue;
      const row = PALETTE_ROWS[at];
      if (row === undefined) throw new Error(`面板里没有第 ${String(at)} 行`);
      expect({ line: got.line, cursor: got.cursor }, line).toEqual(
        paletteFill(line, line.length, row),
      );
    }
  });
});

/* ── 闭包与代价：按到底一定到 `submit`，且两下之内 ───────────────────────────── */

describe("不变量 ⑥：按到底一定到 `submit`，且**两下之内**", () => {
  it("⚠️ 全表每个前缀都在**两下**之内提交（变异：判据里带上光标 → 这里红）", () => {
    // ⚠️ **两下而不是一下**：两段命令名补得出那个尾随空格，故第一次接受改得了行（补一次），
    // 第二次行没变（提交一次）。判据是「数出来的次数」而不是「某几个样本」——
    // 实现改坏时（光标进判据 / 补全不自洽）哪一档变慢都会转红。
    const slow: string[] = [];
    for (const row of PALETTE_ROWS) {
      const name = row.path.slice(1);
      for (let i = 1; i <= name.length; i += 1) {
        for (const tail of ["", " ", " x"]) {
          const line = `/${name.slice(0, i)}${tail}`;
          const n = pressesTo(line, line.length);
          if (n > 2) slow.push(`${line}: ${String(n)}`);
        }
      }
    }
    expect(slow).toEqual([]);
  });

  it("⚠️ 从敲第一个字到跑掉要按几下（**代价的那张表**，四档**全是一下**）", () => {
    // 单段零形参：一下。单段带形参：一下。**两段零形参：一下**（零形参的尾随空格毫无用处）。
    // **两段带形参：一下** —— 而这一档曾**按两下**（补一次尾随空格 + 提交一次），
    // 屏幕上那一帧是「按了回车没反应，按两次才跑」，与 `/help` 此前的症状同形。
    expect(pressesTo("/status", "/status".length)).toBe(1);
    expect(pressesTo("/config AUTH_TYPE", "/config AUTH_TYPE".length)).toBe(1);
    expect(pressesTo("/provider show", "/provider show".length)).toBe(1);
    expect(pressesTo("/user add alice", "/user add alice".length)).toBe(1);
    // ⚠️ **反向自检**：上面那四行真的落在四档上（`/status` 零形参、`/config` 带形参、
    // `/provider show` 两段零形参、`/user add` 两段带形参）—— 否则这张表钉的是同一档四遍。
    // ⚠️ **分档读的是命令表那份形参表**而不是 `needsSpace`：那个字段答的是「补不补尾随空格」，
    // 而这四档答的是「操作者接下来会不会敲形参」—— `/config` 的形参是选填的，它 `needsSpace` 为假。
    const shapeOf = (path: string): string => {
      const spec = COMMAND_SPECS.find((one) => one.path === path);
      if (spec === undefined) throw new Error(`命令表里没有 ${path}`);
      const segs = spec.name.includes(" ") ? "两段" : "单段";
      return `${segs}·${spec.args.length === 0 ? "零形参" : "带形参"}`;
    };
    expect(shapeOf("/status")).toBe("单段·零形参");
    expect(shapeOf("/config")).toBe("单段·带形参");
    expect(shapeOf("/provider show")).toBe("两段·零形参");
    expect(shapeOf("/user add")).toBe("两段·带形参");
    // ⚠️ 半截名字那一档仍是两下（补一次 + 提交一次），而**跑掉的是补全出来的那一条**，
    // 不是他没敲完的那一条（否则「按一下就跑一条别的命令」正是那一档要防的）
    expect(pressesTo("/user a", 7)).toBe(2);
    expect(parseLine("/user a").kind).toBe("bad-args");
    expect(parseLine("/user add ").kind).toBe("bad-args");
  });

  it("`fill` 之后插入符落在**刚写进去那一段的末尾**，而不在行尾", () => {
    // 少了它，上面那条「两下之内」可以在一个光标乱飞的实现上绿（它照样会收敛）。
    expect(enterOutcomeOf("/ses", 4)).toEqual({ kind: "fill", line: "/sessions", cursor: 9 });
    expect(enterOutcomeOf("/user a", 7)).toEqual({ kind: "fill", line: "/user add ", cursor: 10 });
  });
});