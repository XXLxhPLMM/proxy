/**
 * `tests/contract/` —— **呈现层视图契约**的形状断言（零 IO、零 Ink、零 React）
 *
 * 这一档答什么：`@/components/types.ts` 那份 props 契约的**形状** —— `ModalView` 每一档的键集、
 * 判别字段与 `@/store` 的 `WindowState.kind` 逐字同名、`LayoutProps` 里零坐标零函数。
 *
 * ⚠️ **判据形状是「从源码现取的事实」，不是「抄一份字符串数组」也不是「点名一个符号说不许有」**：
 * 前者两处一起漂的时候一起绿（恒真），后者点名一个已删的符号则永远绿。**实测**：
 * 抄一份 `MODAL_KINDS` 再自己比自己，加一档 / 改名 / 删一档 / 加一格坐标 / 加一个函数字段
 * 五种变异**全部恒绿** —— 故那一版被整段拿掉，换成现取。
 *
 * ⚠️ **现取的那份必须带判据自检**：`expectTypeOf` 那一族在 `vitest` 里**恒绿**（类型断言不是运行期判据），
 * 而「探测器认错了东西」与「实现坏了」在屏上一样。故本档每一条负向断言都配**同一条 `it` 里的正向对照**
 * —— 对照答的是「探测器今天还能取到东西吗」，取不到就当场红，而不是静默判成通过。
 *
 * @module tests/contract
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { FieldCell, LayoutProps, ModalView } from "@/components/index.js";
import { slotsOf } from "@/components/index.js";

/** `src/components/types.ts`（⚠️ **两个** `..`：本档在 `tests/contract/`，一个会落到不存在的目录 ⇒ 响亮的红） */
const TYPES_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "components",
  "types.ts",
);

/** 只留**代码**（剔整行 `//` 与 `/* … *\/` 块注释；与 `tests/geometry` 那一档同一套纪律） */
function codeOnly(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlock = true;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * `type X = …` / `interface X { … }` 那个声明的正文
 * @description ⚠️ **括号只数 `(` `[` `{`** —— 数 `<`/`>` 会被 `=>` 与比较运算坑掉（而本目录里两者都有）。
 * ⚠️ **结束判据分两种**：`interface` 收在把深度带回 0 的那个 `}`，`type` 收在深度 0 上的 `;`
 * （`type X = | {…} | {…}` 的第一档闭完深度就回 0 了，按「闭括号即止」取到的只有第一档）。
 */
function declBody(source: string, name: string): string {
  const at = source.search(new RegExp(`(?:type|interface)\\s+${name}\\b`, "u"));
  if (at < 0) throw new Error(`取不到 ${name} 那个声明`);
  const isInterface = /^interface\b/u.test(source.slice(at));
  let depth = 0;
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      if (isInterface && depth <= 0) return source.slice(at, i + 1);
    } else if (!isInterface && ch === ";" && depth <= 0) {
      return source.slice(at, i + 1);
    }
  }
  throw new Error(`${name} 那个声明没有闭合`);
}

/** `ModalView` 每一档的**判别值**（⚠️ 量的是「`kind` 的字面量」这个存在物，不是抄一份数组） */
function modalKinds(): readonly string[] {
  const body = declBody(codeOnly(fs.readFileSync(TYPES_FILE, "utf8")), "ModalView");
  return [...body.matchAll(/readonly kind:\s*"([^"]+)"/gu)].map((one) => one[1]!);
}

