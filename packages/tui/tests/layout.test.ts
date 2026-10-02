/**
 * `@/console/layout` 的**真渲染**断言（假 TTY + 真 Ink）
 *
 * ## 为什么这一档非有不可
 * @description
 * 这一档守的是三条**只有真渲染才看得见**的退化，而它们 `tsc` / `eslint` / 全部纯函数单测都看不见：
 * 1. **Ink 对过宽的 `<Text>` 是静默软换行。** 一换行，**后面所有行都往下移**、边框随之错位 ——
 *    症状是「侧边栏里有一个名字把整块框顶歪了」。而它**只在长名字那一档出现**：
 *    短名字的用例全绿，长 CJK 名字（显示宽度是 ASCII 的两倍）才把它顶出来。
 * 2. **选中态是不是一段连续的反底色。** 拆成三段（记号 / 字形 / 名字）的话那一行读起来是
 *    「两段高亮夹一个亮点」，而侧边栏的唯一职责就是回答「现在是哪一台」。
 * 3. **logo 与结果区是同一个位置**，所以「该显示哪一个」是布局的判据，而纯函数测不到它。
 *
 * 本档写下这三条之前，它们**都真的发生过**（本包历史上第一个 bug 就是真渲染才逮到的）。
 *
 * ## 假 TTY 而不是真终端
 * @description
 * `render()` 要一个 `stdout.isTTY`（否则 Ink 退化成逐帧输出、不排边框）与 `columns` / `rows`
 * —— 这三个都能**注入**，故不需要真 pty。⚠️ 本档**测不到**「真终端退出后干不干净」那一半。
 *
 * ## 每条负向断言都做过变异
 * @description
 * 见文件末尾那七条「变异实测」记录：把被防住的行为放回去，断言必须转红。
 */

import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";

// ⚠️ `FORCE_COLOR` 必须在 **ink（因而 chalk）被 import 之前**设好，否则 chalk 会按
// 「本进程标准输出不是终端」把 level 定成 0，而那样 Ink **根本不生成任何转义序列** ——
// 于是「着色是不是连续的一段」那条判据会变成一个恒真的空断言（没有序列 = 没有裸格子）。
// ⚠️ `vi.hoisted` 是 vitest 唯一保证「在 import 之前」的手段；
// 写在模块体里就晚了（ESM 的 import 先求值），实测那样整档会绿。
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { caretFromColumn, geometry, hitTest } from "@/console/geometry.js";
import { flatten, type FlatLog, type LogEntry, type LogRow } from "@/console/log.js";
import { Layout, type LayoutProps } from "@/console/layout.js";
import { PALETTE_ROWS } from "@/cmd/palette.js";

/** 本档用的标准尺寸（下面的用例大多围绕它） */
const COLUMNS = 100;
const ROWS = 28;

/** 一个假 TTY：Ink 只要求 `isTTY` / `columns` / `rows` / `write` */
function fakeStdout(columns: number, rows: number): PassThrough & {
  columns: number;
  rows: number;
  isTTY: boolean;
} {
  const stream = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  return stream;
}

/**
 * 真渲染一次，返回**那一帧的全部行**（ANSI 已去掉，空行已滤掉）
 * @description
 * ⚠️ `interactive: false` 是这里的关键：它让 Ink **不排增量帧**，而是在 `unmount()` 时把
 * 最后一帧**一次性**写出来（`ink/build/ink.js` 的 unmount 分支），故缓冲里恰好一份纯文本帧。
 * ⚠️ 不用它就得去切 `log-update` 的光标移动序列 —— 本档实测踩过两次：按 `\u001B[?2026h` 切会
 * 切出一个只含**半帧**的「最后一帧」，于是每一条断言都在半个屏上跑，而它看起来还挺像真的。
 */
async function renderFrame(props: LayoutProps): Promise<readonly string[]> {
  const stdout = fakeStdout(props.columns, props.rows);
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const stdin = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
  });
  const instance = render(createElement(Layout, props), {
    stdout: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
    interactive: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  instance.unmount();
  await new Promise((resolve) => setTimeout(resolve, 40));
  // ⚠️ **反向自检**：Ink 必须真的写了东西。少了它，一个「什么都没渲染出来」的实现会让本档
  // 的每一条 `includes` 都绿 —— 而「渲染是空的」恰恰是这一类界面最可能的失败形态。
  // ⚠️ 判据只判「有输出」，**不**判「有满屏」：`rows = 1` 时只剩两片边框（那是正确的形态）。
  return stripAnsi(output)
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * 去掉 CSI / SGR 序列（**逐字符扫**而不是一条正则）
 * @description ⚠️ 判据里的 `\u001B` 会把本包的 `no-control-regex` 触发，而给测试档开一条
 * `eslint-disable` 等于让这条纪律从此不再被看见 —— 这里的**唯一**写法就是「按字节扫」。
 * ⚠️ 终止条件是「参数段之后的第一个字母」（CSI 的最后一段），而**不是**任何字母：
 * 字符串里出现裸字母时按后者判会**把正文吃掉**。
 */
function stripAnsi(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "\u001B") {
      out += ch;
      i += 1;
      continue;
    }
    const bracket = text.indexOf("[", i);
    // 没有 `[` 或没有终止字母 ⇒ 不是一条 CSI，原样留着（那是一个 ESC 键之类）
    if (bracket === -1 || bracket > i + 2) {
      out += ch;
      i += 1;
      continue;
    }
    let end = bracket + 1;
    while (end < text.length && !/[A-Za-z]/u.test(text[end] as string)) end += 1;
    i = end < text.length ? end + 1 : text.length;
  }
  return out;
}

