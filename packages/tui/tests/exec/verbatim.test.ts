/**
 * 逐字档：服务端给的那些字原样上屏（不变量 ①–⑤）
 *
 * @description
 * `changed: false` 是一次成功的 no-op 而非失败、`notice` 是必答项（`null` 时不许编一句出来）、
 * `effective` 只在真改了的时候非 null、`usage` 的三段限定逐字、cluster master 的 `running:false`
 * 是正常而不是异常 —— 五条都拿服务端给的**原串**去逐字比，且每条都配一个「相反形态」的对照组，
 * 证明它不是碰巧也不是恒真。
 *
 * 共享的不变量（十条语义规则与各自的变异、替身纪律、拆档纪律）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/exec
 */

import { describe, expect, it } from "vitest";
import { exec } from "@/lib/exec/run.js";
import {
  MESSAGE_CHANGED,
  RUNNING_MEANS,
  SIDE_EFFECT,
  USAGE_NOTE,
  commandOf,
  deps,
  errsOf,
  fakeClient,
  joined,
  kvOf,
  notesOf,
  statusBody,
  usageBody,
} from "./_shared.js";

const MESSAGE_UNCHANGED = "配额窗口已经是 day，没动";
const NOTICE_JWT = "AUTH_TYPE=jwt 下 disabled 不生效：这个键要改鉴权方式才有效";
const EFFECTIVE_YES = "最迟 1 秒后生效";
/* ── ① `changed: false` 是成功，不是失败 ──────────────────────────────────── */

describe("不变量 ①：changed: false 是一次成功的 no-op，不是失败", () => {
  it("rows 里没有一条 err（变异：changed:false 走 err 分支 → 这里红）", async () => {
    const { client, calls } = fakeClient({
      updateAccount: async () => ({ changed: false, message: MESSAGE_UNCHANGED, notice: null }),
    });
    const result = await exec(commandOf("user set alice quotaWindow day"), deps({ client }));

    expect(errsOf(result)).toEqual([]);
    expect(calls).toEqual(["updateAccount"]);
    // 「没动」是本层唯一那句本地判断，且它不许被覆盖成「已改」
    expect(kvOf(result, "写入")).toBe("没动");
    // 服务端那句「已经是 day」逐字上屏（它是「哪一条里已经有它」这种具体事实）
    expect(notesOf(result)).toContain(MESSAGE_UNCHANGED);
  });

  it("changed: true 时同一处说「已改」—— 对照组：证明上一组不是碰巧", async () => {
    const { client } = fakeClient({
      updateAccount: async () => ({ changed: true, message: MESSAGE_CHANGED }),
    });
    const result = await exec(commandOf("user set alice quotaWindow day"), deps({ client }));

    expect(errsOf(result)).toEqual([]);
    expect(kvOf(result, "写入")).toBe("已改");
  });
});

/* ── ② `notice` 必须上屏 ─────────────────────────────────────────────────── */

describe("不变量 ②：notice 是必答项，漏掉它就是一句骗人的「停了」", () => {
  it("逐字等于服务端那一句（变异：删掉 notice 那一行 → 这里红）", async () => {
    const { client } = fakeClient({
      updateAccount: async () => ({ changed: true, message: MESSAGE_CHANGED, notice: NOTICE_JWT }),
    });
    const result = await exec(commandOf("user off alice"), deps({ client }));

    expect(notesOf(result)).toContain(NOTICE_JWT);
    // ⚠️ 与「文案确实说了点别的」成对断言：单独一条 `toContain` 在 notes 为空时也会绿
    expect(notesOf(result).length).toBeGreaterThan(1);
  });

  it("`notice` 为 null 时不编一句出来（对照组：证明上一组不是恒真）", async () => {
    const { client } = fakeClient({
      updateAccount: async () => ({ changed: true, message: MESSAGE_CHANGED, notice: null }),
    });
    const result = await exec(commandOf("user off alice"), deps({ client }));

    expect(notesOf(result)).toEqual([MESSAGE_CHANGED]);
  });
});

/* ── ③ `changed: false` 时不显示 `effective` ─────────────────────────────── */

