/**
 * `sessions` 表里**落的是什么**：六列的形状与增改删语义，以及升级步
 *
 * @description
 * 与 `driver.test.ts` 的分界是「**表里那些行**」对「那个库本身」；与 ledger 那一档的分界是
 * 「**列与键的形状**」对「逐条目的成败语义」（坏内容即拒、拒写之后数据逐字未动在 ledger 那一档）。
 * 侧边栏清单与对话各有自己的一档（`sidebar` / `messages`）—— 一个子主题一份档。
 *
 * ⚠️ 升级步只能**自己造一份上一版形状的库**（`CREATE TABLE IF NOT EXISTS` 对已存在的表
 * 一个字节都不写，而 `ALTER` 没有 `IF NOT EXISTS` 那一说），理由、以及「pragma 与 schema 版本
 * 必须从外面量」的牙齿见本目录 `AGENTS.md`。
 *
 * @module tests/sqlite
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LedgerError,
  REDACTED_PROVIDER_KEY,
  REDACTED_TOKEN,
  appendMessages,
  closeLedgerDb,
  pinSession,
  readProviders,
  readSessions,
  redactProviderView,
  removeSession,
  renameSession,
  saveSession,
  upsertProvider,
  type ProviderRecord,
} from "@/services/config/index.js";
import { SCHEMA_VERSION } from "@/services/config/tables.js";
import {
  pick,
  rawColumns,
  rawRows,
  rawTables,
  removeCreated,
  tempDb,
  withRaw,
} from "./_shared.js";

afterEach(() => {
  closeLedgerDb();
  vi.restoreAllMocks();
  removeCreated();
});

function record(id: string, name: string, at = 100) {
  return { id, name, createdAt: at, updatedAt: at };
}

describe("会话落盘", () => {
  it("增 / 读：按建成顺序读回来，且**只有四个字段**（输出桶与侧边栏都不在会话自己身上）", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1", 1700000000000));
    saveSession(file, record("s2", "会话 2", 1700000000001));

    expect(readSessions(file)).toEqual([
      { id: "s1", name: "会话 1", createdAt: 1700000000000, updatedAt: 1700000000000 },
      { id: "s2", name: "会话 2", createdAt: 1700000000001, updatedAt: 1700000000001 },
    ]);
    // ⚠️ 桶是内存里 `LOG_KEEP` 条的环形缓冲，而「在不在侧边栏上」是 `sidebar_sessions` 那一问
    // ⚠️ **模型那两列也在表上而不在这个返回值里**：会话的身份定义与「它选了哪个模型」是两组事实
    expect(rawColumns(file, "sessions")).toEqual([
      "id",
      "name",
      "created_at",
      "updated_at",
      "model_ref",
      "reasoning",
    ]);
  });

  it("改名：动 `updated_at`，**不动** `created_at`", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1", 100));
    renameSession(file, "s1", "改名之后", 500);

    expect(readSessions(file)).toEqual([
      { id: "s1", name: "改名之后", createdAt: 100, updatedAt: 500 },
    ]);
  });

  it("删：删一个不存在的 `id` 与删一个存在的都是成功的 no-op / 生效", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1"));

    removeSession(file, "查无此人");
    expect(readSessions(file)).toHaveLength(1);

    removeSession(file, "s1");
    expect(readSessions(file)).toEqual([]);
  });

  it("库不存在 ⇒ 空清单，且**不**因此创建那个库（与台账读面同一条纪律）", () => {
    const file = tempDb();
    expect(readSessions(file)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("同一个 `id` 记两遍 ⇒ 抛（一个会话被记两遍会让「切到会话 2」有两种答案）", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1", 100));

    expect(() => saveSession(file, record("s1", "又来一次", 200))).toThrowError(LedgerError);
    expect(readSessions(file)[0]?.name).toBe("会话 1");
  });
});

/** 造一份上一版形状的库（⚠️ 父目录与那个空文件**自己**造：`readSessions` 对不存在的路径刻意不建库） */
function v3Library(userVersion = 3): string {
  const file = tempDb();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", "utf8");
  withRaw(file, (db) => {
    db.exec(`CREATE TABLE targets (
      id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
      token TEXT NOT NULL, timeout_ms INTEGER NOT NULL);
      CREATE TABLE meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, visible INTEGER NOT NULL DEFAULT 1);
      INSERT INTO sessions VALUES('s1', '老会话', 100, 100, 0);
      INSERT INTO targets VALUES('prod', '生产', 'http://127.0.0.1:3010', 'sk-old-secret', 5000);
      INSERT INTO meta VALUES('selected', 'prod');
      PRAGMA user_version = ${String(userVersion)};`);
  });
  return file;
}