/**
 * 第 `index` 个字符渲染时，某种着色**是否处于生效状态**
 * @description ⚠️ **这是本档最容易写坏的一个探测器**，而它坏掉的方式是**恒绿**：
 * 早前一版只判断「这个位置之前有没有出现过转义序列」—— 于是一个把高亮**拆成三段**的实现
 * （段与段之间有 `49m` 关背景）也照样通过，而那正是这条断言要挡的东西。
 * 故这里真的**解析 SGR 参数**：`0` / `49` 关背景、`40`-`47` / `100`-`107` / `48;…` 开背景，
 * `39` 只关前景（**不动背景**），`?…` 那类私有序列跳过。
 * @description 参数取值范围（ECMA-48）落在实现里而不是抄一份表 —— 抄的那份会漂。
 */
function sgrStateAt(line: string, index: number, kind: "fg" | "bg"): boolean {
  let on = false;
  let i = 0;
  while (i < index && i < line.length) {
    if (line[i] !== "\u001B") {
      i += 1;
      continue;
    }
    i += 1;
    const start = i;
    while (i < line.length && !/[A-Za-z]/u.test(line[i] as string)) i += 1;
    // ⚠️ **跳掉 CSI 引入的那个 `[`**：留着它的话 `Number("[38")` 是 `NaN`，
    // 于是每一个参数都解析失败、`isOn` 永远为假 —— 而那是一条**恒假**的判据，
    // 它表现为「反向自检永远红」，症状与「实现错了」一模一样（实测踩过一次）。
    const params = line.slice(start + (line[start] === "[" ? 1 : 0), i);
    i += 1; // 跳过终止字母
    if (params.startsWith("?")) continue; // 私有序列（`?25l` 之类）与着色无关
    on = applySgr(codesOf(params), on, kind);
  }
  return on;
}

/** `38;2;187;154;247` → `[38, 2, 187, 154, 247]`（`Number("[38")` 是 `NaN`，见调用点） */
function codesOf(params: string): readonly number[] {
  return params.split(";").map((one) => Number(one));
}

/**
 * 依次施加一串 SGR 参数，返回新的「生效」状态
 * @description ⚠️ **`38` / `48` 之后的参数要被整段跳过**：真彩色写成
 * `38;2;R;G;B`，而 `R`/`G`/`B` 的取值（0–255）**与背景色的 `100`–`107`（亮黑等）重叠** ——
 * 不跳过的话一个前景色序列里的 `104` 会被读成「亮背景黑」，于是判据说「这一格有底色」而
 * 屏幕上根本没有底色。⚠️ 这是本档第二个「看起来能过、其实恒错的陷阱」（实测踩过）。
 */
function applySgr(codes: readonly number[], was: boolean, kind: "fg" | "bg"): boolean {
  let on = was;
  let i = 0;
  while (i < codes.length) {
    const code = codes[i] as number;
    if (code === 0) {
      on = false;
      i += 1;
      continue;
    }
    // 扩展色：`38;5;N`（256 色）跳 2 个，`38;2;R;G;B`（真彩色）跳 4 个
    if (code === 38 || code === 48) {
      const isThisKind = (kind === "fg") === (code === 38);
      if (isThisKind) on = true;
      const form = codes[i + 1];
      i += form === 2 ? 5 : form === 5 ? 3 : 2;
      continue;
    }
    const off = kind === "bg" ? 49 : 39;
    if (code === off) {
      on = false;
      i += 1;
      continue;
    }
    const isOn =
      kind === "bg"
        ? (code >= 40 && code <= 47) || (code >= 100 && code <= 107)
        : (code >= 30 && code <= 37) || (code >= 90 && code <= 97);
    if (isOn) on = true;
    i += 1;
  }
  return on;
}

/**
 * 侧边栏里那些行
 * @description ⚠️ 判据是「**剥掉 ANSI 之后**以 `│` 开头」而不是直接 `startsWith`：
 * 开着颜色时每一行的第一个字节是转义序列，故直接 `startsWith("│")` 会把**全部**侧边栏行滤掉 ——
 * 而滤掉之后 `find` 返回 `undefined`，于是一条本该绿的断言在**零行**上也「绿」不了，
 * 症状是 `expected undefined to be defined`（实测踩过）。
 * @description 返回的是**原始**行（含 ANSI），因为着色那组断言要读它。
 */
function sidebarLines(lines: readonly string[]): readonly string[] {
  return lines.filter((line) => stripAnsi(line).startsWith("│"));
}

/** 一份最小的 props（各用例只改自己关心的那几项） */
function props(over: Partial<LayoutProps> = {}): LayoutProps {
  const columns = over.columns ?? COLUMNS;
  const rows = over.rows ?? ROWS;
  const items = over.items ?? [
    { name: "live-ok", state: "connected" },
    { name: "bad-token", state: "unauthorized" },
  ];
  const flat: FlatLog =
    over.flat ??
    flatten(
      [{ id: 1, at: 0, rows: [{ kind: "kv", key: "写入", value: "已改" }] }] as readonly LogEntry[],
      geometry(columns, rows, items.length, 0).outputWidth,
    );
  return {
    columns,
    rows,
    color: false,
    version: "5.2.0",
    items,
    selected: "live-ok",
    flat,
    top: 0,
    input: "",
    cursor: 0,
    ghost: null,
    hint: null,
    notice: null,
    palette: null,
    mouseHint: null,
    showLogo: false,
    droppedHint: null,
    ...over,
  };
}

/* ── ① 每一行都等宽（Ink 静默软换行的护栏）────────────────────────────── */

