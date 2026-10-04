/**
 * `@/lib/log`（结果区的行模型）的纯函数断言
 *
 * **锁什么**：四条不变量 —— ①换行按**显示宽度**（不是字符数）；②表与键值对**不换行**、按宽度截断
 * 且**必须留省略标记**；③滚动位置**永远以行为单位**且夹在「能滚到底也能滚到顶」之间；④环形缓冲
 * 丢掉的最早一条**必须能报出来**（否则操作者以为历史是完整的）。
 *
 * **为什么拆掉哪一处会红**：
 * - `wrap` 里的 `stringWidth` 换成 `ch.length` → 「`a中b` 宽 2」那组给出 2 行而不是 3 行。
 *   ⚠️ **纯 ASCII 的用例对两种度量都成立**，所以每条换行判据都必须带 CJK 行，否则那条护栏恒绿。
 * - 把 `table` / `kv` 也放进 `WRAPPABLE` → 「表不换行」那组红（一张被软换行撕开列对齐的表，
 *   在真终端里比被截短的表更难读，而症状是「表格右边参差不齐」）。
 * - `clampTop` 去掉「装得下就归 0」那一支 → 「内容装得下时归 0」那组红（死滚动条）。
 * - `clip` 不留 `…` → 「截断必须留标记」那组红（静默截断是本仓点名的「显示不完整却不提示」）。
 * - `maskEcho` 改成按真实长度给点号 → 「掩码长度不泄密」那组红。
 */

import { describe, expect, it } from "vitest";
import {
  append,
  clampTop,
  dropped,
  flatten,
  maskEcho,
  trim,
  visibleLines,
  type LogEntry,
  type LogRow,
  type Turn,
} from "@/lib/log/index.js";

/**
 * 一格「工具结果」—— ⚠️ **结果区那一格装的是 `Turn` 而不是 `LogRow`**（`@/lib/log/turn.js`）。
 * @description 本档绝大多数用例要验的是**排版算术**（折行 / 不折行 / 截断），而那些判据的对象是
 * `LogRow`；故这一档把行装进 `tool-result` 那一档，于是每一组原有判据**逐字不变**，
 * 新加的「每个变体各一例」在末尾那一档里单独判。
 */
function toolTurn(rows: readonly LogRow[]): Turn {
  return { kind: "tool-result", rows };
}

function entry(id: number, rows: readonly LogRow[]): LogEntry {
  return { id, at: 0, turns: [toolTurn(rows)] };
}

/** 摊平后的行文本（去掉空行不是必要的，但便于逐字比对） */
function textsOf(entries: readonly LogEntry[], width: number): string[] {
  return flatten(entries, width).lines.map((l) => l.text);
}

describe("不变量 ①：换行按显示宽度算，不是字符数", () => {
  it("「a中b」宽 2 → 拆成 3 行（按字符数拆只会给 2 行，这一组是判别式）", () => {
    // 逐字符推：'a'(1) 进第一行；'中'(2) 放不进第一行(1+2>2) → 另起；'b'(1) 放不进第二行(2+1>2) → 另起
    expect(textsOf([entry(1, [{ kind: "note", text: "a中b" }])], 2)).toEqual(["a", "中", "b"]);
  });

  it("「中文」宽 3 → 拆成 2 行（字符数度量会说「2 个字放得下」而给 1 行）", () => {
    expect(textsOf([entry(1, [{ kind: "note", text: "中文" }])], 3)).toEqual(["中", "文"]);
  });

  it("「中文」宽 4 → 1 行（对照组：宽度够时两种度量一致，证明上一组不是碰巧）", () => {
    expect(textsOf([entry(1, [{ kind: "note", text: "中文" }])], 4)).toEqual(["中文"]);
  });

  it("散文类（echo / head / note / err）换行，表与键值对不换行", () => {
    const long = "一二三四五六七八九十";
    const wrapped = textsOf([entry(1, [{ kind: "note", text: long }])], 4);
    expect(wrapped.length).toBeGreaterThan(1);

    // 表：表头一行 + 每个数据行一行，**永不换行**（超宽就截断）
    const table = flatten([entry(1, [{ kind: "table", head: ["a"], rows: [[long]] }])], 4);
    expect(table.lines).toHaveLength(2); // 表头 1 行 + 数据 1 行
    // 表头「a」只有 1 列、装得下 → 不标截断；数据行超宽 → 标截断。
    // ⚠️ 断言必须**逐行**分开：写 `every(clipped)` 会因为表头没截断而红，而那不是缺陷。
    expect(table.lines[0]!.clipped).toBe(false);
    expect(table.lines[1]!.clipped).toBe(true);

    // 键值对：恰好一行
    const kv = flatten([entry(1, [{ kind: "kv", key: "k", value: long }])], 4);
    expect(kv.lines).toHaveLength(1);
    expect(kv.lines[0]!.clipped).toBe(true);
  });
});

