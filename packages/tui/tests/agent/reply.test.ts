/**
 * 模型回的那一行怎么变成一条 `Command`，以及它一路落到屏上的那几行里**不许带凭据**。
 *
 * 覆盖 **不变量 ③**（模型的输出过一遍与手敲**完全相同**的判据：同一个 `parseLine`、同一张表，
 * 校验失败必须看得见）与 **不变量 ④**（provider 凭据零泄露：屏上 / 文案 / 快照三处各有一道牙）。
 *
 * 共享的不变量（①–④ 与「为什么不用真 `http.Server` 收模型那一头」）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/agent
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseLine } from "@/commands/index.js";
import { MAX_ROUNDS, ask } from "@/lib/agent.js";
import { exec, echoOf } from "@/lib/exec/index.js";
import { maskEcho, rowsOfTurn } from "@/lib/log/index.js";
import { ModelError, commandOfReply } from "@/services/model.js";
import { readProvider, redactProvider, writeProvider } from "@/services/config/index.js";
import { bareDeps, SECRET_KEY } from "./_shared.js";

/* ── ③ 模型输出逐字段校验 ──────────────────────────────────────────────── */

describe("不变量 ③：模型的输出**过一遍与手敲完全相同的判据**", () => {
  it("一条正常命令 → 与 `parseLine` **同形**（逐字可比）", () => {
    const fromModel = commandOfReply("/user add alice 1g");
    const fromHand = parseLine("/user add alice 1g");
    expect(fromHand.kind).toBe("ok");
    if (fromHand.kind !== "ok") throw new Error("解析失败");
    expect(fromModel).toEqual(fromHand.command);
  });

  it("⚠️ **不认识的命令被拒**（不是「当作闲聊」）", () => {
    expect(() => commandOfReply("/nope")).toThrow(ModelError);
  });

  it("⚠️ **形参个数不对被拒**（`parseLine` 的元数判据，不是我们自己重写的）", () => {
    expect(() => commandOfReply("/user add")).toThrow(ModelError);
    expect(() => commandOfReply("/user add a b c")).toThrow(ModelError);
  });

  it("⚠️ **形参的值域不对被拒**（`1.5x` 在 `readTraffic` 那里就拒了）", () => {
    expect(() => commandOfReply("/user add alice 1.5x")).toThrow(ModelError);
    expect(() => commandOfReply("/user set alice nosuchfield off")).toThrow(ModelError);
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
    expect(commandOfReply("好的，我先看看。\n/users\n请过目。")).toEqual(
      parseLine("/users").kind === "ok" ? { kind: "users" } : {},
    );
  });

  it("⚠️ 校验失败**看得见**（`ask` 把失败做成 `failed` 那一档，而不是「没有挑出命令」）", async () => {
    // ⚠️ 反向自检：空台账 ⇒ **一个请求都不发**，而那句话**仍然进桶**
    const result = await ask("删掉 alice", [], {
      endpoint: null,
      timeoutMs: 10,
      execDeps: bareDeps(),
    });
    expect(result.kind).toBe("no-provider");
    expect(result.turns[0]).toEqual({ kind: "user", text: "删掉 alice" });
    if (result.kind === "ok") throw new Error("档位不对");
    expect(rowsOfTurn({ kind: "notice", rows: result.rows }).length).toBeGreaterThan(0);
  });

  it("⚠️ **轮数有上限**：一个永远回命令的 provider 恰好往返 {@link MAX_ROUNDS} 次就停", async () => {
    // ⚠️ 判据是 **`ask` 的行为**而不是源码文本：一个恒回命令的 provider 喂进去，
    // 数它**恰好被请求了几次**，而上限那一档必须自己说出来（否则屏上只有命令的结果）
    const run = await askWithProviderAlwaysAnswering("/users");
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
      endpoint: { baseUrl: "https://provider.invalid/v1", model: "m", apiKey: "sk-x" },
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

/* ── ④ key 零泄露 ─────────────────────────────────────────────────────── */

describe("不变量 ④：provider 凭据零泄露（屏上 / 文案 / 快照三处）", () => {
  /** 一份真库（走真的 `writeProvider` / `readProvider`） */
  function realDb(): string {
    const file = join(mkdtempSync(join(tmpdir(), "swain-tui-key-")), "tui.db");
    writeProvider(file, { baseUrl: "https://api.example.com/v1", model: "m", apiKey: SECRET_KEY });
    return file;
  }

  it("**屏上那一处**恒是掩码（`redactProvider` 是唯一出口）", () => {
    const masked = redactProvider(readProvider(realDb()));
    expect(masked.apiKey).not.toBe(SECRET_KEY);
    expect(masked.apiKey).toBe("••••");
  });

  it("⚠️ **回显那一处**恒是掩码（`echoOf` 重建那一行，而不是就地替换）", () => {
    const parsed = parseLine(`/provider set https://api.example.com/v1 m ${SECRET_KEY}`);
    if (parsed.kind !== "ok") throw new Error("解析失败");
    const echo = echoOf(parsed.command, `/provider set https://api.example.com/v1 m ${SECRET_KEY}`);
    expect(echo.kind).toBe("echo");
    if (echo.kind !== "echo") throw new Error("回显不是 echo 那一档");
    expect(echo.text).not.toContain(SECRET_KEY);
    expect(echo.text).toContain(maskEcho("provider-key", SECRET_KEY));
    // ⚠️ 而**地址与模型名原样留着**（重建而不是抹平：抹平了回显说的就不是用户敲的那条命令）
    expect(echo.text).toContain("https://api.example.com/v1");
    expect(echo.text).toContain(" m ");
  });

  it("⚠️ **两个长度差很多的凭据给出同一个掩码**（长度本身也是信息）", () => {
    expect(maskEcho("provider-key", "a")).toBe(maskEcho("provider-key", SECRET_KEY));
    expect(maskEcho("provider-key", "")).toBe("");
  });

  it("**文案那一处**：`/provider show` 的输出里没有真凭据", async () => {
    const file = realDb();
    const result = await exec(
      { kind: "provider-show" },
      { ...bareDeps(), provider: () => redactProvider(readProvider(file)) },
    );
    expect(JSON.stringify(result.rows)).not.toContain(SECRET_KEY);
    expect(result.rows.some((row) => row.kind === "kv" && row.key === "凭据")).toBe(true);
  });

  it("⚠️ **屏上那一处走的是那条路**（`depsFor.provider` 恒先过打码）", () => {
    // ⚠️ 锚点是**今天仍存在的形状**：`redactProvider` 在 AppState 的 `provider` 那一格里被调了一次
    const app = readFileSync(join(__dirname, "..", "..", "src", "AppState.tsx"), "utf8");
    expect(app).toContain("provider: () => redactProvider(providerRef.current)");
    // ⚠️ **反向自检**：那一份**真**凭据确实存在（否则上面那条是「根本没有凭据」的假绿）
    expect(app).toContain("modelEndpointOf(providerRef.current)");
  });
});