describe("不变量 ①：任何一行的显示宽度都不许超过终端列数", () => {
  it("侧边栏里有一个**超长中文名**时，每一行仍然等宽", async () => {
    // ⚠️ 变异：`NAME_BUDGET_OFFSET` 从 4 改成 2 → 那一行超宽 → Ink 软换行 → 后面的行全部下移 →
    // 下面那条「宽度都等于 columns」的断言转红。
    // 名字刻意是**中文**：ASCII 名的显示宽度等于 `String.length`，而中文是两倍，
    // 所以一个纯 ASCII 的用例会同时通过「按 length 算」与「按显示宽度算」两种实现 ——
    // 那样的用例对这条判据**零鉴别力**。
    const lines = await renderFrame(
      props({
        items: [
          { name: "live-ok", state: "connected" },
          { name: "一个非常非常长的控制面名字", state: "unknown" },
        ],
      }),
    );
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
    // ⚠️ **反向自检**：侧边栏里那个名字**只**出现一次 —— 「现在是哪一台」由侧边栏**独占**回答，
    // 屏上别处再写一遍名字就会让操作者去比两个可能不一致的说法。
    expect(lines.filter((line) => line.includes("live-ok"))).toHaveLength(1);
    // 截断必须带省略标记（`ellipsis` 的契约）：被切掉的半个名字读不出来，
    // 而没有 `…` 的话操作者会以为那个名字就那么长
    expect(sidebarLines(lines).some((line) => line.includes("…"))).toBe(true);
  });

  it("相邻两块之间**只有一根竖线**（两根并排读起来像渲染坏了）", async () => {
    // ⚠️ 变异实测 M9（把侧边栏的 `borderRight={false}` 去掉）**整档全绿** ——
    // 而屏上立刻出现 `││` 两根并排的竖线（侧边栏右边框 + 主区左边框，紧挨着）。
    // 故这条判据落在这里：它是「布局看起来对不对」里唯一一条能写成纯字符串的性质。
    const lines = await renderFrame(
      props({
        items: [
          { name: "live-ok", state: "connected" },
          { name: "bad-token", state: "unauthorized" },
        ],
      }),
    );
    for (const line of lines) expect(line).not.toMatch(/││/u);
    // ⚠️ **反向自检**：侧边栏**确实存在**（窄终端下它整个不画，而那时这条断言恒绿）
    expect(sidebarLines(lines).length).toBeGreaterThan(2);
  });

  it("结果区里一段很长的散文会**换行**而不是把框顶歪", async () => {
    const long = "这是一段刻意写得很长的说明文字".repeat(12);
    const flat = flatten(
      [{ id: 1, at: 0, rows: [{ kind: "note", text: long }] }] as readonly LogEntry[],
      geometry(COLUMNS, ROWS, 2, 0).outputWidth,
    );
    const lines = await renderFrame(props({ flat, top: 0 }));
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
    // ⚠️ 反向自检：那一段确实**换行**了（`note` 允许换行，见 `@/console/log.ts` 文件头）
    expect(lines.filter((line) => line.includes("这是一段")).length).toBeGreaterThan(1);
  });

  it("表格行**不换行**（换行会撕开列对齐，而对不齐的表比被截短的表更难读）", async () => {
    const flat = flatten(
      [
        {
          id: 1,
          at: 0,
          rows: [
            {
              kind: "table",
              head: ["username", "配额"],
              rows: [
                ["一个非常长的账号名字", "1.0 GB"],
                ["bob", "512 MB"],
              ],
            },
          ],
        },
      ] as readonly LogEntry[],
      geometry(COLUMNS, ROWS, 2, 0).outputWidth,
    );
    const lines = await renderFrame(props({ flat, top: 0 }));
    expect(lines.filter((line) => line.includes("username"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("bob"))).toHaveLength(1);
  });
});

/* ── ② 选中态是一段连续的反底色 ────────────────────────────────────────── */

describe("不变量 ②：选中那一行是**一段**反底色，不是三段", () => {
  it("选中行的记号、字形、名字**每一个格子都在反底色里**", async () => {
    // ⚠️ `color: true` 才有背景色可比；无色终端下「连续」这个性质无从断言，
    // 而它正是选中态**唯一**可读的那个场合（`▍` 那个记号不能被切断）。
    const raw = await renderRaw(
      props({
        color: true,
        items: [
          { name: "live-ok", state: "connected" },
          { name: "other", state: "unknown" },
        ],
      }),
    );
    const selected = sidebarLines(raw).find((line) => line.includes("live-ok"));
    const other = sidebarLines(raw).find((line) => line.includes("other"));
    expect(selected).toBeDefined();
    expect(other).toBeDefined();
    // ⚠️ **核心判据**：从记号到名字之间的**每一个**格子都必须在**反底色**里。
    // 拆成三段（记号 / 字形 / 名字三个 `<Text>`，而字形那个不给 `backgroundColor`）时，
    // 字形那一格会先 `49m` 关掉背景 —— 而「选中行里有 `▍`」那种断言在那个实现上**照样绿**。
    expect(selected).toContain("▍");
    expect(other).not.toContain("▍");
    const markAt = (selected as string).indexOf("▍");
    const nameAt = (selected as string).indexOf("live-ok");
    expect(nameAt).toBeGreaterThan(markAt);
    for (let i = markAt; i < nameAt; i += 1) {
      expect(sgrStateAt(selected as string, i, "bg")).toBe(true);
    }
    // ⚠️ **反向自检**：未选中那一行的字形那一格**有前景色、没有背景色**。
    // 少了这一条，上面那条判据在「整个侧边栏都不着色」与「整个侧边栏都反底」两个实现上都会绿。
    const glyphAt = (other as string).indexOf("·");
    expect(glyphAt).toBeGreaterThan(-1);
    expect(sgrStateAt(other as string, glyphAt, "fg")).toBe(true);
    expect(sgrStateAt(other as string, glyphAt, "bg")).toBe(false);
  });
});

/* ── ③ logo 与结果区是同一个位置 ────────────────────────────────────────── */

describe("不变量 ③：没选中控制面时出 logo，判据归上层", () => {
  it("`showLogo` 为真时画的是艺术字与引导语，**不含**结果区那一行滚动提示", async () => {
    const lines = await renderFrame(props({ showLogo: true, selected: null }));
    expect(lines.some((line) => line.includes(" #### "))).toBe(true);
    expect(lines.some((line) => line.includes("左边点一个控制面"))).toBe(true);
    // ⚠️ 引导语里的键位**必须与 `@/app.tsx` 的键位一致**：回车是「执行命令」，
    // 说「回车切」时操作者会先按一次回车、看见自己那条空命令没有任何反应，然后以为界面坏了。
    expect(lines.some((line) => line.includes("回车切"))).toBe(false);
    expect(lines.some((line) => line.includes("已改"))).toBe(false);
  });

  it("`showLogo` 为假时画的是结果区与那一行滚动位置", async () => {
    const lines = await renderFrame(props({ showLogo: false }));
    expect(lines.some((line) => line.includes(" #### "))).toBe(false);
    expect(lines.some((line) => line.includes("已改"))).toBe(true);
    expect(lines.some((line) => line.includes("⇅"))).toBe(true);
  });
});

/* ── ④ 滚动位置那一行永远在，且说清「下面还有多少」 ────────────────────── */

describe("不变量 ④：滚动位置那一行永远在", () => {
  const many: readonly LogRow[] = Array.from({ length: 80 }, (_, i) => ({
    kind: "note" as const,
    text: `第 ${String(i + 1)} 行`,
  }));
  const viewportRows = geometry(COLUMNS, ROWS, 2, 0).outputRows;

  it("内容装得下时写「已到底」，装不下时写「下方还有 N 行」", async () => {
    const width = geometry(COLUMNS, ROWS, 2, 0).outputWidth;
    const short = flatten(
      [{ id: 1, at: 0, rows: [{ kind: "note", text: "只有一行" }] }] as readonly LogEntry[],
      width,
    );
    const tall = flatten([{ id: 1, at: 0, rows: many }] as readonly LogEntry[], width);

    const atBottom = await renderFrame(props({ flat: short, top: 0 }));
    expect(atBottom.some((line) => line.includes("已到底"))).toBe(true);

    const scrolled = await renderFrame(props({ flat: tall, top: 0 }));
    expect(scrolled.some((line) => line.includes("下方还有"))).toBe(true);
    // ⚠️ 顶部那一帧不许说「上方还有」（在顶上）
    expect(scrolled.some((line) => line.includes("上方还有"))).toBe(false);

    // ⚠️ 中间那一档说的是**两个方向的计数**而不是「上方还有 N 行」——
    // 后者是「只有上面有」的形态。而两个计数都由视口算，故从几何读、不写死：
    // 写死一个数（实测写的是 48，真值是 49）会让这条断言变成「几何变了它就红」，
    // 而它要守的其实是**文案形态**。
    const middle = await renderFrame(props({ flat: tall, top: 10 }));
    expect(
      middle.some(
        (line) =>
          line.includes("上 10 行") && line.includes(`下 ${String(80 - 10 - viewportRows)} 行`),
      ),
    ).toBe(true);
    // ⚠️ 中间那一档**不许**说「PgUp 上翻」这种单向的话（两个方向都能走）
    expect(middle.some((line) => line.includes("PgUp / 滚轮上翻"))).toBe(false);
  });

  it("丢掉过历史时那一行**同时**说清「已丢弃」与「现在在哪」（`null` 时不许出现）", async () => {
    // ⚠️ 丢弃声明**不许**把位置那一半顶掉（实测踩过：在丢弃那一支里写死「PgUp 上翻」，
    // 于是顶部那一帧骗人说「上翻」而上面什么都没有）。故判据要求**两句都在**。
    const withDrop = await renderFrame(props({ droppedHint: "（更早的 7 条已被丢弃）" }));
    expect(withDrop.some((line) => line.includes("已被丢弃"))).toBe(true);
    expect(withDrop.some((line) => line.includes("已到底"))).toBe(true);
    const without = await renderFrame(props({ droppedHint: null }));
    expect(without.some((line) => line.includes("已丢弃"))).toBe(false);
  });
});

/* ── ⑤ 侧边栏装不下必须说一声 ──────────────────────────────────────────── */

describe("不变量 ⑤：侧边栏装不下的目标必须说「还有 N 个」", () => {
  it("目标比行数多时给出溢出计数（静默少画几行 = 操作者以为台账就这几个）", async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      name: `t${String(i)}`,
      state: "unknown" as const,
    }));
    const lines = await renderFrame(props({ rows: 10, items }));
    expect(sidebarLines(lines).some((line) => line.includes("还有"))).toBe(true);
    // ⚠️ 反向自检：画出来的那几行**必须**真的画了
    expect(sidebarLines(lines).some((line) => line.includes("t0"))).toBe(true);
    expect(sidebarLines(lines).some((line) => line.includes("t39"))).toBe(false);
  });
});

