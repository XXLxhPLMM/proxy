/**
 * OpenAI 形状：`/chat/completions` + `Authorization: Bearer`，系统提示留在 `messages[0]`。
 *
 * @description 逐字段断的是**发出去的东西**：URL、请求头、请求体里 system 的位置、推理强度的参数名、
 * `off` 档那个字段不出现、清单的 id 抽取。⚠️ **负向断言都带正向对照**（同一个 `it` 里先喂一个真能过的
 * 输入），否则「什么都不做」也满足它。
 *
 * 目录级不变量与「为什么用假 fetch 而不是真 server」在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/model-dialects
 */

import { describe, expect, it } from "vitest";

import { askModel, listProviderModels } from "@/services/model/index.js";
import { API_KEY, USER_TEXT, fakeFetch, inputFor } from "./_shared.js";

/** 一份 OpenAI 形状的回答（⚠️ 形状**逐字段**取自真实协议，故收窄判据断的就是它） */
function replyWith(content: string): Record<string, unknown> {
  return { choices: [{ message: { role: "assistant", content } }] };
}

describe("openai：请求形状", () => {
  it("⚠️ **正向对照**：一条正常往返答得出文本（锚点是 URL + 那个 Bearer 头）", async () => {
    const fake = fakeFetch(() => replyWith("她在用"));
    const reply = await askModel(inputFor("openai", fake.fetchImpl));
    // ⚠️ 正向对照：URL 与头**真的**是这一份形状（否则下面那些负向断言都建在「什么都没发」的形状上）
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe("https://provider.invalid/v1/chat/completions");
    expect(fake.calls[0]!.method).toBe("POST");
    expect(fake.calls[0]!.headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(reply).toEqual({ kind: "text", text: "她在用" });
  });

  it("⚠️ 系统提示**留在 `messages[0]`**（⚠️ 这一档不把它拆出来）", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel(inputFor("openai", fake.fetchImpl));
    const body = fake.lastBody();
    const messages = body["messages"] as readonly { role: string; content: string }[];
    // ⚠️ 判据是**位置**（`messages[0].role === "system"`），不是「文本在请求体里出现过」——
    // 后者对「system 被拆到顶层」那一版也成立（那是 anthropic / gemini 的做法）
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toBe("你是规划器");
    // ⚠️ 而顶层**没有** `system`（这一家不认那个键）
    expect(body["system"]).toBeUndefined();
    expect(messages[1]!.content).toBe(USER_TEXT);
  });

  it("⚠️ 推理强度走 `reasoning_effort`（逐档一个值，**不是**自造的名字）", async () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const fake = fakeFetch(() => replyWith("好"));
      await askModel({ ...inputFor("openai", fake.fetchImpl), reasoning: effort });
      expect(fake.lastBody()["reasoning_effort"], effort).toBe(effort);
    }
  });

  it("⚠️ **`off` 档那个字段整个不出现**（不是发一个「关」的取值）", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel({ ...inputFor("openai", fake.fetchImpl), reasoning: "off" });
    const body = fake.lastBody();
    // ⚠️ 判据用 **`in`** 而不是取值：`= null` 那种实现（发一个空串）也该红
    expect("reasoning_effort" in body).toBe(false);
    // ⚠️ **正向对照**：同一个字段在 `medium` 档**确实出现**（否则上面是「字段名拼错了」）
    const other = fakeFetch(() => replyWith("好"));
    await askModel({ ...inputFor("openai", other.fetchImpl), reasoning: "medium" });
    expect("reasoning_effort" in other.lastBody()).toBe(true);
  });

  it("以 `/` 开头的那一行答成**一条命令**（不是文本）", async () => {
    const fake = fakeFetch(() => replyWith("  /users  "));
    const reply = await askModel(inputFor("openai", fake.fetchImpl));
    // ⚠️ 而**空白被 trim 掉、命令本身逐字留着**（那行要再过一遍 `parseLine`）
    expect(reply).toEqual({ kind: "command", line: "/users" });
  });

  it("清单走 `GET {base}/models`，id 取自 `data[].id`", async () => {
    const fake = fakeFetch(() => ({ data: [{ id: "gpt-a" }, { id: "gpt-b" }] }));
    const models = await listProviderModels(inputFor("openai", fake.fetchImpl));
    expect(fake.calls[0]!.url).toBe("https://provider.invalid/v1/models");
    expect(fake.calls[0]!.method).toBe("GET");
    // ⚠️ 判据是 **id 与 label 两条**：`label` 是「一个可改的显示名初值」，初值恒等于协议 id
    expect(models).toEqual([
      { modelId: "gpt-a", label: "gpt-a" },
      { modelId: "gpt-b", label: "gpt-b" },
    ]);
  });

  it("⚠️ **尾斜杠只归一一次**（基址与路径之间不多拼一个 `/`）", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel({ ...inputFor("openai", fake.fetchImpl), baseUrl: "https://provider.invalid/v1//" });
    // ⚠️ 正向对照：URL 真的发成了那一条（不是恒定的前缀断言）
    expect(fake.calls[0]!.url).toBe("https://provider.invalid/v1/chat/completions");
  });

  it("⚠️ 凭据**只**出现在那一个请求头（请求体与 URL 里都没有）", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel(inputFor("openai", fake.fetchImpl));
    const call = fake.calls[0]!;
    // ⚠️ 判据是**逐处**的：URL / 请求体 / 其它头三处各断一次（`Authorization` 那处在上一档已断）
    expect(call.url).not.toContain(API_KEY);
    expect(call.body).not.toContain(API_KEY);
    for (const [name, value] of Object.entries(call.headers)) {
      if (name !== "Authorization") expect(value, name).not.toContain(API_KEY);
    }
  });
});