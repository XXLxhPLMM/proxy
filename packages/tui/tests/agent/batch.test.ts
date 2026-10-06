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

import { afterEach, describe, expect, it } from "vitest";
import axios from "axios";

import { ALL_TARGETS, parseLine } from "@/commands/index.js";
import { fanOut, exec, type BatchPeer } from "@/lib/exec/index.js";
import type { ManagerTarget } from "@/api/index.js";
import { bareDeps } from "./_shared.js";

/* ── D：batch 的三档 + 「一个挂了不影响别的」 ────────────────────────────── */

/** 一台替身：目标 + 「把这一台自己的应答表装上」 */
interface Stub {
  readonly target: ManagerTarget;
  activate(): void;
}

/**
 * 一台控制面的替身（⚠️ 键是**线上那一行**；未安排的线拒掉而不是给空响应 ——
 * 那一句「没安排」比一个空响应更早把「多发了一个请求」喊出来）
 * @description 端点函数**自己 axios**，而 `axios.defaults.adapter` 是**全进程一格**
 * ⇒ 同一时刻只装得下一份应答表。故 {@link fanOut} 的 `depsFor` 里**逐台装**（`fanOut` 是串行的，
 * 装谁谁生效）—— 这不是权宜：串行本来就是 `/batch` 那三条取舍里的**第一条**，
 * 而「三台各有各的应答」这件事本来就只在串行下说得出来。
 * ⚠️ `afterEach` 还原成**进来时**那一格：⚠️⚠️ **不是 `delete`**（axios 那个键的缺省值是
 * `["xhr","http","fetch"]` 那个**数组**，删掉它会让下一个请求抛 `Unknown adapter 'undefined'`）。
 */
function stubPeer(over: Readonly<Record<string, () => Promise<unknown>>> = {}): Stub {
  return {
    target: { baseUrl: "http://127.0.0.1:1", token: "t", timeoutMs: 200 },
    activate: (): void => {
      axios.defaults.adapter = async (config) => {
        const line = `${String(config.method ?? "get").toUpperCase()} ${String(config.url ?? "")}`;
        const work = over[line];
        if (work === undefined) return Promise.reject(new Error(`本档没有安排 ${line}`));
        return { status: 200, statusText: "OK", data: await work(), headers: {}, config };
      };
    },
  };
}

/** 本档每个用例自己装 ⇒ 自己拆（⚠️ 那一格是全进程一个，漏拆的症状是**别的档**收不到请求） */
const PRISTINE = axios.defaults.adapter;
afterEach(() => {
  axios.defaults.adapter = PRISTINE;
});

/** 一份**过了收窄**的名单响应体（⚠️ `ok` 的判据是「一个 `err` 都没有」，而那要求响应体过 `@/api` 的 `aclSchema`） */
const ACL_BODY = {
  acl: {
    clientIp: { whitelist: ["10.0.0.0/8"], blacklist: [] },
    target: { whitelist: [], blacklist: [] },
    upstream: { whitelist: [], blacklist: [] },
  },
};

/** 一台**真的答上了**的替身 */
const answered = (): Stub => stubPeer({ "GET /api/acl": async () => ACL_BODY });

/** 「没选中」的那台（`target: null` ⇒ 执行层一个请求都不发） */
const UNSELECTED: Stub = { target: null as unknown as ManagerTarget, activate: () => {} };

/** 扇出用的那一条命令（⚠️ 恒是同一条，故「顺序」「逐台」那几条判据量的只是扇出本身） */
const FAN_OUT = { kind: "acl" } as const;

/**
 * 一台「名字 + 替身」
 * @description ⚠️ **`stub` 不在 `BatchPeer` 上**（那是生产契约，`@/AppState.tsx` 递的是真参数）：
 * 「把这一台的应答表装上」是**这一档的**需要（应答表换在全局那一格，故得逐台装），
 * 而把它塞进生产契约就是让生产类型为测试让路。故本档递 `fanOut` 之前自己映射成 `BatchPeer`。
 */
interface Peer {
  readonly name: string;
  readonly stub: Stub;
}