/** 一份库的全部可观察形状（⚠️ 全部表的列 + 数据 + 版本：判断「跑两遍结果一样」要能逐项比） */
function shapeOf(file: string): string {
  return JSON.stringify({
    version: pick(withRaw(file, (db) => db.prepare("PRAGMA user_version").get())),
    tables: rawTables(file),
    columns: Object.fromEntries(rawTables(file).map((t) => [t, rawColumns(file, t)])),
    rows: Object.fromEntries(rawTables(file).map((t) => [t, rawRows(file, t)])),
  });
}

describe("升级步：去掉 `sessions.visible`、补上模型那两列、并把 provider 那两张表建出来", () => {
  it("⚠️ `visible` 真的没了，而别的数据逐字未动（真库 + 真 `ALTER`，不是「按代码读一遍觉得没问题」）", () => {
    const file = v3Library();
    // ⚠️ **先钉住那份库真的是上一版形状**：`before` 里必须躺着 `visible` 且它的值是 0，
    // 否则下面「`visible` 没了」在「它从来就没有过」时也成立
    const before = rawRows(file, "sessions") as Record<string, unknown>[];
    expect(Object.keys(before[0]!).sort()).toEqual(["created_at", "id", "name", "updated_at", "visible"]);
    expect(before[0]!["visible"]).toBe(0);

    // ⚠️ 打开动作就是一次读：库不存在 ⇒ 空清单，而它**不**创建那个库
    expect(readSessions(file)).toEqual([{ id: "s1", name: "老会话", createdAt: 100, updatedAt: 100 }]);

    const after = rawRows(file, "sessions") as Record<string, unknown>[];
    // ⚠️ 判据是**那几行的键**，不只是列清单：列清单说「表上有没有这一列」，键说「这一行里还带不带它」
    expect(Object.keys(after[0]!).sort()).toEqual([
      "created_at",
      "id",
      "model_ref",
      "name",
      "reasoning",
      "updated_at",
    ]);
    expect(rawColumns(file, "sessions")).toEqual([
      "id",
      "name",
      "created_at",
      "updated_at",
      "model_ref",
      "reasoning",
    ]);
    // ⚠️ 别的数据逐字未动（⚠️ 补出来的那两列**自带缺省**：可空的 `model_ref` 与 `NOT NULL DEFAULT` 的 `reasoning`，
    // 而老库里已有的行拿不到 `DEFAULT` 之外的值 —— 少写 `DEFAULT` 这一列就插不进任何新值）
    expect(after[0]).toEqual({
      id: "s1",
      name: "老会话",
      created_at: 100,
      updated_at: 100,
      model_ref: null,
      reasoning: "medium",
    });
    expect(pick(withRaw(file, (db) => db.prepare("PRAGMA user_version").get()))).toBe(SCHEMA_VERSION);
  });

  it("provider 那两张表建出来了，而升级步**一个字都没动**已有的那几行（`meta` 与 `targets` 逐字未变）", () => {
    const file = v3Library();
    readSessions(file);

    expect(rawTables(file)).toEqual([
      "messages",
      "meta",
      "provider_models",
      "providers",
      "sessions",
      "sidebar_sessions",
      "targets",
    ]);
    expect(rawColumns(file, "sidebar_sessions")).toEqual(["session_id", "at"]);
    expect(rawColumns(file, "messages")).toEqual(["session_id", "seq", "at", "turns"]);
    // ⚠️ 升级步答的是「缺的那些形状怎么落到这一版」，**不是**「把台账重写一遍」：
    // 判据落在已有的那两行上（凭据那一格也逐字未变），空清单证明不了任何事
    expect(rawRows(file, "meta")).toEqual([{ key: "selected", value: "prod" }]);
    expect(rawRows(file, "targets")).toEqual([
      { id: "prod", name: "生产", base_url: "http://127.0.0.1:3010", token: "sk-old-secret", timeout_ms: 5000 },
    ]);
  });

  it("⚠️ **跑两遍结果一样**（判据落在**每张表的形状与内容**上，不只是「没抛」）", () => {
    const file = v3Library();
    readSessions(file);
    const once = shapeOf(file);

    // ⚠️ 第二次走的是**另一个 `ensureSchema`**：`closeLedgerDb()` 之后下一次打开会真的重跑一遍
    closeLedgerDb();
    readSessions(file);
    expect(shapeOf(file)).toBe(once);
  });

  it("⚠️ **版本说自己是当前这一版而形状还是上一版 ⇒ 照样按形状收口**（判据不许依赖 `user_version` 的可信度）", () => {
    // ⚠️ 这一档是「不按版本号判」那条纪律**唯一的牙齿**：库被别的东西动过（版本被手工推上去、
    // 或者一次半途失败的升级）时，`user_version` 会说「我已经是这一版了」而形状还没跟上。
    // 一个加了 `version < 当前版本` 门槛的实现在这一档下**恒绿** —— 故它必须自己造出这份自相矛盾的库。
    const file = v3Library(SCHEMA_VERSION);
    expect(pick(withRaw(file, (db) => db.prepare("PRAGMA user_version").get()))).toBe(SCHEMA_VERSION);
    expect(rawColumns(file, "sessions")).toContain("visible");

    readSessions(file);

    expect(rawColumns(file, "sessions")).toEqual([
      "id",
      "name",
      "created_at",
      "updated_at",
      "model_ref",
      "reasoning",
    ]);
    expect(readSessions(file)).toEqual([{ id: "s1", name: "老会话", createdAt: 100, updatedAt: 100 }]);
  });

  it("⚠️ 新鲜库连开两次也一样（第一次那些 `ALTER` 的判据不许每次都触发）", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1"));
    const once = shapeOf(file);

    closeLedgerDb();
    saveSession(file, record("s2", "会话 2"));
    const twice = shapeOf(file);
    // ⚠️ 反向自检：第二次**真的**多了一行（否则上面那条「跑两遍一样」只是一份空的库恰好一样）
    expect(twice).not.toBe(once);
    closeLedgerDb();
    readSessions(file);
    expect(shapeOf(file)).toBe(twice);
  });

  it("存得进新行，而新库**四列就够**（身份那四列就够，模型那两列的缺省住在 DDL 的列上）", () => {
    const file = v3Library();
    readSessions(file);
    saveSession(file, record("s2", "新的", 300));
    expect(readSessions(file)).toHaveLength(2);
  });
});