/* ── ⑥ 极窄 / 极矮终端不许崩、不许花屏 ─────────────────────────────────── */

describe("不变量 ⑥：极端尺寸下渲染不崩，且每一行都不超宽", () => {
  it.each([
    [100, 3],
    [100, 2],
    [100, 1],
    [30, 20],
    [1, 1],
  ] as const)("columns=%i rows=%i", async (columns, rows) => {
    const lines = await renderFrame(props({ columns, rows }));
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
  });
});

/* ── ⑦ 输入区：瞬时消息行与底部状态行 ────────────────────────────────────── */

describe("不变量 ⑦：输入区下面那两行**各是各的**，且位置不可换", () => {
  it("最底那一行是**状态行**，中间那一行是瞬时消息", async () => {
    // ⚠️ 这是**用户要的东西**（「在输入框下面用小字显示所选控制面的远程地址与端口」），
    // 而它此前**零断言** —— 变异实测 M7 把两行的内容对调时整档照样全绿。
    const lines = await renderFrame(
      props({
        notice: "执行中：/status",
        hint: "http://127.0.0.1:18080 · 超时 5000ms · token ••••••",
      }),
    );
    const noticeAt = lines.findIndex((line) => line.includes("执行中"));
    const hintAt = lines.findIndex((line) => line.includes("127.0.0.1:18080"));
    expect(noticeAt).toBeGreaterThan(-1);
    expect(hintAt).toBeGreaterThan(-1);
    // ⚠️ **相邻且有序**：状态行在下面，且**紧挨着**那一行消息。写「在下面」不够 ——
    // 「在下面」在两行对调时也成立，而对调的后果是操作者每次都要重新找那一行在哪；
    // 而写成「倒数第二行」会把这条断言绑在几何上，改了输入区高度它就红（它要守的是**顺序**）。
    expect(hintAt).toBe(noticeAt + 1);
    // ⚠️ **反向自检**：两行**不是同一行**（一个把两段话塞进一行的实现会同时满足上面两条）
    expect(lines[noticeAt]).not.toContain("127.0.0.1");
  });

  it("没有瞬时消息时那一行**空着**，而状态行**仍有两半**", async () => {
    // ⚠️ 状态行右半（版本 + 台账规模）是**会话级**事实，与「当前连的是哪台」无关 ——
    // 左半空掉（右半必须还在）这个组合一旦被实现成「左半空就整行空」，操作者在空台账那档
    // 看不到自己跑的是哪个版本。
    const lines = await renderFrame(props({ notice: null, hint: null }));
    const promptAt = lines.findIndex((line) => line.includes("❯ "));
    expect(promptAt).toBeGreaterThan(-1);
    // 输入行下面恒有两行（几何是这么算的）
    expect(lines.length).toBeGreaterThan(promptAt + 2);
    // 瞬时消息那一行**一个可见字符都没有**（剥掉三根竖线之后只剩空白）——
    // 判据不能写成 `toContain("")` 之类，那对空行恒真
    expect(lines[promptAt + 1]!.replace(/│/gu, "").trim()).toBe("");
    expect(stripAnsi(lines[promptAt + 2]!)).toContain("v5.2.0");
  });
});