/** 本档的 `Peer[]` → `fanOut` 要的 `BatchPeer[]`（那一格只留生产真正用到的东西） */
const batchPeers = (peers: readonly Peer[]): BatchPeer[] =>
  peers.map((one) => ({ name: one.name, target: one.stub.target }));

describe("不变量 ⑤：`/batch` 三档（全部成功 / 部分失败 / 全部失败）", () => {
  it("**全部成功**：每一台的结果都在，且 `ok` 全是真", async () => {
    const peers = [
      { name: "a", stub: answered() },
      { name: "b", stub: answered() },
    ];
    const { reports } = await fanOut(FAN_OUT, batchPeers(peers), (peer) => {
      peers.find((one) => one.name === peer.name)?.stub.activate();
      return { ...bareDeps(), target: peer.target, line: "/acl" };
    });
    expect(reports.map((one) => one.name)).toEqual(["a", "b"]);
    expect(reports.every((one) => one.ok)).toBe(true);
    expect(reports[0]!.rows.length).toBeGreaterThan(0);
  });

  it("⚠️ **部分失败**：成功的那几台的结果**一个字节都不丢**", async () => {
    const peers = [
      { name: "a", stub: answered() },
      { name: "b", stub: UNSELECTED },
      { name: "c", stub: answered() },
    ];
    const { reports } = await fanOut(FAN_OUT, batchPeers(peers), (peer) => {
      peers.find((one) => one.name === peer.name)?.stub.activate();
      return { ...bareDeps(), target: peer.target, line: "/acl" };
    });
    expect(reports.map((one) => one.ok)).toEqual([true, false, true]);
    // ⚠️ **核心判据**：前后两台的结果**仍然在**（一个 `Promise.all` + 一个 catch 的实现会在这里全丢）
    expect(reports[0]!.rows.length).toBeGreaterThan(0);
    expect(reports[2]!.rows.length).toBeGreaterThan(0);
    // ⚠️ 而失败的那一档**说了是它**（「`target === null` ⇒ 没选中控制面」，不是一句总括）
    expect(JSON.stringify(reports[1]!.rows)).toContain("先在左边选一个控制面");
  });

  it("⚠️ **服务端答了「失败」就是那一台失败**（判据是「一个 `err` 都没有」，不是「没抛」）", async () => {
    // ⚠️ **反向自检**：`exec` 把控制面的失败**收进行里**而很少抛，故拿「没抛」当 `ok` 的实现
    // 在这一条上恒绿 —— 而屏上那句话正是数它数出来的
    // ⚠️ **回一个形状不对的 200**（而不是让替身抛异常）：真实路径上「对面答了而本包读不出来」
    // 走的是 `shape` 档，故这一条必须从**真响应**的角度触发 —— 让替身抛异常的话，
    // 测到的会是「传输失败」那一档（另一条纪律），而 `ok === false` 在两条上**都成立** ⇒ 恒绿。
    const peers = [
      { name: "a", stub: stubPeer({ "GET /api/acl": async () => ({ 不像名单: true }) }) },
    ];
    const { reports } = await fanOut(FAN_OUT, batchPeers(peers), (peer) => {
      peers.find((one) => one.name === peer.name)?.stub.activate();
      return { ...bareDeps(), target: peer.target, line: "/acl" };
    });
    expect(reports[0]!.ok).toBe(false);
    expect(reports[0]!.rows.some((row) => row.kind === "err")).toBe(true);
  });

  it("**全部失败**：每一档都**逐台**说了，而不是一句「batch 失败」", async () => {
    const peers = [
      { name: "a", stub: UNSELECTED },
      { name: "b", stub: UNSELECTED },
    ];
    const { reports } = await fanOut(FAN_OUT, batchPeers(peers), (peer) => {
      peers.find((one) => one.name === peer.name)?.stub.activate();
      return { ...bareDeps(), target: peer.target, line: "/acl" };
    });
    expect(reports).toHaveLength(2);
    expect(reports.every((one) => !one.ok)).toBe(true);
    expect(reports[0]!.name).toBe("a");
    expect(reports[1]!.name).toBe("b");
  });

  it("⚠️ **一个挂了不许影响别的**（`try` 包住每一次，判据是**顺序**也变了）", async () => {
    // ⚠️ 这一条是上面那条的**加强版**：中间那台**崩在一个 `exec` 之外的地方**，
    // 而前后两台**必须照常跑完** —— `Promise.all` 或「catch 一次就整批 return」的实现在这里红。
    //
    // ⚠️ **中间那台的「崩」不再是「替身抛异常」**：端点函数自己 axios，而执行层把控制面那一侧的
    // 失败**全部**收进 `attempt()`（故 `fanOut` 的 `rowOfCrash` 在这条路上够不着）。
    // 今天唯一还能让 `fanOut` 的 `try` 真正派上用场的，是**上层递 deps 那一步自己崩了**
    // —— 那正是下面那一条要断的。故这一条改断「某一台**彻底答不上来**」：
    // 它与前后两台的**对照**仍然是「一台坏的不许带走别的」。
    const peers = [
      { name: "a", stub: answered() },
      // ⚠️ 空的应答表 ⇒ 任何一条线都拒（`本档没有安排 …`）⇒ 这一台失败，而**不是**崩在 try 之外
      { name: "b", stub: stubPeer({}) },
      { name: "c", stub: answered() },
    ];
    const { reports } = await fanOut(FAN_OUT, batchPeers(peers), (peer) => {
      peers.find((one) => one.name === peer.name)?.stub.activate();
      return { ...bareDeps(), target: peer.target, line: "/acl" };
    });
    // ⚠️ **三档都在**（中间那台答不上来，而前后两台的结果都还在）
    expect(reports.map((one) => one.name)).toEqual(["a", "b", "c"]);
    expect(reports.map((one) => one.ok)).toEqual([true, false, true]);
    // ⚠️ **顺序恒等于目标的顺序**（并发实现的返回顺序会跟着完成时间跳）
    expect(reports[0]!.name).toBe("a");
    expect(reports[2]!.name).toBe("c");
    expect(reports[0]!.rows.length).toBeGreaterThan(0);
    expect(reports[2]!.rows.length).toBeGreaterThan(0);
  });

  it("⚠️ **一台的依赖造不出来时也不许把别的带走**（`depsFor` 在 `try` 之内）", async () => {
    // ⚠️ **这一条是 `fanOut` 那个 `try` 今天唯一真正咬得住的形状**：`exec` 把控制面的失败**收进行里**而很少抛，
    // 故「某一台炸了」在真实路径上是 `depsFor`（递进去的那份参数造不出来就抛）而不是 `exec`。
    // 而 `try` 提到循环外面的话，前面几台的结果**连同它们的报表一起丢**。
    const peers = [
      { name: "a", stub: answered() },
      { name: "b", stub: UNSELECTED },
      { name: "c", stub: answered() },
    ];
    const { reports } = await fanOut(FAN_OUT, batchPeers(peers), (peer) => {
      if (peer.name === "b") throw new Error("这一台的地址不对");
      peers.find((one) => one.name === peer.name)?.stub.activate();
      return { ...bareDeps(), target: peer.target, line: "/acl" };
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

  it("⚠️ **内层那条命令的原文逐字带上去**（否则那一圈没有「用户敲的是哪一条」）", async () => {
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
    // ⚠️ 锚点是**今天仍然存在的形状**（带引号的一条内层命令逐字回来），而命令名恒是一个词
    // ⇒ 内层那条**唯一的**能带引号的命令是 `/help` 的主题
    const parsed = parseLine('/batch all /help "some topic"');
    if (parsed.kind !== "ok" || parsed.command.kind !== "batch") throw new Error("解析失败");
    expect(parsed.command.command).toEqual({ kind: "help", topic: "some topic" });
  });

  it("⚠️ **内层命令不对 ⇒ 整条被拒**（而不是「发一个空的给每一台」）", () => {
    expect(parseLine("/batch all /nope").kind).toBe("bad-value");
    expect(parseLine("/batch all accounts").kind).toBe("bad-value");
  });
});