describe("删一个会话：级联到侧边栏与对话（一次事务）", () => {
  it("⚠️ 三张表上**没有孤儿行**（从一个不认识本包的句柄倒表比，不用逐字节）", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1"));
    saveSession(file, record("s2", "会话 2"));
    pinSession(file, "s1", 10);
    pinSession(file, "s2", 20);
    appendMessages(file, "s1", [
      { id: 1, at: 100, turns: [{ kind: "notice", rows: [{ kind: "note", text: "一号" }] }] },
    ]);
    appendMessages(file, "s2", [
      { id: 1, at: 200, turns: [{ kind: "notice", rows: [{ kind: "note", text: "二号" }] }] },
    ]);
    upsertProvider(file, {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      api: "openai",
      apiKey: "sk-kept",
    });

    removeSession(file, "s1");

    // ⚠️ 判据是**那几行逐字**（含补出来的那两列的缺省）：只看 `id` 的话「补出来的默认值变了」看不见
    expect(rawRows(file, "sessions")).toEqual([
      {
        id: "s2",
        name: "会话 2",
        created_at: 100,
        updated_at: 100,
        model_ref: null,
        reasoning: "medium",
      },
    ]);
    expect(rawRows(file, "sidebar_sessions")).toEqual([{ session_id: "s2", at: 20 }]);
    expect(rawRows(file, "messages")).toEqual([
      { session_id: "s2", seq: 1, at: 200, turns: '[{"kind":"notice","rows":[{"kind":"note","text":"二号"}]}]' },
    ]);
    // ⚠️ **反向自检：provider 那两张表不在这次级联的范围里**（删一个会话与删一个提供商是两件事）。
    // ⚠️ 而它必须**先真的有一行** —— 空表证明不了「没被级联删掉」，只证明得了「本来就没有」
    expect(rawRows(file, "providers")).toEqual([
      { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", api: "openai", api_key: "sk-kept" },
    ]);
  });

  it("⚠️ **不一致是真的**：只有 `messages` 没有 `sessions` 那一行时，级联删照样让它消失", () => {
    // ⚠️ 这一档造的是**写盘失败 / 库被人动过**之后的那种真状态，而那种库里孤儿消息是会攒出来的
    const file = tempDb();
    saveSession(file, record("s1", "会话 1"));
    appendMessages(file, "s1", [
      { id: 1, at: 100, turns: [{ kind: "notice", rows: [{ kind: "note", text: "孤儿" }] }] },
    ]);
    closeLedgerDb();
    withRaw(file, (db) => db.prepare("DELETE FROM sessions WHERE id = ?").run("s1"));
    expect(rawRows(file, "messages")).toHaveLength(1);

    removeSession(file, "s1");

    expect(rawRows(file, "messages")).toEqual([]);
  });

  it("删一个**从来没有**那几行的会话也是成功的 no-op（三张表一个都不许报错）", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1"));

    expect(() => removeSession(file, "s1")).not.toThrow();
    expect(() => removeSession(file, "s1")).not.toThrow();
    expect(rawRows(file, "sessions")).toEqual([]);
    expect(rawRows(file, "messages")).toEqual([]);
    expect(rawRows(file, "sidebar_sessions")).toEqual([]);
  });
});

