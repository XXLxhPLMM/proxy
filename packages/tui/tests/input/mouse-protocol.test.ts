/**
 * SGR 鼠标报告在**真 Ink 输入通路**上的落点，以及守住「不引起重绘」的那道预算
 * @description 协议报文一个字都不许进输入行（两个消费者之间那一道 C0 的闸已经失效）；
 * 认领掉它之后 50 条移动报告写 **0 字节**；而它**唯一**该改的那一层是 hover 底色。
 * ⚠️ 守住那个 0 的另两条按**源码**判（依赖面 / 定时器）—— 共用的不变量与判据纪律见 `AGENTS.md`。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { ledger, mount, renderAndFeed, report, sidebarNameRow, stripAnsi } from "./_shared.js";
import { SIDEBAR_WIDTH } from "@/lib/geometry.js";

/** `src/` 那一层的绝对路径（「不许有 `setInterval`」那一条按目录现列，不手写清单） */
const srcRoot = join(__dirname, "..", "..", "src");

describe("鼠标报告不许变成输入行的内容（真 Ink 通路）", () => {
  it("移动报告（`b = 35`，`?1003h` 开着时每帧都有）：一个字都不许进输入行", async () => {
    const { output, mouseEvents } = await renderAndFeed([
      report(35, 64, 32),
      report(35, 63, 32),
      report(35, 72, 30),
    ]);
    expect(output).not.toContain("[<");
    // 正向对照：同一份字节**确实**到了鼠标那一侧 —— 否则上面那条可能只是「谁都没收到」。
    expect(mouseEvents.length).toBe(3);
    expect(mouseEvents[0]).toMatchObject({ action: "move", x: 63, y: 31 });
  });

  it("按下 / 释放 / 拖动 / 滚轮四种报告形态同样一个字都不许进输入行", async () => {
    const { output, mouseEvents } = await renderAndFeed([
      report(0, 10, 5),
      report(0, 10, 5, true),
      report(32, 12, 6),
      report(64, 12, 6),
      report(65, 12, 6),
    ]);
    expect(output).not.toContain("[<");
    expect(mouseEvents.map((event) => event.action)).toEqual([
      "down",
      "up",
      "drag",
      "wheelUp",
      "wheelDown",
    ]);
  });

  it("**反向自检**：真敲的字必须出现在输入行上（否则上面两条只是「什么都没渲染」）", async () => {
    const { output, mouseEvents } = await renderAndFeed(["s", "t", "a", "t", "u", "s"]);
    expect(output).toContain("❯ status");
    expect(output).not.toContain("[<");
    expect(mouseEvents).toEqual([]);
  });

  it("报文与真输入混在同一段字节里时，只有真输入进输入行", async () => {
    const { output, mouseEvents } = await renderAndFeed([`${report(35, 5, 5)}ab${report(35, 6, 5)}`]);
    expect(output).toContain("❯ ab");
    expect(output).not.toContain("[<");
    expect(mouseEvents).toHaveLength(2);
  });

  it("用户自己敲的 `[` 与 `[<` 仍然打得进去（判据不许过宽）", async () => {
    const { output } = await renderAndFeed(["[", "<", "1", ";", "2", ";", "3", "M"]);
    expect(output).toContain("❯ [<1;2;3M");
  });

  it("输入行里的 C0 闸仍然在：一段**带换行的粘贴**不会把那截换行变成内容", async () => {
    // ⚠️ 走**括号粘贴**通道（`ESC[200~ … ESC[201~`）：Ink 的输入解析器把整段交给 `useInput`
    // 的**一次**回调，于是 `printableOnly` 面对的是「`a` + U+000D + `b`」这么一串。
    // ⚠️ 别用「敲一个 `\r`」代替：那是 `key.return`，本就该**提交命令**，与 C0 那一道闸无关
    // （实测那样断言会看到输入行被清空，而症状看起来像闸坏了）。
    const { output } = await renderAndFeed(["\u001B[200~a\rb\u001B[201~"]);
    expect(output).toContain("❯ ab");
    expect(output).not.toContain("不认识的命令");
  });
});

