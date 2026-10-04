/**
 * @fileoverview `src/services/config/` 的行为面：真 SQLite 库、真临时目录、零网络
 * @module tests/ledger
 * @description
 * ## 本档锁住的是「事故」，不是「函数」
 * @description
 * 台账这一层几乎每条判据都在防一个具体的、且**丢了就找不回来**的事故。故断言的写法一律是
 * 「**出了事之后，磁盘上那份数据怎么样了**」，而不是「函数抛了没有」：
 * - **坏内容即拒**那组断言的是「抛错之后库里那份数据逐字未变」—— 只断言「抛错」的话，一个「抛错前先
 *   把整张表清空」的实现照样全绿，而那正是我们要防的事故本身。
 * - **权限那组**断言的是真实的 `statSync().mode`，而不是「代码里写了 chmod」—— 后者对着一个
 *   注释也能通过。
 * - **次序那组**断言的是「库文件被建出来时里面还没有任何 token」，而不是「代码里写了 chmod」——
 *   ⚠️ 这条比旧 JSON 时代那条「先 chmod 再 rename」**更强**：那次验的是一个窗口，这次验的是那个窗口里**没有数据**。
 * - **残留那组**断言的是「目录里除那份库与它的 WAL 伴随文件之外一个不多」，因为一次写崩在目录里留一份
 *   含明文 token 的半成品，是本层最容易留下的、且最难被察觉的一种脏。
 *
 * ## 「改坏形状」必须从外面来
 * @description
 * SQLite 下「一份坏台账」不能靠手写一份坏文件造出来了：得**造一个本包不认识的句柄**去改那张表
 * （{@link corrupt} / {@link dump}）。用本包自己的写入路径去造坏形状，验的只是「我写的和我读的一致」；
 * 而 `ALTER TABLE … DROP COLUMN` 那种操作本包的接口根本做不到 —— 那些断言的正是「库被别的东西动过之后
 * 本包会怎么反应」。
 *
 * ## 为什么用真库而不是 mock 掉驱动
 * @description
 * 「journal_mode」「列真的缺了」「`PRAGMA user_version` 是几」这三件事**只存在于真实的 SQLite 语义里**：
 * mock 掉驱动就等于把要验的东西一起 mock 掉了。故本档全部走真目录（`mkdtemp` + `afterEach` 清理），
 * 网络则**完全不碰** —— {@link ../src/services/config/connect.ts:probeTarget} 那几组用注入的 `fetch` 替身。
 *
 * ## 源码级那组（层边界）为什么带判据自检
 * @description
 * 「零 `console` / 零 `process.*`」是一组**负向**断言，而负向断言的经典失败模式是判据写坏了却恒绿
 * （根 `AGENTS.md`「写护栏时」）。故自检那一条把同一套判据喂进**合成的违规文本**，要求它必须判中 ——
 * 「探测器看得见」与「今天真的干净」两条合起来才叫断言。⚠️ 同一条纪律还要求「锚到的符号今天还在」：
 * 本档「不自我引用 barrel」那条的锚曾经写成一个 P0 之前就搬走的目录，于是它恒空、恒绿。
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  LedgerError,
  NAME_MAX_LEN,
  REDACTED_TOKEN,
  TIMEOUT_BOUNDS,
  clientFor,
  closeLedgerDb,
  dbPath,
  idFor,
  probeTarget,
  readLedger,
  redactTarget,
  removeTarget,
  resolveConfigDir,
  selectedTarget,
  setSelected,
  slugify,
  upsertTarget,
  validateTargetInput,
  writeLedger,
  type Ledger,
} from "@/services/config/index.js";

/* ── 目录与工具 ─────────────────────────────────────────────────────────── */

const LEDGER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "services",
  "config",
);

const created: string[] = [];

/** 一个真临时目录（每次调用一个，`afterEach` 统一清） */
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swain-tui-"));
  created.push(dir);
  return dir;
}