/**
 * provider 的落盘面：**清单往返**在 `tests/providers/`（那一档管 provider 那几张表的成败语义），
 * 这一档只留两条只有**真库**才量得到的东西
 *
 * @description
 * ⚠️ 这一族原来断言的形状（三格值落在 `meta` 的三个键上）**已经不存在了**：provider 现在是
 * 一份清单 + 每份一份模型清单（两张表），而 `meta` 只放台账状态。清单本体的往返 / 顺序 /
 * 级联删 / 打码都在 `tests/providers/` 那一档，而**这两条不许跟着那个形状一起消失** ——
 * 它们防的事故今天仍然存在，只是换了一个入口：
 * - **打码出口唯一**：`redactProviderView` 是唯一那一份（`tests/ledger/pure.test.ts` 量它与
 *   `redactTarget` 的同族规格），这一档钉的是「真凭据落在 `providers.api_key` 那一格，
 *   而读出来给人看的那一份永远是掩码」——落盘字节与屏上字节分开量。
 * - **不合规的记录落不下去**：落盘的字节恒是校验过的形态，故「半份配置」不可能存在于盘上。
 * - **别人建的同名表当场拒**：`CREATE TABLE IF NOT EXISTS` 对**已存在**的表一个字节都不写，
 *   而列不对时必须**当场**拒（凭据就落在 `providers` 里 —— 读面还能读出来就已经晚了）。
 */
