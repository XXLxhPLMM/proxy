/**
 * `@/lib/agent.ts` + `@/services/model.ts` + `/batch` 扇出：模型那一圈的三档判据
 *
 * **锁什么**（四条不变量，每条都配了变异实测）：
 * ① ⚠️ **模型绝不许拿到 HTTP client**：它输出的是一条 `Command`，而那条命令能打的地址
 *    **恒等于** `COMMAND_SPECS` 里有的那些 —— 判据是「模型那一侧的源码里没有 client / token / URL」
 *    加上「模型看得到的那几段里没有一个字节是控制面凭据」。
 * ② **工具说明与命令表永不漂**：那份表**从 `COMMAND_SPECS` 现算**，故加一条命令它自动跟着走；
 *    判据是「digest 的每一行都能在表里找到」+「表里每一条命令都在 digest 里」。
 * ③ ⚠️ **模型输出逐字段校验**：`commandOfReply` 走的是 `parseLine` —— 同一个判据、同一张表。
 *    校验失败的表现**必须看得见**，而静默丢掉是最坏的一种。
 * ④ **key 零泄露**：掩码只有一份出口（`maskEcho` + `redactProvider`），而屏上 / 文案 / 快照三处各自有判据。
 *
 * **为什么不用真 `http.Server` 收模型那一头**：那要额外起一个服务，而本档要验的是
 * 「模型看得见的面上有什么」与「模型输出怎么被校验」—— 前者读请求体就够，后者是纯函数。
 * 对真 server 的端到端（控制面那一侧）是 `tests/client.test.ts` 的 8 档，不在这里重复付。
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { ALL_TARGETS, COMMAND_SPECS, parseLine } from "@/commands/index.js";
import { MAX_ROUNDS, ask, toolDigest, toolSpecs } from "@/lib/agent.js";
import { fanOut, exec } from "@/lib/exec/index.js";
import { echoOf, leavesTrace } from "@/lib/exec/index.js";
import { maskEcho, rowsOfTurn } from "@/lib/log/index.js";
import { ModelError, commandOfReply, messagesOf } from "@/services/model.js";
import { readProvider, redactProvider, writeProvider } from "@/services/config/index.js";
import type { ExecDeps } from "@/lib/exec/index.js";
import type { ManagerClient } from "@/services/index.js";

const SECRET_KEY = "sk-do-not-print-this-value";

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

/** 一份什么都不做的 `ExecDeps`（本档只关心「模型看得见什么」，不关心执行） */
function bareDeps(): ExecDeps {
  return {
    client: null,
    width: 80,
    line: "",
    onTargetAdd: () => {},
    onTargetDel: () => {},
    onTargetSwitch: () => {},
    onProviderSet: () => {},
    onProviderKey: () => {},
    provider: () => ({ baseUrl: null, model: null, apiKey: null }),
    peers: () => [],
  };
}

/* ── ① 模型绝不许拿到 HTTP client ──────────────────────────────────────── */

