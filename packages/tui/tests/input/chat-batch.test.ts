/**
 * 一句聊天消息 → 模型挑一条命令：屏上顺序要与那句话对得上事实
 * @description 走**真 `ask()`** + 假 fetch（两个拨号点按 URL 分流），断的是屏面顺序而不是返回值。
 * ⚠️ 共用的不变量见 `AGENTS.md`。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { mount, stripAnsi, typed } from "./_shared.js";
import { writeLedger, writeProvider } from "@/services/config/index.js";

/** 两个控制面 + 一个配好的 provider（⚠️ `/batch all` 要 N ≥ 2 才验得出「N 份结果」与那一句汇总） */
function chatLedger(): string {
  const file = join(mkdtempSync(join(tmpdir(), "swain-tui-input-")), "tui.db");
  writeLedger(file, {
    version: 1,
    selected: "prod",
    targets: [
      { id: "prod", name: "prod", baseUrl: "http://127.0.0.1:1", token: "t0ken", timeoutMs: 200 },
      { id: "stage", name: "stage", baseUrl: "http://127.0.0.1:2", token: "t0ken", timeoutMs: 200 },
    ],
  });
  writeProvider(file, { baseUrl: "https://provider.invalid/v1", model: "m", apiKey: "sk-x" });
  return file;
}

/** 六份名单全空的一份 acl 响应体（三组 × 白/黑 ⇒ `aclRows` 落成一句「六份名单都是空的」） */
const EMPTY_ACL = {
  acl: {
    clientIp: { whitelist: [], blacklist: [] },
    target: { whitelist: [], blacklist: [] },
    upstream: { whitelist: [], blacklist: [] },
  },
};

/**
 * 模型那一头假答一条 `/batch`，控制面那一头假答一份空 acl
 * @description ⚠️ **按 URL 分流**而不是「第一个请求给模型」：本包有**两个**拨号点，而探活也在发请求
 * （`clientFor` 造客户端那一档），故「按次数猜」在探活先跑时会整个错位。
 */
function stubTwoDialPoints(): () => void {
  const stub = vi.fn(async (input: unknown) => {
    const url = String(input);
    const body = url.includes("/chat/completions")
      ? { choices: [{ message: { content: "/batch all /acl" } }] }
      : EMPTY_ACL;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  vi.stubGlobal("fetch", stub);
  return (): void => {
    vi.unstubAllGlobals();
  };
}

describe("一句聊天消息 → 模型挑 `/batch`：屏上顺序与那一句话对得上事实", () => {
  it("⚠️ 用户消息 → **助手那一句** → N 份结果 + 汇总（那一句说「下面」，而结果真的在下面）", async () => {
    const restore = stubTwoDialPoints();
    try {
      const ui = await mount({ interactive: false, ledgerFile: chatLedger() });
      await ui.feed([...typed("把名单发给所有控制面"), "\r"]);
      // ⚠️ 这一圈要**往返 + 扇出**（fetch → exec → applyEffect → fanOut → push），而 `feed` 的等待量按一个键算
      await new Promise((resolve) => setTimeout(resolve, 500));
      const output = stripAnsi(await ui.finish());

      /** 屏上那一句话的位置（⚠️ 找不到就直接红并报出缺哪一句 —— 顺序断言在缺件时会给出假绿） */
      const at = (needle: string): number => {
        const where = output.indexOf(needle);
        expect(where, `屏上没有「${needle}」`).toBeGreaterThanOrEqual(0);
        return where;
      };
      const marks = [
        at("❯ 把名单发给所有控制面"),
        at("在下面几行"),
        at("prod · /acl"),
        at("stage · /acl"),
        at("2 台全部成功"),
      ];
      // ⚠️ **逐段递增**才是判据：只断言「四句都在」的话，顺序整个反过来也照样绿
      expect(marks).toEqual([...marks].sort((a, b) => a - b));
      // ⚠️ 而**助手那一行本身**不许转述对面返回的数据（对面这一档给的是「六份名单都是空的」；
      // 那一行里它一个字都不许有 —— 而它作为 N 份结果**逐台**出现在下面是对的）
      const assistantLine = output.split("\n").find((one) => one.includes("在下面几行")) ?? "";
      expect(assistantLine).not.toContain("六份名单");
      // ⚠️ **正向对照**：那份数据确实在屏上（否则上面那条是「对面根本没答上」造成的假绿）
      expect(output).toContain("六份名单都是空的");
    } finally {
      restore();
    }
  });
});
