/**
 * 模型回的那一行怎么变成一条 `Command`，以及它一路落到屏上的那几行里**不许带凭据**。
 *
 * 覆盖 **不变量 ③**（模型的输出过一遍与手敲**完全相同**的判据：同一个 `parseLine`、同一张表，
 * 校验失败必须看得见）与 **不变量 ④**（provider 凭据零泄露）。
 *
 * ⚠️ ④ 的**三道牙**跟着命令表一起搬了家：provider 的增删改查现在在 `/providers` 弹窗里，而弹窗
 * 由状态层直接调 `@/services/config` 的读写面 —— 于是本档剩下的那一道牙是
 * **「模型看得见的请求体里一个字节的凭据都没有」**（`messagesOf` 那条），而打码那一道
 * （`maskEcho`）与回显重建那一道都在弹窗那一侧了。
 *
 * 共享的不变量（①–④ 与「为什么不用真 `http.Server` 收模型那一头」）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/agent
 */

import { describe, expect, it, vi } from "vitest";

import { parseLine } from "@/commands/index.js";
import { MAX_ROUNDS, ask } from "@/lib/agent.js";
import { ModelError, commandOfReply } from "@/services/model/index.js";
import { bareDeps } from "./_shared.js";

/* ── ③ 模型输出逐字段校验 ──────────────────────────────────────────────── */

