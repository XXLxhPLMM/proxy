/**
 * 模型看得见的那一面：它拿不到 client / 凭据 / 端点表，而那份命令说明**从 `COMMAND_SPECS` 现算**。
 *
 * 覆盖 **不变量 ①**（模型绝不许拿到 HTTP client）与 **不变量 ②**（工具说明与命令表永不漂），
 * 外加「判据自检」那一档 —— ⚠️ 那一档不是凑数：上面两条判据都是**读源码文本**，探测器认不出那个词时
 * 它们会**在空集上通过**，而正向自检（`SRC.length >= 40`）是唯一的牙齿。
 *
 * 共享的不变量（①–④ 与「为什么不用真 `http.Server` 收模型那一头」）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/agent
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { ALL_TARGETS, COMMAND_SPECS } from "@/commands/index.js";
import { toolDigest, toolSpecs } from "@/lib/agent.js";
import { leavesTrace } from "@/lib/exec/index.js";
import { maskEcho } from "@/lib/log/index.js";
import { messagesOf } from "@/services/model/index.js";
import { SECRET_KEY } from "./_shared.js";

/* ── ① 模型绝不许拿到 HTTP client ──────────────────────────────────────── */

/** `src/` 下**模型那一侧**的源码（⚠️ 按目录现列，不手写清单） */
function modelSideSources(): ReadonlyArray<readonly [string, string]> {
  const root = join(__dirname, "..", "..", "src");
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

/** 模型那一侧的源码（⚠️ 前缀匹配那个目录，**不是**手写清单 —— 加一个方言它自动进扫描面） */
function isModelSide(name: string): boolean {
  return name.startsWith("services/model/") || name === "lib/agent.ts";
}

describe("不变量 ①：模型绝不许拿到 HTTP client", () => {
  const SRC = modelSideSources();

  it("扫描面不是空的（⚠️ 探测器坏了 ⇒ 下面每一条都在空集上通过）", () => {
    expect(SRC.length).toBeGreaterThanOrEqual(40);
    // ⚠️ 三个方言一个都不能少：判据是「那份目录里真的有三份请求形状」，不是「有一个文件」
    const modelSide = SRC.map(([name]) => name).filter(isModelSide);
    expect(modelSide).toContain("services/model/openai.ts");
    expect(modelSide).toContain("services/model/anthropic.ts");
    expect(modelSide).toContain("services/model/gemini.ts");
  });

  it("⚠️ 模型那一侧的**源码里**没有 `ManagerClient`（它只被 `exec` 那条路拿）", () => {
    // ⚠️ 判据是**代码**（剥掉注释与字符串）：注释里写着「不许用 `ManagerClient`」是纪律，不是用法
    const agentSide = SRC.filter(([name]) => isModelSide(name));
    expect(agentSide.length).toBeGreaterThanOrEqual(4);
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

  it("⚠️ 模型能触达的请求面**只有 provider 那三处**，而它们的凭据只往 provider 去", () => {
    // ⚠️ **正向锚点**：三份方言各自认自己那条端点（今天仍然存在的形状）——
    // 少了它们，下面那些「不认识 ENDPOINTS」就是在「一条路径都没写」的形状上恒绿
    const sourceOf = (name: string): string => SRC.find(([n]) => n === name)![1];
    expect(sourceOf("services/model/openai.ts")).toContain("/chat/completions");
    expect(sourceOf("services/model/anthropic.ts")).toContain("/v1/messages");
    expect(sourceOf("services/model/gemini.ts")).toContain(":generateContent");
    // ⚠️ 而**整个模型那一侧恒不认 `ENDPOINTS`**：它压根不引 `src/api`，于是「模型能打哪些地址」
    // 在类型上就等于「`COMMAND_SPECS` 里有哪几条命令」
    for (const [name, text] of SRC.filter(([n]) => isModelSide(n))) {
      expect(codeOnly(text), name).not.toContain("ENDPOINTS");
    }
    // ⚠️ **反向自检**：`manager-client.ts` 那一侧**确实**认 `ENDPOINTS`（否则上面几条是恒真的）
    expect(codeOnly(sourceOf("services/manager-client.ts"))).toContain("ENDPOINTS");
  });

  it("⚠️ `toolSpecs` 里**没有组**（组不是命令，模型挑了必然过不了解析）", () => {
    for (const spec of toolSpecs()) expect(spec.subs).toEqual([]);
    expect(toolSpecs().length).toBe(COMMAND_SPECS.filter((one) => one.subs.length === 0).length);
    // ⚠️ **正向对照**：命令表里**确实**还有那几档（否则上面那条只是「表是空的」也绿）
    expect(toolSpecs().map((one) => one.name)).toContain("accounts");
    expect(toolSpecs().map((one) => one.name)).toContain("batch");
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
    // ⚠️ 下界是「**这张表非空到值得逐条重算**」而不是某个具体数字：命令表刚变短过一轮，
    // 而上面那一条已经**逐条**钉死了确切的条数 —— 这一条只防「digest 整体空掉」
    expect(digestLines).toBeGreaterThan(10);
  });

  it("形参名**逐字**进 digest（模型填参数时最常错的就是「第二个形参叫什么」）", () => {
    expect(toolDigest()).toContain("/usage [用户名]");
    expect(toolDigest()).toContain("/batch <控制面> <命令>");
  });

  it("⚠️ 弹窗那一族**也在** digest 里（它们是命令，模型得知道它们存在）", () => {
    // ⚠️ 反向自检：这一条与「零兼容」那一条是**两件事** —— 一条说模型看得见今天这几条，
    // 那一条说它看不见已经删掉的那几条；而它们合成一条断言的话，任何一边坏了都看不出来
    const digest = toolDigest();
    for (const path of ["/accounts", "/targets", "/users", "/providers", "/models"]) {
      expect(digest, path).toContain(path);
    }
    for (const path of ["/user add", "/target switch", "/provider show", "/managers"]) {
      expect(digest, path).not.toContain(path);
    }
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