describe("鼠标移动**不引起重绘**（认领掉的那一道闸顺带省掉了整场重画）", () => {
  it("50 条移动报告在主区里写出的字节是 **0**（认领掉协议报文后 React 一个状态都不改）", async () => {
    const ui = await mount({ interactive: true });
    const settled = ui.bytes();
    // ⚠️ **列范围避开两处「移动真的会改状态」的地方**：侧边栏那几行（hover 换底色）与
    // 最右那一列（拖宽手柄自己换底色）。它们是**两条真实的通道**，把它们算进「移动引起的
    // 重绘」会让这条判据恒红 —— 而它护的是「认领掉协议报文之后不该有任何重绘」。
    // ⚠️ 起点从 {@link SIDEBAR_WIDTH} + 1 起算：那一列宽是**缺省值**，而写死的列号在它变宽之后
    // 就会落进侧边栏里，于是「移动不引起重绘」变成「移动改了 hover」。
    await ui.feed(Array.from({ length: 50 }, (_, i) => report(35, SIDEBAR_WIDTH + 1 + (i % 40), 20)));
    const afterMoves = ui.bytes() - settled;
    await ui.feed(["a"]);
    const afterKey = ui.bytes() - settled - afterMoves;
    await ui.finish();

    expect(ui.mouseEvents).toHaveLength(50);
    // 正向对照：**尺**必须是真的，否则「0」只是「什么都在写不出来」
    expect(afterKey).toBeGreaterThan(1024);
    expect(afterMoves).toBe(0);
  });

  it("50 条移动报告**在同一个会话项里来回划**也只写一次整帧（hover 只在换了一项时才 setState）", async () => {
    const ui = await mount({ interactive: true });
    const settled = ui.bytes();
    // ⚠️ 第 1 项占**两行**（0 与 1），而这三列都在它里面：于是 `hoveredId` 从「无」变一次
    // 「会话 1」之后就再也不变 —— React 跳过重渲染，屏上一个字节都不该多写。
    await ui.feed(Array.from({ length: 50 }, (_, i) => report(35, 4 + (i % 3), 2)));
    const afterMoves = ui.bytes() - settled;
    await ui.feed(["a"]);
    const afterKey = ui.bytes() - settled - afterMoves;
    await ui.finish();

    // ⚠️ 判据是「**至多一次整帧**」：一次 hover 变化 = 一次重绘，而它**已经发生过了**
    // （`afterMoves > 0` 就是那个证据）—— 于是 50 条报告里有 49 条一个字都不写。
    // 闸门被拆掉时这 50 条是 50 次整帧，而一个键位本身也就是一帧（实测 1.3 KB / 帧）。
    expect(afterMoves).toBeGreaterThan(0);
    expect(afterMoves).toBeLessThanOrEqual(afterKey);
  });

  /**
   * ⚠️ `src/` 里**一处 `setInterval` 都不许有**（动画 = 每 80ms 一整帧）
   *
   * @description 上面那两条是「不重绘」的**症状级**判据，而这一条按**源码**判同一个不变量：
   * 一旦有人挂上一个定时器驱动的动画（最可能的候选是 `@inkjs/ui` 的 `Spinner`，它无条件
   * `setInterval(…, 80)` 且**没有 `isActive`**），屏上就会每 80ms 排一帧，而本包的布局恒等于 `rows` 高
   * ⇒ 每帧都是 fullscreen。⚠️ **实测过**（win32 / 100×28 / 50 条移动报告）：空转时那 50 条报告写
   * **0 字节**，挂一个常驻 spinner 之后写 **1224 字节** —— 症状是「一动鼠标就卡」。
   *
   * @description ⚠️ **为什么不等上面那两条转红再改**：那要等到「屏上看着卡」才被发现，而这一条当场就红。
   * ⚠️ 锚点是 `setInterval` 这个 **API** 而不是某个符号名，故它既不恒真也不恒假（`src/` 今天真的是 0 处）。
   */
  it("⚠️ `src/` 里一处 `setInterval` 都没有（唯一的定时器是消息那一记 8 秒的 `setTimeout`）", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && readFileSync(full, "utf8").includes("setInterval")) {
          offenders.push(relative(srcRoot, full).split(sep).join("/"));
        }
      }
    };
    walk(srcRoot);
    expect(
      offenders,
      "本包有定时器驱动的动画：布局恒等于 rows 高 ⇒ 每一次定时器回调都是一整帧 fullscreen\n" +
        `（实测 1224 字节 / 50 条移动报告，而「不重绘」那一档是 0）：\n${offenders.join("\n")}\n\n` +
        "修法：动画只在「真的有东西在动」时挂载，且动画那一块自己算帧（不许拖整屏）。",
    ).toEqual([]);
  });
});