describe("不变量 ③：effective 只在 changed: true 时非 null", () => {
  it("changed: false 时 effective 一个字节都不上屏（变异：无条件显示 → 这里红）", async () => {
    const { client } = fakeClient({
      updateAccount: async () => ({
        changed: false,
        message: MESSAGE_UNCHANGED,
        // ⚠️ 服务端在 `changed: false` 时给 `null`；这里**故意给一句非空的**，用来证明本层
        // 判的是 `changed` 而不是「`effective` 是不是有值」—— 后者才是「看字段有没有」那种
        // 恒真的护栏
        effective: EFFECTIVE_YES,
      }),
    });
    const result = await exec(commandOf("user set alice quotaWindow day"), deps({ client }));

    expect(joined(result)).not.toContain(EFFECTIVE_YES);
  });

  it("changed: true 时逐字上屏 —— 对照组：证明上一组不是碰巧", async () => {
    const { client } = fakeClient({
      updateAccount: async () => ({
        changed: true,
        message: MESSAGE_CHANGED,
        effective: EFFECTIVE_YES,
      }),
    });
    const result = await exec(commandOf("user set alice quotaWindow day"), deps({ client }));

    expect(notesOf(result)).toContain(EFFECTIVE_YES);
  });
});

/* ── ④ 账本三段限定逐字 ──────────────────────────────────────────────────── */

describe("不变量 ④：usage 的三段限定逐字上屏", () => {
  it("sideEffect 与 note 逐字、lagMs 的原值逐字（变异：把 note 换成自己编的一句 → 这里红）", async () => {
    const { client } = fakeClient({ usage: async () => usageBody() });
    const result = await exec(commandOf("usage"), deps({ client }));

    expect(notesOf(result)).toContain(SIDE_EFFECT);
    expect(notesOf(result)).toContain(USAGE_NOTE);
    expect(kvOf(result, "账本可能滞后")).toBe("1.2s（1200 ms）");
    // ⚠️ 三段都在（而 `sideEffect` / `note` 两句长得不一样，恒真的护栏骗不到这里）
    expect(notesOf(result)).toHaveLength(2);
  });

  it("`usage <用户名>` 取**那一次**读的限定（它自带的 lagMs 才是那个数的归属）", async () => {
    const { client, calls } = fakeClient({
      usageFor: async () =>
        ({
          usage: { user: "alice", windowKey: "2026-10", total: 1024 },
          errors: [],
          lagMs: 5000,
          sideEffect: SIDE_EFFECT,
          note: USAGE_NOTE,
        }) as never,
    });
    const result = await exec(commandOf("usage alice"), deps({ client }));

    expect(calls).toEqual(["usageFor"]);
    expect(kvOf(result, "账本可能滞后")).toBe("5s（5000 ms）");
    expect(notesOf(result)).toContain(SIDE_EFFECT);
    expect(notesOf(result)).toContain(USAGE_NOTE);
  });

  it("账本读失败的旁路逐条上屏（不合并成一句）", async () => {
    const { client } = fakeClient({
      usage: async () => ({ ...usageBody(), usage: [], errors: ["alice 的账本行损坏"] }),
    });
    const result = await exec(commandOf("usage"), deps({ client }));

    expect(notesOf(result)).toContain("alice 的账本行损坏");
  });
});

/* ── ⑤ `runningMeans` 逐字，且不被包成失败 ───────────────────────────────── */

describe("不变量 ⑤：cluster master 的 running:false 是正常的", () => {
  it("逐字上屏，且没有一行 err（变异：把 running:false 当异常抛出 → 这里红）", async () => {
    const { client, calls } = fakeClient({ status: async () => statusBody() });
    const result = await exec(commandOf("status"), deps({ client }));

    expect(notesOf(result)).toContain(RUNNING_MEANS);
    expect(errsOf(result)).toEqual([]);
    expect(calls).toEqual(["status"]);
    // 「没有这个数」说 `—` 而不是 `0s`（那等于宣称「它刚起来」）
    expect(kvOf(result, "数据面已跑")).toBe("—");
    expect(kvOf(result, "running")).toBe("关");
    expect(kvOf(result, "模式")).toBe("master");
  });
});
