/**
 * Gemini 形状：`:generateContent` + `x-goog-api-key`，系统提示走 `systemInstruction`，清单 id 剥 `models/`。
 *
 * @description 目录级不变量在 `./AGENTS.md`。⚠️ 这一档有两处别处没有的判据：
 * **角色名是 `model` 而不是 `assistant`**，而**清单里的 id 带一段资源名前缀**。
 *
 * @module tests/model-dialects
 */

import { describe, expect, it } from "vitest";

import { askModel, listProviderModels } from "@/services/model/index.js";
import { API_KEY, USER_TEXT, fakeFetch, inputFor } from "./_shared.js";

/** 一份 Gemini 形状的回答（`candidates[0].content.parts[0].text`） */
function replyWith(text: string): Record<string, unknown> {
  return { candidates: [{ content: { role: "model", parts: [{ text }] } }] };
}

describe("gemini：请求形状", () => {
  it("⚠️ **正向对照**：一条正常往返答得出文本（锚点是 URL + 凭据头 + 模型名在路径里）", async () => {
    const fake = fakeFetch(() => replyWith("她在用"));
    const reply = await askModel(inputFor("gemini", fake.fetchImpl));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe("https://provider.invalid/v1/models/some-model:generateContent");
    expect(fake.calls[0]!.headers["x-goog-api-key"]).toBe(API_KEY);
    expect(reply).toEqual({ kind: "text", text: "她在用" });
  });

  it("⚠️ 凭据走**头**而不走 `?key=` 查询串（URL 会被访问日志原样记下）", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel(inputFor("gemini", fake.fetchImpl));
    // ⚠️ 判据是**整条 URL**：凭据既不在 URL 里也不在请求体里，只在那个头里
    expect(fake.calls[0]!.url).not.toContain(API_KEY);
    expect(fake.calls[0]!.url).not.toContain("?key=");
    expect(fake.calls[0]!.body).not.toContain(API_KEY);
  });

  it("⚠️ 系统提示走**顶层 `systemInstruction`**，而 `contents` 里一条 system 都没有", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel(inputFor("gemini", fake.fetchImpl));
    const body = fake.lastBody();
    const instruction = body["systemInstruction"] as { parts: readonly { text: string }[] };
    // ⚠️ 判据是**两处同时**：顶层有它，且 `contents` 里没有一条 role 为 system
    //（只断前者的话，「复制一份留在 contents 里」那一版照样绿 —— 而那正是这一家的错）
    expect(instruction.parts[0]!.text).toBe("你是规划器");
    const contents = body["contents"] as readonly { role: string; parts: readonly { text: string }[] }[];
    expect(contents.map((one) => one.role)).not.toContain("system");
    expect(contents[0]!.parts[0]!.text).toBe(USER_TEXT);
  });

  it("⚠️ 角色名是 **`model`** 而不是 `assistant`（这一家不认后者）", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel(inputFor("gemini", fake.fetchImpl));
    const contents = fake.lastBody()["contents"] as readonly { role: string }[];
    // ⚠️ 判据是**第二个那一条**（`assistant` 那档被换成了什么），不是「里面有没有 model」
    expect(contents[1]!.role).toBe("model");
  });

  it("⚠️ 推理强度走 `generationConfig.thinkingConfig.thinkingBudget`（逐档不同）", async () => {
    const seen: number[] = [];
    for (const effort of ["low", "medium", "high"] as const) {
      const fake = fakeFetch(() => replyWith("好"));
      await askModel({ ...inputFor("gemini", fake.fetchImpl), reasoning: effort });
      const config = fake.lastBody()["generationConfig"] as {
        thinkingConfig: { thinkingBudget: number };
      };
      seen.push(config.thinkingConfig.thinkingBudget);
    }
    // ⚠️ **逐档递增**（三档一个值就是「强度档只是装饰」，而屏上分不出那四档）
    expect(new Set(seen).size).toBe(3);
    expect(seen[0]!).toBeLessThan(seen[1]!);
    expect(seen[1]!).toBeLessThan(seen[2]!);
  });

  it("⚠️ **`off` 档 `generationConfig` 整个不出现**（不是发一个 0 预算）", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel({ ...inputFor("gemini", fake.fetchImpl), reasoning: "off" });
    // ⚠️ **正向对照**：同一个请求体里 `contents` 还在（否则上面是「请求体整个空了」）
    expect("generationConfig" in fake.lastBody()).toBe(false);
    expect(fake.lastBody()["contents"]).toBeDefined();
  });

  it("`parts` 里混着**思考块**时只取文本", async () => {
    const fake = fakeFetch(() => ({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "先看 ACL 表", thought: true }, { text: "/acl add" }],
          },
        },
      ],
    }));
    const reply = await askModel(inputFor("gemini", fake.fetchImpl));
    expect(reply).toEqual({ kind: "command", line: "/acl add" });
    expect(JSON.stringify(reply)).not.toContain("ACL 表");
  });

  it("⚠️ 清单走 `GET {base}/models`，id 取自 `models[].name` 且**剥掉 `models/` 前缀**", async () => {
    const LISTING = { models: [{ name: "models/gemini-a" }, { name: "models/gemini-b" }] };
    // ⚠️ **正向对照**：对面给的**原始**那一段确实带前缀（否则下面只是「本来就没有前缀可剥」）
    expect(JSON.stringify(LISTING)).toContain("models/gemini-a");
    const fake = fakeFetch(() => LISTING);
    const models = await listProviderModels(inputFor("gemini", fake.fetchImpl));
    expect(fake.calls[0]!.url).toBe("https://provider.invalid/v1/models");
    expect(fake.calls[0]!.method).toBe("GET");
    // ⚠️ **剥前缀的理由**：那个 id 要拿去拼 `:generateContent` 的 URL，带着前缀对面不认
    expect(models).toEqual([
      { modelId: "gemini-a", label: "gemini-a" },
      { modelId: "gemini-b", label: "gemini-b" },
    ]);
  });

  it("⚠️ **不带前缀**的 id 原样过一遍（剥前缀必须幂等）", async () => {
    const fake = fakeFetch(() => ({ models: [{ name: "tuned/gemini-c" }] }));
    // ⚠️ 一个**别的**前缀（`tuned/` 而不是 `models/`）不许被剥 —— 判据是那**一段**而不是「前面有东西」
    expect(await listProviderModels(inputFor("gemini", fake.fetchImpl))).toEqual([
      { modelId: "tuned/gemini-c", label: "tuned/gemini-c" },
    ]);
  });
});