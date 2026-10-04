/**
 * 零 IO 那一圈：打码 / 台账位置 / 编辑面 / 输入面 —— 四个 `describe` 都不碰磁盘、不碰网络
 * @description
 * - **打码只有一份出口**，且**绝不**返回半截明文（逐个 4 字节窗口验）、**空串保持空串**
 *   （「没配」与「配了但不给你看」是两种事实）。
 * - **位置是一个字面量**：固定 `<homedir>/.config/swain-proxy`、**一个环境变量都不认**
 *   （`APPDATA` 也不认，否则 WSL 与 Windows 各有一份），且只由那一个入参决定。
 * - ⚠️ **编辑面每个函数都是纯函数**：`id` 是稳定身份而 `name` 是可变显示名，`slugify` 幂等是契约；
 *   删一个不存在的 `id` 是**成功的 no-op**，而 `selected` 指向不存在的 id 一律抛（否则那份库再也读不出来）。
 * - 输入面：归一（trim / 去尾斜杠）、15 种硬拒绝、以及**对 token 字符集零约束**（服务端比的是 SHA-256 摘要）。
 *
 * 目录级不变量见 `AGENTS.md`。
 *
 * @module tests/ledger
 */

import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIMEOUT_MS,
  LedgerError,
  NAME_MAX_LEN,
  REDACTED_TOKEN,
  TIMEOUT_BOUNDS,
  dbPath,
  idFor,
  redactTarget,
  removeTarget,
  resolveConfigDir,
  selectedTarget,
  setSelected,
  slugify,
  upsertTarget,
  validateTargetInput,
} from "@/services/config/index.js";
import { firstTarget } from "./_shared.js";

/* ── 打码 ───────────────────────────────────────────────────────────────── */

describe("打码形态", () => {
  const token = "tok-ABCDEFGH-1234567890";

  it("返回的是固定占位符，且一个 token 字节都不带", () => {
    const view = redactTarget({ ...firstTarget(), token });
    expect(view.token).toBe(REDACTED_TOKEN);
    expect(JSON.stringify(view)).not.toContain(token);
  });

  it("**绝不**返回半截明文：任何 4 字节窗口都不许出现", () => {
    // 「前 4 位 + 星号」不是打码：短 token 加上「长度有限」足以让穷举空间小到几次尝试。
    // 故这条断言不满足于「不等于 token」，它逐个窗口验。
    const view = redactTarget({ ...firstTarget(), token });
    const rendered = JSON.stringify(view);
    for (let i = 0; i + 4 <= token.length; i += 1) {
      expect(
        rendered.includes(token.slice(i, i + 4)),
        `打码后的形态里出现了 token 的第 ${i} 个窗口`,
      ).toBe(false);
    }
  });

  it("空 token 保持空串（不是星号）：「没配」与「配了但不给你看」是两种事实", () => {
    expect(redactTarget({ ...firstTarget(), token: "" }).token).toBe("");
  });
});

/* ── 路径 ───────────────────────────────────────────────────────────────── */

describe("台账位置", () => {
  it("配置目录固定是 `<homedir>/.config/swain-proxy`，**一个环境变量都不认**", () => {
    // ⚠️ 本仓零兼容：「认一个环境变量就多一份可能落点」的东西一律不接，
    // 故这里只有一个入参 —— 判据是**签名本身**：多一个 env 形参，类型就红。
    expect(resolveConfigDir("/home/u")).toBe(path.join("/home/u", ".config", "swain-proxy"));
  });

  it("配置目录**直接**在 `~/.config` 下面（不在 `~/.config/proxy` 之类的地方再套一层）", () => {
    expect(path.dirname(resolveConfigDir("/home/u"))).toBe(path.join("/home/u", ".config"));
  });

  it("Windows 也落 `~/.config`，不接 APPDATA（否则 WSL 与 Windows 各有一份）", () => {
    const windowsHome = "C:\\Users\\u";
    const dir = resolveConfigDir(windowsHome);
    expect(dir).toBe(path.join(windowsHome, ".config", "swain-proxy"));
    expect(dir).not.toContain("AppData");
  });

  it("库文件是那个目录下的 `tui.db`", () => {
    expect(dbPath("/home/u")).toBe(path.join("/home/u", ".config", "swain-proxy", "tui.db"));
  });

  it("本模块零 process：路径只由那一个入参决定（把它换成别的，结果只跟着变）", () => {
    expect(dbPath("/a")).not.toBe(dbPath("/b"));
  });
});

