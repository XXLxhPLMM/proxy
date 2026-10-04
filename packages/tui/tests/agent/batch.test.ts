/**
 * 模型挑出的那一条 `/batch`：一条命令扇出 N 台控制面，扇出那一圈的三档与那个 N 的来历。
 *
 * 覆盖 **不变量 ⑤**（三档：全部成功 / 部分失败 / 全部失败，外加「一个挂了不影响别的」）与
 * **不变量 ⑥**（N 从哪儿来：显式 / `all` / 空）。
 *
 * 共享的不变量（①–④ 与「为什么不用真 `http.Server` 收模型那一头」）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/agent
 */

import { describe, expect, it } from "vitest";

import { ALL_TARGETS, parseLine } from "@/commands/index.js";
import { fanOut, exec } from "@/lib/exec/index.js";
import type { ManagerClient } from "@/services/index.js";
import { bareDeps } from "./_shared.js";

/* ── D：batch 的三档 +「一个挂了不影响别的」 ────────────────────────────── */

/** 替身客户端（`ManagerClient` 是 class，而公开成员结构化，故一个对象就够） */
function stubClient(over: Partial<Record<string, () => Promise<unknown>>> = {}): ManagerClient {
  return {
    info: { baseUrl: "http://127.0.0.1:1", token: "t", timeoutMs: 200 },
    knownEndpoints: [],
    status: async () => ({ throw: new Error("status 没安排") }) as never,
    config: async () => ({ throw: new Error("config 没安排") }) as never,
    users: async () => ({ throw: new Error("users 没安排") }) as never,
    user: async () => ({ throw: new Error("user 没安排") }) as never,
    acl: async () => ({ throw: new Error("acl 没安排") }) as never,
    usage: async () => ({ throw: new Error("usage 没安排") }) as never,
    usageFor: async () => ({ throw: new Error("usageFor 没安排") }) as never,
    createAccount: async () => ({ throw: new Error("createAccount 没安排") }) as never,
    updateAccount: async () => ({ throw: new Error("updateAccount 没安排") }) as never,
    deleteAccount: async () => ({ throw: new Error("deleteAccount 没安排") }) as never,
    addAclEntry: async () => ({ throw: new Error("addAclEntry 没安排") }) as never,
    removeAclEntry: async () => ({ throw: new Error("removeAclEntry 没安排") }) as never,
    ...over,
  } as unknown as ManagerClient;
}

