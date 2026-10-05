/**
 * Anthropic 形状：`/v1/messages` + `x-api-key` + 版本头，系统提示**拆到顶层** `system`。
 *
 * @description 目录级不变量在 `./AGENTS.md`。⚠️ 这一档与 {@link ./openai.test.ts} 最重要的差别是
 * **系统提示的位置**：留在 `messages[0]` 会被这一家当成一条用户消息，故负向断言都配了正向对照。
 *
 * @module tests/model-dialects
 */

import { describe, expect, it } from "vitest";

import { askModel, listProviderModels } from "@/services/model/index.js";
import { API_KEY, USER_TEXT, fakeFetch, inputFor } from "./_shared.js";

/** 一份 Anthropic 形状的回答（`content` 是**一串块**，不是一段文本） */
function replyWith(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }] };
}

describe("anthropic：请求形状", () => {
  it("⚠️ **正向对照**：一条正常往返答得出文本（锚点是 URL + 凭据头 + 版本头）", async () => {
    const fake = fakeFetch(() => replyWith("她在用"));
    const reply = await askModel(inputFor("anthropic", fake.fetchImpl));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe("https://provider.invalid/v1/v1/messages");
    expect(fake.calls[0]!.headers["x-api-key"]).toBe(API_KEY);
    // ⚠️ **版本头必填**（这一家按版本发版），而它的值要有一个形状锚点 ⇒ 判据是「非空且像个日期」
    expect(fake.calls[0]!.headers["anthropic-version"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(reply).toEqual({ kind: "text", text: "她在用" });
  });

  it("⚠️ 系统提示**拆到顶层** `system`，而 `messages` 里只剩两档", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel(inputFor("anthropic", fake.fetchImpl));
    const body = fake.lastBody();
    // ⚠️ 判据是**两处同时**：顶层有 `system` 且 `messages` 里**一条 system 都没有**
    // （只断前者的话，「复制一份留在数组里」那一版照样绿 —— 而那正是这一家的错）
    expect(body["system"]).toBe("你是规划器");
    const messages = body["messages"] as readonly { role: string; content: string }[];
    expect(messages.map((one) => one.role)).toEqual(["user", "assistant"]);
    expect(messages[0]!.content).toBe(USER_TEXT);
  });

  it("⚠️ **`max_tokens` 必填**（缺了对面直接拒，而那一格请求体里不能没有）", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel(inputFor("anthropic", fake.fetchImpl));
    const max = fake.lastBody()["max_tokens"];
    // ⚠️ 判据是**一个正整数**而不是某个具体值（那个值是保守缺省，改它是正当演进）
    expect(typeof max).toBe("number");
    expect(Number(max)).toBeGreaterThan(0);
  });

  it("⚠️ 推理强度走 `thinking.budget_tokens`（**逐档不同**，不是三档一个值）", async () => {
    const seen: number[] = [];
    for (const effort of ["low", "medium", "high"] as const) {
      const fake = fakeFetch(() => replyWith("好"));
      await askModel({ ...inputFor("anthropic", fake.fetchImpl), reasoning: effort });
      const thinking = fake.lastBody()["thinking"] as { type: string; budget_tokens: number };
      expect(thinking.type, effort).toBe("enabled");
      seen.push(thinking.budget_tokens);
    }
    // ⚠️ **逐档递增**（三档一个值就是「强度档只是装饰」，而屏上分不出那四档）
    expect(new Set(seen).size).toBe(3);
    expect(seen[0]!).toBeLessThan(seen[1]!);
    expect(seen[1]!).toBeLessThan(seen[2]!);
  });

  it("⚠️ **`off` 档 `thinking` 整个不出现**（不是发一个 `type: \"disabled\"`）", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel({ ...inputFor("anthropic", fake.fetchImpl), reasoning: "off" });
    // ⚠️ **正向对照**：同一格里 `max_tokens` 还在（否则上面是「请求体整个空了」）
    expect("thinking" in fake.lastBody()).toBe(false);
    expect(fake.lastBody()["max_tokens"]).toBeGreaterThan(0);
  });

  it("⚠️ `content` 里混着**思考块**时只取文本（取全部会把思考过程当成模型的话）", async () => {
    const fake = fakeFetch(() => ({
      content: [
        { type: "thinking", thinking: "先看 ACL 表" },
        { type: "text", text: "/acl add" },
      ],
    }));
    const reply = await askModel(inputFor("anthropic", fake.fetchImpl));
    expect(reply).toEqual({ kind: "command", line: "/acl add" });
    expect(JSON.stringify(reply)).not.toContain("ACL 表");
  });

  it("清单走 `GET {base}/v1/models`，id 取自 `data[].id`", async () => {
    const fake = fakeFetch(() => ({ data: [{ id: "claude-a" }] }));
    const models = await listProviderModels(inputFor("anthropic", fake.fetchImpl));
    // ⚠️ 清单端点**带 `/v1`** 而聊天端点也带（这一家的前缀在两处一样，不是只有聊天那一条带）
    expect(fake.calls[0]!.url).toBe("https://provider.invalid/v1/v1/models");
    expect(fake.calls[0]!.method).toBe("GET");
    expect(models).toEqual([{ modelId: "claude-a", label: "claude-a" }]);
  });

  it("⚠️ 凭据**只**出现在 `x-api-key`（请求体与 URL 里都没有）", async () => {
    const fake = fakeFetch(() => replyWith("好"));
    await askModel(inputFor("anthropic", fake.fetchImpl));
    const call = fake.calls[0]!;
    expect(call.url).not.toContain(API_KEY);
    expect(call.body).not.toContain(API_KEY);
    for (const [name, value] of Object.entries(call.headers)) {
      if (name !== "x-api-key") expect(value, name).not.toContain(API_KEY);
    }
  });
});