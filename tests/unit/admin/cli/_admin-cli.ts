/**
 * 本目录各档共用的临时目录、写入面、账号基准与 `run()`
 *
 * @description
 * 收件门槛是「**两个以上档真用到**」，不是「看起来通用」：只被一档用到的东西（多条目名单 `MANY` /
 * `writeAcl` / `widestLine` / `sqliteEnv`）就留在那一档里 —— 搬进来就成了一份没人能单独删掉、
 * 也没人说得清谁在用的间接层。
 *
 * ⚠️ **必须住在这个目录，不能搬进 `tests/helpers/`**：零外网护栏的 `SCAN_DIRS` 是
 * `["unit","integration","library"]`（`helpers/` 不在其中），而 `walk()` 收目录下**全部 `.ts`** ——
 * `ACCOUNT_WITH_EVERYTHING` 带公网 host 字面量，搬进 `helpers/` 就等于让那一部分覆盖从普查里静默
 * 消失，而下界断言照样绿。**可见的重复优于看不见的失效。**
 *
 * ⚠️ 临时目录挂在 `beforeEach` / `afterEach` 上：这一对钩子随本模块被导入而对**导入它的每一档**生效，
 * 而 `_*.ts` 不带 `.test.ts`，vitest 不会把它收成一份空跑的空档。
 *
 * @module tests/unit/admin/cli
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { runAdminCli } from "@/admin/index.js";
import type { AdminIo } from "@/admin/index.js";

/** 每条用例的 cwd：`beforeEach` 换一个新 `mkdtemp`，`afterEach` 删掉它 */
export let dir = "";

/**
 * 一份把 stdout / stderr / 成功提示**分开**收集的写入面（与真实进程的三条通道逐字对应）
 *
 * @description
 * 导出它是因为 `run()` 的返回类型就是它 —— 「三条通道分得开」是本目录所有呈现层断言的共同前提
 * （`out` 里混进成功提示就污染下游管道），而那个形状属于 `run` 的契约而不属于任何单独一档。
 */
export function makeIo(): AdminIo & { out: string[]; err: string[]; changes: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const changes: string[] = [];
  return {
    out,
    err,
    changes,
    write: (line) => out.push(line),
    warn: (line) => err.push(line),
    changed: (line) => changes.push(line),
  };
}

/** 跑一条命令，返回 `{ code, io }`（`env` 刻意**只**给需要的键，不继承宿主 process.env） */
export async function run(
  argv: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; io: ReturnType<typeof makeIo> }> {
  const io = makeIo();
  const code = await runAdminCli({
    argv,
    env: { NODE_ENV: "development", ...extraEnv },
    cwd: dir,
    io,
  });
  return { code, io };
}

export function usersPath(): string {
  return path.join(dir, "cfg", "users.json");
}

export function aclPath(): string {
  return path.join(dir, "cfg", "acl.json");
}

export function writeUsers(body: unknown): void {
  fs.mkdirSync(path.dirname(usersPath()), { recursive: true });
  fs.writeFileSync(usersPath(), JSON.stringify(body, null, 2));
}

export function readUsers(): unknown[] {
  return JSON.parse(fs.readFileSync(usersPath(), "utf8")) as unknown[];
}

export const ACCOUNT_WITH_EVERYTHING = {
  username: "alice",
  password: "pw1",
  quota: { bytes: 1073741824, window: "day" },
  // 归一后的磁盘形态：`AccountSource.put` 走 `toAccountDoc`，而它用
  // `new Date(epoch).toISOString()`，故落盘恒为带 `.000Z` 的 UTC 串（正则同样收 `Z`）。
  // 基准必须写成这个形态 —— 用它的那些档断言的是「**别的键逐字未变**」，基准本身不对就整组无意义。
  expiresAt: "2030-01-01T00:00:00.000Z",
  disabled: false,
  acl: { target: { whitelist: ["example.com"], blacklist: ["evil.com"] } },
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-cli-"));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不应遮蔽用例结论
  }
});