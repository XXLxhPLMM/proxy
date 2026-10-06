/**
 * 没有控制面那一档：`target === null` 时一个请求都不发、也不给副作用（不变量 ⑩）
 *
 * @description
 * 仪器是**传输适配器**而不是某个按路径登记应答的替身 —— `target === null` 时压根没有请求参数可递，
 * 判一个没接上的替身恒为零，那是一条**恒绿**的护栏；而传输适配器是任何拨号路线的必经之处
 * （哪怕某个实现 fallback 到一组硬写的参数去连 `0.0.0.0:0`）。本档自带「仪器自检」证明同一个计数器
 * 在真发出去时确实会动。
 *
 * ⚠️ 端点函数**自己 axios**（不再经某个 `ManagerHttp` 对象），故仪器就是 `axios.defaults.adapter`
 * ——**全包唯一的传输缝**。这也让本档比旧形态少一副担子：过去「替身计数器」与「传输计数器」是**两个**
 * 全局（一个挂在注入的 `request()` 上、一个挂在 adapter 上），而它们各自能单独坏；今天它们是**同一格**。
 *
 * 共享的不变量（语义规则与各自的变异、替身纪律、拆档纪律）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/exec
 */

import { afterEach, describe, expect, it } from "vitest";
import axios from "axios";
import { exec } from "@/lib/exec/run.js";
import type { Command } from "@/commands/index.js";
import { commandOf, deps, errsOf } from "./_shared.js";

/**
 * 传输**适配器**的计数器（守 ⑩ 的仪器）
 * @description 换的是 `axios.defaults.adapter`，不是全局 `fetch` —— 拨号走 axios，而 axios 的 Node adapter
 * 走 `http` 模块，**不经 `fetch`**（换 `fetch` 的仪器恒为零）。
 * ⚠️ **必须原样还回 `original` 而不是 `delete`**：`axios.defaults.adapter` 的缺省值是
 * `["xhr","http","fetch"]` 那个**数组**，删掉它会让下一个请求抛 `Unknown adapter 'undefined'`。
 */
function transportSpy(): { readonly calls: string[]; readonly restore: () => void } {
  const calls: string[] = [];
  const original = axios.defaults.adapter;
  axios.defaults.adapter = (config) => {
    calls.push(`${String(config.method).toUpperCase()} ${String(config.url)}`);
    return Promise.reject(
      Object.assign(new Error("本档不发真的请求"), { code: "ECONNREFUSED" }),
    );
  };
  return { calls, restore: (): void => { axios.defaults.adapter = original; } };
}

/** 本档每个用例自己装、自己拆（⚠️ 漏了 `restore` 的症状是**下一个档**莫名其妙地收不到请求） */
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/* ── ⑩ 没有控制面时一个请求都不发 ─────────────────────────────────────────── */

describe("不变量 ⑩：target === null 时不发请求、也不给副作用", () => {
  const NEEDS_TARGET: readonly Command[] = [
    commandOf("status"),
    commandOf("config"),
    commandOf("usage"),
    commandOf("acl"),
    commandOf("accounts"),
    commandOf("r"),
  ];

  it("逐条命令：一个请求都不发、effects 为空、只有一句「先选控制面」", async () => {
    // ⚠️ 计数器是**传输适配器**：`target === null` 时压根没有请求参数可递，判一个没接上的
    // 替身恒为零 —— 那是一条恒绿的护栏。而传输适配器是**任何**拨号路线的必经之处
    // （哪怕某个实现 fallback 到一组硬写的参数），所以它是这一条唯一咬得住的仪器。
    const spy = transportSpy();
    restore = spy.restore;
    for (const command of NEEDS_TARGET) {
      const result = await exec(command, deps({ line: "/status" }));
      expect(spy.calls).toEqual([]);
      expect(result.effects).toEqual([]);
      expect(errsOf(result)).toHaveLength(1);
      expect(errsOf(result)[0]).toContain("先在左边选一个控制面");
    }
  });

  it("判据自检：同一个计数器在「有控制面」时确实会动（否则上一条是恒绿）", async () => {
    const spy = transportSpy();
    restore = spy.restore;
    // ⚠️ 一个**真的**地址 + **真的**适配器：这一条要证明的是「请求确实出了门」，
    // 所以不能拿一个按路径登记应答的替身顶替 —— 那会证明的是「替身被调过」。
    const result = await exec(
      commandOf("status"),
      deps({ target: { baseUrl: "http://127.0.0.1:3010", token: "tok", timeoutMs: 1000 } }),
    );

    expect(spy.calls).toEqual(["GET /api/status"]);
    // 传输层被拒 → 失败被翻译成一句判据（这一条顺带证明「请求真的出了门」）
    expect(errsOf(result).length).toBe(1);
  });

  it("对照组：本地命令（help / clear / new / 弹窗那一族）不靠控制面，照样能用", async () => {
    const help = await exec(commandOf("help"), deps({ target: null }, "/help"));
    expect(errsOf(help)).toEqual([]);
    expect(help.rows.some((row) => row.kind === "table")).toBe(true);

    const cleared = await exec(commandOf("clear"), deps({ target: null }, "/clear"));
    expect(cleared.effects).toEqual([{ kind: "clear-log" }]);

    // ⚠️ `/new` 与弹窗那一族是**界面状态**上的动作：一个请求都不发（`target: null`
    // 下它们照样给出结果），而它们各自说出一个 `Effect` 让上层去改会话 / 开窗口
    const created = await exec(commandOf("new"), deps({ target: null }, "/new"));
    expect(errsOf(created)).toEqual([]);
    expect(created.effects).toEqual([{ kind: "session-new" }]);
    const targets = await exec(commandOf("targets"), deps({ target: null }, "/targets"));
    expect(errsOf(targets)).toEqual([]);
    expect(targets.effects).toEqual([{ kind: "targets-open" }]);
    // ⚠️ 两条都**一个字节都不留**（判据只有一份，在 `./echo.ts:leavesTrace`）：留着的那一行会落进
    // **`/new` 被敲的那个会话**，而用户早就切走了。
    // ⚠️ 正向对照就在上面几行：同一个 `target: null` 下 `/help` 照样给出一张表，故「空」是判据，
    // 而不是因为 `exec` 这一趟整体没跑出东西（那会让这一档通篇绿）。
    expect(created.rows).toEqual([]);
    expect(targets.rows).toEqual([]);
  });

  it("⚠️ `/accounts` **一个请求都不发**（它读的是注入进来的那一份，而清单归哪台由上面那一格答）", async () => {
    // ⚠️ 判据是**传输适配器**：一个「顺手改成 `users(target)`」的实现会在这里被逮住，
    // 而症状是「敲一条纯读命令先卡一下」（而它一个请求都不该发 —— 弹窗已经读过一遍了）
    const spy = transportSpy();
    restore = spy.restore;
    const result = await exec(
      commandOf("accounts"),
      deps({ target: { baseUrl: "http://127.0.0.1:3010", token: "tok", timeoutMs: 1000 }, accounts: () => ({ accounts: [] }) }, "/accounts"),
    );
    expect(spy.calls).toEqual([]);
    // ⚠️ 而它**照样出行**：空集出文案而不是一张空表（判据在 `./rows.js:userRows`）
    expect(errsOf(result)).toEqual([]);
    expect(result.rows.some((row) => row.kind === "note")).toBe(true);
  });
});
