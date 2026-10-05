/**
 * @fileoverview 端到端：真的起进程，走真的 stdio，真的读 `~/.swain-proxy/`
 * @module tests/tools/wiring
 * @description
 * ⚠️ 前面几档都在**同一个进程里**调 handler，于是它们共同漏掉了一整类问题：**进程边界上的
 * 那些**。这一档补上：
 *
 * ① `dist/cli.js` 起得来（shebang + 产物是 ESM + 依赖解析对）
 * ② 激活状态**真的是进程内存**（子进程激活后退出，父进程下一次调用仍然是「没激活」）
 * ③ 台账写在**真的 `~/.swain-proxy/`**（子进程用临时 HOME 起，事后查盘）
 *
 * ⚠️ 这一档依赖 `pnpm build` 的产物，故它在 `dist/` 不存在时**整档跳过**而不是红 ——
 * 「没构建过」不是失败，而单测跑在 build 之前是常规顺序（与根仓 `build:lib` 的纪律同族）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..", "..");
const entry = path.join(pkg, "dist", "cli.js");

const built = fs.existsSync(entry);

/** 一条应答（⚠️ `id` 恒有：这一档只等请求的应答，而通知没有应答） */
interface Reply {
  readonly id: number;
  readonly result?: { readonly content?: readonly { readonly text: string }[] };
  readonly error?: { readonly code: number; readonly message: string };
}

interface Run {
  readonly out: readonly Reply[];
  readonly err: string;
  readonly code: number | null;
}

/** 喂给子进程的几条 JSON-RPC，逐条取它的应答（⚠️ 通知没有应答，故只等请求） */
function rpc(home: string, lines: readonly string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const lines = out
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Reply);
      resolve({ out: lines, err, code });
    });
    child.stdin.end(lines.join("\n") + "\n");
  });
}

function init(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
}

function call(id: number, name: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

describe.skipIf(!built)("端到端 · 真进程真 stdio", () => {
  let home = "";

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? "."), "swain-mcp-e2e-"));
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("dist/cli.js 起得来，tools/list 给出 22 个工具", async () => {
    const run = await rpc(home, [init(1), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const listed = run.out.find((one) => one.id === 2)?.result as { tools: { name: string }[] };
    expect(listed.tools).toHaveLength(22);
    const initResult = run.out.find((one) => one.id === 1)?.result as { protocolVersion: string };
    expect(initResult.protocolVersion).toBe("2025-06-18");
  }, 30_000);

  it("⚠️ 激活只活在进程内存：子进程激活后退出，下一个子进程仍然「没激活」", async () => {
    const work = fs.mkdtempSync(path.join(home, "act-"));
    // ⚠️ `id` 是**名字的 slug**（`@/store/managers.js:slugify`）：ASCII 名就取它的 slug，
    // 所以这里必须用 `north` 而不是写死 `m` —— 那个 id 只在名字落不到 ASCII 时才出现
    await rpc(work, [init(1), call(2, "manager_add", { name: "north", baseUrl: "http://a:1", key: "k" })]);
    const onDisk = path.join(work, ".swain-proxy", "managers.json");
    expect(fs.readFileSync(onDisk, "utf8")).toContain("http://a:1");

    const second = await rpc(work, [init(1), call(2, "env_create", { name: "prod", managers: ["north"] })]);
    const created = second.out.find((one) => one.id === 2)?.result as { content: { text: string }[] };
    expect(created.content[0]?.text).toContain("prod");

    const third = await rpc(work, [init(1), call(2, "env_activate", { name: "prod" }), call(3, "env_list")]);
    const activated = third.out.find((one) => one.id === 3)?.result as { content: { text: string }[] };
    expect(activated.content[0]?.text).toContain('"activeEnv": "prod"');

    // ⚠️ **新进程**：激活必须归零（推导见 `@/store/session.js` 的文件头）
    const fourth = await rpc(work, [init(1), call(2, "env_list")]);
    const after = fourth.out.find((one) => one.id === 2)?.result as { content: { text: string }[] };
    expect(after.content[0]?.text).toContain('"activeEnv": null');
  }, 60_000);

  it("⚠️ 台账真的写在 $HOME/.swain-proxy/ 下，且 key 在盘上、在返回里不在", async () => {
    const work = fs.mkdtempSync(path.join(home, "files-"));
    const run = await rpc(work, [
      init(1),
      call(2, "manager_add", { name: "n", baseUrl: "http://a:1", key: "disk-secret" }),
    ]);
    const added = run.out.find((one) => one.id === 2)?.result as { content: { text: string }[] };
    expect(added.content[0]?.text).not.toContain("disk-secret");

    const file = path.join(work, ".swain-proxy", "managers.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("disk-secret");
  }, 60_000);
});
