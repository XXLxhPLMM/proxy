/**
 * `@/commands/palette`（命令面板）的纯函数断言
 *
 * **锁什么**：四条不变量 —— ①面板的**开**只有一条判据（整行以 `/` 开头）；②列的是**全表**
 * 而敲出来的东西只定高亮（否则 `↑`/`↓` 走一步就无路可走）；③高亮是**输入行的纯函数**
 * （界面上没有「高亮在第几行」这个状态，故不存在「输入行 A、高亮 B」那一帧）；④`↑`/`↓`/`Tab`/
 * 鼠标点**共用同一个补全实现**，而它只换**命令名那一段**、形参原样留着。
 *
 * **为什么拆掉哪一处会红**（**二十九条 + 二十二条**变异实测，51 条里 **50 条转红**；
 * 剩那一条是**可证明的等价变异**，记录在末尾）：
 * - 「开」的前缀那道闸去掉 → 「不带前缀的行不开面板」那组红（且**没有**别处会红）。
 * - 列表改成「按敲的东西过滤」→ 「`↓` 能一路走到底」那组红：填完 `/clear` 之后列表塌成一行。
 * - 高亮改成 `at` 自己累加（不再是纯函数）→ 「高亮跟着输入行走」那组红。
 * - `paletteFill` 改成替换**整行** → 「形参原样留着」那组红（`/user ad|d alice` 丢掉形参）。
 * - `paletteFill` 不补那个尾随空格 → 「两段命令名的空格」那组红。
 * - **命令名那段宽度按「被选中那条名字的前缀」算** → 「`↓` 走过两段命令名的边界」那组红：
 *   `/user add` 走到 `/user set` 只吃掉 `user`，剩下的 ` add` 变成尾巴（一条命令里夹着一个形参，
 *   而 `parseLine` 不会因此报错）。
 * - **命令名不跨空白取** → 同上：`/user add `（名字已敲完）的���亮停在 `/user` 上，
 *   而屏上那个形状是「按了 `↓` 它不动」。
 * - `paletteWindow` 换成 `clamp` → 「高亮被顶到视口最后一行时才滚」那组红。
 * - `paletteStep` 改成循环 → 「到头停住」那组红。
 *
 * ⚠️ 本档**测不到**的是面板占哪几行：那是 `@/lib/geometry.ts` 的算术
 * （`packages/tui/tests/geometry.test.ts`）与 `@/app.tsx` 的呈现
 * （`packages/tui/tests/layout.test.ts`）各一半，而两者读的是**同一个** `paletteCount`。
 *
 * ## 变异实测记录（每条都做过，绿 / 红两次输出都在交接说明里）
 *
 * | # | 变异 | 转红的判据 |
 * | --- | --- | --- |
 * | N1 | `parseLine` 的前缀那道闸整段删掉 | `parse.test.ts` 的「不带前缀」那一组 + `input.test.ts` 的「不带 `/` 回车」 |
 * | N2 | `complete` 的前缀那道闸删掉 | `complete.test.ts`「退格删掉 `/` 之后那一行」 |
 * | N3 | `complete` 把命令名也接回来 | `complete.test.ts`「命令名一个候选都不给」那组 |
 * | N4 | `paletteOpen` 只判「永远开」 | `input.test.ts` 里 6 条（空输入行上不该有面板） |
 * | N5 | 面板按敲的东西过滤 | 四档同时炸（`paletteOf` 的返回形状变了） |
 * | N6 | 高亮改成累加（不再是纯函数） | `input.test.ts` 里 5 条 |
 * | N7 | `paletteFill` 直接拼 `row.path` | 「不许把前缀写两遍」+ `input.test.ts` 里 4 条 |
 * | N8 | `paletteFill` 只换第一个词 | ④「光标在命令名中间」 |
 * | N9 | 尾随空格不补 | ④「两段命令名的空格」+ ④「补完的光标」 |
 * | N10 | `paletteStep` 改成循环 | ⑤「到头停住」 |
 * | N11 | `paletteWindow` 换成 `clamp` | ⑤「高亮被顶到视口最后一行时才滚」 |
 * | N12 | 完全相同的那条不优先 | ③「`/user` 高亮到 `/user` 本身」 |
 * | N13 | `path` 不再是「前缀 + 名字」 | `exec.test.ts` 的 `help` 两条 + `input.test.ts` 里 3 条 |
 * | N14 | `submit` 又回显原文 | `input.test.ts`「回显只出现一次」+「解析失败清输入行」 |
 * | N15 | `exec` 不再统一加回显 | `exec.test.ts` 里 5 条（含「每一条命令的第一行都是回显」） |
 * | N16 | 面板**叠在**结果区下面（两者都画） | `layout.test.ts`「面板贴着输入框、结果区仍在它上面」 |
 * | N17 | 面板的说明那一格不给反底色 | `layout.test.ts`「同一段反底色里」 |
 * | N18 | 名字那一列不封顶 | `layout.test.ts`「命令名很长时说明那一列仍然看得见」 |
 * | N19 | 几何层不看 `paletteCount` | `geometry.test.ts` ⑥ 的四组 |
 * | N20 | 面板第一行骑在上框上 | `geometry.test.ts` ⑥「第一行的 y」 |
 * | N21 | `↑`/`↓` 不归面板 | `input.test.ts`「面板开着时不切目标」 |
 * | N22 | `Tab` 不接受面板的高亮 | `input.test.ts`「Tab 接受高亮那一行」 |
 * | N23 | 幽灵文本不再由面板那份算出 | `input.test.ts`「幽灵 = 按 Tab 会插进来什么」 |
 * | N24 | 瞬时消息里「有哪些命令」那一档回来 | `input.test.ts`「底部不再有那条提示栏」 |
 * | N25 | 状态行左半又写回 `target add` 引导 | 同上 |
 * | N26 | 鼠标点面板行按候选序回查 | `input.test.ts`「滚过之后点某一行」 |
 * | N27 | 滚轮在面板开着时仍滚结果区 | `input.test.ts`「滚轮移动高亮」 |
 * | N28 | 装不下时不留「共 N 条」 | `input.test.ts`「面板装不下时」 |
 * | N29 | 窗口夹住而不跟着高亮滚 | 同上 |
 *
 * ## 面板改成「浮在输入框上方」那一轮的变异（二十二条）
 *
 * | # | 变异 | 转红的判据 |
 * | --- | --- | --- |
 * | M1 | 面板的上限不封顶（占满整块结果区） | `geometry.test.ts` ⑥「不超过内容行 × 40%」 |
 * | M2 | 上限给「至少一行」的兜底（矮屏上超过 40%） | 同上（`rows=8` 那一档） |
 * | M3 | 那一条「装不下」说明行**算在上限之外** | 同上 +「说明行算在上限之内」 |
 * | M4 | 面板**不贴输入框**（离它一格） | ⑥「最后一行候选的下缘 == 输入框的上缘」 |
 * | M5 | 结果区**不扣**面板占掉的行 | ⑥「结果文本 + 面板 = 内容高度」 |
 * | M6 | 侧边栏每项**不铺满整列** | `geometry.test.ts`「横跨整列」+ `layout.test.ts`「铺满整列」 |
 * | M7 | 侧边栏**第一项不从第 0 行起** | `geometry.test.ts`「没有框：第一项从第 0 行起」 |
 * | M8 | 结果区内容宽度**多扣一列** | `geometry.test.ts`「一个列都不多扣」 |
 * | M9 | 输入区**框里那 3 行**改成 2 行 | `geometry.test.ts` 的首尾相接那几组 |
 * | M10 | 侧边栏**把框加回来** | `layout.test.ts`「整屏只有输入框有框」 |
 * | M11 | 主区**把框加回来** | 同上 |
 * | M12 | 侧边栏**标题行加回来** | `layout.test.ts`「侧边栏没有标题行」 |
 * | M13 | 去掉 hover 那一项 `<Box>` 上的底色 | `layout.test.ts` ②「hover 铺满整列」 |
 * | M14 | 选中项的**名字不给「选中」色** | `layout.test.ts` ②「选中的那一项」 |
 * | M15 | 选中项**给一层反底色**（两个通道混在一起） | 同上（底色那一半） |
 * | M16 | hover 的底色**取列那一条** | `layout.test.ts` ② + `input.test.ts` 的 hover 三条 |
 * | M17 | `Output` 的高度回到「结果文本 + 1」 | 🟢 **实测仍绿** —— 见下面那条证明 |
 * | M18 | 面板那几行**不按几何的高度画** | `layout.test.ts`「面板开着时输入区整块还在屏上」 |
 * | M19 | `move` 报告**不再换 hover** | `input.test.ts`「指到侧边栏那一项」 |
 * | M20 | hover **不跟着指针离开而清掉** | `input.test.ts`「划到主区回到列那一条」 |
 * | M21 | 命令名**不跨空白**取 | 本档「`↓` 走过两段命令名的边界」 |
 * | M22 | 换掉的宽度回到「被选中那条名字的前缀」 | 同上 |
 *
 * ⚠️ **两条「不是变异的变异」**（实测是绿的，故它们**不是**这条护栏在生效的证据）：
 * - 把 `complete` 的 `cursor < lead` 判据删掉 —— 那一半被「`startsWith`」**同时**挡着，
 *   单独删它没有可观测后果（真正的牙齿是 N2 与 N3 的组合）。
 * - **M17 是可证明的等价变异**：`outputRows = max(0, outputBlockRows - 1)`，故 `outputBlockRows ≥ 1`
 *   时 `outputRows + 1 === outputBlockRows` 逐字相等；而 `outputBlockRows === 0` 时那个恒等式
 *   让「多画的一行滚动提示」正好落在结果区**本来就有的**那一行空位里（结果是**不溢出**）。
 *   它真正被挡住的地方是 ⑥ 的恒等式「`outputBlockRows + 面板 === 内容行数`」—— 那条一旦破，
 *   这一行就无处安放。
 *
 * ⚠️ 早先那条「面板画在结果区前面 → 真渲染看不见」也已作废：面板现在**自己占行**，两者
 * 画在同一列里依次排下去，`flexDirection` 的先后**看得见**（N16 就是靠它转红的）。
 */

