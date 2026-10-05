/**
 * 四类失败：连不上 / 非 2xx / 不是 JSON / 形状不对 —— 文案**不转述响应体**。
 *
 * @description 目录级不变量在 `./AGENTS.md`。⚠️ 这一档的判据**逐格式各跑一遍**：
 * 收窄那几层（`objectAt` / `arrayAt` / `stringAt`）是三家共用的，而「形状不对在哪一格」是各家自己的，
 * 只测一家的话另两家的路径写错了照样绿。
 *
 * @module tests/model-dialects
 */

import { describe, expect, it } from "vitest";
import type { ModelApiFormat } from "@/services/config/index.js";
import { ModelError, askModel, listProviderModels } from "@/services/model/index.js";
import { API_KEY, USER_TEXT, fakeFetch, inputFor } from "./_shared.js";

const FORMATS: readonly ModelApiFormat[] = ["openai", "anthropic", "gemini"];

/** 一份能过的回答（按格式分派）—— ⚠️ **正向对照的另一半**：失败那一档必须先有一个真能过的形状 */
const OK: Readonly<Record<ModelApiFormat, Record<string, unknown>>> = {
  openai: { choices: [{ message: { content: "好" } }] },
  anthropic: { content: [{ type: "text", text: "好" }] },
  gemini: { candidates: [{ content: { role: "model", parts: [{ text: "好" }] } }] },
};

/** 一份**形状不对**的回答（三个键都不在那三家要的路径上） */
const WRONG_SHAPE: Record<string, unknown> = {
  error: { message: "CANARY-RESPONSE-BODY" },
  detail: "CANARY-RESPONSE-BODY",
};

