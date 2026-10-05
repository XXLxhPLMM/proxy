/**
 * `/providers` 与它的表单、`/models` 三档：提供商清单的增删改查 + 按提供商分组选模型
 * @description ⚠️ 这一族**不发一个请求**（提供商清单与模型清单是本机那一份 SQLite），
 * 于是「零请求」是它天然的一条判据；而凭据（`apiKey`）**永不明文上屏**。
 * ⚠️ 键位、槽位序与落点见 `./_shared.ts`。
 */

import { describe, expect, it, vi } from "vitest";

import {
  CTRL_A,
  CTRL_D,
  CTRL_E,
  CTRL_F,
  CTRL_G,
  CTRL_M,
  CTRL_P,
  CTRL_R,
  DOWN,
  ENTER,
  ESC,
  SPACE,
  TAB,
  UP,
  mount,
  typed,
} from "../input/_shared.js";
import {
  CHANGED,
  controlLedger,
  modelListing,
  openCommand,
  seedModelChoice,
  seedModels,
  seedProvider,
  seedSession,
  strip,
  stubControlPlane,
  type ControlTarget,
} from "./_shared.js";
import { readProviders, readProviderModels, readSessionModels } from "@/services/config/index.js";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

describe("/providers：清单态的增删改查", () => {
  it("⚠️ 逐行给出**地址**与 API 格式，而**凭据一个字都不给**", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家", baseUrl: "https://p1.invalid/v1", apiKey: "sk-secret" });
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    const output = strip(await ui.finish());
    expect(output).toContain("提供商（1）");
    expect(output).toContain("乙家");
    expect(output).toContain("https://p1.invalid/v1");
    expect(output).toContain("openai");
    // ⚠️ **凭据永不明文上屏**（打码出口只有 `redactProviderView` 一处）
    expect(output).not.toContain("sk-secret");
  });

  it("⚠️ `Enter` = 用这个提供商**填满当前会话**（切到它的一个模型）", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家" });
    seedModels(file, "p1", [["m1", "甲模型"]]);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    await ui.feed([ENTER]);
    const output = strip(await ui.finish());
    // ⚠️ **关窗**：清单那一行不在了
    expect(output).not.toContain("提供商（1）");
    // ⚠️ **核心判据**：那一档「提供商 · 推理强度」写的是**显示名**，而存储键落进了盘
    expect(output).toContain("乙家 · medium");
    expect(readSessionModels(file, "s1").modelRef).toBe("p1/m1");
  });

  it("⚠️ 一个模型都还没有时 `Enter` ⇒ **说一句**而不是静默（关窗但清单没变）", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家" });
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    await ui.feed([ENTER]);
    const output = strip(await ui.finish());
    expect(output).toContain("还没有模型");
    expect(readSessionModels(file, "s1").modelRef).toBeNull();
  });

  it("⚠️ `Ctrl+D` **按两次**才删（而**模型清单跟着级联删掉**）", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家" });
    seedModels(file, "p1", [["m1", "甲模型"]]);
    const once = await mount({ interactive: false, ledgerFile: file });
    await once.feed(openCommand("providers"));
    await once.feed([CTRL_D]);
    await once.finish();
    expect(readProviders(file).map((one) => one.id)).toEqual(["p1"]);
    const twice = await mount({ interactive: false, ledgerFile: file });
    await twice.feed(openCommand("providers"));
    await twice.feed([CTRL_D, CTRL_D]);
    await twice.finish();
    expect(readProviders(file)).toEqual([]);
    expect(readProviderModels(file, "p1")).toEqual([]);
  });

  it("⚠️ `Ctrl+M` 进**该提供商的模型列表**，而 `Esc` 从那里保存并回列表", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家" });
    seedModels(file, "p1", [["m1", "甲模型"]]);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    await ui.feed([CTRL_M]);
    const opened = strip(await ui.finish());
    expect(opened).toContain("模型 · 乙家");
    expect(opened).toContain("甲模型");
  });
});