import { describe, expect, it } from "vitest";

import {
  PALETTE_ROWS,
  commandHead,
  paletteFill,
  paletteOf,
  paletteOpen,
  paletteStep,
  paletteWindow,
} from "@/commands/palette.js";
import { COMMAND_SPECS } from "@/commands/parse.js";

/** 面板里那一行的下标（`paletteOf` 的返回在类型上给不出这个断言要的东西，故这里取一行） */
function rowAt(line: string, index: number): string {
  const palette = paletteOf(line);
  const row = palette.rows[index];
  if (row === undefined) throw new Error(`面板里没有第 ${index} 行（共 ${palette.rows.length} 行）`);
  return row.path;
}

/* ── ① 面板的开 ──────────────────────────────────────────────────────────── */

describe("不变量 ①：面板开 ⇔ 整行以 `/` 开头（只有这一条判据）", () => {
  it("带前缀就开，空行与不带前缀的行都不开", () => {
    expect(paletteOpen("/")).toBe(true);
    expect(paletteOpen("/s")).toBe(true);
    expect(paletteOpen("/user add alice")).toBe(true);
    expect(paletteOpen("/status ")).toBe(true);
    // ⚠️ **反向自检**：不带前缀的一律不开。少了它，「面板亮着而 Tab 什么也不做」就会出现
    // （`@/commands:complete` 对同一行给零候选 —— 两层不同步）。
    expect(paletteOpen("")).toBe(false);
    expect(paletteOpen("status")).toBe(false);
    expect(paletteOpen("  /status")).toBe(false);
    expect(paletteOpen("x")).toBe(false);
  });

  it("⚠️ 光标在哪、有没有空格**都不影响**开不开（变异：加上那些条件 → 这里红）", () => {
    // 判据是「只判前缀」这件事本身：每加一个条件（光标在不在名字里、是不是刚敲完一个空格），
    // 面板就会多一种形态，而操作者看到的是「有时候有面板有时候没有」。
    for (const line of ["/", "/user", "/user ", "/user add", "/user add "]) {
      expect(paletteOpen(line)).toBe(true);
    }
  });

  it("关着的时候给的是中性值（不是 `null` 的分支）", () => {
    const closed = paletteOf("status");
    expect(closed.open).toBe(false);
    expect(closed.at).toBe(-1);
    expect(closed.rows).toEqual([]);
  });
});