/** 某一档那一支的**键集**（`kind: "x"` 那一支，从它起到下一个 `kind:` 或声明末尾） */
function variantKeys(kind: string): readonly string[] {
  const body = declBody(codeOnly(fs.readFileSync(TYPES_FILE, "utf8")), "ModalView");
  const at = body.search(new RegExp(`readonly kind:\\s*"${kind}"`, "u"));
  if (at < 0) throw new Error(`ModalView 里没有 ${kind} 那一档`);
  // ⚠️ 从 `at` 起（不是 `at + 1`：那会啃掉 `readonly` 的第一个字母，于是 `kind` 那一格取不到）
  const rest = body.slice(at);
  const next = rest.slice("readonly kind:".length).search(/readonly kind:\s*"/u);
  const branch = next < 0 ? rest : rest.slice(0, next);
  return [...new Set([...branch.matchAll(/readonly (\w+)[?]?:/gu)].map((one) => one[1]!))].sort();
}

/** `LayoutProps` 每一格的**成员名**（⚠️ 量的是「声明里有哪些 `readonly x`」，不是「不许有某个名字」） */
function layoutKeys(): readonly string[] {
  const body = declBody(codeOnly(fs.readFileSync(TYPES_FILE, "utf8")), "LayoutProps");
  return [...new Set([...body.matchAll(/readonly (\w+)[?]?:/gu)].map((one) => one[1]!))].sort();
}

/** `LayoutProps` 某一格声明的**原文**（判据按原文判形 ⇒ 加一格坐标 / 一个函数字段都会被抓到） */
function layoutMember(name: string): string {
  const body = declBody(codeOnly(fs.readFileSync(TYPES_FILE, "utf8")), "LayoutProps");
  const at = body.search(new RegExp(`readonly ${name}[?]?:`, "u"));
  if (at < 0) throw new Error(`LayoutProps 里没有 ${name} 那一格`);
  // ⚠️ 那一格的**声明原文**：取到行尾或分号为止（⚠️ 类型里有 `;` 的没有，故分号与行尾都算结束）
  const line = body.slice(at).split(/[;\n]/u)[0]!;
  return line.slice(line.indexOf(":") + 1).trim();
}

/** `@/store` 那一侧**穷举**出来的 `WindowState` 判别值（⚠️ 现取源码，不是抄一份） */
function storeKinds(): readonly string[] {
  return [
    ...new Set([...windowStateBody().matchAll(/readonly kind:\s*"([^"]+)"/gu)].map((one) => one[1]!)),
  ].sort();
}

/** `@/store` 那一侧 `WindowState` 那个声明的正文（与 {@link declBody} 共用同一套括号计数） */
function windowStateBody(): string {
  const file = path.resolve(path.dirname(TYPES_FILE), "..", "store", "app-store.ts");
  return declBody(codeOnly(fs.readFileSync(file, "utf8")), "WindowState");
}

/** `WindowState` 某一档的**键集**（`kind: "x"` 那一支，从它起到下一个 `kind:` 或声明末尾） */
function storeVariantKeys(kind: string): readonly string[] {
  const body = windowStateBody();
  const at = body.search(new RegExp(`readonly kind:\\s*"${kind}"`, "u"));
  if (at < 0) throw new Error(`WindowState 里没有 ${kind} 那一档`);
  // ⚠️ 从 `at` 起（不是 `at + 1`：那会啃掉 `readonly` 的第一个字母，于是 `kind` 那一格取不到）
  const rest = body.slice(at);
  const next = rest.slice("readonly kind:".length).search(/readonly kind:\s*"/u);
  const branch = next < 0 ? rest : rest.slice(0, next);
  return [...new Set([...branch.matchAll(/readonly (\w+)[?]?:/gu)].map((one) => one[1]!))].sort();
}

/** 弹窗槽位的全集（现取 `@/lib/geometry.ts` 的 `WindowSlot`，⚠️ 加一档时它会红） */
function slotKinds(): readonly string[] {
  const file = path.resolve(path.dirname(TYPES_FILE), "..", "lib", "geometry.ts");
  const body = declBody(codeOnly(fs.readFileSync(file, "utf8")), "WindowSlot");
  return [...new Set([...body.matchAll(/readonly kind:\s*"([^"]+)"/gu)].map((one) => one[1]!))].sort();
}

describe("视图契约：探测器**今天还能取到东西**吗（每条负向断言的正向对照）", () => {
  it("⚠️ 取得到 `ModalView` 的每一档（探测器认错了形状 ⇒ 下面全绿，而契约已经没了）", () => {
    const kinds = modalKinds();
    expect(kinds.length).toBeGreaterThan(1);
    // ⚠️ 正向对照：它取到的必须是**逐字**那几档（抄一份数组再自己比自己是恒真的）
    expect(kinds).toContain("sessions");
    expect(kinds).toContain("provider-form");
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("⚠️ 取得到 `LayoutProps` 的键，且**宽高两格恒在**（否则「零坐标」那条会因 props 是空的而恒绿）", () => {
    const keys = layoutKeys();
    expect(keys).toContain("columns");
    expect(keys).toContain("rows");
    expect(keys).toContain("view");
    expect(keys.length).toBeGreaterThan(10);
  });

  it("⚠️ 取得到 `@/store` 的判别值与几何层的槽位种类（这两个探测器各自都得先自证）", () => {
    expect(storeKinds()).toContain("sessions");
    expect(storeKinds()).toContain("provider-models");
    expect(slotKinds()).toContain("row");
    expect(slotKinds()).toContain("check");
  });
});

describe("视图契约：`ModalView` 是判别联合，且判别字段与 `@/store` **逐字同名**", () => {
  /**
   * 视图里**多出来**的那几档（呈现层画、而跨帧状态不表达它）
   * @description ⚠️ **这张表是判据的一部分，不许因为「今天只有一档」就把它删掉**：
   * 少了它，「多一档」与「少一档」两个方向就有一个恒绿 —— 而那正是根仓 `AGENTS.md`
   * 「写护栏时」点名的坑（点名一个已删的符号 ⇒ 永远绿；反过来，**放行一个已删的例外**
   * 会让「这一档该不该存在」这件事从此无人过问）。
   * ⚠️ 每一项都必须**给出为什么它不在 `@/store` 那一边**（形状答不上来就是它该搬进窗态的信号）。
   */
  const VIEW_ONLY: Readonly<Record<string, string>> = {
    // ⚠️ 表单那一档：五种表单（提供商 / 控制面 / 账号 / 改密码 / 改显示名）要的格子从四格到一格不等，
    // 而「一个 `kind` + 全可选字段」正是那份形状的谎话 ⇒ 它住在状态层的局部 `FormState` 上，
    // 呈现层只拿 `fields`（长度由状态层给）。
    "provider-form": "五种表单的字段表彼此不同，窗态那一个变体表达不了 ⇒ 住在状态层的局部 FormState",
  };

  it("⚠️ 视图的判别值 = `@/store` 的判别值 ∪ **逐字列出的那几档例外**（两边不许多也不少）", () => {
    // ⚠️ 判据是**两个 union 的成员集各归其类**：视图层多一档（且不在例外表里）/ 少一档都红，
    // 而「抄两份字符串数组互相比」在两处一起漂的时候一起绿
    const view = modalKinds().slice().sort();
    const store = storeKinds();
    expect(view).toEqual([...store, ...Object.keys(VIEW_ONLY)].sort());
    // ⚠️ **反向自检**：`@/store` 那一侧**不许**多出不在视图里的档（多一档 ⇒ 状态层开得出来而
    // 呈现层画不出，症状是「弹窗开了一个空的卡片」而屏上零解释）
    expect(store.filter((one) => !view.includes(one))).toEqual([]);
    // ⚠️ **正向对照**：例外表恒非空且每一项**真的在视图里**（表为空时上面那条恒绿，
    // 而表里写着一个已删的档名时它也恒绿 —— 两头都要挡）
    expect(Object.keys(VIEW_ONLY)).not.toEqual([]);
    for (const [kind, why] of Object.entries(VIEW_ONLY)) {
      expect(view, kind).toContain(kind);
      // ⚠️ 例外**不许只是一张清单**：每一项都要说得出「为什么它不进窗态」
      expect(why.length, kind).toBeGreaterThan(10);
    }
  });

  it("⚠️ 每一档的**键集**逐字钉住（少一格 ⇒ 呈现层读不到；多一格 ⇒ 有人在视图里塞了别的东西）", () => {
    const wanted: Readonly<Record<string, readonly string[]>> = {
      sessions: ["at", "closeHint", "kind", "note", "rows", "title"],
      targets: ["at", "closeHint", "kind", "note", "rows", "title"],
      users: ["at", "closeHint", "kind", "note", "rows", "title"],
      providers: ["at", "closeHint", "kind", "note", "rows", "title"],
      "provider-form": ["closeHint", "fields", "kind", "note", "title"],
      "provider-models": ["at", "closeHint", "filter", "kind", "note", "rows", "title"],
      models: ["at", "closeHint", "kind", "note", "rows", "title"],
    };
    expect(modalKinds().slice().sort()).toEqual(Object.keys(wanted).sort());
    for (const [kind, keys] of Object.entries(wanted)) {
      expect(variantKeys(kind)).toEqual(keys);
    }
  });

  it("⚠️ 清单三档**行上**带 `pending`（判据是「那一行真有那一格」，不是「弹窗上有」）", () => {
    // ⚠️ 正向对照：取得到那一档的行形状（探测器认错了 ⇒ 下面恒绿）
    const source = codeOnly(fs.readFileSync(TYPES_FILE, "utf8"));
    for (const declName of ["ListRow", "SessionListRow"] as const) {
      const decl = declBody(source, declName);
      expect(decl).toContain("readonly pending: boolean;");
      // ⚠️ 正向对照：同一格里**别的**格子也在（不是整份文件里搜到过就万事大吉）
      expect(decl).toContain("readonly id: string;");
    }
    // ⚠️ 而模型清单那一档的行**也**带那一格（删除在那一档同样是两段 `Ctrl+D`）
    expect(declBody(source, "ModelCheckRow")).toContain("readonly pending: boolean;");
  });

  it("⚠️ 表单那一档是 `fields`（**一个数组**）而模型清单那一档是 `filter`（**一格**）", () => {
    // ⚠️ 正向对照：`FieldCell` 的两个档都认，而它真的只带那两个键
    const source = codeOnly(fs.readFileSync(TYPES_FILE, "utf8"));
    const cell = declBody(source, "FieldCell");
    // ⚠️ 判别字段是**一个字面量闭集**（`"input" | "select"`）而不是两格可选 —— 量的是那一行原文
    const kindLine = cell.split(/\r?\n/u).find((line) => line.includes("readonly kind:"))!;
    expect([...kindLine.matchAll(/"([^"]+)"/gu)].map((one) => one[1])).toEqual(["input", "select"]);
    // ⚠️ `options` 是**可选**的（`?:`）—— 只在 `select` 那一格上给，而那一格恒有它
    expect(cell).toContain("readonly options?: readonly string[];");
    // ⚠️ 判别字段不是可选的（可选的话一个 `undefined` 就能混进来，而那正是「忘了传」）
    expect(cell).toContain('readonly kind: "input" | "select";');
    // ⚠️ **`cursor` 恒在且恒不是可选**（可选的话「忘了传」与「这一格刻意没有插入符」在类型上
    // 长得一样，而漏传的症状是「焦点在这一格、光标不知道在哪儿」而屏上零报错）
    expect(cell).toContain("readonly cursor: number;");
    // ⚠️ **反向自检**：可选的那一份**真的没有**（`cursor?:` 混进来时上面那条会红）
    expect(cell).not.toContain("readonly cursor?:");
  });

  it("⚠️ 每一档清单的**窗态**上都挂着 `pending`（同一个「待确认删除」不许有两个持有者）", () => {
    // ⚠️ 判据是**逐档现取键集**而不是「源码里有 `pending` 这个字」：不带它的那一档照样通过
    // 后面那半句，而症状是「待确认删除住在状态层而窗态不知道」——两处各有一份时关窗重开就漏
    for (const kind of storeKinds()) {
      const keys = storeVariantKeys(kind);
      expect(keys, kind).toContain("pending");
      // ⚠️ **正向对照**：探测器认得这一档的**别的**格子（`kind` 恒在 ⇒ 取到的是这一支而不是整份声明）
      expect(keys, kind).toContain("kind");
    }
    // ⚠️ 而**视图那一侧没有** `pending`：待确认删除是**窗态**的一格，屏上那一格由行模型回答
    // （`ListRow.pending` / `SessionListRow.pending` / `ModelCheckRow.pending`）——
    // 两边各有一个 pending 会造出「窗态说在等、那一行却不是警告色」这种两处各说各话的屏面
    for (const kind of modalKinds()) {
      expect(variantKeys(kind), kind).not.toContain("pending");
    }
  });

  it("⚠️ 槽位种类是**六档**，不多不少（⚠️ **正向对照**：加一档时现取的那份会红）", () => {
    expect(slotKinds()).toEqual(["check", "group", "input", "note", "row", "select"]);
  });
});

describe("视图契约：`LayoutProps` 里**零坐标、零函数**，而屏的尺寸恒在", () => {
  /** 坐标的**具名**形状（⚠️ **只收真坐标那几名**：行号 / 下标（`top` / `cursor` / `sessionsTop`）不是坐标 —— 它们推不出一个矩形） */
  const COORD_NAMES = ["x", "y", "rect", "origin", "corner", "point", "box", "slotRect"];
  /** 一格**函数字段**的类型形状（箭头函数 / `Function`） */
  const FUNCTION_SHAPE = /=>|\bFunction\b/u;

  it("⚠️ 零坐标成员（⚠️ **正向对照**：宽高与侧边栏宽度**恒在** —— 否则「零」是空的）", () => {
    const keys = layoutKeys();
    expect(keys).toContain("columns");
    expect(keys).toContain("rows");
    expect(keys).toContain("sidebarWidth");
    for (const name of COORD_NAMES) {
      expect(keys).not.toContain(name);
    }
    // ⚠️ **`top` / `cursor` / `sessionsTop` 不是坐标**（行号与下标，判据是「它推不推得出一个矩形」）：
    // 滚动位置与插入符下标恒在 `LayoutProps` 上，而它们答的是「第几行」与「第几个字」。
    // ⚠️ 把它们算成坐标的话这条判据就只剩三个名字可盯，而下一次叫 `row` / `offset` 就漏过了。
    expect(keys).toContain("top");
    expect(keys).toContain("cursor");
    // ⚠️ **类型形状那一半**（成员名只挡得住同名的那个坐标）：任何一格**推得出一个矩形**就红 ——
    // 两条判据各自独立：① 类型**指名**几何层那几种（`Rect` / `Geometry` / `Point` / `MenuRequest`），
    // ② 类型**内联**一个带坐标格的对象（`{ x: … }` 那一族）。故下一次叫 `where` / `hit` / `bounds`
    // 也照样被逮住，而不必先把名字列全（列全的那种下一次就漏了）。
    const NAMED = /\b(Rect|Geometry|Point|MenuRequest)\b/u;
    const INLINE = /\b(x|y|width|height|left|right|top|bottom)\s*[?:]/u;
    for (const name of keys) {
      const type = layoutMember(name);
      expect(`${name}:${NAMED.test(type)}`).toBe(`${name}:false`);
      expect(`${name}:${INLINE.test(type)}`).toBe(`${name}:false`);
    }
    // ⚠️ **正向对照**：探测器认得那两种形状（否则上面那两趟是恒绿）
    expect(NAMED.test("Rect")).toBe(true);
    expect(INLINE.test("{ x: number; y: number }")).toBe(true);
    expect(NAMED.test("ModalView | null")).toBe(false);
    expect(INLINE.test("readonly SidebarEntry[]")).toBe(false);
  });

  it("⚠️ 零函数字段（呈现层一个动作都不许自己存 ⇒ 跨帧状态全在状态层）", () => {
    // ⚠️ 判据按**声明的原文**判形 ⇒ 叫 `pick` / `doX` / `handleY` / `onSelect` 全都躲不过
    for (const name of layoutKeys()) {
      expect(`${name}:${FUNCTION_SHAPE.test(layoutMember(name))}`).toBe(`${name}:false`);
    }
    // ⚠️ **正向对照**：真有函数字段的那种形状会被判中（探测器认得它，否则上面那条是恒真）
    expect(FUNCTION_SHAPE.test("(id: string) => void")).toBe(true);
    expect(FUNCTION_SHAPE.test("Function")).toBe(true);
  });

  it("⚠️ 一个 `view` 统管所有弹窗，而改名框**住顶层**（焦点在框上这件事屏上到处都要读）", () => {
    // ⚠️ 正向对照：视图恒可空（`null` 是「没开」的唯一写法，⚠️ **不设可选** ——
    // `undefined` 会让「忘了传」与「没开」在类型上分不开）
    expect(layoutMember("view")).toBe("ModalView | null");
    expect(layoutMember("rename")).toBe("RenameField | null");
    expect(layoutMember("view")).not.toBe(layoutMember("rename"));
  });

  it("⚠️ 「完成」记号那一族是**两个格子**而不是合成一格（合成的话看一眼就把它一起清了）", () => {
    const source = codeOnly(fs.readFileSync(TYPES_FILE, "utf8"));
    const row = declBody(source, "SessionRow");
    // ⚠️ 判据是「**两格都在**」而 `run` 的三档**一个字都不许删**（`runMarkOf` 的 `Record` 靠它）
    expect(row).toContain("readonly run: RunState;");
    expect(row).toContain("readonly seen: boolean;");
    expect(runStates()).toEqual(["done", "idle", "running"]);
  });

  it("⚠️ 输入区选区**两端已排好序**，而「提供商 · 推理强度」那一行恒有一档推理强度", () => {
    const source = codeOnly(fs.readFileSync(TYPES_FILE, "utf8"));
    // ⚠️ 正向对照：判据是「**两个成员都在**」而不是「不许有第三个」（多一格不由这条挡）
    expect(declBody(source, "InputSelection")).toContain("readonly start: number;");
    expect(declBody(source, "InputSelection")).toContain("readonly end: number;");
    expect(layoutMember("inputSelection")).toBe("InputSelection | null");
    // ⚠️ 「没选模型」是 `provider === null`（**不是**空串 —— 空串是一个名字）
    const status = declBody(source, "ModelStatusView");
    expect(status).toContain("readonly provider: string | null;");
    expect(status).toContain("readonly reasoning: ReasoningEffort;");
  });
});

describe("视图契约：真的造得出每一档（类型层恒绿，运行期这一层才拦得住）", () => {
  /** 一份真的弹窗视图（⚠️ **每一档一个** —— 只造一档的话 union 少掉其余几档时全绿） */
  function viewOf(kind: ModalView["kind"]): ModalView {
    const base = { title: "T", closeHint: true } as const;
    switch (kind) {
      case "sessions":
        return { ...base, kind, note: null, rows: [], at: 0 };
      case "targets":
      case "users":
      case "providers":
        return { ...base, kind, note: null, rows: [], at: 0 };
      case "provider-form":
        return { ...base, kind, note: null, fields: [] };
      case "provider-models":
        return {
          ...base,
          kind,
          note: null,
          at: 0,
          rows: [],
          filter: { kind: "input", label: "过滤", value: "", focused: true, cursor: 0 },
        };
      case "models":
        return { ...base, kind, note: null, rows: [], at: 0 };
    }
  }

  it("⚠️ 现取的每一档都**造得出来**，且装进 `LayoutProps.view` 后判别值不变", () => {
    const seen: string[] = [];
    for (const kind of modalKinds()) {
      const view = viewOf(kind as ModalView["kind"]);
      const props: Pick<LayoutProps, "view"> = { view };
      expect(view.kind).toBe(kind);
      // ⚠️ 正向对照：它**装得进**那个字段（`view` 恒可空 ⇒ 装进去之后读出来仍收窄得到）
      expect(props.view?.kind).toBe(kind);
      seen.push(kind);
    }
    // ⚠️ **正向对照**：真的走了一趟全部档（上面那趟是空的时 `seen` 也空 ⇒ 这条恒绿）
    expect(seen.length).toBe(modalKinds().length);
  });

  it("⚠️ 表单**五个字段**按固定顺序，而焦点恒恰好一格、`options` 只在 `select` 上", () => {
    const fields: readonly FieldCell[] = [
      { kind: "input", label: "地址", value: "https://x", focused: false, cursor: 8 },
      { kind: "select", label: "API 格式", value: "openai", focused: true, cursor: 6, options: ["openai"] },
      { kind: "input", label: "提供商 id", value: "p1", focused: false, cursor: 2 },
      { kind: "input", label: "提供商名称", value: "P", focused: false, cursor: 1 },
      { kind: "input", label: "key", value: "••••", focused: false, cursor: 0 },
    ];
    const view = { ...viewOf("provider-form"), fields } as Extract<
      ModalView,
      { readonly kind: "provider-form" }
    >;
    if (view.kind !== "provider-form") throw new Error("kind");
    // ⚠️ 顺序就是屏上顺序（判据是**逐个字段名**）
    expect(view.fields.map((one) => one.label)).toEqual([
      "地址",
      "API 格式",
      "提供商 id",
      "提供商名称",
      "key",
    ]);
    // ⚠️ 焦点恒恰好一格 —— `Tab` 在字段之间走靠的就是它（零格 ⇒ `Tab` 无处可去）
    expect(view.fields.filter((one) => one.focused).length).toBe(1);
    for (const one of view.fields) {
      if (one.kind === "select") expect(one.options).not.toBeUndefined();
      else expect(one.options).toBeUndefined();
      // ⚠️ **每一格都带一个插入符下标**（可选项也不例外）：屏上「光标在第几个字」这一条
      // 没有它就答不出来，而漏传的症状是「焦点在这一格、光标在行首」而零报错
      expect(typeof one.cursor, one.label).toBe("number");
    }
    // ⚠️ **`select` 那一格的插入符落在那一档文本的末尾**（`↑↓` 换的是整档而不是往某个位置插字，
    // 而契约里那个数必须与状态层记的同一个数同源 ⇒ 呈现层才能据它算「光标不落在档中间」）
    const select = view.fields.find((one) => one.kind === "select")!;
    expect(select.cursor).toBe(select.value.length);
    // ⚠️ **正向对照**：探测器真能区分这两个数（恒 0 的一个判据是恒真的）
    expect(select.cursor).not.toBe(0);
  });

  it("⚠️ 改显示名那一档**只有一格**（判据是「`fields` 的长度」，不是「五个字段」）", () => {
    // ⚠️ 屏上那一格是「显示名」，而它是 `provider-form` 那一档**唯一**的字段 ——
    // 状态层把它当五格里的第一格画的话，屏上会多出四行空白字段而每一格都可 `Tab` 进去。
    // ⚠️ **判据是长度本身**，而「它得是五格」这个实现在长度上恰好不同 ⇒ 有鉴别力。
    const one: readonly FieldCell[] = [
      { kind: "input", label: "显示名", value: "claude-x", focused: true, cursor: 8 },
    ];
    const view = { ...viewOf("provider-form"), fields: one } as Extract<
      ModalView,
      { readonly kind: "provider-form" }
    >;
    expect(view.fields).toHaveLength(1);
    // ⚠️ **正向对照**：同一个渲染器**接得住**多格的那一份（判据不是「渲染器只画一格」）
    const five: readonly FieldCell[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "input" as const,
      label: `第 ${String(i)} 格`,
      value: "",
      focused: i === 0,
      cursor: 0,
    }));
    expect({ ...view, fields: five }.fields).toHaveLength(5);
    // ⚠️ **槽位序跟着 `fields` 的长度走**（`slotsOf` 是那**唯一**一个出口，而它按
    // `view.fields.map(…)` 现算 ⇒ 一格那一档**不需要**另一份槽位定义）：
    // 判据量的是**槽位串本身**，不是「渲染器支持几格」这种读不出来的东西。
    // ⚠️ **正向对照**：同一档给五格时槽位串真的长到五格（恒长一格的判据是恒绿的）
    expect(slotsOf(view, null).map((slot) => slot.kind)).toEqual(["input"]);
    expect(slotsOf({ ...view, fields: five }, null)).toHaveLength(5);
    // ⚠️ 而**下拉那一格占 `select` 槽而不是 `input` 槽**（判据在状态层那一格上，
    // 而几何层按同一下标铺位置 ⇒ 两处对「第 i 格」的理解对不上时下面那些行整体错位一格）
    const withSelect = [
      one[0]!,
      { ...one[0]!, label: "档", kind: "select" as const, options: ["a"] },
    ];
    expect(slotsOf({ ...view, fields: withSelect }, null).map((slot) => slot.kind)).toEqual([
      "input",
      "select",
    ]);
  });

  it("⚠️ **模型清单的过滤**只影响显示（`filter` 恒是 `input` 一格，勾选在**行**上）", () => {
    const view = {
      ...viewOf("provider-models"),
      filter: { kind: "input", label: "过滤", value: "claude", focused: true, cursor: 2 },
      rows: [
        { id: "p1/a", label: "claude-x", checked: true, pinned: false, pending: false },
        { id: "p1/b", label: "gpt-y", checked: false, pinned: true, pending: false },
      ],
    } as Extract<ModalView, { readonly kind: "provider-models" }>;
    if (view.kind !== "provider-models") throw new Error("kind");
    // ⚠️ 正向对照：它**恒有焦点**（键盘收在它上面），而勾选与置顶是行上的格子
    expect(view.filter.kind).toBe("input");
    expect(view.filter.focused).toBe(true);
    expect(Array.isArray(view.filter)).toBe(false);
    // ⚠️ **它也带插入符**：过滤框是这一屏唯一收键的地方，而「光标在第几个字」与
    // 「焦点在这一格」是两件事 —— 少一格时屏上答得出后者、答不出前者
    expect(view.filter.cursor).toBe(2);
    expect(view.rows.map((one) => one.checked)).toEqual([true, false]);
    expect(view.rows.map((one) => one.pinned)).toEqual([false, true]);
  });

  it("⚠️ 一份**真的** `LayoutProps` 造得出来，而它零坐标零函数", () => {
    const props: LayoutProps = {
      columns: 80,
      rows: 24,
      color: false,
      version: "0.0.0",
      sidebarWidth: 24,
      sessions: [],
      sessionsTop: 0,
      selectedSessionId: null,
      hoveredSessionId: null,
      sessionCloseHot: false,
      handleHot: false,
      managerStates: [],
      flat: { lines: [], height: 0, any: false },
      top: 0,
      input: "",
      cursor: 0,
      inputSelection: null,
      modelStatus: { provider: null, reasoning: "medium" },
      ghost: null,
      notice: null,
      mouseHint: null,
      showLogo: true,
      palette: null,
      droppedHint: null,
      view: null,
      rename: null,
      menu: null,
    };
    // ⚠️ 判据是「**值**的形状」而不是键名：加一格 `{ x, y }` 这里就红
    for (const [name, value] of Object.entries(props)) {
      expect(`${name}:${typeof value}`).not.toBe(`${name}:function`);
      expect(`${name}:${rectish(value)}`).toBe(`${name}:false`);
    }
  });
});

/** 一格**坐标**（`{ x, y, … }` 那个形状）—— ⚠️ 与 {@link layoutKeys} 那一族**互补**：一个量键名，一个量值 */
function rectish(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ["x", "y", "width", "height"].every((key) => key in value)
  );
}

/** `@/store` 的 `RunState` 三档（现取；⚠️ `runMarkOf` 的 `Record<RunState, RunMark>` 靠它，少一档就红） */
function runStates(): readonly string[] {
  const file = path.resolve(path.dirname(TYPES_FILE), "..", "store", "app-store.ts");
  const body = declBody(codeOnly(fs.readFileSync(file, "utf8")), "RunState");
  return [...body.matchAll(/"([^"]+)"/gu)].map((one) => one[1]!).sort();
}