/**
 * 本目录各档共用的替身、样本与断言工具。
 *
 * ⚠️ 收件门槛是「**两个以上档真用到**」，不是「看起来通用」：只被一档用到的东西（`configBody` /
 * `aclBody` / `columnOf` / `fetchSpy`）就留在那一档里 —— 搬进来就成了一份没人能单独删掉、
 * 也没人说得清谁在用的间接层。
 *
 * ⚠️ **这里没有跨档共用的可变状态**，故拆档不改变任何一档的语义：两个替身都是**工厂**
 * （`fakeClient` / `deps` 各自返回全新的计数器与全新的样本）。
 * ⚠️ 唯一动全局的是 `fetchSpy` 换入的 `globalThis.fetch`，而它在**一条 `it` 内部**就换回、且只有
 * 「没有客户端」那一档用它 —— 故它留在那一档，不进这里。
 *
 * @module tests/exec
 */

import type { ExecDeps, ExecResult } from "@/lib/exec/run.js";
import type { LogRow } from "@/lib/log/index.js";
import type { ManagerClient } from "@/services/index.js";
import type {
  AclBody,
  ConfigBody,
  StatusBody,
  UsageBody,
  UsersBody,
} from "@/api/index.js";
import { COMMAND_PREFIX, parseLine, type Command } from "@/commands/index.js";
/* ── 替身 ────────────────────────────────────────────────────────────────── */

/** 每个端点一个方法；未安排的方法一律抛（本档每条命令都显式安排自己那一个） */
export type Overrides = {
  status?: () => Promise<StatusBody>;
  config?: () => Promise<ConfigBody>;
  users?: () => Promise<UsersBody>;
  acl?: () => Promise<AclBody>;
  usage?: () => Promise<UsageBody>;
  usageFor?: () => Promise<never>;
};

/** 一个客户端替身 + 它的调用计数器（守 ⑩ 要的就是「一次都没被调过」） */
export function fakeClient(over: Overrides): { client: ManagerClient; calls: string[] } {
  const calls: string[] = [];
  const run = <T>(name: string, work: (() => Promise<T>) | undefined): Promise<T> => {
    calls.push(name);
    if (work === undefined) return Promise.reject(new Error(`本档没有安排 ${name}`));
    return work();
  };
  const stub = {
    status: (): Promise<StatusBody> => run("status", over.status),
    config: (): Promise<ConfigBody> => run("config", over.config),
    users: (): Promise<UsersBody> => run("users", over.users),
    user: (): Promise<never> => run("user", undefined) as Promise<never>,
    acl: (): Promise<AclBody> => run("acl", over.acl),
    usage: (): Promise<UsageBody> => run("usage", over.usage),
    usageFor: (): Promise<never> => run("usageFor", over.usageFor) as Promise<never>,
  };
  return { client: stub as unknown as ManagerClient, calls };
}

/** 默认的执行上下文：宽 80 的一行，原文默认是那一条命令 */
export function deps(over: Partial<ExecDeps> = {}, line = "/status"): ExecDeps {
  return {
    client: null,
    width: 80,
    // ⚠️ 默认那一行也带前缀：`ExecDeps.line` 是**界面层原样递过来的那一行**，
    // 而它一定带前缀（`parseLine` 不接受不带前缀的行）—— 故测试里喂不带前缀的会得到一个
    // 「回显与解析读的不是同一行」的世界，而那种世界与真实界面无关。
    line,
    // ⚠️ **两个注入的读面**：执行层不读台账，而 `/accounts` 与 `/targets` 弹窗各自画的那一份
    // 由上层递进来。缺省给空清单（于是「空集出文案」那一档不必先造数据）。
    accounts: () => ({ accounts: [] }),
    targetsView: () => [],
    peers: () => [],
    ...over,
  };
}

/* ── 样本 ────────────────────────────────────────────────────────────────── */

export const RUNNING_MEANS =
  "running 为 false 只表示本进程不持有数据面（cluster master 由 worker 持有端口）";

