/**
 * provider 清单 / 模型清单 / 会话的模型选择：**真 SQLite 库**上的往返、顺序、级联删与打码
 *
 * @description
 * 与 `model-ref.test.ts` / `validate.test.ts` 的分界是「真库上的效果」对「纯函数与逐字段判据」。
 * **档间共用的一条不变量见本目录 `AGENTS.md`。**
 *
 * ⚠️ 列清单与落盘字节一律**从外面**量（`_shared.ts:withRaw`）：本包自己的接口正是被测的那一份，
 * 用它去量就是自证。
 *
 * @module tests/providers
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LedgerError,
  REDACTED_PROVIDER_KEY,
  REDACTED_TOKEN,
  closeLedgerDb,
  joinModelRef,
  readProviderModels,
  readProviders,
  readSessionModels,
  redactProviderView,
  removeModel,
  removeProvider,
  saveSession,
  upsertProvider,
  writeProviderModels,
  writeProviders,
  writeSessionModel,
  type ModelRecord,
  type ProviderRecord,
} from "@/services/config/index.js";
import { SCHEMA_VERSION } from "@/services/config/tables.js";
import { rawColumns, rawRows, rawTables, rawUserVersion, removeCreated, tempDb, withRaw } from "./_shared.js";

afterEach(() => {
  closeLedgerDb();
  removeCreated();
});

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

function model(over: Partial<ModelRecord> = {}): ModelRecord {
  return { providerId: "openai", modelId: "gpt-4o", label: "GPT-4o", pinned: false, ...over };
}

function session(id: string) {
  return { id, name: `会话 ${id}`, createdAt: 100, updatedAt: 100 };
}

describe("两张新表建出来了，而旧的那三行 provider 键**不在盘上**", () => {
  it("⚠️ 表清单里那两张在，而 `meta` 只剩台账状态（倒的是 `sqlite_master` **现列**的每一张表）", () => {
    // ⚠️ 判据不写死整张清单：漏一张就是「那个实现把那张表清空了而断言照样绿」
    const file = tempDb();
    upsertProvider(file, provider());
    closeLedgerDb();
    expect(rawTables(file)).toContain("providers");
    expect(rawTables(file)).toContain("provider_models");
    const keys = withRaw(file, (db) =>
      (db.prepare("SELECT key FROM meta ORDER BY key").all() as { key: string }[]).map(
        (row) => row.key,
      ),
    );
    expect(keys.some((key) => key.startsWith("provider."))).toBe(false);
  });

  it("⚠️ **两张表的列名就是那两份形状**（`api_key` 与 `targets.token` 同级，故列名不能含糊）", () => {
    const file = tempDb();
    upsertProvider(file, provider());
    closeLedgerDb();
    expect(rawColumns(file, "providers")).toEqual(["id", "name", "base_url", "api", "api_key"]);
    expect(rawColumns(file, "provider_models")).toEqual(["provider_id", "model_id", "label", "pinned"]);
    expect(rawTables(file)).toContain("meta");
  });

  it("⚠️ **schema 版本推到 `SCHEMA_VERSION` 且只有一处**（读的是 `PRAGMA user_version`，不是那个常量）", () => {
    const file = tempDb();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
    expect(rawUserVersion(file)).toBe(0);
    readProviders(file);
    closeLedgerDb();
    // ⚠️ 反向自检：这一步真的建了东西（否则「版本是 5」在一个空库上也成立）
    expect(rawTables(file)).toContain("provider_models");
    expect(rawUserVersion(file)).toBe(SCHEMA_VERSION);
    expect(rawTables(file)).not.toContain("schema_version");
  });
});

describe("提供商清单：往返、顺序与编辑", () => {
  it("写进去读得回来，五格逐字（含**不归一**的地址）", () => {
    const file = tempDb();
    upsertProvider(file, provider({ baseUrl: "not a url at all" }));
    expect(readProviders(file)).toEqual([provider({ baseUrl: "not a url at all" })]);
  });

  it("⚠️ **顺序靠 `rowid` = 插入序**，而整份换掉是「先全删再按数组序插回去」", () => {
    const file = tempDb();
    const [a, b, c] = [provider({ id: "a" }), provider({ id: "b" }), provider({ id: "c" })];
    writeProviders(file, [c, a, b]);
    expect(readProviders(file).map((one) => one.id)).toEqual(["c", "a", "b"]);
    writeProviders(file, [b, c]);
    expect(readProviders(file).map((one) => one.id)).toEqual(["b", "c"]);
    expect(rawRows(file, "providers").map((row) => row["id"])).toEqual(["b", "c"]);
  });

  it("编辑 = 同一个 `id` 上的一次 UPSERT（**不清掉别的**提供商）", () => {
    const file = tempDb();
    upsertProvider(file, provider({ id: "a" }));
    upsertProvider(file, provider({ id: "b", name: "B" }));
    upsertProvider(file, provider({ id: "a", name: "改名之后" }));
    expect(readProviders(file)).toEqual([provider({ id: "a", name: "改名之后" }), provider({ id: "b", name: "B" })]);
    expect(readProviders(file)).toHaveLength(2);
  });

  it("⚠️ **库不存在 ⇒ 空清单，且不因此创建那个库**（与台账读面同一条纪律）", () => {
    const file = path.join(path.dirname(tempDb()), "nope", "tui.db");
    expect(readProviders(file)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(readProviderModels(file, "openai")).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("⚠️ **坏内容即拒**（`api` 不在闭集里即抛 `LedgerError`，而绝不降级成空清单）", () => {
    const file = tempDb();
    upsertProvider(file, provider());
    closeLedgerDb();
    withRaw(file, (db) => db.prepare("UPDATE providers SET api = ? WHERE id = ?").run("ollama", "openai"));
    expect(() => readProviders(file)).toThrow(LedgerError);
    // ⚠️ 反向自检：抛完之后盘上那一份**逐字未变**（降级成空清单的话下一次写就会把它清空）
    closeLedgerDb();
    expect(rawRows(file, "providers")).toEqual([
      { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", api: "ollama", api_key: SECRET },
    ]);
  });

  it("⚠️ **落盘的字节里凭据是明文而库里只有那一个地方**（防线是 `0600` 库 + `0700` 目录，不是加密）", () => {
    // ⚠️ 这一档记的是**结论**：不加密是设计决定，于是必须有一道牙说明真凭据躺在哪些字节里
    const file = tempDb();
    upsertProvider(file, provider());
    closeLedgerDb();
    expect(rawRows(file, "providers")[0]?.["api_key"]).toBe(SECRET);
    expect(JSON.stringify(rawRows(file, "providers"))).toContain(SECRET);
  });
});

describe("模型清单：往返、顺序与覆盖写", () => {
  it("写进去读得回来，四格逐字（`model_id` **可含 `/`**）", () => {
    const file = tempDb();
    upsertProvider(file, provider());
    writeProviderModels(file, "openai", [
      model({ modelId: "anthropic/claude-x", label: "Claude X", pinned: true }),
      model({ modelId: "gpt-4o", label: "GPT-4o" }),
    ]);
    expect(readProviderModels(file, "openai")).toEqual([
      { providerId: "openai", modelId: "anthropic/claude-x", label: "Claude X", pinned: true },
      { providerId: "openai", modelId: "gpt-4o", label: "GPT-4o", pinned: false },
    ]);
  });

  it("⚠️ **置顶位落盘是 INTEGER**（盘上是 `0/1` 而不是布尔：SQLite 没有布尔这一种类型）", () => {
    const file = tempDb();
    upsertProvider(file, provider());
    writeProviderModels(file, "openai", [model({ pinned: true }), model({ modelId: "b", pinned: false })]);
    closeLedgerDb();
    expect(rawRows(file, "provider_models")).toEqual([
      { provider_id: "openai", model_id: "gpt-4o", label: "GPT-4o", pinned: 1 },
      { provider_id: "openai", model_id: "b", label: "GPT-4o", pinned: 0 },
    ]);
  });

  it("⚠️ **保存 = 整份覆盖写**（去掉一个模型再存一次，那一行真的没了）", () => {
    const file = tempDb();
    upsertProvider(file, provider());
    writeProviderModels(file, "openai", [model({ modelId: "a" }), model({ modelId: "b" })]);
    writeProviderModels(file, "openai", [model({ modelId: "b" })]);
    expect(readProviderModels(file, "openai").map((one) => one.modelId)).toEqual(["b"]);
    expect(rawRows(file, "provider_models")).toHaveLength(1);
  });

  it("⚠️ **换个提供商的那一份互不干扰**（复合主键的第一段就是 providerId）", () => {
    const file = tempDb();
    upsertProvider(file, provider({ id: "openai" }));
    upsertProvider(file, provider({ id: "openrouter" }));
    writeProviderModels(file, "openai", [model({ modelId: "gpt-4o" })]);
    writeProviderModels(file, "openrouter", [model({ providerId: "openrouter", modelId: "anthropic/claude-x" })]);
    expect(readProviderModels(file, "openai").map((one) => one.modelId)).toEqual(["gpt-4o"]);
    expect(readProviderModels(file, "openrouter").map((one) => one.modelId)).toEqual([
      "anthropic/claude-x",
    ]);
  });

  it("⚠️ **存之前那对 `providerId` 不一致即拒**（否则模型静默落到另一个提供商名下）", () => {
    const file = tempDb();
    upsertProvider(file, provider({ id: "openai" }));
    upsertProvider(file, provider({ id: "openrouter" }));
    expect(() => writeProviderModels(file, "openai", [model({ providerId: "openrouter" })])).toThrow(
      LedgerError,
    );
    // ⚠️ 反向自检：拒写必须是真的拒写（盘上那一份一个字都没动）
    expect(readProviderModels(file, "openai")).toEqual([]);
  });

  it("去一个不在清单上的 `(provider, model)` 是**成功的一次 no-op**", () => {
    const file = tempDb();
    upsertProvider(file, provider());
    writeProviderModels(file, "openai", [model({ modelId: "a" })]);
    expect(() => removeModel(file, "openai", "查无此模")).not.toThrow();
    expect(() => removeModel(file, "openai", "a")).not.toThrow();
    expect(readProviderModels(file, "openai")).toEqual([]);
  });
});

describe("删一个提供商：级联到它的模型", () => {
  it("⚠️ **两张表上都没有孤儿行**（从一个不认识本包的句柄倒表比，不用逐字节）", () => {
    const file = tempDb();
    upsertProvider(file, provider({ id: "openai" }));
    upsertProvider(file, provider({ id: "openrouter" }));
    writeProviderModels(file, "openai", [model({ modelId: "gpt-4o" }), model({ modelId: "gpt-4o-mini" })]);
    writeProviderModels(file, "openrouter", [
      model({ providerId: "openrouter", modelId: "anthropic/claude-x" }),
    ]);

    removeProvider(file, "openai");

    expect(rawRows(file, "providers").map((row) => row["id"])).toEqual(["openrouter"]);
    expect(rawRows(file, "provider_models").map((row) => row["model_id"])).toEqual([
      "anthropic/claude-x",
    ]);
  });

  it("⚠️ **整份换掉时也级联**（不在新清单里的那些提供商，它们的模型不许攒成孤儿）", () => {
    const file = tempDb();
    upsertProvider(file, provider({ id: "a" }));
    upsertProvider(file, provider({ id: "b" }));
    writeProviderModels(file, "a", [model({ providerId: "a", modelId: "x" })]);
    writeProviderModels(file, "b", [model({ providerId: "b", modelId: "y" })]);
    closeLedgerDb();

    writeProviders(file, [provider({ id: "a" }), provider({ id: "c" })]);

    expect(readProviders(file).map((one) => one.id)).toEqual(["a", "c"]);
    expect(rawRows(file, "provider_models").map((row) => row["model_id"])).toEqual(["x"]);
  });

  it("删一个**从来没有**的 `id` 也是成功的 no-op（两张表一个都不许报错）", () => {
    const file = tempDb();
    upsertProvider(file, provider());
    writeProviderModels(file, "openai", [model({ modelId: "a" })]);
    expect(() => removeProvider(file, "查无此家")).not.toThrow();
    expect(readProviders(file)).toHaveLength(1);
    expect(readProviderModels(file, "openai")).toHaveLength(1);
  });
});

describe("打码：唯一的出口", () => {
  it("⚠️ **配了凭据时恒是那个掩码，而空串保持空串**（`targets.token` 那一条同规格）", () => {
    expect(redactProviderView(provider()).apiKey).toBe(REDACTED_PROVIDER_KEY);
    expect(redactProviderView(provider({ apiKey: "" })).apiKey).toBe("");
    // ⚠️ 反向自检：与 `targets.token` 的掩码**同形**（两个不同的真凭据不许看起来一样长）
    expect(redactProviderView(provider()).apiKey).toBe(REDACTED_TOKEN);
  });

  it("⚠️ **绝不返回半截明文**，而其余几格原样透传（界面还要显示地址与格式）", () => {
    const view = redactProviderView(provider({ apiKey: SECRET }));
    expect(view.apiKey).not.toContain(SECRET.slice(0, 4));
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view).toEqual({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      api: "openai",
      apiKey: REDACTED_PROVIDER_KEY,
    });
  });
});

describe("会话级的模型选择", () => {
  it("⚠️ **没有选过时是「没选 + 缺省档」，而新增的那一行自带那两列的缺省**", () => {
    const file = tempDb();
    saveSession(file, session("s1"));
    closeLedgerDb();
    expect(readSessionModels(file, "s1")).toEqual({ modelRef: null, reasoning: "medium" });
    // ⚠️ 判据落在**列的缺省**上：老库升级补出来的那一列也带它，故插入不必（也不该）在代码里再写一遍
    expect(rawColumns(file, "sessions")).toContain("model_ref");
    expect(rawRows(file, "sessions")[0]?.["reasoning"]).toBe("medium");
  });

  it("⚠️ **写入读回逐字相等**，而四档都放行", () => {
    const file = tempDb();
    saveSession(file, session("s1"));
    const key = joinModelRef("openrouter", "anthropic/claude-x");
    writeSessionModel(file, "s1", key, "high");
    expect(readSessionModels(file, "s1")).toEqual({ modelRef: key, reasoning: "high" });
    for (const one of ["off", "low", "medium", "high"] as const) {
      writeSessionModel(file, "s1", null, one);
      expect(readSessionModels(file, "s1")).toEqual({ modelRef: null, reasoning: one });
    }
  });

  it("⚠️ **那两列不在会话的身份定义里**（读回来的清单仍是四列，而模型单独一查）", () => {
    const file = tempDb();
    saveSession(file, session("s1"));
    saveSession(file, session("s2"));
    writeSessionModel(file, "s2", joinModelRef("openai", "gpt-4o"), "low");
    // ⚠️ 反向自检：`s1` 真的还在清单里，而它没选过模型（否则「另一行不受影响」这一档是空的）
    expect(readSessionModels(file, "s1")).toEqual({ modelRef: null, reasoning: "medium" });
    expect(readSessionModels(file, "s2").modelRef).toBe("openai/gpt-4o");
    expect(rawRows(file, "sessions")).toHaveLength(2);
  });

  it("⚠️ **一个不存在的会话读出来是缺省那一档**，而写它是成功的 no-op", () => {
    const file = tempDb();
    saveSession(file, session("s1"));
    expect(readSessionModels(file, "查无此会话")).toEqual({ modelRef: null, reasoning: "medium" });
    expect(() => writeSessionModel(file, "查无此会话", null, "low")).not.toThrow();
    expect(readSessionModels(file, "查无此会话")).toEqual({ modelRef: null, reasoning: "medium" });
  });

  it("⚠️ **坏键与坏档即拒**（闭集不放行：屏上「推理强度」那一栏会显示一个不存在的档）", () => {
    const file = tempDb();
    saveSession(file, session("s1"));
    expect(() => writeSessionModel(file, "s1", "gpt-4o", "medium")).toThrow(/modelRef/);
    expect(() => writeSessionModel(file, "s1", "/gpt-4o", "medium")).toThrow(/modelRef/);
    expect(() => writeSessionModel(file, "s1", null, "none" as never)).toThrow(/reasoning/);
    // ⚠️ 反向自检：拒写必须是真的拒写
    expect(readSessionModels(file, "s1")).toEqual({ modelRef: null, reasoning: "medium" });
  });

  it("⚠️ **盘上那一列被改成闭集外的值 ⇒ 当场拒**（坏内容即拒，绝不悄悄退回缺省档）", () => {
    const file = tempDb();
    saveSession(file, session("s1"));
    closeLedgerDb();
    withRaw(file, (db) => db.prepare("UPDATE sessions SET reasoning = ? WHERE id = ?").run("ultra", "s1"));
    expect(() => readSessionModels(file, "s1")).toThrow(LedgerError);
  });

  it("⚠️ **悬空的键放行**（provider 被删掉之后那个会话仍要能显示「没选」，而拦住写入只会让人改不掉）", () => {
    const file = tempDb();
    saveSession(file, session("s1"));
    upsertProvider(file, provider({ id: "openai" }));
    writeSessionModel(file, "s1", joinModelRef("openai", "gpt-4o"), "medium");
    removeProvider(file, "openai");
    expect(readSessionModels(file, "s1")).toEqual({ modelRef: "openai/gpt-4o", reasoning: "medium" });
  });
});