describe("provider 的落盘面（清单本体的成败语义在 `tests/providers/`）", () => {
  const SECRET = "sk-a-very-long-secret-value";

  function provider(over: Partial<ProviderRecord> = {}): ProviderRecord {
    return {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      api: "openai",
      apiKey: SECRET,
      ...over,
    };
  }

  it("⚠️ 真凭据落在 `api_key` 那一格，而**读出来给人看的那一份永远是掩码**（落盘字节与屏上字节分开量）", () => {
    const file = tempDb();
    upsertProvider(file, provider());
    closeLedgerDb();

    // ⚠️ 落盘的那一份是**明文**：没有可加密它的密钥，防线是 `0600` 库 + `0700` 目录而不是加密
    // （这一条记的是**结论** —— 于是必须有一道牙说明真凭据躺在哪些字节里）
    expect((rawRows(file, "providers")[0] as Record<string, unknown>)["api_key"]).toBe(SECRET);
    expect(JSON.stringify(rawRows(file, "providers"))).toContain(SECRET);

    // ⚠️ 而屏上那一侧永远是现算的掩码：它**不是**从盘上那一格读出来的
    const view = redactProviderView(readProviders(file)[0]!);
    expect(view.apiKey).toBe(REDACTED_PROVIDER_KEY);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    // ⚠️ **反向自检**：与 `targets.token` 的掩码**同形**（两个不同的真凭据不许看起来一样长）
    expect(view.apiKey).toBe(REDACTED_TOKEN);
    // ⚠️ **空串保持空串**（「没配」与「配了但不给你看」是两种不同的事实）
    expect(redactProviderView(provider({ apiKey: "" })).apiKey).toBe("");
  });

  it("⚠️ **`providers` 的列不对 ⇒ 读清单时当场拒**（`IF NOT EXISTS` 会把别人建的同名表当成自己的用）", () => {
    const file = tempDb();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
    withRaw(file, (db) => {
      db.exec(`CREATE TABLE targets (
        id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
        token TEXT NOT NULL, timeout_ms INTEGER NOT NULL);
        CREATE TABLE meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE providers (id TEXT NOT NULL PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL);
        CREATE TABLE sessions (
          id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    });
    closeLedgerDb();
    // ⚠️ 判据是**读面**（第一次碰到那张表就拒），而不是「写进去才炸」——
    // 凭据落进一张列不对的表，读面还是能读出来的，而那就晚了
    expect(() => readProviders(file)).toThrow(LedgerError);
    expect(() => readSessions(file)).toThrow(LedgerError);
    // ⚠️ **反向自检**：那份库真的是「别人的同名表」—— 列名与今天要的那几列**对不上**
    // （否则上面那两条在「库是本包建的」时也成立，判据就锚到了一个今天不在的形状上）
    expect(rawColumns(file, "providers")).toEqual(["id", "url", "secret"]);
    expect(rawColumns(file, "providers")).not.toContain("api_key");
  });

  it("⚠️ **不合规的记录一个字节都落不下去**（界面上与「没配」长得一样，而用户去查一个他改过的东西）", () => {
    const file = tempDb();
    for (const bad of [
      { apiKey: "" },
      { apiKey: "   " },
      { baseUrl: "" },
      { name: "" },
      { api: "ollama" as never },
      { id: "openai/gpt" },
    ]) {
      expect(() => upsertProvider(file, provider(bad))).toThrow(LedgerError);
    }
    // ⚠️ **反向自检一**：合规的那一份真的写得进去（否则上面那六条在「什么都写不进去」时也成立）
    upsertProvider(file, provider());
    expect(readProviders(file)).toHaveLength(1);
    // ⚠️ **反向自检二**：拒写必须是真的拒写 —— 盘上那一份只有刚才那一条，没有半份配置
    expect(rawRows(file, "providers")).toEqual([
      { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", api: "openai", api_key: SECRET },
    ]);
  });
});