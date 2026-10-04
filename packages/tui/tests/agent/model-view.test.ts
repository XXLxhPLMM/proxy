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
import { messagesOf } from "@/services/model.js";
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
