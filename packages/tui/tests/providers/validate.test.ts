/**
 * provider 清单与模型清单的**逐字段判据**：每一格不合法即拒，而文案一个字都不转述用户输入
 *
 * @description
 * 与 `model-ref.test.ts` 的分界是「一份记录的判据」对「键的算术」；与 `store.test.ts` 的分界是
 * 「判据本身」对「判据在真库上的效果」。**档间共用的一条不变量见本目录 `AGENTS.md`。**
 *
 * @module tests/providers
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REASONING_EFFORT,
  LedgerError,
  MODEL_API_FORMATS,
  NAME_MAX_LEN,
  REASONING_EFFORTS,
  validateModelRecord,
  validateProviderRecord,
} from "@/services/config/index.js";

const SECRET = "sk-a-very-long-secret-value";

function provider(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    api: "openai",
    apiKey: SECRET,
    ...over,
  };
}

function model(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { providerId: "openai", modelId: "gpt-4o", label: "GPT-4o", pinned: false, ...over };
}

describe("一个提供商：判据", () => {
  it("合规的那一份逐字过（显示名与地址都 trim 过）", () => {
    expect(validateProviderRecord(provider({ name: "  OpenAI  ", baseUrl: " https://x/v1 " }))).toEqual({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://x/v1",
      api: "openai",
      apiKey: SECRET,
    });
  });

  it("⚠️ `api` 只认那三档，而文案点的是**合法档位**而不是用户敲的那几个字", () => {
    for (const api of MODEL_API_FORMATS) {
      expect(validateProviderRecord(provider({ api })).api).toBe(api);
    }
    expect(() => validateProviderRecord(provider({ api: "ollama" }))).toThrow(LedgerError);
    expect(() => validateProviderRecord(provider({ api: "OpenAI" }))).toThrow(LedgerError);
    expect(() => validateProviderRecord(provider({ api: 7 }))).toThrow(/必须是/);
  });

  it("⚠️ **`id` 不许含 `/`**（存储键按第一个 `/` 切，含了会把键切错）", () => {
    expect(() => validateProviderRecord(provider({ id: "openai/gpt" }))).toThrow(
      /不能含「\/」/,
    );
  });

  it("⚠️ **`id` 与 `apiKey` 非空，而地址不归一**（`normalizeBaseUrl` 是控制面那份判据）", () => {
    expect(() => validateProviderRecord(provider({ id: "   " }))).toThrow(/不能为空/);
    expect(() => validateProviderRecord(provider({ name: "" }))).toThrow(/不能为空/);
    expect(() => validateProviderRecord(provider({ baseUrl: "" }))).toThrow(/不能为空/);
    expect(() => validateProviderRecord(provider({ apiKey: "  " }))).toThrow(/不能为空/);
    // ⚠️ 一个控制面那份判据**会拒**的地址，在这里**必须过**（provider 可以是任何兼容端点）
    expect(validateProviderRecord(provider({ baseUrl: "not a url at all" })).baseUrl).toBe(
      "not a url at all",
    );
  });

  it("显示名过 `NAME_MAX_LEN`（多一个码点即拒）", () => {
    expect(validateProviderRecord(provider({ name: "n".repeat(NAME_MAX_LEN) })).name).toBe(
      "n".repeat(NAME_MAX_LEN),
    );
    expect(() => validateProviderRecord(provider({ name: "n".repeat(NAME_MAX_LEN + 1) }))).toThrow(
      LedgerError,
    );
  });

  it("⚠️ **凭据永远不进任何一条失败文案**（它与 `targets.token` 同级）", () => {
    // ⚠️ 两路都喂：凭据自己坏掉，以及**别的格**坏掉而凭据在旁边（后者才是真会漏的那一路）
    const texts: string[] = [];
    for (const bad of ["  ", 42, null, ["x"], SECRET]) {
      for (const extra of [{}, { api: "nope" }]) {
        try {
          validateProviderRecord(provider({ apiKey: bad, ...extra }));
        } catch (err) {
          texts.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
    expect(texts.filter((text) => text.includes(SECRET)), "凭据漏进文案了").toEqual([]);
    // ⚠️ 反向自检：这一档**真的**判中过（否则上面那条在「一条文案都没产出」时也成立）
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((text) => text.includes("apiKey") || text.includes("api"))).toBe(true);
  });

  it("⚠️ **失败文案绝不引用用户输入的其余几格**（地址与显示名会进可滚动的结果区）", () => {
    const baseUrl = "https://带凭据的地址.example/sk-secret-in-url";
    let text = "";
    try {
      validateProviderRecord(provider({ baseUrl, api: "nope" }));
    } catch (err) {
      text = err instanceof Error ? err.message : String(err);
    }
    expect(text).not.toContain("带凭据");
  });
});

describe("一个模型：判据", () => {
  it("`modelId` **可含 `/`**（协议标识），能显示的是 `label`", () => {
    const hit = validateModelRecord(model({ modelId: "anthropic/claude-x" }));
    expect(hit).toEqual({
      providerId: "openai",
      modelId: "anthropic/claude-x",
      label: "GPT-4o",
      pinned: false,
    });
  });

  it("`providerId` 同样不许含 `/`（它是键的前半段）", () => {
    expect(() => validateModelRecord(model({ providerId: "openai/x" }))).toThrow(/不能含「\/」/);
  });

  it("⚠️ 置顶位两处写法都放行（盘上是 INTEGER 0/1，界面上是布尔）", () => {
    for (const pinned of [0, 1, false, true]) {
      expect(validateModelRecord(model({ pinned })).pinned).toBe(Boolean(pinned));
    }
    expect(() => validateModelRecord(model({ pinned: 2 }))).toThrow(/置顶位/);
    expect(() => validateModelRecord(model({ pinned: "yes" }))).toThrow(/置顶位/);
  });

  it("`modelId` 与 `label` 非空，而显示名过 `NAME_MAX_LEN`", () => {
    expect(() => validateModelRecord(model({ modelId: "" }))).toThrow(/不能为空/);
    expect(() => validateModelRecord(model({ label: "  " }))).toThrow(/不能为空/);
    expect(() => validateModelRecord(model({ label: "n".repeat(NAME_MAX_LEN + 1) }))).toThrow(
      LedgerError,
    );
  });
});

describe("推理强度：闭集的四档", () => {
  it("⚠️ **四档与它们的顺序就是下拉框与循环切档的那一份**（少一档即界面少一档）", () => {
    expect(REASONING_EFFORTS).toEqual(["off", "low", "medium", "high"]);
  });

  it("⚠️ **缺省档是 `medium` 而不是第一档**（一半模型不认这个参数，而 `off` 让「没配」看起来像一个选择）", () => {
    // ⚠️ 反向自检：拿第一档（`off`）当缺省的那一版会全程绿，故这一条必须点名中间那一档
    expect(DEFAULT_REASONING_EFFORT).toBe("medium");
    expect(REASONING_EFFORTS[0]).not.toBe(DEFAULT_REASONING_EFFORT);
  });
});