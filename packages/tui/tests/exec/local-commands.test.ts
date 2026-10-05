/**
 * 本地命令档：一个请求都不发的那几条命令，与回显那一行
 *
 * @description
 * `help` / `clear` / `r` / `new` / `targets` / `users` / `providers` / `models` / `sessions` 不靠客户端
 * 照样能用；**留痕的**那些第一行一定是回显（判据锚在 `rows[0]`），而那一族**纯界面动作**
 * **一个字都不留**、各自的 `Effect` 一个字未改 —— 那条不变式分两半守，两半各自做过变异，
 * 且**负向那一半带正向对照**（同一份 `deps` 下 `/help` 照样留痕）。
 * 末尾一条是回显的另一半：用户敲的那一行**逐字**上屏。
 *
 * 共享的不变量（语义规则与各自的变异、替身纪律、拆档纪律）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/exec
 */

import { describe, expect, it } from "vitest";
import { exec, type Effect } from "@/lib/exec/run.js";
import { COMMAND_PREFIX } from "@/commands/index.js";
import { commandOf, deps, errsOf, fakeClient, kvOf, tableOf } from "./_shared.js";
/* ── 本地命令：help / clear / r / 弹窗那一族 ─────────────────────────────── */

describe("本地命令：一个请求都不发", () => {
  it("`clear` 的**回显**加上紧随其后的清屏（屏上因此什么也不留）", async () => {
    // ⚠️ 「不留任何行」这条断言曾经写的是 `rows` 为空 —— 而它**漏掉**了「还没选中控制面」那一支，
    // 于是那条命令跑过了、结果区却没有「你刚才跑了什么」那一行，症状像「那条命令没跑过」。
    // 故判据改成「回显**有**、而紧随其后的 `clear-log` 会把它清掉」：两件事都要在。
    const result = await exec(commandOf("clear"), deps({ client: null }, "/clear"));

    expect(result.rows).toEqual([{ kind: "echo", text: "/clear" }]);
    expect(result.effects).toEqual([{ kind: "clear-log" }]);
  });

  it("⚠️ **留痕的**那些命令第一行一定是回显（判据锚在 `rows[0]`）", async () => {
    // 这条护的是「回显只由 {@link exec} 的外层加一次」那条不变式：把哪一个分支漏掉，
    // 这里就红 —— 而漏掉的现象是屏上少一行，看起来像「那条命令没跑过」。
    // ⚠️ 样本是**显式列出来的**，不是遍历命令表：`./echo.ts:leavesTrace` 那张表已经答了「哪一条不留痕」，
    // 若这里也由表驱动着断言自己，它就只是在给自己的实现发绿牌。
    const samples: readonly string[] = ["status", "help", "clear", "r", "acl", "config", "usage"];
    for (const line of samples) {
      // ⚠️ `line` **必须**喂进 `deps`：回显读的是 `deps.line`（界面层原样递过来的那一行），
      // 而缺省那一份是 `/status` —— 于是本档会对每一条命令都看到 `/status` 的回显而全绿。
      const result = await exec(commandOf(line), deps({ client: null }, COMMAND_PREFIX + line));
      expect(result.rows[0]).toEqual({ kind: "echo", text: COMMAND_PREFIX + line });
    }
  });

  it("⚠️ `/new` 与弹窗那一族**一个字都不留**，而各自的副作用一个字都没变", async () => {
    // 判据是 `./echo.ts:leavesTrace` 说的那几档：它们的效果（侧边栏那一项加粗选中 / 弹窗自带说明）
    // 屏幕上已经说得清，结果区里每一行都只是第二遍。⚠️ 而副作用**必须**同时断言：删掉 `Effect`
    // 会让这条命令变成「什么都不发生」，而一个什么都不发生的 `/new` 比留一行更坏（它连会话都不建）。
    const created = await exec(commandOf("new"), deps({ client: null }, "/new"));
    const sessions = await exec(commandOf("sessions"), deps({ client: null }, "/sessions"));
    const targets = await exec(commandOf("targets"), deps({ client: null }, "/targets"));
    const users = await exec(commandOf("users"), deps({ client: null }, "/users"));
    const providers = await exec(commandOf("providers"), deps({ client: null }, "/providers"));
    const models = await exec(commandOf("models"), deps({ client: null }, "/models"));

    for (const result of [created, sessions, targets, users, providers, models]) {
      expect(result.rows).toEqual([]);
    }
    expect(created.effects).toEqual([{ kind: "session-new" }]);
    expect(sessions.effects).toEqual([{ kind: "open-sessions" } satisfies Effect]);
    expect(targets.effects).toEqual([{ kind: "targets-open" } satisfies Effect]);
    expect(users.effects).toEqual([{ kind: "users-open" } satisfies Effect]);
    expect(providers.effects).toEqual([{ kind: "providers-open" } satisfies Effect]);
    expect(models.effects).toEqual([{ kind: "models-open" } satisfies Effect]);
    // ⚠️ **正向对照**：同一份 `deps` 下 `/help` 照样留痕 —— 否则上面那几条「空」分不清是判据成立
    // 还是 `exec` 这一趟整体没跑出东西（那会通篇绿）
    const help = await exec(commandOf("help"), deps({ client: null }, "/help"));
    expect(help.rows[0]).toEqual({ kind: "echo", text: "/help" });
  });

  it("⚠️ 弹窗那一族**一个请求都不发**（`client === null` 时它们照样给出那个 `Effect`）", async () => {
    // ⚠️ 判据是**注入的客户端那个计数器**：把它排到「需要控制面」那一支的话，这里会看到一次调用，
    // 而症状是「敲一条弹窗命令先卡一下再弹窗」。而它们的清单由上层递进来（`deps.accounts` /
    // `deps.targetsView`），执行层自己一个字节都不读台账。
    const { client, calls } = fakeClient({});
    for (const [line, effect] of [
      ["targets", "targets-open"],
      ["users", "users-open"],
      ["providers", "providers-open"],
      ["models", "models-open"],
      ["sessions", "open-sessions"],
    ] as const) {
      const result = await exec(commandOf(line), deps({ client }, `/${line}`));
      expect(calls, line).toEqual([]);
      expect(result.effects, line).toEqual([{ kind: effect } satisfies Effect]);
      expect(result.rows, line).toEqual([]);
    }
  });

  it("⚠️ `/exit` 与 `/quit`：零行、零请求，只交出**一个**副作用", async () => {
    // ⚠️ 判据是**注入的客户端计数器**：退出一个请求都不许发（而它连控制面都不需要）
    const { client, calls } = fakeClient({});
    const exited = await exec(commandOf("exit"), deps({ client }, "/exit"));
    const quit = await exec(commandOf("quit"), deps({ client }, "/quit"));
    // ⚠️ **零行**：`/exit` 与 `/new` / 弹窗那一族同族（`leavesTrace` 说它们不留痕）——
    // 而「它退了」由终端回到提示符那一件事自己回答
    expect(exited.rows).toEqual([]);
    expect(quit.rows).toEqual([]);
    // ⚠️ **两个名字交出同一个副作用**：退出只有一条实现，故「加一个别名要改几处」恒等于 1
    expect(exited.effects).toEqual([{ kind: "request-exit" } satisfies Effect]);
    expect(quit.effects).toEqual(exited.effects);
    expect(calls).toEqual([]);
  });

  it("`r` 只给副作用", async () => {
    const { client, calls } = fakeClient({});
    const result = await exec(commandOf("r"), deps({ client, line: "/r" }));

    expect(calls).toEqual([]);
    expect(result.effects).toEqual([{ kind: "reprobe" } satisfies Effect]);
  });

  it("`help` 列出命令表（每一行都来自那份表，一行不多一行不少）", async () => {
    const result = await exec(commandOf("help"), deps({ client: null }, "/help"));
    const table = tableOf(result);

    expect(table.rows.length).toBeGreaterThan(10);
    const names = table.rows.map((row) => row[0]?.trim() ?? "");
    // ⚠️ **带前缀**：这一列印的就是操作者回车时该敲的那一串（`CommandSpec.path`），
    // 而 `parseLine` 收带前缀的那一串 —— 印不带前缀的表等于给出一份抄不回去的清单。
    expect(names).toContain("/accounts");
    expect(names).toContain("/users");
    expect(names).toContain("/targets");
    expect(names).toContain("/providers");
    expect(names).toContain("/models");
    // ⚠️ **两个退出的名字都必须印出来**：它是本包唯一的门，而 `/help` 是屏上唯一那份清单 ——
    // 门不在清单上，操作者就永远不知道怎么出去
    expect(names).toContain("/exit");
    expect(names).toContain("/quit");
    expect(names.some((one) => !one.startsWith("/"))).toBe(false);
  });

  it("`help <命令名>` 给用法与形参；不认识的名字给一句判据", async () => {
    const one = await exec(commandOf("help usage"), deps({ client: null }, "/help usage"));
    expect(kvOf(one, "用法")).toBe("/usage [用户名]");
    expect(kvOf(one, "说明")).toContain("用量");
    expect(kvOf(one, "形参 用户名")).toBe("选填");

    const two = await exec(commandOf("help nope"), deps({ client: null }, "/help nope"));
    expect(errsOf(two)).toHaveLength(1);
    expect(errsOf(two)[0]).toContain("nope");
  });

  it("⚠️ 弹窗那一族的**键位说明**逐条上屏（那是屏上唯一一份键位说明）", async () => {
    // ⚠️ 判据落在**命令表那一句**上（`rows` 与 `summary` 逐字来自 `@/commands`），
    // 而补全与面板都不许另抄一份 —— 少一个键的话操作者在弹窗里按了它而什么都没有发生
    const keys = ["↑↓", "Enter", "Ctrl+A", "Ctrl+D", "Ctrl+E", "Esc"];
    for (const line of ["targets", "users", "providers"]) {
      const result = await exec(commandOf(`help ${line}`), deps({ client: null }, "/help"));
      expect(kvOf(result, "说明"), line).toBeDefined();
      for (const key of keys) {
        expect(kvOf(result, "说明") ?? "", `${line} 少了 ${key}`).toContain(key);
      }
    }
  });
});

/* ── 回显 ────────────────────────────────────────────────────────────────── */

describe("回显：用户敲的那一行（凭据已掩码）", () => {
  it("无凭据的命令逐字回显原文", async () => {
    const { client } = fakeClient({ status: async () => ({ throw: new Error("没安排") }) as never });
    const result = await exec(commandOf("status"), deps({ client }, "  status  "));

    const echo = result.rows[0];
    expect(echo?.kind === "echo" ? echo.text : "").toBe("  status  ");
  });
});