/** `src/` 下**模型那一侧**的源码（⚠️ 按目录现列，不手写清单） */
function modelSideSources(): ReadonlyArray<readonly [string, string]> {
  const root = join(__dirname, "..", "src");
  const out: Array<readonly [string, string]> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
        out.push([full.slice(root.length + 1).split(sep).join("/"), readFileSync(full, "utf8")]);
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 去掉注释与字符串字面量（⚠️ 判据要落在**代码**上：注释里提到 `token` 是在讲纪律，不是在用它） */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // ⚠️ **行尾注释也要剥**（不是只剥「整行都是注释」的那些）：`const a = 1; // token` 那半行同样是注释
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

describe("不变量 ①：模型绝不许拿到 HTTP client", () => {
  const SRC = modelSideSources();

  it("扫描面不是空的（⚠️ 探测器坏了 ⇒ 下面每一条都在空集上通过）", () => {
    expect(SRC.length).toBeGreaterThanOrEqual(40);
    expect(SRC.map(([name]) => name)).toContain("services/model.ts");
  });

  it("⚠️ 模型那一侧的**源码里**没有 `ManagerClient`（它只被 `exec` 那条路拿）", () => {
    // ⚠️ 判据是**代码**（剥掉注释与字符串）：注释里写着「不许用 `ManagerClient`」是纪律，不是用法
    const agentSide = SRC.filter(([name]) => name === "services/model.ts" || name === "lib/agent.ts");
    for (const [name, text] of agentSide) {
      expect(codeOnly(text), name).not.toContain("ManagerClient");
    }
    // ⚠️ **反向自检**：`manager-client.ts` 那一侧**确实**有它（否则上面那两条是「探测器认不出这个词」）
    expect(codeOnly(SRC.find(([n]) => n === "services/manager-client.ts")![1])).toContain("ManagerClient");
  });

  it("⚠️ 模型看得见的那几段里**没有控制面凭据、没有端点地址**", () => {
    // ⚠️ 判据是**请求体**：模型能看见的只有「系统提示 + 用户/模型的话」，
    // 而台账里的 `token` 与 `baseUrl` 一个字节都不在里面（那正是「模型绝不许拿到 client」的实义）
    const messages = messagesOf(
      [
        { kind: "user", text: "看看 alice 的用量" },
        { kind: "assistant", text: "她在用" },
        // ⚠️ **这一格是本条判据的牙齿**：控制面的回答里可能有账号名、配额、地址，
        // 而 `messagesOf` **刻意只取 `user`/`assistant` 两档** —— 少那个 `if` 这条就红
        { kind: "tool-result", rows: [{ kind: "note", text: "token=t0ken url=http://127.0.0.1:1" }] },
        { kind: "error", rows: [{ kind: "err", text: "unauthorized：凭据不对 t0ken" }] },
        { kind: "notice", rows: [{ kind: "note", text: "已存进台账 t0ken" }] },
      ],
      toolDigest(),
    );
    const wire = JSON.stringify(messages);
    expect(wire).not.toContain("t0ken");
    expect(wire).not.toContain("127.0.0.1:1");
    expect(wire).not.toContain("Bearer");
    // ⚠️ 而**用户那句话确实在里面**（否则模型是在跟空气对话）
    expect(wire).toContain("看看 alice 的用量");
  });

  it("⚠️ **`messagesOf` 只取两档**（判据是「那几段的 role 与条数」，不是某一段文本）", () => {
    // ⚠️ 锚点是**今天仍存在的形状**：`[system, user, assistant]` 三段，顺序固定
    const messages = messagesOf(
      [
        { kind: "user", text: "问" },
        { kind: "tool-call", echo: { kind: "echo", text: "/users" } },
        { kind: "tool-result", rows: [{ kind: "note", text: "答" }] },
        { kind: "assistant", text: "答" },
      ],
      "工具表",
    );
    expect(messages.map((one) => one.role)).toEqual(["system", "user", "assistant"]);
  });

  it("⚠️ 模型能触达的请求面**只有 provider 那一处**，而它的凭据只往 provider 去", () => {
    // ⚠️ 锚点是**今天仍存在的形状**（`askModel` 那一行的 URL 拼法与那一行 header），
    // 而它恒不认 `ENDPOINTS`：模型那一侧压根不引 `src/api`，于是「模型能打哪些地址」
    // 在类型上就等于「`COMMAND_SPECS` 里有哪几条命令」
    const model = SRC.find(([n]) => n === "services/model.ts")![1];
    expect(model).toContain("/chat/completions");
    expect(codeOnly(model)).not.toContain("ENDPOINTS");
    expect(codeOnly(SRC.find(([n]) => n === "lib/agent.ts")![1])).not.toContain("ENDPOINTS");
    // ⚠️ **反向自检**：`manager-client.ts` 那一侧**确实**认 `ENDPOINTS`（否则上面两条是恒真的）
    expect(codeOnly(SRC.find(([n]) => n === "services/manager-client.ts")![1])).toContain("ENDPOINTS");
  });

  it("⚠️ `toolSpecs` 里**没有组**（组不是命令，模型挑了必然过不了解析）", () => {
    for (const spec of toolSpecs()) expect(spec.subs).toEqual([]);
    expect(toolSpecs().length).toBe(COMMAND_SPECS.filter((one) => one.subs.length === 0).length);
  });
});

/* ── ② 工具说明与命令表永不漂 ──────────────────────────────────────────── */

describe("不变量 ②：给模型的那份命令表**从 `COMMAND_SPECS` 现算**", () => {
  it("表里每一条命令都在 digest 里（漏一条 ⇒ 模型压根不知道有它）", () => {
    const digest = toolDigest();
    for (const spec of toolSpecs()) expect(digest, spec.name).toContain(spec.usage);
  });

  it("digest 的每一行都能在表里找到（多一行 ⇒ 模型在照一份不存在的命令表挑）", () => {
    const lines = toolDigest().split("\n");
    expect(lines.length).toBe(toolSpecs().length);
    for (const line of lines) {
      const path = line.slice(2, line.indexOf("："));
      expect(toolSpecs().some((spec) => spec.usage === path), line).toBe(true);
    }
  });

  it("⚠️ **加了命令它就跟着走**（变异：往表里加一条，digest 自动多一行）", () => {
    // 判据是「digest 的行数 == 表里非组命令的条数」而不是某一行文本：
    // 前者对「表变宽」敏感，后者对「某一行的措辞」敏感 —— 两者要的是不同的东西
    const digestLines = toolDigest().split("\n").length;
    expect(digestLines).toBe(COMMAND_SPECS.filter((one) => one.subs.length === 0).length);
    expect(digestLines).toBeGreaterThan(20);
  });

  it("形参名**逐字**进 digest（模型填参数时最常错的就是「第二个形参叫什么」）", () => {
    expect(toolDigest()).toContain("/user add <用户名> [流量上限]");
    expect(toolDigest()).toContain("/target add <名字> <地址> <token> [超时毫秒]");
  });
});

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
    const app = readFileSync(join(__dirname, "..", "src", "AppState.tsx"), "utf8");
    expect(app).toContain("provider: () => redactProvider(providerRef.current)");
    // ⚠️ **反向自检**：那一份**真**凭据确实存在（否则上面那条是「根本没有凭据」的假绿）
    expect(app).toContain("modelEndpointOf(providerRef.current)");
  });
});