/* ── ⑨ 底部状态行：会话元信息在底部，屏顶没有横向区域 ────────────────────── */

describe("不变量 ⑨：版本号与控制面数量在**底部**状态行，且屏顶不重复它们", () => {
  const HINT = "http://127.0.0.1:18080 · 超时 5000ms · token ••••••";

  it("两半**各自在位**：地址在左、版本与数量在右，且那一行是**最底那一行**", async () => {
    const lines = await renderFrame(props({ notice: "Tab 补全", hint: HINT }));
    const statusAt = lines.findIndex((line) => line.includes("v5.2.0"));
    expect(statusAt).toBeGreaterThan(-1);
    // ⚠️ 它是**最后一行内容**而不是最后一行 —— 下面还压着主区那个框的下边框。
    // 只判「它是最后一行」的话，一个把状态行画在框**外面**的实现（于是下边框被挤掉）也绿。
    expect(lines[statusAt + 1]).toContain("╰");
    expect(statusAt).toBe(lines.length - 2);
    const line = stripAnsi(lines[statusAt]!);
    // ⚠️ 右半**真的靠右**：紧挨着右边框。判据是「整行去空白后以 `│` 收尾」——
    // 只判「含版本号」的话，一个把两段话并排塞在行首的实现照样绿。
    expect(line.trimEnd().endsWith("│")).toBe(true);
    expect(line).toContain("127.0.0.1:18080");
    // 左半在版本号之前（反过来就是「先牺牲地址」那条判据被换掉了）
    expect(line.indexOf("127.0.0.1")).toBeLessThan(line.indexOf("v5.2.0"));
  });

  it("控制面数量**跟着台账里的目标数走**（不是写死的一个数）", async () => {
    // ⚠️ 判据落在「两组目标数给出两个不同的数字」上。只判「含 `2 个控制面`」的话，
    // 一个把数字写死成常量的实现在任何目标数下都绿 —— 而那正好是这一行最可能的写法。
    const two = await renderFrame(props());
    expect(two.some((line) => line.includes("2 个控制面"))).toBe(true);
    const four = await renderFrame(
      props({
        items: [
          { name: "live-ok", state: "connected" },
          { name: "bad-token", state: "unauthorized" },
          { name: "no-server", state: "unreachable" },
          { name: "another", state: "unknown" },
        ],
      }),
    );
    expect(four.some((line) => line.includes("4 个控制面"))).toBe(true);
    expect(four.some((line) => line.includes("2 个控制面"))).toBe(false);
  });

  it("屏顶**没有横向区域**（顶部那两样一旦搬回顶栏，这条立刻红）", async () => {
    const lines = await renderFrame(props({ hint: HINT }));
    // ⚠️ 判据是「**一个曾经存在过的字符串**在整帧里找不到」，而不是「第一行长什么样」——
    // 后者会被「顶栏画了但内容空着」骗过，而那正是「删了行却留了个框」那种实现。
    expect(lines.some((line) => line.includes("PROXY CONSOLE"))).toBe(false);
    expect(lines.some((line) => line.includes("个控制面"))).toBe(true);
  });

  it("侧边栏标题**只有一行**（同一个数在一屏里不许出现两次）", async () => {
    // ⚠️ 目标数在状态行的右半，侧边栏标题下面就**没有**第二行数字了。两处都写的话，
    // 操作者会去比它们 —— 而两处都得对才不出错。
    const rows = sidebarLines(await renderFrame(props()));
    const headAt = rows.findIndex((line) => line.includes("控制面"));
    expect(headAt).toBeGreaterThan(-1);
    expect(rows[headAt + 1]).toContain("live-ok");
  });

  it("窄终端下**先牺牲地址**、保住右半（右半是不可让的那一半）", async () => {
    const lines = await renderFrame(props({ columns: 62, hint: HINT }));
    const statusAt = lines.findIndex((line) => line.includes("v5.2.0"));
    expect(statusAt).toBeGreaterThan(-1);
    expect(stripAnsi(lines[statusAt]!)).toContain("127.0.0.1:18080");
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(62);
  });

  it("版本号空串时**不留一个孤零零的 `v`**", async () => {
    const lines = await renderFrame(props({ version: "" }));
    const statusAt = lines.findIndex((line) => line.includes("个控制面"));
    expect(statusAt).toBeGreaterThan(-1);
    expect(stripAnsi(lines[statusAt]!)).not.toContain("v");
  });
});