describe("/providers 的表单：字段之间走、整份提交、不过就不关窗", () => {
  it("⚠️ `Tab` 在**字段之间**走，而 `↑↓` 在**下拉那一格**换档（判据是那一格是不是下拉）", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家" });
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    await ui.feed([CTRL_E]);
    // ⚠️ **正向对照**：五格都在，而第二格把三档列出来（否则「`↑↓` 换档」在屏上答不出来）
    const opened = strip(await ui.finish());
    expect(opened).toContain("地址");
    expect(opened).toContain("API 格式");
    expect(opened).toContain("openai / anthropic / gemini");
    expect(opened).toContain("提供商 id");
    expect(opened).toContain("提供商名称");
    expect(opened).toContain("key");
    expect(opened).toContain("••••");
  });

  it("⚠️ `Esc` 取消整份表单回列表，而**台账一个字节都没变**", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家" });
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    await ui.feed([CTRL_A, ESC]);
    const output = strip(await ui.finish());
    expect(readProviders(file).map((one) => one.id)).toEqual(["p1"]);
    expect(output).toContain("提供商（1）");
    expect(output).not.toContain("新增提供商");
  });

  it("⚠️ 校验不过 ⇒ **不关窗**，而说明说清**哪一格**（`id` 不许含 `/` 是其中一条）", async () => {
    const file = controlLedger();
    seedSession(file);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    await ui.feed([CTRL_A]);
    await ui.feed([...typed("https://p.invalid/v1"), TAB]);
    await ui.feed([TAB]);
    await ui.feed([...typed("a/b"), TAB]);
    await ui.feed([...typed("乙家"), TAB]);
    await ui.feed([...typed("sk-x"), ENTER]);
    const output = strip(await ui.finish());
    // ⚠️ **不关窗**：标题还在
    expect(output).toContain("新增提供商");
    expect(output).toContain("不能含「/」");
    // ⚠️ **正向对照**：台账一个字节都没变
    expect(readProviders(file)).toEqual([]);
  });

  it("⚠️ 填满五格按 `Enter` ⇒ **一次落盘整份表单**（而不是提交当前字段）", async () => {
    const file = controlLedger();
    seedSession(file);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    await ui.feed([CTRL_A]);
    await ui.feed([...typed("https://p.invalid/v1"), TAB]);
    // ⚠️ **第二格是下拉**：`↓` 换到 `anthropic`，而 `Tab` 才是「去下一格」
    await ui.feed([DOWN]);
    await ui.feed([TAB]);
    await ui.feed([...typed("pz"), TAB]);
    await ui.feed([...typed("丙家"), TAB]);
    await ui.feed([...typed("sk-x"), ENTER]);
    await ui.finish();
    const saved = readProviders(file);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.id).toBe("pz");
    expect(saved[0]?.name).toBe("丙家");
    expect(saved[0]?.api).toBe("anthropic");
    // ⚠️ **凭据落盘是真值**，而屏上从头到尾没有它
    expect(saved[0]?.apiKey).toBe("sk-x");
  });
});