describe("不变量 ⑤：`/batch` 三档（全部成功 / 部分失败 / 全部失败）", () => {
  /** 一台**真的答上了**的客户端（⚠️ 判据是「一个 `err` 都没有」，而那要求响应体过 `SHAPES.change`） */
  const answered = (): ManagerClient =>
    stubClient({ deleteAccount: async () => ({ changed: true, message: "删了" }) });

  it("**全部成功**：每一台的结果都在，且 `ok` 全是真", async () => {
    const peers = [
      { name: "a", client: answered() },
      { name: "b", client: answered() },
    ];
    const { reports } = await fanOut(
      { kind: "user-del", username: "alice" },
      peers,
      (peer) => ({ ...bareDeps(), client: peer.client }),
    );
    expect(reports.map((one) => one.name)).toEqual(["a", "b"]);
    expect(reports.every((one) => one.ok)).toBe(true);
    expect(reports[0]!.rows.length).toBeGreaterThan(0);
  });

  it("⚠️ **部分失败**：成功的那几台的结果**一个字节都不丢**", async () => {
    const peers = [
      { name: "a", client: answered() },
      { name: "b", client: null },
      { name: "c", client: answered() },
    ];
    const { reports } = await fanOut(
      { kind: "user-del", username: "alice" },
      peers,
      (peer) => ({ ...bareDeps(), client: peer.client }),
    );
    expect(reports.map((one) => one.ok)).toEqual([true, false, true]);
    // ⚠️ **核心判据**：前后两台的结果**仍然在**（一个 `Promise.all` + 一个 catch 的实现会在这里全丢）
    expect(reports[0]!.rows.length).toBeGreaterThan(0);
    expect(reports[2]!.rows.length).toBeGreaterThan(0);
    // ⚠️ 而失败的那一档**说了是它**（「`null` 客户端 ⇒ 没选中控制面」，不是一句总括）
    expect(JSON.stringify(reports[1]!.rows)).toContain("先在左边选一个控制面");
  });

  it("⚠️ **`changed: false` 是成功的 no-op，不算那一台失败**", async () => {
    // ⚠️ **反向自检**（`succeeded` 那条判据的另一半）：服务端语义里它是一次成功，
    // 少这一条的话「删掉一个不存在的账号」会被算成「那台挂了」
    const peers = [
      { name: "a", client: stubClient({ deleteAccount: async () => ({ changed: false, message: "查无此人" }) }) },
    ];
    const { reports } = await fanOut(
      { kind: "user-del", username: "nobody" },
      peers,
      (peer) => ({ ...bareDeps(), client: peer.client }),
    );
    expect(reports[0]!.ok).toBe(true);
  });

  it("**全部失败**：每一档都**逐台**说了，而不是一句「batch 失败」", async () => {
    const peers = [
      { name: "a", client: null },
      { name: "b", client: null },
    ];
    const { reports } = await fanOut(
      { kind: "user-del", username: "alice" },
      peers,
      (peer) => ({ ...bareDeps(), client: peer.client }),
    );
    expect(reports).toHaveLength(2);
    expect(reports.every((one) => !one.ok)).toBe(true);
    expect(reports[0]!.name).toBe("a");
    expect(reports[1]!.name).toBe("b");
  });

  it("⚠️ **一个挂了不许影响别的**（`try` 包住每一次，判据是**顺序**也变了）", async () => {
    // ⚠️ 这一条是上面那条的**加强版**：中间那台**直接抛**（不是「没选」那种正常失败），
    // 而前后两台**必须照常跑完** —— `Promise.all` 或「catch 一次就整批 return」的实现在这里红
    const boom = (): Promise<never> => Promise.reject(new Error("这一台炸了"));
    const peers = [
      { name: "a", client: answered() },
      { name: "b", client: stubClient({ deleteAccount: boom }) },
      { name: "c", client: answered() },
    ];
    const { reports } = await fanOut(
      { kind: "user-del", username: "alice" },
      peers,
      (peer) => ({ ...bareDeps(), client: peer.client }),
    );
    // ⚠️ **三档都在**（中间那台崩了，而前后两台的结果都还在）
    expect(reports.map((one) => one.name)).toEqual(["a", "b", "c"]);
    expect(reports.map((one) => one.ok)).toEqual([true, false, true]);
    // ⚠️ **顺序恒等于目标的顺序**（并发实现的返回顺序会跟着完成时间跳）
    expect(reports[0]!.name).toBe("a");
    expect(reports[2]!.name).toBe("c");
    // ⚠️ 而那一档说了是**这一台**崩了，且**不转述 `err.message`**（那串可能带出别的东西）
    expect(reports[1]!.rows.some((row) => row.kind === "err")).toBe(true);
    expect(JSON.stringify(reports[1]!.rows)).not.toContain("这一台炸了");
  });

  it("⚠️ **一台的依赖造不出来时也不许把别的带走**（`depsFor` 在 `try` 之内）", async () => {
  // ⚠️ **这一条才是 M4 那次变异真正能咬住的那一条**：`exec` 把控制面的失败**收进行里**而很少抛，
  // 故「某一台炸了」在真实路径上是 `depsFor`（`clientFor` 归一失败就抛）而不是 `exec`。
  // 而 `try` 提到循环外面的话，前面几台的结果**连同它们的报表一起丢**。
  const peers = [
    { name: "a", client: answered() },
    { name: "b", client: null },
    { name: "c", client: answered() },
  ];
  const { reports } = await fanOut({ kind: "user-del", username: "alice" }, peers, (peer) => {
    if (peer.name === "b") throw new Error("这一台的地址不对");
    return { ...bareDeps(), client: peer.client };
  });
  // ⚠️ **三档都在**：中间那台造不出客户端，而前后两台**照常跑完**
  expect(reports.map((one) => one.name)).toEqual(["a", "b", "c"]);
  expect(reports.map((one) => one.ok)).toEqual([true, false, true]);
  expect(reports[0]!.rows.length).toBeGreaterThan(0);
  expect(reports[2]!.rows.length).toBeGreaterThan(0);
  expect(JSON.stringify(reports[1]!.rows)).not.toContain("这一台的地址不对");
});

it("⚠️ **`/batch` 自己一个请求都不发**（它只把「内层命令 + 那一批」递给上层）", async () => {
    const called: string[] = [];
    const result = await exec(
      { kind: "batch", targets: ALL_TARGETS, command: { kind: "status" }, line: "/status" },
      { ...bareDeps(), peers: (names) => { called.push(...names); return []; } },
    );
    // ⚠️ `/batch` **不留痕**：内层那条命令的回显由扇出那一圈逐台加（加了 N+1 次同一条没人读）
    expect(result.rows).toEqual([]);
    expect(called).toEqual([ALL_TARGETS]);
    expect(result.effects[0]?.kind).toBe("batch");
  });

  it("⚠️ **内层那条命令的原文逐字带上去**（否则回显是一个空串，而掩码靠原文定位）", async () => {
    const result = await exec(
      { kind: "batch", targets: ALL_TARGETS, command: { kind: "status" }, line: "/status" },
      { ...bareDeps(), peers: () => [] },
    );
    const effect = result.effects[0];
    if (effect?.kind !== "batch") throw new Error("副作用不对");
    expect(effect.line).toBe("/status");
  });
});