/* ── ② 列全表，敲的东西只定高亮 ─────────────────────────────────────────── */

describe("不变量 ②：列的是**全表**，敲出来的东西只用来定高亮", () => {
  it("每一行都来自那唯一一张表，且顺序就是表的顺序（`help` 的呈现顺序）", () => {
    expect(paletteOf("/").rows.map((row) => row.path)).toEqual(
      COMMAND_SPECS.map((spec) => spec.path),
    );
    expect(paletteOf("/").rows.map((row) => row.summary)).toEqual(
      COMMAND_SPECS.map((spec) => spec.summary),
    );
  });

  it("敲了一半**不裁列表**（否则 `↓` 只能走一步）", () => {
    // ⚠️ 这是本组的核心：过滤会让高亮写成 `/clear` 之后列表塌成一行，于是第二次 `↓`
    // 无处可去 —— 症状是「面板只能选一次」。
    expect(paletteOf("/s").rows).toHaveLength(PALETTE_ROWS.length);
    expect(paletteOf("/user").rows).toHaveLength(PALETTE_ROWS.length);
  });

  it("敲的东西表里没有时：**一个都不高亮**，而列表照旧全在", () => {
    const none = paletteOf("/zzz");
    expect(none.open).toBe(true);
    expect(none.at).toBe(-1);
    expect(none.rows).toHaveLength(PALETTE_ROWS.length);
  });

  it("高亮 = 第一个名字以命令名开头的行（**表的顺序**，不是字典序）", () => {
    // ⚠️ `/c` 的两条候选是 `config`（表里第 3）与 `acl`（第 5）；按字典序会选 `acl`，
    // 而这一组断言钉的是「先查帮助、再干活」那个顺序。
    expect(paletteOf("/c").at).toBe(COMMAND_SPECS.findIndex((spec) => spec.name === "config"));
    expect(rowAt("/c", paletteOf("/c").at)).toBe("/config");
  });

  it("命令名**跨空白**取到「第一个不属于命令名的词」为止", () => {
    // ⚠️ 判据落在「**跨空白**」上：`/user add alice` 的命令名是 `user add`，而按空白截断得到
    // `user` —— 于是 `/user add `（名字已经敲完，后面那个空格就是分界）的高亮停在 `/user` 上，
    // 而屏上那个形状是「按了 `↓` 它不动」。
    expect(commandHead("/user add alice")).toBe("user add");
    expect(commandHead("/user add")).toBe("user add");
    expect(commandHead("/user add ")).toBe("user add");
    expect(commandHead("/user")).toBe("user");
    expect(commandHead("/users")).toBe("users");
    expect(commandHead("/")).toBe("");
    // ⚠️ **敲到一半的词也算**：高亮落在唯一那一条上（`/user a` → `/user add`）
    expect(commandHead("/user a")).toBe("user a");
    expect(rowAt("/user a", paletteOf("/user a").at)).toBe("/user add");
    // ⚠️ 表里没有的东西**只取第一个词**（那是「正在敲的那一段」）
    expect(commandHead("/zzz tail")).toBe("zzz");
    // ⚠️ 对照：这一段只管命令名，而**光标所在那个词**的候选是 `@/commands:complete` 的活。
    // 两者看的是不同的位置，所以它们给两个答案不是矛盾。
    expect(commandHead("/user add alice")).not.toBe("add");
  });

  it("⚠️ `↓` 走过**两段命令名**的边界时，输入行与高亮**始终**指着同一条", () => {
    // ⚠️ 这一条是上面那条判据的**可观察后果**：两段命令名一带的换行若只吃掉第一个词，输入行会
    // 变成 `/user set add` 而高亮回到 `/user` —— 于是再按 `↓` 就**再也不动了**
    // （`paletteStep` 看到 `at` 没变就直接返回）。故它必须一路走过那一段才验得出来。
    let line = "/";
    let cursor = 1;
    const walked: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const to = paletteStep(paletteOf(line).at, 1, PALETTE_ROWS.length);
      const row = PALETTE_ROWS[to];
      if (row === undefined) throw new Error(`面板里没有第 ${String(to)} 行`);
      const filled = paletteFill(line, cursor, row);
      line = filled.line;
      cursor = filled.cursor;
      // ⚠️ 换完之后的输入行**就是**刚选中的那一条（补出来的那个尾随空格也算进去）
      expect(line).toBe(`${row.path}${row.needsSpace ? " " : ""}`);
      expect(paletteOf(line).at).toBe(to);
      walked.push(row.path);
    }
    // ⚠️ **反向自检**：12 步真的走了 12 条不同的命令（一个「原地不动」的实现也满足上面两条，
    // 而屏上那一帧是「按了 `↓` 没反应」）
    expect(new Set(walked).size).toBe(12);
  });
});