/* ── 呈现层：零外部组件库（判据是**依赖面**，不是「某个 import」） ──────────────── */

/** 只留**代码**（⚠️ 注释里提到 `useInput` 是在讲纪律，不是在挂订阅） */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\/.*$/gm, "");
}

/**
 * 本包 `package.json` 里的**依赖面**（⚠️ 读的是那个文件本身：判据是「装了什么」而不是「import 了什么」——
 * 装了而没引与引了而没装是两种不同的事，而只有前者能在引入之前就红）
 */
function dependencyNames(): readonly string[] {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

describe("呈现层：呈现层的词汇全部在 `src/components/`，零外部组件库", () => {
  it("⚠️ 依赖面里**没有组件库**（判据：Ink / React / string-width 之外没有别的呈现层依赖）", () => {
    // ⚠️ **白名单是「今天的依赖面」逐条列出来的**，不是「除 Ink 外都不许有」——
    // 后者会把「加一个纯函数库」也判成违规，于是下一个人会去改断言而不是改依赖
    expect(dependencyNames().toSorted()).toEqual([
      "@types/node",
      "@types/react",
      "@typescript-eslint/eslint-plugin",
      "@typescript-eslint/parser",
      "esbuild",
      "eslint",
      "ink",
      "react",
      "string-width",
      "typescript",
      "vitest",
    ]);
  });

  it("⚠️ 探测器认得出依赖名（否则上面那条是「读不到 `package.json` → 空数组」的假绿）", () => {
    expect(dependencyNames()).toContain("ink");
    expect(dependencyNames().length).toBeGreaterThan(5);
  });

  it("⚠️ **`src/` 里没有一处 `@inkjs/ui`**（它的 spinner 会把「不重绘」那一档从 0 字节变成 1224 字节）", () => {
    const users: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && readFileSync(full, "utf8").includes("@inkjs/ui")) {
          users.push(relative(srcRoot, full).split(sep).join("/"));
        }
      }
    };
    walk(srcRoot);
    // ⚠️ **反向自检**：`ink` 本身**确实**在依赖面里（否则上面那条是「本包压根不用 Ink」）
    expect(dependencyNames()).toContain("ink");
    expect(
      users,
      `本包引了 @inkjs/ui：\n${users.join("\n")}\n\n` +
        "理由见 `packages/tui/AGENTS.md`「零外部组件库」一节：`Spinner` 常驻重绘、`TextInput` 的\n" +
        "光标硬绕开 `@/theme`、`useTextInput` 不接管 `Esc`（与「改名框就是输入行」冲突）、`Select`\n" +
        "自带几何，而 `Modal` / `Dialog` / `Table` / `KeyValue` / `Tabs` / `Toast` 那个库**根本没有**。",
    ).toEqual([]);
  });

  it("⚠️ **只有一处 `useInput`**（第二个收键者会抢键：改名框的 `Esc` 就不归它了）", () => {
    const owners: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && /\buseInput\s*\(/.test(codeOf(readFileSync(full, "utf8")))) {
          owners.push(relative(srcRoot, full).split(sep).join("/"));
        }
      }
    };
    walk(srcRoot);
    // ⚠️ **正向对照**：收键的那一处**确实**挂了 `useInput`（否则上面那条是「探测器认不出这个词」）
    expect(codeOf(readFileSync(join(srcRoot, "hooks", "useHotkeys.ts"), "utf8"))).toContain("useInput(");
    expect(owners, `收键的地方不止一处：\n${owners.join("\n")}`).toEqual(["hooks/useHotkeys.ts"]);
  });
});

/* ── hover：`move` 报告换掉那一项的底色 ─────────────────────────────────── */