/* ── `/batch` 的名字怎么展开 ──────────────────────────────────────────── */

describe("不变量 ⑥：`/batch` 的 N 从哪儿来（显式 / all / 空）", () => {
  it("`all` 保留成**一个词**（由上层对着台账展开）", async () => {
    let seen: readonly string[] = [];
    await exec({ kind: "batch", targets: ALL_TARGETS, command: { kind: "status" }, line: "/status" }, {
      ...bareDeps(),
      peers: (names) => { seen = names; return []; },
    });
    expect(seen).toEqual([ALL_TARGETS]);
  });

  it("逗号分隔的若干个**逐个**交出去（顺序 = 用户敲的顺序）", async () => {
    let seen: readonly string[] = [];
    await exec({ kind: "batch", targets: "prod,stage", command: { kind: "status" }, line: "/status" }, {
      ...bareDeps(),
      peers: (names) => { seen = names; return []; },
    });
    expect(seen).toEqual(["prod", "stage"]);
  });

  it("⚠️ **一个空词是失败**（`a,,b` 少打一个名字 ⇒ 静默少发一台）", () => {
    expect(parseLine("/batch a,,b /status").kind).toBe("bad-value");
    expect(parseLine("/batch , /status").kind).toBe("bad-value");
    expect(parseLine("/batch all /status").kind).toBe("ok");
  });

  it("⚠️ **`ALL` 与 `all` 是同一件事**（用户不区分大小写地敲）", () => {
    const parsed = parseLine("/batch ALL /status");
    if (parsed.kind !== "ok" || parsed.command.kind !== "batch") throw new Error("解析失败");
    expect(parsed.command.targets).toBe(ALL_TARGETS);
  });

  it("⚠️ **内层命令的引号逐字保留**（`rest` 那一格不吃「分词再拼回去」）", () => {
    const parsed = parseLine('/batch all /user pass bob "a b"');
    if (parsed.kind !== "ok" || parsed.command.kind !== "batch") throw new Error("解析失败");
    expect(parsed.command.command).toEqual({ kind: "user-pass", username: "bob", password: "a b" });
  });

  it("⚠️ **内层命令不对 ⇒ 整条被拒**（而不是「发一个空的给每一台」）", () => {
    expect(parseLine("/batch all /nope").kind).toBe("bad-value");
    expect(parseLine("/batch all users").kind).toBe("bad-value");
  });
});