/* ── ③ 高亮是输入行的纯函数 ─────────────────────────────────────────────── */

describe("不变量 ③：高亮只由输入行决定（界面上没有「高亮在第几行」这个状态）", () => {
  it("`↓` 走一步之后，写进输入行的那一行**就是**下一帧的高亮", () => {
    const at = paletteOf("/").at;
    const next = paletteStep(at, 1, PALETTE_ROWS.length);
    const row = PALETTE_ROWS[next] as (typeof PALETTE_ROWS)[number];
    const filled = paletteFill("/", 1, row);
    // ⚠️ 闭包：填完之后重新算，高亮必须落在刚填的那一行上。
    // 少了这一条，「输入行上敲的是 A、面板高亮的是 B」就会在每一次 `↓` 之后发生一次。
    expect(paletteOf(filled.line).at).toBe(next);
    expect(rowAt(filled.line, paletteOf(filled.line).at)).toBe(row.path);
  });

  it("⚠️ 同一行**算两次逐字相同**（变异：让 `at` 自己累加 → 这里红）", () => {
    // 判据是「可重复」这件事本身：一个把 `at` 记在模块级变量里的实现两次调用会给出不同的结果，
    // 而 React 重渲染时同一帧算两次那种形状（StrictMode / 双调用）就会让高亮自己走。
    expect(paletteOf("/user set bob").at).toBe(paletteOf("/user set bob").at);
    // ⚠️ 敲 `/user` 高亮的是 `/user` **本身**而不是 `/users`（表里 `users` 排在前面）——
    // 少了这条，`Tab` 会补出一条他没敲的命令，而那一条还真实存在。
    expect(rowAt("/user", paletteOf("/user").at)).toBe("/user");
    expect(rowAt("/users", paletteOf("/users").at)).toBe("/users");
  });

  it("敲了前缀就高亮那一条（`/st` → `/status`）", () => {
    expect(rowAt("/st", paletteOf("/st").at)).toBe("/status");
    expect(rowAt("/user", paletteOf("/user").at)).toBe("/user");
  });
});