describe("hover：`move` 报告换掉那一项的底色（指针位置那一层通道）", () => {
  /**
   * 那一行上**名字之前**最后一个生效的背景色（`r/g/b`）
   * @description ⚠️ 只认 `48;2;r;g;b`（背景）而**不**认 `38;2;…`（前景），且问的是「**哪一个**
   * 底色」而不是「开没开」—— 侧边栏**整列**都有 `surface` 那一条底色，于是「开没开」在这一列上
   * 恒为真，一个「hover 从来没生效过」的实现照样通过。
   */
  /**
   * `name` 之前最后一个**背景色**的 SGR 参数（`null` = 一个都没有）
   * @description ⚠️ 问的是「**哪一个**底色」而不是「开没开」—— 侧边栏**整列**都有
   * `surface` 那一条底色，于是「开没开」在这一列上恒为真，一个「hover 从来没生效过」的
   * 实现照样通过。
   * @description ⚠️ **在没剥 ANSI 的那一行上找**：剥完再找 `48;2;` 的话那个探测永远是 `null`，
   * 而症状是「hover 没生效」—— 与「探测器坏了」**长得一样**（实测踩过一次）。
   */
  function bgBefore(output: string, name: string): string | null {
    const line = output.split("\n").find((one) => stripAnsi(one).includes(name));
    if (line === undefined) throw new Error(`侧边栏里没有 ${name}`);
    const head = line.slice(0, line.indexOf(name));
    let found: string | null = null;
    let i = 0;
    while (i < head.length) {
      if (head[i] !== "\u001B") {
        i += 1;
        continue;
      }
      const bracket = head.indexOf("[", i);
      if (bracket === -1 || bracket > i + 2) {
        i += 1;
        continue;
      }
      let end = bracket + 1;
      while (end < head.length && !/[A-Za-z]/u.test(head[end] as string)) end += 1;
      const params = head.slice(bracket + 1, end);
      if (params.startsWith("48;2;")) found = params;
      i = end < head.length ? end + 1 : head.length;
    }
    return found;
  }


  it("⚠️ 指到侧边栏那一项 ⇒ 它的底色**换成 hover 那一档**（与列那一条不同）", async () => {
    // ⚠️ `color: true` 才有底色可比 —— 无色终端下底色退成 `undefined`（侧边栏与主区长得一模一样），
    // 这一整套性质**无从断言**，而那正是本条设计**刻意**付出的代价（`src/theme/palette.ts` 的 `NO_COLOR` 那一档）。
    // ⚠️ **行号从 {@link sidebarNameRow} 取**，不写死 `1`：清单每项两行、项间一行，写死的后果是
    // 「几何一改、点就点空了而这条断言照旧绿」（它曾经正是那样恒绿的）。
    const pointed = await renderAndFeed([report(35, 6, sidebarNameRow(1, 0))], {
      color: true,
      ledgerFile: ledger(),
    });
    // ⚠️ **反向自检**：与「没有被指着」的那一帧比 —— 判据是「**两者不同**」，而单看一帧的话
    // 「整列常亮」与「hover 生效」长得一模一样。
    const bare = await renderAndFeed([], { color: true, ledgerFile: ledger() });
    const hot = bgBefore(pointed.output, "live-ok");
    const cold = bgBefore(bare.output, "live-ok");
    expect(hot).not.toBeNull();
    expect(hot).not.toBe(cold);
  });

  it("⚠️ 划到主区 ⇒ 侧边栏那一项的底色**回到列那一条**（不留着上一次那一层）", async () => {
    const away = await renderAndFeed(
      [report(35, 6, sidebarNameRow(1, 0)), report(35, 60, sidebarNameRow(1, 0))],
      {
        color: true,
        ledgerFile: ledger(),
      },
    );
    // ⚠️ 判据是「**回到**列那一条」而不是「有没有底色」—— 而这条之所以要写，是因为
    // 「指针不在侧边栏上就停在上一次那一项」那个实现会让底色留着，而屏上没有任何东西解释它。
    const bare = await renderAndFeed([], { color: true, ledgerFile: ledger() });
    expect(bgBefore(away.output, "live-ok")).toBe(bgBefore(bare.output, "live-ok"));
  });

  it("⚠️ hover 一个字节都不许进输入行（`move` 报告走的是鼠标那一路）", async () => {
    const { output, mouseEvents } = await renderAndFeed([report(35, 6, sidebarNameRow(1, 0))], {
      ledgerFile: ledger(),
    });
    expect(output).not.toContain("[<");
    // ⚠️ **正向对照**：同一份字节**确实**到了鼠标那一侧 —— 否则上面那两条只是「谁都没收到」
    expect(mouseEvents.map((one) => one.action)).toEqual(["move"]);
  });
});