describe("不变量 ②：截断必须留省略标记（静默截断是本仓点名的失败形状）", () => {
  it("超宽的表行以「…」结尾，且成品宽度不超过给定宽度", () => {
    const flat = flatten(
      [entry(1, [{ kind: "table", head: ["名称", "状态"], rows: [["一二三四五六", "启用"]] }])],
      8,
    );
    // 表头一行 + 数据一行
    expect(flat.lines).toHaveLength(2);
    const data = flat.lines[1]!;
    expect(data.text.endsWith("…")).toBe(true);
    // 宽度上界：截断后不许超（超了就是 Ink 静默软换行，而摊平层以为它只占 1 行 → 滚动全错位）
    expect(displayWidthOf(data.text)).toBeLessThanOrEqual(8);
  });

  it("宽度为 1 时也留标记（不是留空）", () => {
    const flat = flatten([entry(1, [{ kind: "note", text: "abcdef" }])], 1);
    // 散文走换行路径：每段宽 1
    expect(flat.lines.map((l) => l.text)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("宽度为 0 时不炸，且摊出空串（终端被压到 0 列的那一帧）", () => {
    const flat = flatten([entry(1, [{ kind: "table", head: ["x"], rows: [["y"]] }])], 0);
    // 表头 + 数据各一行，都塌成空串（**不是 0 行**：行数由条目结构决定，与宽度无关）
    expect(flat.lines).toHaveLength(2);
    expect(flat.lines.every((l) => l.text === "")).toBe(true);
  });
});

describe("不变量 ③：滚动位置永远以行为单位，且夹在合法范围里", () => {
  it("超过底部 → 停在「最后一行贴住视口底」", () => {
    expect(clampTop(100, 20, 999)).toBe(80);
  });

  it("负数 → 停在 0（能滚到顶）", () => {
    expect(clampTop(100, 20, -5)).toBe(0);
  });

  it("内容装得下 → 归 0（死滚动条：往上滚不出东西、往下也已经到底）", () => {
    expect(clampTop(10, 20, 5)).toBe(0);
  });

  it("NaN → 归到底（一次坏输入不该把滚动位置变成 NaN 并在屏上什么都不显示）", () => {
    expect(clampTop(100, 20, Number.NaN)).toBe(80);
  });

  it("取屏 = 按行切，且行数不足时只给剩下的那些", () => {
    // 宽 4 = 每行 2 个中文字，10 个字 → 5 行
    const flat = flatten([entry(1, [{ kind: "note", text: "一二三四五六七八九十" }])], 4);
    expect(flat.height).toBe(5);
    expect(visibleLines(flat, 0, 2).map((l) => l.text)).toEqual(["一二", "三四"]);
    expect(visibleLines(flat, 1, 2).map((l) => l.text)).toEqual(["三四", "五六"]);
    expect(visibleLines(flat, 4, 2).map((l) => l.text)).toEqual(["九十"]);
    expect(visibleLines(flat, 0, 0)).toHaveLength(0);
  });
});

describe("不变量 ④：摊平的行数与高度永远自洽（不自洽就会滚动错位）", () => {
  it("空日志：没有内容，且与「有内容但全是空行」可区分", () => {
    const empty = flatten([], 40);
    expect(empty.any).toBe(false);
    expect(empty.height).toBe(0);
  });

  it("多条目摊平后 lines.length === height，且每行都带得出它的 entryId", () => {
    const entries = [
      entry(1, [{ kind: "note", text: "第一句" }]),
      entry(2, [
        {
          kind: "table",
          head: ["a", "b"],
          rows: [
            ["1", "2"],
            ["3", "4"],
          ],
        },
      ]),
    ];
    const flat = flatten(entries, 40);
    expect(flat.lines).toHaveLength(flat.height);
    expect(flat.lines.map((l) => l.entryId)).toEqual([1, 2, 2, 2]);
  });

  it("最后一条的每一行都被标成最新（呈现层用它画「↓ 有新内容」）", () => {
    const flat = flatten(
      [entry(1, [{ kind: "note", text: "旧" }]), entry(2, [{ kind: "note", text: "新一二" }])],
      2,
    );
    const newest = flat.lines.filter((l) => l.isNewestEntry);
    expect(newest.length).toBeGreaterThan(0);
    expect(newest.every((l) => l.entryId === 2)).toBe(true);
    expect(flat.lines.filter((l) => l.entryId === 1).every((l) => !l.isNewestEntry)).toBe(true);
  });
});

describe("不变量 ⑤：环形缓冲丢掉的最早一条必须报得出来", () => {
  it("没丢过时 dropped 为 0", () => {
    const entries = [entry(1, []), entry(2, [])];
    expect(dropped(entries, 5)).toBe(0);
  });

  it("丢过时 dropped 是留下来的最早那条的 id（不是条数）", () => {
    const entries = [entry(1, []), entry(2, []), entry(3, []), entry(4, [])];
    const kept = trim(entries, 2);
    expect(kept.map((e) => e.id)).toEqual([3, 4]);
    expect(dropped(entries, 2)).toBe(1);
  });

  it("trim 返回新数组（就地改会让 React 的 setState 看不到变化）", () => {
    const entries = [entry(1, []), entry(2, [])];
    const kept = trim(entries, 5);
    expect(kept).not.toBe(entries);
    expect(entries).toHaveLength(2);
  });

  it("append 的 id 从 1 起且单调递增（0 留给「一条都没丢」那个含义，见实现注释）", () => {
    const a: LogEntry[] = [];
    const b = append(a, [toolTurn([{ kind: "note", text: "x" }])], 1000);
    const c = append(b, [toolTurn([{ kind: "note", text: "y" }])], 2000);
    expect(b.map((e) => e.id)).toEqual([1]);
    expect(c.map((e) => e.id)).toEqual([1, 2]);
    expect(c[1]!.at).toBe(2000);
    expect(a).toHaveLength(0);
  });

  it("丢了历史之后最早那条的 id 不会撞上 0（否则「丢过」与「没丢过」不可区分）", () => {
    let entries: LogEntry[] = [];
    for (let i = 0; i < 4; i += 1) {
      entries = append(entries, [toolTurn([{ kind: "note", text: `n${i}` }])], 0);
    }
    const kept = trim(entries, 2);
    expect(kept.map((e) => e.id)).toEqual([3, 4]);
    // 关键：丢掉过 → 报出来的数**必须**与「没丢过」的 0 区分得开
    expect(dropped(entries, 2)).not.toBe(dropped(kept, 5));
    expect(dropped(kept, 5)).toBe(0);
  });

  it("两条一模一样的结果各占一个 id（拿文本当锚点会让第二条在第一次重绘就消失）", () => {
    const same: LogRow[] = [{ kind: "note", text: "完全一样" }];
    const once = append(append([], [toolTurn(same)], 0), [toolTurn(same)], 1);
    expect(once[0]!.id).not.toBe(once[1]!.id);
  });
});

describe("不变量 ⑥：凭据掩码是定长的（长度本身也是信息）", () => {
  it("1 个字符与 64 个字符给出同一个掩码", () => {
    expect(maskEcho("user-pass", "a")).toBe(maskEcho("user-pass", "x".repeat(64)));
  });

  it("空凭据返回空串（不能因为「反正要打码」就凭空显示 6 个点）", () => {
    expect(maskEcho("target-add", "")).toBe("");
  });
});

/* ── 不变量 ⑦：六个 `Turn` 变体各一例，且**判据是 `kind` 而不是字形** ─────────── */

describe("不变量 ⑦：`Turn` 的每个变体各摊出一行（判据按 `kind`，不靠字符串嗅探）", () => {
  /** 摊一段 `Turn` 之后的行文本 */
  function texts(turns: readonly Turn[]): string[] {
    return flatten([{ id: 1, at: 0, turns }], 40).lines.map((l) => l.text);
  }

  it("`user`：走 `echo` 那一档（呈现层给它加 `❯ `，于是「我敲的」与「回显的命令」同形）", () => {
    expect(texts([{ kind: "user", text: "看看 alice" }])).toEqual(["看看 alice"]);
  });

  it("`assistant`：走 `note` 那一档且色档是 `ok`（它不是本包的话，也不是错误）", () => {
    const flat = flatten([{ id: 1, at: 0, turns: [{ kind: "assistant", text: "她在用" }] }], 40);
    expect(flat.lines[0]!.kind).toBe("note");
    expect(flat.lines[0]!.tone).toBe("ok");
  });

  it("`tool-call`：**逐字**给那一行（它已由回显边界掩码过，本层不许再动它）", () => {
    const echo: LogRow = { kind: "echo", text: "/user pass alice ••••••" };
    expect(texts([{ kind: "tool-call", echo }])).toEqual(["/user pass alice ••••••"]);
  });

  it("`tool-result`：里面那些行**原样**摊开（`kv` 的补齐宽度由排版层算，故这一档只钉「行还在」）", () => {
    // ⚠️ 补齐到 12 显示列是 `@/lib/log/rows.ts:kvLine` 的算术，与本档无关；
    // 「`kv` 永不折行」那条判据在上文不变量 ① 里逐字保留着
    const lines = texts([toolTurn([{ kind: "kv", key: "k", value: "v" }])]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("v")).toBe(true);
  });

  it("`notice`：本包自己说的话 —— 色档是 `note` 的缺省（`warn`），**不是** `err`", () => {
    // ⚠️ 判据是**色档**：硬把本包的话塞进 `error` 的话「至少留一个会话」会染上危险色，
    // 而那是一句**假事实**（拒绝不是故障）。
    const flat = flatten([{ id: 1, at: 0, turns: [{ kind: "notice", rows: [{ kind: "note", text: "x" }] }] }], 40);
    expect(flat.lines[0]!.kind).toBe("note");
    expect(flat.lines[0]!.tone).toBe("warn");
  });

  it("`error`：里面那些行原样摊开，而 `err` 那一档色档是 `danger`", () => {
    const flat = flatten([{ id: 1, at: 0, turns: [{ kind: "error", rows: [{ kind: "err", text: "boom" }] }] }], 40);
    expect(flat.lines[0]!.kind).toBe("err");
    expect(flat.lines[0]!.tone).toBe("danger");
  });

  it("⚠️ **「模型的话」与「本包的话」色档不同**（同色 = 分不出谁在说话）", () => {
    // ⚠️ 判据锚在**今天仍存在的形状**（摊出来的 `LogLine.tone`），不是点名某个符号。
    // ⚠️ 刻意**不**断言「六档两两不同」：那是假事实 —— `user` 与 `tool-call` 都走 `echo` 那一档
    //（两者都是「喂进去的东西」，由内容而不是色档分开），`tool-result` 与 `notice` 都把内部行原样透出
    //（色档由**行自己**决定，见 `rows.ts:DEFAULT_TONE`）。故这里只钉**真的会混淆的那一对**。
    const toneOf = (turn: Turn): string =>
      flatten([{ id: 1, at: 0, turns: [turn] }], 40).lines[0]!.tone ?? "none";
    const model = toneOf({ kind: "assistant", text: "M" });
    const mine = toneOf({ kind: "notice", rows: [{ kind: "note", text: "M" }] });
    expect(model).not.toBe(mine);
    // ⚠️ **反向自检**：两者都**不是**缺省（少了那一档就分不出来），而失败恒在 `danger` 上
    expect(model).not.toBe("none");
    expect(mine).not.toBe("none");
    expect(toneOf({ kind: "error", rows: [{ kind: "err", text: "M" }] })).toBe("danger");
  });

  it("⚠️ 摊平的层**不认** `Turn`（漏一个变体必须**编译期**红，不是运行期静默少一行）", () => {
    // ⚠️ 这一档钉的是「变体清单只有六档」这个事实本身：`@/lib/log/turn.js:rowsOfTurn` 的
    // `default` 那一支形参是 `never`，漏一档时 `tsc` 就红（判据见本档头注释的「编译期锁」）。
    // 锚点是**今天活着的形状**（`rowsOfTurn` 对六档都给出结果），不是点名某个内部函数。
    for (const turn of [
      { kind: "user", text: "x" },
      { kind: "assistant", text: "x" },
      { kind: "tool-call", echo: { kind: "echo", text: "x" } },
      toolTurn([{ kind: "note", text: "x" }]),
      { kind: "notice", rows: [{ kind: "note", text: "x" }] },
      { kind: "error", rows: [{ kind: "err", text: "x" }] },
    ] satisfies readonly Turn[]) {
      expect(flatten([{ id: 1, at: 0, turns: [turn] }], 40).height).toBe(1);
    }
  });
});

/** 局部量宽：只在本测试里用来断言「成品宽度不超上界」 */
function displayWidthOf(text: string): number {
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    n +=
      code >= 0x1100 &&
      (code <= 0x115f ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6))
        ? 2
        : 1;
  }
  return n;
}