/* ── ④ 一个补全实现，四处共用 ───────────────────────────────────────────── */

describe("不变量 ④：`paletteFill` 只换命令名那一段，形参与光标位置都保住", () => {
  /** 取面板里的某一行（按名字找，锚在**给人看的**那一串上） */
  function rowNamed(path: string): (typeof PALETTE_ROWS)[number] {
    const row = PALETTE_ROWS.find((one) => one.path === path);
    if (row === undefined) throw new Error(`面板里没有 ${path}`);
    return row;
  }

  it("光标在命令名中间：换掉**整个**命令名段（含光标后面的字）", () => {
    // ⚠️ `/user ad|d alice` → `/user add alice`：尾部的形参**原样留着**
    const filled = paletteFill("/user add alice", 8, rowNamed("/user add"));
    expect(filled.line).toBe("/user add alice");
    expect(filled.cursor).toBe("/user add".length);
  });

  it("⚠️ 尾部形参一个字节都不许动（变异：改成替换整行 → 这里红）", () => {
    const filled = paletteFill("/st alice 1g", 3, rowNamed("/status"));
    expect(filled.line).toBe("/status alice 1g");
    const other = paletteFill("/zzz keep-me", 4, rowNamed("/target switch"));
    expect(other.line).toBe("/target switch keep-me");
  });

  it("两段命令名的补完**补一个尾随空格**，单段的**不补**", () => {
    // ⚠️ 不补空格的话操作者接着敲形参会粘在名字后面（`/user addalice`），那是一个**静默**
    // 的参数错误；而给单段的补空格会让面板多出「补一次就关掉」的手感。
    expect(paletteFill("/", 1, rowNamed("/user add")).line).toBe("/user add ");
    expect(paletteFill("/", 1, rowNamed("/status")).line).toBe("/status");
    expect(PALETTE_ROWS.find((one) => one.path === "/user add")?.needsSpace).toBe(true);
    expect(PALETTE_ROWS.find((one) => one.path === "/status")?.needsSpace).toBe(false);
  });

  it("补完的光标落在刚写进去的那一段**之后**", () => {
    expect(paletteFill("/", 1, rowNamed("/acl")).cursor).toBe("/acl".length);
    expect(paletteFill("/", 1, rowNamed("/target switch")).cursor).toBe(
      "/target switch ".length,
    );
  });

  it("⚠️ 补进去的**不许**把前缀写两遍（变异：直接拼 `row.path` → 这里红）", () => {
    // `row.path` 是**给人看**的那一串（带前缀），而写进行内时前缀由 `COMMAND_PREFIX` 写一次。
    // 拼两次的结果是 `//status` —— 而它**恰好**还能被 `parseLine` 拒掉，于是症状是「补完之后
    // 回车说不认识命令」，看起来像解析器的锅。
    for (const row of PALETTE_ROWS) {
      const filled = paletteFill("/", 1, row);
      expect(filled.line.startsWith("//")).toBe(false);
      const name = row.path.slice(1);
      expect(filled.line.slice(1, 1 + name.length)).toBe(name);
    }
  });
});

