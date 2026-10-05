/**
 * 没有控制面那一档：`client === null` 时一个请求都不发、也不给副作用（不变量 ⑩）
 *
 * @description
 * 仪器是**全局 `fetch`** 而不是那个客户端替身 —— `client === null` 时压根没有对象可调，判一个没接上的
 * 替身恒为零，那是一条**恒绿**的护栏；而 `fetch` 是任何拨号路线的必经之处（哪怕某个实现 fallback 到一个
 * 自造的默认客户端去连 `0.0.0.0:0`）。本档自带「仪器自检」证明同一个计数器在真发出去时确实会动。
 *
 * 共享的不变量（语义规则与各自的变异、替身纪律、拆档纪律）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/exec
 */

import { describe, expect, it } from "vitest";
import { exec } from "@/lib/exec/run.js";
import type { Command } from "@/commands/index.js";
import { commandOf, deps, errsOf, fakeClient, statusBody } from "./_shared.js";

/**
 * 全局 `fetch` 的计数器（守 ⑩ 的仪器）
 * @description
 * 为什么不判「客户端替身一次都没被调过」：守 ⑩ 的场合 `deps.client` **就是 `null`**，压根没有对象
 * 可调 —— 判一个没接上的替身恒为零，那是一条**恒绿**的护栏。而 `fetch` 是任何拨号路线的必经之处
 * （哪怕某个实现 fallback 到一个自造的默认客户端去连 `0.0.0.0:0`），故它是唯一咬得住的仪器。
 * ⚠️ 因此本档另配一条「仪器自检」：同一个计数器在真发出去时**必须**会动。
 */
function fetchSpy(): { readonly calls: string[]; readonly restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    calls.push(String(input));
    return Promise.reject(new Error("本档不发真的请求"));
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/* ── ⑩ 没有客户端时一个请求都不发 ────────────────────────────────────────── */

describe("不变量 ⑩：client === null 时不发请求、也不给副作用", () => {
  const NEEDS_TARGET: readonly Command[] = [
    commandOf("status"),
    commandOf("config"),
    commandOf("usage"),
    commandOf("acl"),
    commandOf("accounts"),
    commandOf("r"),
  ];

  it("逐条命令：一个请求都不发、effects 为空、只有一句「先选控制面」", async () => {
    // ⚠️ 计数器是**全局 `fetch`** 而不是那个客户端替身：`client === null` 时压根没有对象可调，
    // 判一个没接上的替身恒为零 —— 那是一条恒绿的护栏。而 `fetch` 是**任何**拨号路线的必经之处
    // （哪怕某个实现 fallback 到一个自造的默认客户端），所以它是这一条唯一咬得住的仪器。
    const spy = fetchSpy();
    try {
      for (const command of NEEDS_TARGET) {
        const result = await exec(command, deps({ line: "/status" }));
        expect(spy.calls).toEqual([]);
        expect(result.effects).toEqual([]);
        expect(errsOf(result)).toHaveLength(1);
        expect(errsOf(result)[0]).toContain("先在左边选一个控制面");
      }
    } finally {
      spy.restore();
    }
  });

  it("判据自检：同一个计数器在「有客户端」时确实会动（否则上一条是恒绿）", async () => {
    const { client, calls } = fakeClient({ status: async () => statusBody() });
    const spy = fetchSpy();
    try {
      const result = await exec(commandOf("status"), deps({ client }));

      expect(calls).toEqual(["status"]);
      // ⚠️ 替身不碰 `fetch`（它就是替身），所以这一档能自检的是**替身计数器**；`fetch` 计数器
      // 的自检在下面那条「真发出去」里（那条走真的 `ManagerClient`）。
      expect(errsOf(result)).toEqual([]);
      expect(spy.calls).toEqual([]);
    } finally {
      spy.restore();
    }
  });

  it("真发出去时 `fetch` 计数器会动 —— 这是上一条那条 `fetch` 断言的仪器自检", async () => {
    const { ManagerClient } = await import("@/services/index.js");
    const spy = fetchSpy();
    try {
      const real = new ManagerClient({
        baseUrl: "http://127.0.0.1:3010",
        token: "tok",
        timeoutMs: 1000,
      });
      const result = await exec(commandOf("status"), deps({ client: real }));

      expect(spy.calls.length).toBeGreaterThan(0);
      // 替身回了 500 → 失败被翻译成一句判据（这一条顺带证明「请求真的出了门」）
      expect(errsOf(result).length).toBe(1);
    } finally {
      spy.restore();
    }
  });

  it("对照组：本地命令（help / clear / new / 弹窗那一族）不靠客户端，照样能用", async () => {
    const help = await exec(commandOf("help"), deps({ client: null }, "/help"));
    expect(errsOf(help)).toEqual([]);
    expect(help.rows.some((row) => row.kind === "table")).toBe(true);

    const cleared = await exec(commandOf("clear"), deps({ client: null }, "/clear"));
    expect(cleared.effects).toEqual([{ kind: "clear-log" }]);

    // ⚠️ `/new` 与弹窗那一族是**界面状态**上的动作：一个请求都不发（`client: null`
    // 下它们照样给出结果），而它们各自说出一个 `Effect` 让上层去改会话 / 开窗口
    const created = await exec(commandOf("new"), deps({ client: null }, "/new"));
    expect(errsOf(created)).toEqual([]);
    expect(created.effects).toEqual([{ kind: "session-new" }]);
    const targets = await exec(commandOf("targets"), deps({ client: null }, "/targets"));
    expect(errsOf(targets)).toEqual([]);
    expect(targets.effects).toEqual([{ kind: "targets-open" }]);
    // ⚠️ 两条都**一个字节都不留**（判据只有一份，在 `./echo.ts:leavesTrace`）：留着的那一行会落进
    // **`/new` 被敲的那个会话**，而用户早就切走了。
    // ⚠️ 正向对照就在上面几行：同一个 `client: null` 下 `/help` 照样给出一张表，故「空」是判据，
    // 而不是因为 `exec` 这一趟整体没跑出东西（那会让这一档通篇绿）。
    expect(created.rows).toEqual([]);
    expect(targets.rows).toEqual([]);
  });

  it("⚠️ `/accounts` **一个请求都不发**（它读的是注入进来的那一份，而清单归哪台由客户端答）", async () => {
    // ⚠️ 判据是**注入的客户端计数器**：一个「顺手改成 `client.users()`」的实现会在这里被逮住，
    // 而症状是「敲一条纯读命令先卡一下」（而它一个请求都不该发 —— 弹窗已经读过一遍了）
    const { client, calls } = fakeClient({ users: async () => ({ accounts: [] }) });
    const spy = fetchSpy();
    try {
      const result = await exec(
        commandOf("accounts"),
        deps({ client, accounts: () => ({ accounts: [] }) }, "/accounts"),
      );
      expect(calls).toEqual([]);
      expect(spy.calls).toEqual([]);
      // ⚠️ 而它**照样出行**：空集出文案而不是一张空表（判据在 `./rows.js:userRows`）
      expect(errsOf(result)).toEqual([]);
      expect(result.rows.some((row) => row.kind === "note")).toBe(true);
    } finally {
      spy.restore();
    }
  });
});