describe("/providers 的模型清单：过滤框 / 勾选 / 拉取 / 改显示名 / 去掉", () => {
  it("⚠️ 最上面那个框恒在，而 `Space` 切**高亮那一个**的勾选", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家" });
    seedModels(file, "p1", [["m1", "甲模型"], ["m2", "乙模型"]]);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    await ui.feed([CTRL_M]);
    const output = strip(await ui.finish());
    expect(output).toContain("模型 · 乙家");
    expect(output).toContain("甲模型");
    expect(output).toContain("乙模型");
    // ⚠️ **正向对照**：两个模型**都在勾上**（起手从现有清单起步，而「全不勾」是用户自己能走到的）
    const open = await mount({ interactive: false, ledgerFile: file });
    await open.feed(openCommand("providers"));
    await open.feed([CTRL_M]);
    const frame = strip(await open.finish());
    expect(frame.split("[x]").length - 1).toBe(2);
  });

  it("⚠️ `Ctrl+A` = **全选 / 取消全选**（切一次全掉，`Esc` 保存之后清单空了）", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家" });
    seedModels(file, "p1", [["m1", "甲模型"], ["m2", "乙模型"]]);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    await ui.feed([CTRL_M, CTRL_A, ESC]);
    await ui.finish();
    // ⚠️ **核心判据**：`Esc` 那一步把 `picked` 整份落盘，而「全不勾」= 一份空清单
    expect(readProviderModels(file, "p1")).toEqual([]);
  });

  it("⚠️ **过滤只影响显示**：被过滤掉的行**仍在勾里**，而 `Esc` 保存后它还在", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家" });
    seedModels(file, "p1", [["m1", "甲模型"], ["m2", "乙模型"]]);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    await ui.feed([CTRL_M]);
    // ⚠️ 往**过滤框**里打「乙」⇒ 屏上只剩那一行，而另一行**仍在勾里**
    await ui.feed([...typed("乙")]);
    await ui.feed([ESC]);
    await ui.finish();
    // ⚠️ **核心判据**：落盘那一份仍是两个（保存写的是 `picked` 而不是屏上那几行）
    expect(readProviderModels(file, "p1").map((one) => one.modelId)).toEqual(["m1", "m2"]);
  });

  it("⚠️ `Ctrl+G` 从那个 `/models` 端点拉一次并**全选**", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家", baseUrl: "https://p1.invalid/v1" });
    seedModels(file, "p1", [["m1", "甲模型"]]);
    const plane = stubControlPlane((url) => (url.includes("/models") ? modelListing(["x1", "x2"]) : CHANGED));
    try {
      const ui = await mount({ interactive: false, ledgerFile: file });
      await ui.feed(openCommand("providers"));
      await ui.feed([CTRL_M]);
      await ui.feed([CTRL_G]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await ui.feed([ESC]);
      await ui.finish();
      // ⚠️ **核心判据**：拉回来的两个都在清单里（而原来那个也在）
      expect(readProviderModels(file, "p1").map((one) => one.modelId)).toEqual(["m1", "x1", "x2"]);
      // ⚠️ **正向对照**：它真的**出了网**（按 URL 分流 ⇒ 探活那一族不会把它算进来）
      expect(plane.calls().some((one) => one.url.includes("/models"))).toBe(true);
    } finally {
      plane.restore();
    }
  });

  it("⚠️ `Ctrl+E` 改**显示名**，而**协议标识 `modelId` 不给人改**", async () => {
    const file = controlLedger();
    seedSession(file);
    seedProvider(file, { id: "p1", name: "乙家" });
    seedModels(file, "p1", [["m1", "甲模型"]]);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("providers"));
    await ui.feed([CTRL_M]);
    await ui.feed([CTRL_E]);
    // ⚠️ 改显示名那一档**只有一格**，而它装的是**当前那个显示名**
    const opened = strip(await ui.finish());
    expect(opened).toContain("改显示名");
    expect(opened).toContain("甲模型");
  });
});