/* ── ⑤ `↑`/`↓` 与滚动窗口 ───────────────────────────────────────────────── */

describe("不变量 ⑤：`↑`/`↓` 不循环，而滚动窗口保证高亮可见", () => {
  it("到头停住（不循环）", () => {
    expect(paletteStep(0, -1, 5)).toBe(0);
    expect(paletteStep(4, 1, 5)).toBe(4);
  });

  it("⚠️ 没有高亮时 `↓` 到第一行、`↑` 到最后一行（变异：返回 `-1` → 这里红）", () => {
    // 「敲了一个表里没有的东西之后按 `↓` 永远没反应」，而那恰好是最需要面板给点提示的时刻
    expect(paletteStep(-1, 1, 5)).toBe(0);
    expect(paletteStep(-1, -1, 5)).toBe(4);
    expect(paletteStep(-1, 1, 0)).toBe(-1);
  });

  it("窗口：装得下就是 0，装不下就把高亮**顶进**视口（而不是 clamp 首行号）", () => {
    expect(paletteWindow(0, 10, 5)).toBe(0);
    expect(paletteWindow(4, 10, 5)).toBe(0);
    // ⚠️ 高亮在视口里就不滚（移动最少的那一个）
    expect(paletteWindow(3, 10, 19)).toBe(0);
    expect(paletteWindow(9, 10, 19)).toBe(0);
    expect(paletteWindow(10, 10, 19)).toBe(1);
    expect(paletteWindow(18, 10, 19)).toBe(9);
    // 末行之后不许露出空行
    expect(paletteWindow(999, 10, 19)).toBe(9);
    expect(paletteWindow(0, 0, 19)).toBe(0);
  });

  it("⚠️ `at` 越界也得能用（变异：先夹 `at` 再算窗口 → 这里红）", () => {
    // 判据是「返回的首行号仍然让高亮落在视口里」这件事，不是「某个具体数字」——
    // 后者对「恒返回 0」绿，而那正是那个 bug 的形状。
    for (const at of [-5, -1, 0, 7, 18, 999]) {
      const start = paletteWindow(at, 6, 19);
      const clampedAt = Math.min(Math.max(at, 0), 18);
      expect(clampedAt).toBeGreaterThanOrEqual(start);
      expect(clampedAt).toBeLessThan(start + 6);
    }
  });
});