export function statusBody(): StatusBody {
  return {
    process: {
      pid: 42,
      startedAt: 1,
      uptimeMs: 3_600_000,
      node: "v22.23.2",
      platform: "linux",
      cwd: "/srv",
    },
    proxy: {
      mode: "master",
      protocol: null,
      host: null,
      port: null,
      running: false,
      startedAt: null,
      uptimeMs: null,
    },
    runningMeans: RUNNING_MEANS,
    data: {
      configDir: "/etc/proxy",
      envFiles: ["/etc/proxy/.env"],
      accounts: { driver: "json", path: "/etc/proxy/accounts" },
      acl: { driver: "json", path: "/etc/proxy/acl" },
      // ⚠️ **只有 `dir`**：服务端刻意不给文件名（给文件名就要造一个数据源）
      usage: { driver: "sqlite", dir: "/etc/proxy/usage" },
      auth: { enabled: true, type: "jwt" },
      quotaResetHour: 0,
      defaultQuotaWindow: "month",
      flushIntervalMs: 1000,
    },
  };
}

export function usersBody(): UsersBody {
  return {
    accounts: [
      {
        username: "bob",
        password: { set: true },
        disabled: false,
        quota: { bytes: 0 },
        expiresAtIso: null,
      },
      {
        username: "alice",
        password: { set: false },
        disabled: true,
        quota: { bytes: 1073741824, window: "day" },
        expiresAt: 1893456000000,
        expiresAtIso: "2030-01-01T00:00:00.000Z",
        acl: { target: { whitelist: ["a.example"], blacklist: [] } },
      },
    ],
  };
}

export const SIDE_EFFECT = "这次读取会物化账本文件（目标不存在时数据源会先建出来）";
export const USAGE_NOTE = "本工具不能清账：账本的行由运行中的代理进程判定，手工删行不生效";

export function usageBody(): UsageBody {
  return {
    usage: [
      { user: "alice", windowKey: "2026-10", total: 1024 },
      { user: "bob", windowKey: "2026-10", total: 4096 },
    ],
    errors: [],
    lagMs: 1200,
    sideEffect: SIDE_EFFECT,
    note: USAGE_NOTE,
  };
}

/* ── 断言工具 ────────────────────────────────────────────────────────────── */

/**
 * 全部行的文本拼成一个串（守 ⑦ 用它：凭据不许出现在**任何**一行里）
 * @description `kv` 那一档**键与值都**进串：只收值的话，一个把凭据塞进 `key` 的实现会从这条
 * 断言下溜过去，而 `key` 同样会被 `log.ts` 打到屏幕上。
 */
export function joined(result: ExecResult): string {
  return result.rows
    .map((row) => {
      if (row.kind === "table") return [...row.head, ...row.rows.flat()].join("\n");
      if (row.kind === "kv") return `${row.key} ${row.value}`;
      return row.text;
    })
    .join("\n");
}

/** `note` 那一档的全部文本（守 ② / ④ / ⑨ 用它做逐字比对） */
export function notesOf(result: ExecResult): string[] {
  return result.rows
    .filter((row): row is Extract<LogRow, { kind: "note" }> => row.kind === "note")
    .map((row) => row.text);
}

/** `err` 那一档的全部文本（守 ① / ⑤ / ⑩ 用它判「有没有被包成失败」） */
export function errsOf(result: ExecResult): string[] {
  return result.rows
    .filter((row): row is Extract<LogRow, { kind: "err" }> => row.kind === "err")
    .map((row) => row.text);
}

export function kvOf(result: ExecResult, key: string): string | undefined {
  const found = result.rows.find(
    (row): row is Extract<LogRow, { kind: "kv" }> => row.kind === "kv" && row.key === key,
  );
  return found === undefined ? undefined : found.value;
}

export function tableOf(result: ExecResult): Extract<LogRow, { kind: "table" }> {
  const found = result.rows.find((row) => row.kind === "table");
  if (found === undefined) throw new Error("这一条结果里没有表格行");
  return found;
}

/**
 * 走一遍真实的解析器（而不是手拼 `Command`）：那一步是上游的契约，不重抄一遍命令的形状
 * @description ⚠️ **这里补上 {@link COMMAND_PREFIX}**：本档的用例写的是**命令名**，
 * 而「必须以 `/` 开头」那条不变量由 `@/commands/parse.ts` 自己那一档断言守
 * （`packages/tui/tests/parse/command-table.test.ts`），不在这几十条里重复一遍 ——
 * 重复一遍的后果是改前缀时本档与那一档一起红，而红的东西一多就等于没红。
 */
export function commandOf(line: string): Command {
  const parsed = parseLine(COMMAND_PREFIX + line);
  if (parsed.kind !== "ok") throw new Error(`测试自己敲的命令解析不了：${line}（${parsed.kind}）`);
  return parsed.command;
}