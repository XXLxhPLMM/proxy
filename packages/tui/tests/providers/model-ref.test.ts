/**
 * 模型存储键的**拆与拼**：按第一个 `/` 切分，而拼的那一半在参数自相矛盾时**抛**
 *
 * @description
 * 与 `validate.test.ts` 的分界是「键的算术」对「一份记录的逐字段判据」；与 `store.test.ts` 的分界是
 * 「纯函数」对「真 SQLite 库上的往返」。**档间共用的一条不变量见本目录 `AGENTS.md`。**
 *
 * @module tests/providers
 */

import { describe, expect, it } from "vitest";
import { joinModelRef, splitModelRef } from "@/services/config/index.js";

describe("拆：按第一个 `/` 切分", () => {
  it("两段时 providerId 与 modelId 各归各位", () => {
    expect(splitModelRef("openai/gpt-4o")).toEqual({ providerId: "openai", modelId: "gpt-4o" });
  });

  it("⚠️ **三段也是三段里的后两段**（`modelId` 自己可含 `/`：openrouter 的 `anthropic/claude-x`）", () => {
    // ⚠️ 反向自检：按**全部** `/` 切的实现会把 providerId 认成 `openrouter/anthropic`，
    // 而那种键在 `/models` 弹窗里选中的模型与库里存的那一条对不上，而屏上两个 provider 长得一样
    expect(splitModelRef("openrouter/anthropic/claude-x")).toEqual({
      providerId: "openrouter",
      modelId: "anthropic/claude-x",
    });
    expect(splitModelRef("a/b/c/d")).toEqual({ providerId: "a", modelId: "b/c/d" });
  });

  it("⚠️ 构不成一个键的三种形态都给 `null`（没有 `/` / providerId 空 / modelId 空）", () => {
    // ⚠️ 「空的一段」不是「那个模型没名字」而是「这个键本身坏了」，故一律 `null` 而不是半截解析
    expect(splitModelRef("gpt-4o")).toBe(null);
    expect(splitModelRef("/gpt-4o")).toBe(null);
    expect(splitModelRef("openai/")).toBe(null);
    expect(splitModelRef("")).toBe(null);
  });

  it("⚠️ **`/` 在末尾那一档是坏键而不是「没有分隔符」**（两者都 `null`，但判据问的是「能不能用」）", () => {
    expect(splitModelRef("/")).toBe(null);
    expect(splitModelRef("a//b")).toEqual({ providerId: "a", modelId: "/b" });
  });
});

describe("拼：拼出来的那把键一定能被拆回来", () => {
  it("两段拼回去，逐字相等", () => {
    expect(joinModelRef("openai", "gpt-4o")).toBe("openai/gpt-4o");
    expect(joinModelRef("openrouter", "anthropic/claude-x")).toBe("openrouter/anthropic/claude-x");
  });

  it("⚠️ **`providerId` 含 `/` 时抛**（不是拼一把拆不回来的键：症状是「选中了另一个模型」）", () => {
    expect(() => joinModelRef("openrouter/anthropic", "claude-x")).toThrow(/providerId/);
    expect(() => joinModelRef("", "claude-x")).toThrow(/providerId/);
    expect(() => joinModelRef("openai", "")).toThrow(/modelId/);
  });

  it("⚠️ **拆拼互逆**（往返判据：`joinModelRef` 的产物必能被 `splitModelRef` 拆回同一对）", () => {
    // ⚠️ 反向自检：上面那些「抛」的形态不许漏进来 —— 一把拆不回来的键拼成功，症状是选中的模型静默错位
    const cases: readonly (readonly [string, string])[] = [
      ["openai", "gpt-4o"],
      ["openrouter", "anthropic/claude-x"],
      ["p", "a/b/c/d"],
      ["带空格的 id", "带空格的模型"],
    ];
    for (const [providerId, modelId] of cases) {
      expect(splitModelRef(joinModelRef(providerId, modelId))).toEqual({ providerId, modelId });
    }
  });
});