/** 临时目录里的库文件路径（父目录还不存在 —— 那正是首次启动的形态） */
function tempDb(): string {
  return path.join(tempDir(), "nested", "tui.db");
}

afterEach(() => {
  closeLedgerDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 一份形状正确的台账（各组按需改字段） */
function goodLedger(overrides: Partial<Ledger> = {}): Ledger {
  return { version: 1, selected: null, targets: [firstTarget()], ...overrides };
}

/* ── 「从外面改坏那份库」那组工具 ─────────────────────────────────────────── */

/**
 * 一个**不认识本包**的原始句柄
 * @description 注入坏形状必须从外面来：用本包自己的表去写断言，验的只是「我写的和我读的一致」。
 */
function rawHandle(file: string): RawDb {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (file: string) => RawDb;
  };
  return new DatabaseSync(file);
}

/** `node:sqlite` 里本档要用的那几个方法（结构声明，不 import 那个模块） */
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(): unknown[] };
  close(): void;
}

/** 收掉本包的句柄再改坏它：⚠️ 不这么做的话改的是本包**已经打开**的那一份，`ensureSchema` 不会再跑一遍 */
function corrupt(file: string, sql: string): void {
  closeLedgerDb();
  const db = rawHandle(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/**
 * 把那份库里三张表的内容倒成一段文本
 * @description 比逐字节更硬：WAL 模式下数据可能整段还在 `-wal` 里，逐字节只看得到主文件，于是「没动过」会假绿。
 */
function dump(file: string): string {
  const db = rawHandle(file);
  try {
    return JSON.stringify(["targets", "meta", "sessions"].map((table) => rowsOf(db, table)));
  } finally {
    db.close();
  }
}

function rowsOf(db: RawDb, table: string): unknown {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } catch (err) {
    // 表本身就是被改坏的那一处时，倒不出来也是一份事实（比"抛了"信息更多）
    return String(err);
  }
}

/** 目录里「不是那份库、也不是它的 WAL 伴随文件」的条目；⚠️ WAL 下 `-wal` / `-shm` 是库的一部分，不是残留 */
function strayEntries(dir: string): readonly string[] {
  const known = new Set(["tui.db", "tui.db-wal", "tui.db-shm"]);
  return fs
    .readdirSync(dir)
    .filter((name) => !known.has(name))
    .sort();
}

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

/* ── 读面 ───────────────────────────────────────────────────────────────── */

describe("ledger 读面", () => {
  it("库不存在 ⇒ 空台账，且**不**因此创建那个库", () => {
    const file = tempDb();
    expect(fs.existsSync(file)).toBe(false);
    expect(readLedger(file)).toEqual({ version: 1, selected: null, targets: [] });
    // 「看一眼配置」不该在磁盘上留痕迹：痕迹会让下一次「库在不在」这个判断失去意义
    expect(fs.existsSync(file)).toBe(false);
  });

  it("那个文件不是 SQLite 库 ⇒ LedgerError(unreadable)，且**原文件逐字未变**", () => {
    const file = path.join(tempDir(), "tui.db");
    const garbage = "这不是一个 SQLite 库";
    fs.writeFileSync(file, garbage, "utf8");

    expect(() => readLedger(file)).toThrowError(LedgerError);
    // ⚠️ 这条才是重点：坏内容绝不能被「空台账」悄悄覆盖掉（丢的是管理员凭据）
    expect(fs.readFileSync(file, "utf8")).toBe(garbage);
  });

  it("形状坏时逐条点名出错的那个字段，且库里那份数据逐字未变", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["version 不是 1", "PRAGMA user_version = 2;", "version"],
      [
        "targets 是别人建的同名表",
        "DROP TABLE targets; CREATE TABLE targets (id TEXT PRIMARY KEY, title TEXT, url TEXT, token TEXT, timeout_ms INTEGER);",
        "targets",
      ],
      ["target 缺 token", "ALTER TABLE targets DROP COLUMN token;", "token"],
      [
        "selected 指向不存在的端点",
        "INSERT INTO meta(key,value) VALUES('selected','查无此人');",
        "selected",
      ],
      ["id 不是 slug", "UPDATE targets SET id = '有 大写';", "id"],
      ["baseUrl 不是可用的地址", "UPDATE targets SET base_url = 'not a url';", "baseUrl"],
      ["timeout 越界", "UPDATE targets SET timeout_ms = 5;", "timeoutMs"],
    ];

    for (const [label, sql, field] of cases) {
      const file = path.join(tempDir(), "tui.db");
      writeLedger(file, goodLedger());
      corrupt(file, sql);
      const before = dump(file);

      let thrown: unknown;
      try {
        readLedger(file);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `${label} 应当抛`).toBeInstanceOf(LedgerError);
      expect((thrown as LedgerError).code, `${label} 的档位`).toBe("unreadable");
      expect((thrown as LedgerError).message, `${label} 的文案必须点名出错字段`).toContain(field);
      // 「抛了」不够 —— 必须证明那份库没被降级成空台账改掉
      expect(dump(file), `${label} 之后磁盘上的数据被改了`).toBe(before);
    }
  });

  it("坏台账的错误文案里一个 token 字节都不许有（哪怕库里躺着两份真凭据）", () => {
    // ⚠️ 这条必须让库里**真的有**两份 token 才成立：一份「token 被改成非字符串」的坏样本让断言恒真 ——
    // 那种坏法下任何错误文案都不可能提到真 token，而它证明不了「判据不引用内容」。
    const file = path.join(tempDir(), "tui.db");
    writeLedger(
      file,
      goodLedger({
        targets: [firstTarget(), { ...firstTarget(), id: "lab", token: "另一份-token" }],
      }),
    );
    corrupt(file, "UPDATE targets SET base_url = 'nope' WHERE id = 'lab';");

    let thrown: unknown;
    try {
      readLedger(file);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LedgerError);
    expect((thrown as LedgerError).message).not.toContain("s3cr3t-token");
    expect((thrown as LedgerError).message).not.toContain("另一份-token");
  });

  it("手改出来的尾斜杠在**读出时**就归一（不推迟到网络上才失败）", () => {
    const file = path.join(tempDir(), "tui.db");
    writeLedger(file, goodLedger({ selected: "prod" }));
    corrupt(file, "UPDATE targets SET base_url = 'http://127.0.0.1:3010/';");

    const ledger = readLedger(file);
    expect(selectedTarget(ledger)?.baseUrl).toBe("http://127.0.0.1:3010");
    // 且下一次写把它固化下来
    writeLedger(file, ledger);
    expect(readLedger(file).targets[0].baseUrl).toBe("http://127.0.0.1:3010");
  });
});