/** 四类失败对三种格式**全都成立**（⚠️ 判据是「格式 × 类别」的每一格，故写成两重循环而不是抽样） */
describe("失败分档与文案（三种格式逐个跑）", () => {
  it("⚠️ **正向对照**：三种格式各答得出东西（否则下面四类都在「什么都拿不到」的形状上恒绿）", async () => {
    for (const api of FORMATS) {
      const fake = fakeFetch(() => OK[api]);
      expect(await askModel(inputFor(api, fake.fetchImpl)), api).toEqual({ kind: "text", text: "好" });
    }
  });

  it("⚠️ **连不上**归 `unreachable` 档，而文案只带连接层那一句", async () => {
    for (const api of FORMATS) {
      const fetchImpl = (async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof globalThis.fetch;
      const err = await askModel(inputFor(api, fetchImpl)).catch((e: unknown) => e);
      expect(err, api).toBeInstanceOf(ModelError);
      expect((err as ModelError).code, api).toBe("unreachable");
      // ⚠️ 凭据与用户那句话**都不许**在这一句里（URL 与请求体都没读，而这一句只转述连接层）
      expect((err as ModelError).message, api).not.toContain(API_KEY);
      expect((err as ModelError).message, api).not.toContain(USER_TEXT);
    }
  });

  it("⚠️ **非 2xx** 说的是状态码，而**一个字都不转述响应体**", async () => {
    for (const api of FORMATS) {
      const fake = fakeFetch(() => WRONG_SHAPE);
      const fetchImpl = wrappedStatus(fake.fetchImpl, 429, JSON.stringify(WRONG_SHAPE));
      const err = await askModel(inputFor(api, fetchImpl)).catch((e: unknown) => e);
      expect(err, api).toBeInstanceOf(ModelError);
      expect((err as ModelError).code, api).toBe("shape");
      // ⚠️ 状态码**确实**在里面（否则是「一句泛泛的失败」，而那答不出「对面拒了什么」）
      expect((err as ModelError).message, api).toContain("429");
      // ⚠️ 而响应体里那两个探针一个都不许出现（⚠️ 响应体可能回显请求里的用户输入）
      expect((err as ModelError).message, api).not.toContain("CANARY-RESPONSE-BODY");
      expect((err as ModelError).message, api).not.toContain(API_KEY);
      expect((err as ModelError).message, api).not.toContain(USER_TEXT);
    }
  });

  it("⚠️ **不是 JSON** 单独一档（那多半是对面指错了一台服务，不是「形状不对」）", async () => {
    for (const api of FORMATS) {
      const fetchImpl = wrappedText(fakeFetch(() => OK[api]).fetchImpl, "CANARY-RESPONSE-BODY <html>");
      const err = await askModel(inputFor(api, fetchImpl)).catch((e: unknown) => e);
      expect(err, api).toBeInstanceOf(ModelError);
      expect((err as ModelError).code, api).toBe("shape");
      // ⚠️ 文案说清的是「不是 JSON」这一件事，而**不是**把那几行 HTML 抄回来
      expect((err as ModelError).message, api).toContain("JSON");
      expect((err as ModelError).message, api).not.toContain("CANARY-RESPONSE-BODY");
    }
  });

  it("⚠️ **形状不对**说清是哪一格不对，而那一格是**今天仍存在的形状**", async () => {
    // ⚠️ 锚点是三条路径本身（openai 走 choices / anthropic 走 content / gemini 走 candidates），
    // 而**不是**点名某个符号 —— 那些符号改名或搬走时判据不该跟着腐烂
    for (const [api, where] of [
      ["openai", "choices"],
      ["anthropic", "content"],
      ["gemini", "candidates"],
    ] as const) {
      const fake = fakeFetch(() => WRONG_SHAPE);
      const err = await askModel(inputFor(api, fake.fetchImpl)).catch((e: unknown) => e);
      expect(err, api).toBeInstanceOf(ModelError);
      expect((err as ModelError).code, api).toBe("shape");
      // ⚠️ 文案点名**那一格**，而 WRONG_SHAPE 的内容一个都不许被转述
      expect((err as ModelError).message, api).toContain(where);
      expect((err as ModelError).message, api).not.toContain("CANARY-RESPONSE-BODY");
    }
  });

  it("⚠️ **清单**那一侧的四类失败同样分档（它不是 `ask` 的副产品，路径全不一样）", async () => {
    // ⚠️ **正向对照**：三种格式各拉得出清单
    const LISTING: Readonly<Record<ModelApiFormat, Record<string, unknown>>> = {
      openai: { data: [{ id: "m" }] },
      anthropic: { data: [{ id: "m" }] },
      gemini: { models: [{ name: "models/m" }] },
    };
    for (const api of FORMATS) {
      const ok = fakeFetch(() => LISTING[api]);
      expect(await listProviderModels(inputFor(api, ok.fetchImpl)), api).toEqual([
        { modelId: "m", label: "m" },
      ]);
    }
    // ⚠️ 而非 2xx 那一条说的是状态码，**不转述响应体**
    for (const api of FORMATS) {
      const fetchImpl = wrappedStatus(
        fakeFetch(() => LISTING[api]).fetchImpl,
        401,
        JSON.stringify(WRONG_SHAPE),
      );
      const err = await listProviderModels(inputFor(api, fetchImpl)).catch((e: unknown) => e);
      expect((err as ModelError).message, api).toContain("401");
      expect((err as ModelError).message, api).not.toContain("CANARY-RESPONSE-BODY");
    }
  });

  it("⚠️ **整个回答不是一个 JSON 对象**时也是 `shape` 档（`null` / 数组 / 字符串三种）", async () => {
    // ⚠️ 这一档断的是**最外层**那道收窄：前面的几档喂的还是「一个对象、只是里面的键不对」，
    // 而对面答一个 JSON 标量（网关超时页、代理返回的裸字符串）是真会发生的
    for (const api of FORMATS) {
      for (const [what, payload] of [
        ["null", null],
        ["空数组", []],
        ["裸字符串", "CANARY-RESPONSE-BODY"],
      ] as const) {
        const fetchImpl = wrappedText(
          fakeFetch(() => OK[api]).fetchImpl,
          JSON.stringify(payload),
        );
        const err = await askModel(inputFor(api, fetchImpl)).catch((e: unknown) => e);
        expect(err, `${api}/${what}`).toBeInstanceOf(ModelError);
        // ⚠️ **分档**：那是「答了但形状不对」而不是「没答上」（处置动作完全不同：前者换模型，后者查地址）
        expect((err as ModelError).code, `${api}/${what}`).toBe("shape");
        // ⚠️ 而**裸字符串那一档**正是「响应体被原样抄进文案」最容易发生的地方
        expect((err as ModelError).message, `${api}/${what}`).not.toContain("CANARY-RESPONSE-BODY");
        expect((err as ModelError).message, `${api}/${what}`).not.toContain(API_KEY);
      }
    }
  });

  it("⚠️ 失败文案**永远不带 URL**（用户敲的地址与可能嵌在里面的凭据都在那上面）", async () => {
    for (const api of FORMATS) {
      const fetchImpl = wrappedStatus(
        fakeFetch(() => OK[api]).fetchImpl,
        500,
        JSON.stringify(WRONG_SHAPE),
      );
      const input = { ...inputFor(api, fetchImpl), baseUrl: "https://user-typed.invalid/v1" };
      const err = await askModel(input).catch((e: unknown) => e);
      expect((err as ModelError).message, api).not.toContain("user-typed.invalid");
    }
  });
});

/** 把一个 fetch 换成「固定状态码 + 固定响应体」的那一种 */
function wrappedStatus(
  inner: typeof globalThis.fetch,
  status: number,
  body: string,
): typeof globalThis.fetch {
  return async (input, init): Promise<Response> => {
    await inner(input, init);
    return { ok: false, status, text: async () => body } as Response;
  };
}

/** 把一个 fetch 换成「固定那几行不是 JSON 的文本」的那一种 */
function wrappedText(inner: typeof globalThis.fetch, body: string): typeof globalThis.fetch {
  return async (input, init): Promise<Response> => {
    await inner(input, init);
    return { ok: true, status: 200, text: async () => body } as Response;
  };
}