/* ── D：batch 的三档 +「一个挂了不影响别的」 ────────────────────────────── */

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

/* ── 探测器自检 ─────────────────────────────────────────────────────── */

describe("判据自检（防「探测器写坏了 → 恒绿」）", () => {
  it("`codeOnly` 剥掉了注释与字符串（否则上面那几条认不出「注释里提到 token」）", () => {
    expect(codeOnly('/** token */\nconst a = "token"; // token\n')).not.toContain("token");
    expect(codeOnly("const a = 1;")).toBe("const a = 1;");
  });

  it("`codeOnly` **不**剥掉标识符名（`client` 在代码里就是 `client`）", () => {
    expect(codeOnly("const client = deps.client;")).toContain("client");
  });

  it("⚠️ 反向自检：`maskEcho` 对**未知类别**编译期就红（那是「加了类别忘了掩码」的第一道）", () => {
    // ⚠️ 判据锚在**今天仍存在的形状**（三个类别各自的掩码），不是点名某个符号
    expect(maskEcho("user-pass", SECRET_KEY)).toBe(maskEcho("target-add", SECRET_KEY));
    expect(maskEcho("target-add", SECRET_KEY)).toBe(maskEcho("provider-key", SECRET_KEY));
  });

  it("⚠️ `leavesTrace` 对 `/batch` 说**不留痕**（`default` 拿不到值 ⇒ 表穷尽联合）", () => {
    // ⚠️ 留痕的话同一条命令会在屏上出现 N+1 次（一次来自 `/batch`，N 次来自扇出那一圈）
    expect(
      leavesTrace({ kind: "batch", targets: ALL_TARGETS, command: { kind: "status" }, line: "/status" }),
    ).toBe(false);
  });
});