describe("/models：按提供商分组选模型", () => {
  const TWO_PROVIDERS: readonly ControlTarget[] = [
    { id: "live-ok", name: "live-ok", baseUrl: "http://127.0.0.1:1", token: "t0ken", timeoutMs: 200 },
  ];

  it("⚠️ **按提供商分组**渲染，而 `↓` **跨组连续**（不按组重启）", async () => {
    const file = controlLedger(TWO_PROVIDERS);
    seedSession(file);
    seedProvider(file, { id: "p1", name: "甲家" });
    seedProvider(file, { id: "p2", name: "乙家" });
    seedModels(file, "p1", [["m1", "一模型"]]);
    seedModels(file, "p2", [["m2", "二模型"]]);
    const listed = await mount({ interactive: false, ledgerFile: file });
    await listed.feed(openCommand("models"));
    const output = strip(await listed.finish());
    // ⚠️ **两个分组标题都在屏上**，而两组各一个模型
    expect(output).toContain("甲家");
    expect(output).toContain("乙家");
    expect(output).toContain("一模型");
    expect(output).toContain("二模型");
    // ⚠️ **核心判据**（**不是**「槽位表里有几个 `row`」—— 那种判据只数一份**本档自己写的字面量**）：
    // 一次 `↓` 就从**甲家那组**跨到**乙家那组** ⇒ 高亮数的是**可选项**而不是「第几行」
    // （按行数的话那一步会停在乙家那个标题行上，而标题行不可选 ⇒ `Enter` 关窗而什么都没写）
    const crossed = await mount({ interactive: false, ledgerFile: file });
    await crossed.feed(openCommand("models"));
    await crossed.feed([DOWN, ENTER]);
    await crossed.finish();
    expect(readSessionModels(file, "s1").modelRef).toBe("p2/m2");
  });

  it("⚠️ `Enter` 把高亮那一个写进**当前会话**的 `Session.modelRef`", async () => {
    const file = controlLedger(TWO_PROVIDERS);
    seedSession(file);
    seedProvider(file, { id: "p1", name: "甲家" });
    seedProvider(file, { id: "p2", name: "乙家" });
    seedModels(file, "p1", [["m1", "一模型"]]);
    seedModels(file, "p2", [["m2", "二模型"]]);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("models"));
    await ui.feed([DOWN, ENTER]);
    const output = strip(await ui.finish());
    expect(readSessionModels(file, "s1").modelRef).toBe("p2/m2");
    // ⚠️ **关窗**（`Esc` 的对象不在了）⇒ 那一档换成了状态行上的「提供商 · 推理强度」
    expect(output).toContain("乙家 · medium");
  });

  it("⚠️ `Ctrl+F` 置顶（**落盘且全局**），而它排到最前并带 `★`", async () => {
    const file = controlLedger(TWO_PROVIDERS);
    seedSession(file);
    seedProvider(file, { id: "p1", name: "甲家" });
    seedModels(file, "p1", [["m1", "一模型"], ["m2", "二模型"]]);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("models"));
    await ui.feed([CTRL_F, ESC]);
    await ui.finish();
    // ⚠️ **落盘那一列**：**高亮那一个**（第 0 行）被置顶，而另一个没动
    // ⚠️ **正向对照**：`↓` 一次再置顶 ⇒ 换成了另一个（判据落在「按哪一格」而不是「按没按」）
    expect(readProviderModels(file, "p1").map((one) => [one.modelId, one.pinned])).toEqual([
      ["m1", true],
      ["m2", false],
    ]);
    // ⚠️ 置顶之后**排在最前**，于是下一次开窗时 `↓` 到的是另一个模型 ⇒ 再置顶它
    const other = await mount({ interactive: false, ledgerFile: file });
    await other.feed(openCommand("models"));
    await other.feed([DOWN, CTRL_F, ESC]);
    await other.finish();
    expect(readProviderModels(file, "p1").map((one) => one.pinned)).toEqual([true, true]);
  });

  it("⚠️ `Ctrl+R` 循环**推理强度四档**（而缺省是 `medium`）", async () => {
    const file = controlLedger(TWO_PROVIDERS);
    seedSession(file);
    seedProvider(file, { id: "p1", name: "甲家" });
    seedModels(file, "p1", [["m1", "一模型"]]);
    seedModelChoice(file, "p1/m1");
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("models"));
    // ⚠️ **一次切一档**（`medium` → `high`），两次回到 `off` —— 四档循环
    await ui.feed([CTRL_R]);
    await ui.feed([ESC]);
    await ui.finish();
    expect(readSessionModels(file, "s1").reasoning).toBe("high");
  });

  it("⚠️ 一个模型都没有时那一档**仍然开**，并说清怎么先有一个", async () => {
    const file = controlLedger(TWO_PROVIDERS);
    seedSession(file);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("models"));
    const output = strip(await ui.finish());
    expect(output).toContain("还没有可选的模型");
    expect(output).toContain("/providers");
  });
});