/* ── 写面 ───────────────────────────────────────────────────────────────── */

describe("ledger 写面", () => {
  it("write → read 往返逐字相等（含 selected 与清单顺序）", () => {
    const file = path.join(tempDir(), "tui.db");
    const ledger = {
      version: 1 as const,
      selected: "prod",
      targets: [
        {
          id: "prod",
          name: "生产",
          baseUrl: "http://127.0.0.1:3010",
          token: "tok-a",
          timeoutMs: 3000,
        },
        {
          id: "lab",
          name: "实验室",
          baseUrl: "https://lab.example.net:8443",
          token: "tok-b",
          timeoutMs: 8000,
        },
      ],
    };

    writeLedger(file, ledger);
    expect(readLedger(file)).toEqual(ledger);
  });

  it("父目录不存在就建出来，且目录里除库与它的 WAL 伴随文件外**一个不多**", () => {
    const file = tempDb();
    writeLedger(file, { version: 1, selected: null, targets: [] });

    expect(fs.existsSync(file)).toBe(true);
    expect(strayEntries(path.dirname(file))).toEqual([]);
  });

  it("覆盖写（库已存在）之后同样不残留任何半成品", () => {
    const file = path.join(tempDir(), "tui.db");
    writeLedger(file, { version: 1, selected: null, targets: [] });
    writeLedger(file, { version: 1, selected: "a", targets: [{ ...firstTarget(), id: "a" }] });
    writeLedger(file, {
      version: 1,
      selected: "a",
      targets: [{ ...firstTarget(), id: "a", token: "换过的" }],
    });

    expect(strayEntries(path.dirname(file))).toEqual([]);
    expect(readLedger(file).targets[0].token).toBe("换过的");
  });

  it("库文件在**任何 token 落进去之前**就已经是 0600（次序不是随意的）", () => {
    // ⚠️ 这一条**不**依赖平台：权限位的**实际结果**只在 POSIX 上可判（见下面那条 skipIf），
    // 而「次序」在任何平台上都是同一段代码。故这里用透传式的 spy 记录真实调用序列，
    // 并在 chmod 的**那一刻**量一次大小：0 字节 ⇒ 那一刻里面还没有任何凭据。
    const file = tempDb();
    const events: string[] = [];
    const sizes: Record<string, number> = {};
    const realChmod = fs.chmodSync.bind(fs);
    vi.spyOn(fs, "chmodSync").mockImplementation((target, mode) => {
      events.push(`chmod ${String(target)} ${modeToOct(mode)}`);
      sizes[String(target)] = fs.statSync(String(target)).size;
      realChmod(target, mode);
    });

    writeLedger(file, { version: 1, selected: null, targets: [firstTarget()] });

    expect(events).toEqual([`chmod ${path.dirname(file)} 700`, `chmod ${file} 600`]);
    expect(sizes[file]).toBe(0);
  });

  it("给定一份坏台账 ⇒ 抛，且磁盘一个字节都没动（落盘恒是校验过的形态）", () => {
    const file = path.join(tempDir(), "tui.db");
    writeLedger(file, { version: 1, selected: "prod", targets: [firstTarget()] });
    const before = dump(file);

    // selected 指向不存在的端点：写盘必须拒掉，而不是把这份坏形状落下去
    expect(() =>
      writeLedger(file, { version: 1, selected: "查无此人", targets: [firstTarget()] }),
    ).toThrowError(LedgerError);
    expect(dump(file)).toBe(before);
  });

  // ⚠️ win32 上跳过：NTFS 的 ACL 不由 `chmod` 表达，Node 在 Windows 上只把 mode 映射到只读位，
  // 于是 `mode & 0o777` 在那里恒等于 666 —— 断言它「不是 600」会得到一个**测的是平台**的红。
  // POSIX 上的那一份权限是本模块唯一真正的防线，故只在它成立的地方断言。
  it.skipIf(process.platform === "win32")("POSIX：库文件 0600、目录 0700", () => {
    const file = tempDb();
    writeLedger(file, { version: 1, selected: null, targets: [firstTarget()] });

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
});

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

/* ── 接线面 ─────────────────────────────────────────────────────────────── */

describe("台账 → 客户端", () => {
  it("clientFor 再过一次地址归一（Target 是可能被手改 / 内存里直接构造的）", () => {
    const client = clientFor({ ...firstTarget(), baseUrl: "http://127.0.0.1:3010/" });
    expect(client.info.baseUrl).toBe("http://127.0.0.1:3010");
    expect(client.info.token).toBe(firstTarget().token);
    expect(client.info.timeoutMs).toBe(firstTarget().timeoutMs);
  });

  it("clientFor 对不可用的地址抛（那是输入 / 台账的错，不是「连不上」）", () => {
    expect(() => clientFor({ ...firstTarget(), baseUrl: "http://u:p@h:1" })).toThrow();
  });

  it("probeTarget：连上了 ⇒ ok:true 带状态", async () => {
    stubFetch({ status: 200, body: STATUS_BODY });
    const result = await probeTarget(clientFor(firstTarget()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status.data.configDir).toBe("/srv/cfg");
  });

  it("probeTarget：连不上 ⇒ ok:false 带 TuiError，**不**抛", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const result = await probeTarget(clientFor(firstTarget()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("transport");
  });

  it("probeTarget：401 也只是 ok:false（三档判别原样交出去，由界面决定怎么显示）", async () => {
    stubFetch({
      status: 401,
      body: { error: { code: "unauthorized", message: "凭据不对", requestId: "req-1" } },
    });
    const result = await probeTarget(clientFor(firstTarget()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("wire");
      expect(result.error.code).toBe("unauthorized");
    }
  });

  it("probeTarget：答了但形状不对 ⇒ ok:false 的 shape 档（对面版本与本包不一致）", async () => {
    stubFetch({ status: 200, body: { 不像: "status" } });
    const result = await probeTarget(clientFor(firstTarget()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("shape");
  });

  it("probeTarget：非 TuiError 的异常**照旧往上抛**（那是本包的 bug，不该伪装成网络失败）", async () => {
    const broken = {
      status: async () => {
        throw new RangeError("本包自己的 bug");
      },
    };
    await expect(probeTarget(broken as never)).rejects.toThrowError(RangeError);
  });
});

/* ── 层边界（源码级） ───────────────────────────────────────────────────── */

describe("层边界（源码级）", () => {
  /** 注释行整行略过：注释里点名被禁符号是在**描述**这条不变量 */
  function codeLines(text: string): string[] {
    return text.split("\n").filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"));
    });
  }

  const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
    ["console", /(^|[^.\w$])console\s*\./],
    ["process", /(^|[^.\w$])process\s*\./],
  ];

  function hits(text: string): string[] {
    const lines = codeLines(text);
    const found: string[] = [];
    for (const [what, shape] of FORBIDDEN) {
      lines.forEach((line, index) => {
        if (shape.test(line)) found.push(`${what} @ ${index + 1}: ${line.trim()}`);
      });
    }
    return found;
  }

  function sources(): ReadonlyArray<readonly [string, string]> {
    return fs
      .readdirSync(LEDGER_DIR)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(LEDGER_DIR, name), "utf8")]);
  }

  it("扫描面非空且真的覆盖到本目录的源文件（否则下面两条是空断言）", () => {
    const files = sources().map(([name]) => name);
    expect(files).toContain("store.ts");
    expect(files).toContain("validate.ts");
    // ⚠️ 新的驱动与 DDL 两块必须**在**扫描面里：不在的话「本层零 console / 零 process.*」验的是残缺的一份
    expect(files).toContain("db.ts");
    expect(files).toContain("tables.ts");
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("src/services/config 零 console、零 process.*（`homedir` 由入参注入正是为了这一条）", () => {
    const violations = sources().flatMap(([name, text]) =>
      hits(text).map((where) => `${name}: ${where}`),
    );
    expect(violations, `本层出现了呈现 / 宿主访问：\n${violations.join("\n")}`).toEqual([]);
  });

  it("判据自检：同一套判据必须能认出违规文本（否则上面那条是恒绿）", () => {
    // 「探测器看得见」与「今天真的干净」合起来才叫断言；只写后半条的话，探测器写坏了照样全绿
    const dirty = ['console.log("x");', "const x = process.env.HOME;"];
    for (const sample of dirty) {
      expect(hits(sample).length, `判据没认出：${sample}`).toBe(1);
    }
    // 且不能把成员访问误判成宿主访问（`obj.console` / `obj.process` 都只是普通字段名）
    expect(hits("const a = obj.console.log;").length).toBe(0);
    expect(hits("const a = obj.process.exit;").length).toBe(0);
  });

  it("目录对外只暴露一个 barrel，且内部不自我引用它", () => {
    const selfReferencing = sources()
      .filter(([name]) => name !== "index.ts")
      .flatMap(([name, text]) => {
        const code = codeLines(text).join("\n");
        // ⚠️ 锚是**今天还存在的**路径 `@/services/config/`：P0 之前这里写的是 `@/ledger/`，
        // 那个目录早就不存在了，于是判据恒空、这条断言恒绿。
        return /from\s+"@\/services\/config\//.test(code) || /from\s+"\.\/index\.js"/.test(code)
          ? [`${name} 引了 barrel`]
          : [];
      });
    expect(
      selfReferencing,
      `本目录内部引用了自己的 barrel（循环依赖图）：\n${selfReferencing.join("\n")}`,
    ).toEqual([]);
  });

  it("barrel 那条判据会红（自检：给本目录某个文件加一句引 barrel，判据必须抓到）", () => {
    const dirty = 'import { x } from "@/services/config/index.js";\nexport const y = x;\n';
    const code = codeLines(dirty).join("\n");
    expect(/from\s+"@\/services\/config\//.test(code)).toBe(true);
    expect(
      /from\s+"\.\/index\.js"/.test(codeLines('import { x } from "./index.js";').join("\n")),
    ).toBe(true);
  });

  it("barrel 只 export，一行逻辑都没有", () => {
    const barrel = sources().find(([name]) => name === "index.ts");
    expect(barrel).toBeDefined();
    // 口径：把所有 `export { … } from "…"` 声明整段拿掉之后，剩下的**必须**只剩空白与分号。
    // 这样「多写了一句逻辑」会留下残渣，而不是靠一张越来越长的允许清单（那清单迟早漏项）。
    const residue = barrel![1]
      .replace(/export\s*\{[^}]*\}\s*from\s*"[^"]*";/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/[\s;]/g, "");
    expect(residue, `barrel 里有非 export 的内容：${residue}`).toBe("");
  });

  it("barrel 那条判据会红（自检：给 barrel 加一句逻辑，残渣判据必须抓到）", () => {
    // 「探测器看得见」与「今天真的干净」两条合起来才叫断言
    const residueOf = (text: string) =>
      text
        .replace(/export\s*\{[^}]*\}\s*from\s*"[^"]*";/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/[\s;]/g, "");
    expect(residueOf('export { a } from "./a.js";\nconst sneaky = 1;\n')).not.toBe("");
    // 反向：干净的那一份必须**什么都不剩**，否则上面那条只是「匹配不到东西」而不是「没有逻辑」
    expect(
      residueOf('export {\n  a,\n  type B,\n} from "./a.js";\nexport { c } from "./c.js";\n'),
    ).toBe("");
  });
});

/* ── 本档的小工具（放在末尾，便于上面读起来像规格） ───────────────────────── */

/** 权限位在断言里一律写成八进制文本（`600` 而不是 `384`） */
function modeToOct(mode: unknown): string {
  return typeof mode === "number" ? mode.toString(8) : String(mode);
}

/** 磁盘上一条合法端点的默认形态 */
function firstTarget() {
  return {
    id: "prod",
    name: "生产",
    baseUrl: "http://127.0.0.1:3010",
    token: "s3cr3t-token",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

/** 一份形状正确的 `GET /api/status` 响应（探活成功那档要读到它） */
const STATUS_BODY = {
  process: { pid: 42, startedAt: 0, uptimeMs: 1, node: "node", platform: "linux", cwd: "/srv" },
  proxy: {
    mode: "running",
    protocol: "http",
    host: "0.0.0.0",
    port: 8080,
    running: true,
    startedAt: 0,
    uptimeMs: 1,
  },
  runningMeans: "数据面在监听",
  data: {
    configDir: "/srv/cfg",
    envFiles: ["/srv/.env"],
    accounts: { driver: "json", path: "/srv/cfg/users.json" },
    acl: { driver: "json", path: "/srv/cfg/acl.json" },
    usage: { driver: "json", dir: "/srv/log" },
    auth: { enabled: true, type: "uid" },
    quotaResetHour: 1,
    defaultQuotaWindow: "month",
    flushIntervalMs: 1000,
  },
};

/** 注入一个 `fetch` 替身（探活那几组用它，**不**碰真网络） */
function stubFetch(response: { status: number; body: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(response.body), { status: response.status })),
  );
}