/* ── 编辑面 ─────────────────────────────────────────────────────────────── */

describe("编辑面（纯函数）", () => {
  it("slugify：折段、去首尾、空则兜底，且**幂等**", () => {
    expect(slugify("  生产 API  ")).toBe("api");
    expect(slugify("prod--api")).toBe("prod-api");
    expect(slugify("生产环境")).toBe("target");
    // 幂等是契约：不幂等时「已存在的 id 是怎么来的」这条推理会在重算时给出另一个答案，
    // 表现为端点莫名改名、`selected` 悬空
    for (const name of ["prod--api", "生产 API", "!!!"]) {
      expect(slugify(slugify(name)), `slugify 对 ${name} 不幂等`).toBe(slugify(name));
    }
  });

  it("idFor：撞名按 -2 / -3 递增", () => {
    expect(idFor("prod", [])).toBe("prod");
    expect(idFor("prod", ["prod"])).toBe("prod-2");
    expect(idFor("prod", ["prod", "prod-2"])).toBe("prod-3");
    // 跳号也认：用户删过 prod-2 之后，prod-3 不该被重排（id 是引用键）
    expect(idFor("prod", ["prod", "prod-3"])).toBe("prod-2");
  });

  it("upsertTarget：新建 ⇒ 分配 id 并把它设为 selected，入参一个字节都没改", () => {
    const before = { version: 1 as const, selected: null, targets: [] };
    const snapshot = JSON.stringify(before);

    const next = upsertTarget(before, userInput());

    expect(JSON.stringify(before)).toBe(snapshot);
    expect(next.selected).toBe(next.targets[0].id);
    expect(next.targets).toHaveLength(1);
    expect(next.targets[0]).toMatchObject({ name: "生产", baseUrl: "http://127.0.0.1:3010" });
  });

  it("upsertTarget：替换 ⇒ id、位置、selected 全都不变（只换内容）", () => {
    const before = {
      version: 1 as const,
      selected: "prod",
      targets: [
        { ...firstTarget(), id: "prod" },
        { ...firstTarget(), id: "lab", name: "实验室" },
      ],
    };
    const snapshot = JSON.stringify(before);

    const next = upsertTarget(before, {
      ...userInput({ name: "生产（改名）", token: "新 token" }),
      id: "prod",
    });

    expect(JSON.stringify(before)).toBe(snapshot);
    expect(next.selected).toBe("prod");
    expect(next.targets.map((t) => t.id)).toEqual(["prod", "lab"]);
    expect(next.targets[0].name).toBe("生产（改名）");
    expect(next.targets[0].token).toBe("新 token");
    // 位置不变 ⇒ 用户排好的显示顺序不会因为改一个字段而乱
    expect(next.targets[1].name).toBe("实验室");
  });

  it("upsertTarget：给了不存在的 id ⇒ 抛，不静默新建（否则「我改的是 A」变成「我多了一个 B」）", () => {
    const before = {
      version: 1 as const,
      selected: null,
      targets: [{ ...firstTarget(), id: "prod" }],
    };
    expect(() => upsertTarget(before, { ...userInput(), id: "查无此人" })).toThrowError(
      LedgerError,
    );
  });

  it("removeTarget：同时清掉指向它的 selected（悬空的 selected 会让整份台账读不出来）", () => {
    const before = {
      version: 1 as const,
      selected: "prod",
      targets: [
        { ...firstTarget(), id: "prod" },
        { ...firstTarget(), id: "lab" },
      ],
    };

    const next = removeTarget(before, "prod");
    expect(next.selected).toBeNull();
    expect(next.targets.map((t) => t.id)).toEqual(["lab"]);
    expect(JSON.stringify(before)).toContain('"selected":"prod"');
  });

  it("removeTarget：删一个不存在的 id 是一次成功 no-op（数据一个字节都没动）", () => {
    const before = {
      version: 1 as const,
      selected: "prod",
      targets: [{ ...firstTarget(), id: "prod" }],
    };
    const next = removeTarget(before, "查无此人");
    expect(next).toEqual(before);
    expect(next).not.toBe(before);
  });

  it("setSelected：指向不存在的 id ⇒ 抛（否则文件再也读不出来）", () => {
    const before = {
      version: 1 as const,
      selected: null,
      targets: [{ ...firstTarget(), id: "prod" }],
    };
    expect(() => setSelected(before, "查无此人")).toThrowError(LedgerError);
    expect(setSelected(before, null).selected).toBeNull();
    expect(setSelected(before, "prod").selected).toBe("prod");
  });

  it("selectedTarget：空 selected ⇒ null，且**不**抛（那是界面用的读）", () => {
    expect(selectedTarget({ version: 1, selected: null, targets: [] })).toBeNull();
    const withOne = {
      version: 1 as const,
      selected: "prod",
      targets: [{ ...firstTarget(), id: "prod" }],
    };
    expect(selectedTarget(withOne)?.id).toBe("prod");
  });
});