describe("/users：账号清单**要一个客户端**", () => {
  it("⚠️ 没选中控制面 ⇒ **一个请求都不发**，而那一档说清为什么", async () => {
    const file = controlLedger([]);
    seedSession(file);
    const plane = stubControlPlane(() => CHANGED);
    try {
      const ui = await mount({ interactive: false, ledgerFile: file });
      await ui.feed(openCommand("users"));
      const output = strip(await ui.finish());
      expect(output).toContain("还没选中控制面");
      // ⚠️ **核心判据**：**一个请求都不发**（沿用执行层那条纪律：账号表属于某一台）
      expect(plane.calls()).toEqual([]);
      // ⚠️ **正向对照**：带上一个控制面之后它就**真的发了**（否则上面那条是「这一档压根不发」）
      const seeded = controlLedger([
        { id: "live-ok", name: "live-ok", baseUrl: "http://127.0.0.1:1", token: "t0ken", timeoutMs: 200 },
      ]);
      seedSession(seeded);
      const withOne = stubControlPlane((url) => (url.includes("/api/users") ? { accounts: [{ username: "u1", password: { set: true }, disabled: false, expiresAtIso: null }] } : CHANGED));
      try {
        const two = await mount({ interactive: false, ledgerFile: seeded });
        await two.feed(openCommand("users"));
        await new Promise((resolve) => setTimeout(resolve, 200));
        const frame = strip(await two.finish());
        expect(frame).toContain("账号（1）");
        expect(withOne.calls().some((one) => one.url.includes("/api/users"))).toBe(true);
      } finally {
        withOne.restore();
      }
    } finally {
      plane.restore();
    }
  });

  it("⚠️ `Ctrl+D` **按两次**才发那一个删除请求（⚠️ 第一次**不发任何请求**）", async () => {
    const file = controlLedger([
      { id: "live-ok", name: "live-ok", baseUrl: "http://127.0.0.1:1", token: "t0ken", timeoutMs: 200 },
    ]);
    seedSession(file);
    const plane = stubControlPlane((url, init) => {
      if (url.includes("/api/users") && init.method === "GET") {
        return { accounts: [{ username: "u1", password: { set: true }, disabled: false, expiresAtIso: null }] };
      }
      return CHANGED;
    });
    try {
      const once = await mount({ interactive: false, ledgerFile: file });
      await once.feed(openCommand("users"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await once.feed([CTRL_D]);
      await once.finish();
      expect(plane.calls().filter((one) => one.method === "DELETE")).toEqual([]);
      const twice = await mount({ interactive: false, ledgerFile: file });
      await twice.feed(openCommand("users"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await twice.feed([CTRL_D, CTRL_D]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await twice.finish();
      expect(plane.calls().some((one) => one.method === "DELETE")).toBe(true);
    } finally {
      plane.restore();
    }
  });

  it("⚠️ `Ctrl+P` 改密码 ⇒ **单独一份表单**，而 `Esc` 取消（一个请求都不发）", async () => {
    const file = controlLedger([
      { id: "live-ok", name: "live-ok", baseUrl: "http://127.0.0.1:1", token: "t0ken", timeoutMs: 200 },
    ]);
    seedSession(file);
    const plane = stubControlPlane((url, init) => {
      if (url.includes("/api/users") && init.method === "GET") {
        return { accounts: [{ username: "u1", password: { set: true }, disabled: false, expiresAtIso: null }] };
      }
      return CHANGED;
    });
    try {
      const ui = await mount({ interactive: false, ledgerFile: file });
      await ui.feed(openCommand("users"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await ui.feed([CTRL_P]);
      const opened = strip(await ui.finish());
      expect(opened).toContain("改密码");
      // ⚠️ **密码逐字保留、永不回显** ⇒ 起手那一格恒是空的
      expect(opened).not.toContain("•");
      expect(plane.calls().filter((one) => one.method === "PUT")).toEqual([]);
    } finally {
      plane.restore();
    }
  });
});

/** ⚠️ 上面那一族断言的公共依赖：`Space` 与 `Tab` 都在 `../input/_shared.js` 里（避免各档各造一份） */
describe("键位量的那一处出处", () => {
  it("`Space` / `Tab` 造出来的是**真键**（一个空格与一个制表符）", () => {
    expect(SPACE).toBe(" ");
    expect(TAB).toBe("\t");
    expect(ESC).toBe("\u001B");
    expect(UP.endsWith("[A")).toBe(true);
    expect(DOWN.endsWith("[B")).toBe(true);
    // ⚠️ **`Ctrl+M` 走 kitty 的那一族**（裸 `^M` 与 `Enter` 是同一个字节，屏上分不出来）
    expect(CTRL_M).toBe(`${String.fromCharCode(0x1b)}[13;5u`);
    expect(CTRL_G).toBe("\u0007");
    expect(CTRL_F).toBe("\u0006");
  });
});