/* ── ⑧ 这一档自己的探测器不是坏的（否则上面七条全在空帧上绿）───────────── */

describe("反向自检：本档的探测器真的能看到内容", () => {
  it("一个**必然渲染出来**的字符串（状态行右半的版本号）在原始帧里找得到", async () => {
    // ⚠️ 判据落在「一个具体的、只有真渲染才会出现的字符串」上。若帧提取坏掉
    // （只切出半帧、或剥 ANSI 时把内容一起剥了），这一条会红 —— 而上面那些**不会**：
    // 它们要么 `toBe(false)`、要么断言一个恰好也被切掉的东西。
    const raw = await renderRaw(props());
    expect(raw.some((line) => line.includes("v5.2.0"))).toBe(true);
    expect(raw.some((line) => line.includes("已改"))).toBe(true);
    // 而「剥掉 ANSI 之后行还在」—— 这是 ① 那批断言成立的前提
    expect(raw.map(stripAnsi).some((line) => line.includes("已改"))).toBe(true);
  });
});

/* ── ⑩ 画在哪 = 点在哪（渲染出来的列号必须等于几何给的矩形起点）─────────── */

describe("不变量 ⑩：可点区域的起点与**画出来的字符**在同一列", () => {
  it("输入行第一个字符的列号 == `inputText.x`（点它得到插入符 0）", async () => {
    // ⚠️ 这条判据落在「**渲染出来的字符落在哪一列**」上，而不是「两个常量相等」——
    // 后者对「两个常量一起错一列」恒绿，而那正是边框那一列漏算时的形状。
    // 症状：点一个字，插入符落在它**右边**那个位置；终端上看不出差别（插入符在两字之间），
    // 只有真去点才发现少了一格 —— 而那时没人想得到是几何错了。
    const lines = await renderFrame(props({ input: "abc", cursor: 1 }));
    const promptAt = lines.findIndex((line) => line.includes("❯ "));
    expect(promptAt).toBeGreaterThan(-1);
    const g = geometry(COLUMNS, ROWS, 2, 0);
    expect(lines[promptAt]!.indexOf("abc")).toBe(g.inputText!.x);
  });

  it("侧边栏那一行的 `▍` 的列号 == `sidebarRows[0].x`", async () => {
    const lines = await renderFrame(props());
    const g = geometry(COLUMNS, ROWS, 2, 0);
    const rowAt = lines.findIndex((line) => line.includes("▍"));
    expect(rowAt).toBeGreaterThan(-1);
    // 行的 y 与几何给的 y 相对齐（帧的第一行就是第 0 行）
    expect(rowAt).toBe(g.sidebarRows[0]!.y);
    expect(lines[rowAt]!.indexOf("▍")).toBe(g.sidebarRows[0]!.x);
  });

  it("点输入行第一个字**得到插入符 0**（`hitTest` 与 `caretFromColumn` 合起来的结果）", () => {
    const box = geometry(COLUMNS, ROWS, 2, 0).inputText;
    // ⚠️ **反向自检**：这个尺寸下一定有输入行文本区；少了它，下面两行会在 `undefined` 上跑，
    // 而「拿不到那个矩形」正是「点输入行毫无反应」的实现形状。
    expect(box).not.toBeNull();
    if (box === null) return;
    // ⚠️ 走的是**真的**两个函数（不是重新推一遍算术）—— 判据是「点那一列的结果」
    expect(hitTest(box.x, box.y, [box])).toBe(0);
    expect(caretFromColumn(box.x, box, "abc")).toBe(0);
  });
});

/* ── 原始帧（含 ANSI）────────────────────────────────────────────────────── */