/* ── 输入面 ─────────────────────────────────────────────────────────────── */

describe("用户输入面", () => {
  it("归一：name / token trim、baseUrl 去尾斜杠", () => {
    const checked = validateTargetInput({
      ...userInput({ name: "  生产  ", token: "  tok\n", baseUrl: "http://127.0.0.1:3010/" }),
    });
    expect(checked).toEqual({
      name: "生产",
      baseUrl: "http://127.0.0.1:3010",
      token: "tok",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  const rejected: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["name 是空串", { name: "" }],
    ["name 全是空白", { name: "   " }],
    ["name 超长", { name: "x".repeat(NAME_MAX_LEN + 1) }],
    ["name 含控制字符", { name: "生产\n环境" }],
    ["token 是空串", { token: "" }],
    ["token 全是空白", { token: "  \t " }],
    ["timeout 低于下界", { timeoutMs: TIMEOUT_BOUNDS.min - 1 }],
    ["timeout 高于界", { timeoutMs: TIMEOUT_BOUNDS.max + 1 }],
    ["timeout 不是整数", { timeoutMs: 1000.5 }],
    ["timeout 不是数字", { timeoutMs: "1000" }],
    ["baseUrl 是空串", { baseUrl: "" }],
    ["baseUrl 不是 http/https", { baseUrl: "file:///etc/passwd" }],
    ["baseUrl 带 userinfo", { baseUrl: "http://u:p@127.0.0.1:3010" }],
    ["baseUrl 缺主机名", { baseUrl: "http://" }],
    ["baseUrl 不是合法 URL", { baseUrl: "127.0.0.1:3010" }],
  ];

  it.each(rejected)("拒绝：%s", (_label, override) => {
    const input = userInput(override);
    // 地址那几条的判据住在 `@/api`（故抛 `TuiError`），其余抛 `LedgerError`；
    // 两者都是**硬失败** —— 存一条注定连不上的记录比拒绝它更坏。
    expect(() => validateTargetInput(input)).toThrow();
  });

  it("拒绝对 token 的字符集**零约束**（服务端比的是 SHA-256 摘要，任何字节都合法）", () => {
    // 这条是防「给自己造一个假约束」：一个 4 位 token 在这里必须**通过**，
    // 否则「token 至少 N 位」这种自造规则会把服务端明明接受的凭据挡在门外。
    const short = validateTargetInput(userInput({ token: "a1b2" }));
    expect(short.token).toBe("a1b2");
    const exotic = validateTargetInput(userInput({ token: "带 空格 与 / 斜杠" }));
    expect(exotic.token).toBe("带 空格 与 / 斜杠");
  });

  it("拒绝时的文案不引用 token 的内容", () => {
    try {
      validateTargetInput(userInput({ token: "" }));
      expect.unreachable("应当抛");
    } catch (err) {
      expect((err as Error).message).not.toContain("s3cr3t-token");
    }
  });
});

/* ── 本档的小工具（放在末尾，便于上面读起来像规格） ───────────────────────── */

/** 一个合法的用户输入 */
function userInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "生产",
    baseUrl: "http://127.0.0.1:3010",
    token: "s3cr3t-token",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...overrides,
  };
}