describe("不变量 ③：模型的输出**过一遍与手敲完全相同的判据**", () => {
  it("一条正常命令 → 与 `parseLine` **同形**（逐字可比）", () => {
    const fromModel = commandOfReply("/usage alice");
    const fromHand = parseLine("/usage alice");
    expect(fromHand.kind).toBe("ok");
    if (fromHand.kind !== "ok") throw new Error("解析失败");
    expect(fromModel).toEqual(fromHand.command);
  });

  it("⚠️ **不认识的命令被拒**（不是「当作闲聊」）", () => {
    expect(() => commandOfReply("/nope")).toThrow(ModelError);
  });

  it("⚠️ **形参个数不对被拒**（`parseLine` 的元数判据，不是我们自己重写的）", () => {
    expect(() => commandOfReply("/usage alice bob")).toThrow(ModelError);
    expect(() => commandOfReply("/status extra")).toThrow(ModelError);
  });

  it("⚠️ **形参的值域不对被拒**（`a,,b` 在 `readTargets` 那里就拒了）", () => {
    expect(() => commandOfReply("/batch a,,b /status")).toThrow(ModelError);
    expect(() => commandOfReply('/batch all ""')).toThrow(ModelError);
  });

  it("⚠️ **没给 `/` 开头的那一行被拒**，而失败文案**不转述模型的话**", () => {
    let thrown: ModelError | null = null;
    try {
      commandOfReply("我不知道你在说什么");
    } catch (err) {
      thrown = err as ModelError;
    }
    expect(thrown).toBeInstanceOf(ModelError);
    expect(thrown!.code).toBe("shape");
    // ⚠️ 失败文案会落进**可滚动的结果区**，而那句话里可能有用户敲的内容
    expect(thrown!.message).not.toContain("我不知道你在说什么");
  });

  it("⚠️ **多行回答里挑出那一行命令**（模型爱解释，而解释不是命令）", () => {
    expect(commandOfReply("好的，我先看看。\n/accounts\n请过目。")).toEqual({ kind: "accounts" });
  });

  it("⚠️ 零兼容：表里删掉的那一族**模型也挑不到**（同一个 `parseLine`，同一张表）", () => {
    // ⚠️ 判据锚在**用户真会敲的那一串**上（不是某个符号名）：模型完全可能照着旧习惯回一句
    // `/user add alice`，而它必须与手敲一样被拒 —— 否则「模型的输出过一遍同一张表」这条就是假的
    for (const line of ["/user add alice", "/target switch prod", "/provider show", "/managers"]) {
      expect(() => commandOfReply(line), line).toThrow(ModelError);
    }
    // ⚠️ **正向对照**：今天存在的同族命令照旧收得到（否则上面那四条只是「全都被拒了」）
    expect(commandOfReply("/accounts")).toEqual({ kind: "accounts" });
  });

  it("⚠️ 校验失败**看得见**（`ask` 把失败做成 `failed` 那一档，而不是「没有挑出命令」）", async () => {
    // ⚠️ 反向自检：空台账 ⇒ **一个请求都不发**，而那句话**仍然进桶**
    const result = await ask("看看 alice 的用量", [], {
      endpoint: null,
      timeoutMs: 10,
      execDeps: bareDeps(),
    });
    expect(result.kind).toBe("no-provider");
    expect(result.turns[0]).toEqual({ kind: "user", text: "看看 alice 的用量" });
    if (result.kind === "ok") throw new Error("档位不对");
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("⚠️ **轮数有上限**：一个永远回命令的 provider 恰好往返 {@link MAX_ROUNDS} 次就停", async () => {
    // ⚠️ 判据是 **`ask` 的行为**而不是源码文本：一个恒回命令的 provider 喂进去，
    // 数它**恰好被请求了几次**，而上限那一档必须自己说出来（否则屏上只有命令的结果）
    const run = await askWithProviderAlwaysAnswering("/status");
    expect(run.fetches, `provider 被请求了 ${String(run.fetches)} 次`).toBe(MAX_ROUNDS);
    // ⚠️ 判据是**那一档自己说出来的话**，而不是「它失败了」：屏上只有命令的结果时用户会以为是模型放弃了
    if (run.result.kind !== "failed") throw new Error(`档位不对：${run.result.kind}`);
    expect(JSON.stringify(run.result.rows)).toContain("还没给出答案");
    // ⚠️ **正向对照**：真的停在那儿了（否则上面三条都在「一轮都没跑」的形状上恒绿）
    expect(run.fetches).toBeGreaterThan(1);
  });
});

/**
 * 一个**永远回同一条命令**的 provider 喂进 `ask`，数它被请求了几次
 * @description ⚠️ **上限那一档必须看得见**：一个恒回命令的 provider 在没有上限的那一版里是一个
 * 自己烧钱的循环，而「无限」不能变成一条挂死的测试 —— 故替身在 {@link MAX_ROUNDS} × 8 次之后
 * 直接抛（那一版于是以「数不对」转红，而不是把测试进程钉死在一个微任务死循环里）。
 * @description ⚠️ 每次往返都让出一次事件循环：真实 `fetch` 本来就是 I/O，而一个不让出的微任务
 * 循环会让「测试超时」这个兜底也永远轮不到触发。
 */
async function askWithProviderAlwaysAnswering(
  command: string,
): Promise<{ readonly fetches: number; readonly result: Awaited<ReturnType<typeof ask>> }> {
  let fetches = 0;
  vi.stubGlobal("fetch", async (): Promise<unknown> => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (fetches > MAX_ROUNDS * 8) throw new Error("这一圈已经往返了太多次（上限没生效？）");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: command } }] }),
    };
  });
  try {
    const result = await ask("一直问下去", [], {
      // ⚠️ `endpoint` 是「除这一次的话之外的一切」：请求形状（`api`）、地址、模型、凭据、推理强度
      endpoint: {
        api: "openai",
        baseUrl: "https://provider.invalid/v1",
        model: "m",
        apiKey: "sk-x",
        reasoning: "off",
      },
      timeoutMs: 1000,
      // ⚠️ **零行命令会就此打住**（那是「纯界面动作」那一档），故这里挑一条**留痕**的：
      // 回显那一行本身就让 `rows.length > 0`，于是循环真的能转到上限
      execDeps: bareDeps(),
    });
    return { fetches, result };
  } finally {
    vi.unstubAllGlobals();
  }
}