/** 与 {@link renderFrame} 相同，但**保留 ANSI**（着色那几组断言需要它） */
async function renderRaw(props: LayoutProps): Promise<readonly string[]> {
  const stdout = fakeStdout(props.columns, props.rows);
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const stdin = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
  });
  const instance = render(createElement(Layout, props), {
    stdout: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
    interactive: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  instance.unmount();
  await new Promise((resolve) => setTimeout(resolve, 40));
  return output.split("\n").filter((line) => line !== "");
}

/* ── 变异实测记录（每条都做过，绿 / 红两次输出都在交接说明里）──────────────
 * 1. `NAME_BUDGET_OFFSET` 4 → 2            → 不变量 ①「长中文名」转红（那一行超宽 → 软换行）
 * 2. 选中态的字形那一格不给 `backgroundColor` → 不变量 ② 转红（那一格不在反底色里）
 * 3. `scrollHintOf` 的丢弃分支写死「PgUp 上翻」→ 不变量 ④「已丢弃」转红（顶部骗人说上翻）
 * 4. `scrollHintOf` 在中间那一档写「上方还有 N 行」→ 不变量 ④「装得下」转红（形态不对）
 * 5. `showLogo` 无条件为真                  → 不变量 ③ 第二条 + 两条宽度断言转红
 * 6. 侧边栏溢出那一行删掉                    → 不变量 ⑤ 转红
 * 7. 帧提取去掉 `interactive: false`         → **八条**转红（切出半帧）
 * 8. 输入区那两行的内容对调                   → 不变量 ⑦ 转红（地址那一行跑到了上面）
 * 9. 侧边栏把右边框画出来                     → 不变量 ①「只有一根竖线」转红
 * 10. 状态行右半（版本 + 控制面数量）删掉     → 不变量 ⑨ 全部六条 + 反向自检转红
 * 11. 状态行两半左右**对调**                  → 不变量 ⑦ + ⑨ 三条转红（先牺牲地址）
 * 12. 控制面数量**写死**成常量               → 不变量 ⑨「跟着目标数走」转红
 * 13. 版本号空串时仍留一个 `v`               → 不变量 ⑨「不留孤零零的 v」转红
 * 14. 状态行忘了扣**右边框那一列**            → 不变量 ⑨「右半紧挨右框」转红（压到边框上）
 * 15. 顶栏那一行加回来（画 `PROXY CONSOLE`） → 不变量 ⑨「屏顶没有横向区域」转红
 * 16. 侧边栏标题下面加回第二行数字             → 不变量 ⑤ + ⑨「标题只有一行」转红
 * 17. `BORDER_LEFT_COLUMN` 1 → 0（geometry.ts）→ 不变量 ⑩ 两条全转红（点字得到它右边的位置）
 * 18. `SIDEBAR_HEADER_HEIGHT` 1 → 2（geometry.ts）→ 本档 ⑩ + `geometry.test.ts`「37 行」转红
 * 19. `framed` 恒为真                       → 不变量 ⑥ 的 `columns=1 rows=1` 转红（框越过终端一列）
 *
 * ⚠️ **第 2、7、8、9 条是本档写出来之后才发现需要的**：对应的第一版判据（只看「选中行里有
 * `▍`」、按 `?2026h` 切帧、两行只查「在下面」、压根没有「一根竖线」那条）在那些变异下
 * **全绿**。故本档的三个探测器（{@link sgrStateAt} / `interactive: false` / 「相邻且有序」）
 * 各自带一段它自己踩过的坑，读的时候不要跳过。
 * ⚠️ **第 10–19 条里，第 17 条挡的是一类「两个常量一起错一列」的 bug**，而它对「两个常量相等」
 * 那条判据**恒绿** —— 故 ⑩ 断言的是**渲染出来的字符列号**，不是任何一对常量的关系。
 * ────────────────────────────────────────────────────────────────────── */
/* ── ⑪ 命令面板：接管结果区，一行「命令名 + 说明」 ──────────────────────── */

/** 面板的一份视图模型（按 `PALETTE_ROWS` 切片，故**不是**另抄一份命令表） */
function paletteOf(
  count: number,
  over: { readonly at?: number; readonly footer?: string | null } = {},
): NonNullable<LayoutProps["palette"]> {
  const total = PALETTE_ROWS.length;
  // ⚠️ 取**前** `count` 行（不是后 `count` 行）：本档要断言的那两条命令与那句话都在表的开头，
  // 而取尾部的话 `paletteOf(6)` 里根本没有 `/help` —— 断言会因「数据里没有」而红，
  // 那种红的形状与被测行为无关。
  return {
    rows: PALETTE_ROWS.slice(0, count).map((row) => ({
      text: row.path,
      summary: row.summary,
    })),
    at: over.at ?? 0,
    total,
    footer: over.footer ?? null,
  };
}

describe("不变量 ⑪：命令面板接管结果区，每一行「命令名 + 说明」", () => {
  it("每一行都**带前缀**且**带说明**（用户要的就是这两列）", async () => {
    const lines = await renderFrame(props({ palette: paletteOf(19, { at: 2 }) }));
    const body = lines.filter((line) => line.includes("/"));
    expect(body.some((line) => line.includes("/help"))).toBe(true);
    expect(body.some((line) => line.includes("/target switch"))).toBe(true);
    // ⚠️ **说明那一列**也要在：只有命令名的面板是一张名字表，而它没有回答「这条干什么」
    expect(body.some((line) => line.includes("服务进程与代理的现状"))).toBe(true);
    expect(body.some((line) => line.includes("清掉结果区"))).toBe(true);
  });

  it("⚠️ 面板**接管**结果区（结果区那几行一个字都不许露出来）", async () => {
    // ⚠️ 判据是「**那个** kv 行不见了」：`Layout` 判据若写成「两者都画」，Ink 不会抱怨
    // （它只把子元素往下堆），症状是「面板开着、上一条命令的结果还露在它上面」。
    const withPanel = await renderFrame(props({ palette: paletteOf(6) }));
    const without = await renderFrame(props({ palette: null }));
    expect(without.some((line) => line.includes("已改"))).toBe(true);
    expect(withPanel.some((line) => line.includes("已改"))).toBe(false);
    // ⚠️ 同理也不出 logo：`showLogo` 与面板是**互斥**的两块，同一个矩形
    const logo = await renderFrame(props({ showLogo: true, palette: paletteOf(4) }));
    expect(logo.some((line) => line.includes("台账里还没有控制面"))).toBe(false);
  });

  it("高亮那一行有 `▍` 记号，且**只有它有**", async () => {
    const lines = await renderFrame(props({ palette: paletteOf(6, { at: 2 }) }));
    // ⚠️ 只看**主区**那几列：侧边栏的选中记号与面板的记号在同一行上，不切列就分不出是谁的
    const main = lines.map((line) => line.split("│")[2] ?? "").filter((one) => one.includes("/"));
    const marked = main.filter((one) => one.includes("▍"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("/config");
  });

  it("⚠️ 高亮那一行的记号、名字、说明**在同一段反底色里**", async () => {
    // ⚠️ `color: true` 才有背景色可比 —— 无色终端下「连续反底」这个性质无从断言，
    // 而它正是高亮**唯一**可读的那个场合（与侧边栏那条同源）。
    const raw = await renderRaw(props({ color: true, palette: paletteOf(6, { at: 2 }) }));
    const line = raw.find((one) => one.includes("/config"));
    // ⚠️ **不许**把这一行切出来再问「反底色开着吗」：背景状态由**这一行之前**的转义序列决定，
    // 切掉前缀之后 `sgrStateAt` 看到的是一个从没开过背景的串 —— 于是三条断言全红，
    // 而屏上高亮好好地在那儿（判据自己坏了，不是被测行为坏了）。
    if (line === undefined) throw new Error("没画出高亮那一行");
    // ⚠️ **取最后一个** `▍`：侧边栏选中目标那一行也有 `▍`，而它与面板高亮落在**同一个屏幕行**上，
    // 于是 `indexOf` 找到的可能是侧边栏那个 —— 它当然不在反底色里。
    const markAt = line.lastIndexOf("▍");
    const nameAt = line.indexOf("/config");
    const summaryAt = line.indexOf("配置项");
    expect(markAt).toBeGreaterThan(-1);
    expect(nameAt).toBeGreaterThan(markAt);
    expect(summaryAt).toBeGreaterThan(nameAt);
    for (let i = markAt; i < summaryAt; i += 1) expect(sgrStateAt(line, i, "bg")).toBe(true);
    // ⚠️ **反向自检**：未高亮那一行同名的那一段**不在**反底色里 ——
    // 少了它，一个「整块面板都在反底色里」的实现同样满足上面那条。
    const other = raw.find((one) => one.includes("/usage"));
    if (other === undefined) throw new Error("没画出未高亮那一行");
    expect(sgrStateAt(other, other.indexOf("/usage"), "bg")).toBe(false);
  });

  it("⚠️ `at = -1` 时**整块没有反底色**（敲的东西表里没有）", async () => {
    const raw = await renderRaw(props({ palette: paletteOf(4, { at: -1 }) }));
    let checked = 0;
    for (const line of raw) {
      // ⚠️ 只看**主区**那几列：侧边栏那一行的 `▍`（选中目标）与面板的记号在同一行上，
      // 不切列的话「侧边栏有记号」会被读成「面板有记号」—— 那是恒假的红。
      const main = line.split("│")[2] ?? "";
      if (!main.includes("/")) continue;
      checked += 1;
      expect(main).not.toContain("▍");
    }
    // ⚠️ **反向自检**：至少查到了几行，否则上面那条对「一个面板都没画」恒真
    expect(checked).toBeGreaterThan(0);
  });

  it("说明那一列**对齐**（按显示列补空格，不是一个挨着一个排）", async () => {
    const lines = await renderFrame(props({ palette: paletteOf(6) }));
    const body = lines.filter((line) => line.includes("服务进程") || line.includes("各账号"));
    expect(body).toHaveLength(2);
    // ⚠️ 判据是「两行的说明落在**同一列**」，不是「说明存在」
    const at = body.map((line) => line.search(/(服务进程|各账号)/u));
    expect(new Set(at).size).toBe(1);
  });

  it("⚠️ 每一行都不超宽（面板的宽度预算是算出来的，而算错了就是整屏下移）", async () => {
    // ⚠️ 用**超长**的命令名与说明：按 `nameWidth = min(最长, 宽度/2)` 与「不看名字长度」
    // 两种实现在这一档给出**不同**的行宽，故它有鉴别力。
    const wide = PALETTE_ROWS.map((row) => ({
      text: row.path + " ".repeat(40),
      summary: row.summary + "服务进程".repeat(20),
    }));
    const lines = await renderFrame(
      props({ columns: 80, palette: { rows: wide.slice(0, 8), at: 1, total: 8, footer: null } }),
    );
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(80);
  });

  it("⚠️ 命令名**很长**时说明那一列仍然看得见（名字那一列不许吃掉全部预算）", async () => {
    // ⚠️ **这一条才有鉴别力**：命令表里最长的名字是 `/target switch`（14 列），而名字那一列的
    // 预算是「最长者与半屏取小」—— 于是对**今天这张表**那个封顶永远不生效，它只是一道保险。
    // 保险要验就得喂一个**比整个内容区还宽**的名字进去，而症状不是「某一行超宽」（Ink 裁掉），
    // 是**说明那一整列消失** —— 而说明正是这块面板存在的第二个理由。
    const long = PALETTE_ROWS.slice(0, 4).map((row) => ({
      text: row.path.padEnd(90, "-"),
      summary: row.summary,
    }));
    const lines = await renderFrame(
      props({ palette: { rows: long, at: 0, total: 4, footer: null } }),
    );
    // ⚠️ 只查**前两行**的说明：后两行的说明本来就比半屏还长（`user set` 那条列了七个字段），
    // 它们**本来**就该被裁短 —— 拿它们当判据，这条断言会在正确实现上也红。
    for (const row of PALETTE_ROWS.slice(0, 2)) {
      expect(lines.some((line) => line.includes(row.summary))).toBe(true);
    }
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
  });

  it("装不下时**必须有**那一句「共 N 条」（静默少画几行就是一张残缺的表）", async () => {
    // 屏只有 8 行，而命令表有 19 条 ⇒ 装不下
    const lines = await renderFrame(
      props({
        rows: 8,
        palette: { ...paletteOf(4), footer: "第 1–4 条 · 共 19 条 · ↑↓ 选 · Tab 接受" },
      }),
    );
    expect(lines.some((line) => line.includes("共 19 条"))).toBe(true);
    expect(lines.some((line) => line.includes("Tab 接受"))).toBe(true);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(100);
  });

  it("⚠️ 面板开着时**每一行**都不超宽（极端尺寸也要过那把尺）", async () => {
    for (const [columns, rows] of [
      [100, 6],
      [60, 5],
      [30, 12],
      [1, 1],
    ] as const) {
      const lines = await renderFrame(props({ columns, rows, palette: paletteOf(5) }));
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
    }
  });
});
