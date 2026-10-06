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

import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { afterEach } from "vitest";
import type { ExecDeps, ExecResult } from "@/lib/exec/run.js";
import type { LogRow } from "@/lib/log/index.js";
import type { ManagerTarget, Method, StatusBody, UsageBody, UsersBody } from "@/api/index.js";
import { COMMAND_PREFIX, parseLine, type Command } from "@/commands/index.js";
/* ── 替身 ────────────────────────────────────────────────────────────────── */

/**
 * 一条请求的线上写法（`Method` 逐字取自契约，故方法名拼错在**编译期**就红）
 * @description ⚠️ **路径那一段刻意不封闭**：它是替身的键，而把 12 条路径抄成一份联合
 * 就是给「路径只有一份真相源」凭空造第二份 —— 抄错的那份只会在某一档静默失配。
 */
export type WireLine = `${Method} ${string}`;

/**
 * 客户端替身：**按线上那一行**安排应答
 * @description 键是 `${method} ${path}` —— 于是「这一档真的只碰了 `GET /api/status`」这件事
 * 由键本身做判据，而不是靠「有一个叫 `status` 的方法被调过」这种间接说法。
 * ⚠️ 未安排的线一律拒（而不是给个空对象）：那一句「本档没有安排 …」比一个空响应更早把
 * 「实现多发了一个请求」这条漂移喊出来。
 *
 * ⚠️ **替身换在 `axios.defaults.adapter` 上**（axios 自己的注入点，而不是本包另设的一个）：
 * 端点函数自己 axios，而 axios 的 Node adapter 是**全局**那一格 ⇒ 一个替身盖得住全部十二个端点，
 * 盖不住的是「axios 走的是哪条传输」这件事本身（那归 `tests/client/` 的真 `http.Server`）。
 * ⚠️ **必须原样还回 `original` 而不是 `delete`**：`axios.defaults.adapter` 的缺省值是
 * `["xhr","http","fetch"]` 那个**数组**，删掉它会让下一个请求抛 `Unknown adapter 'undefined'`。
 */
export type Overrides = Readonly<Record<WireLine, () => Promise<unknown>>>;

/**
 * 一个控制面替身 + 它的请求计数器（守 ⑩ 要的就是「一次都没被调过」）
 * @description 拦在 axios 的**适配器**那一格：端点函数不再经某个 `request()` 对象，
 * 而 axios 逐请求把 `(method, path)` 原样拼进 `config` ⇒ 判据仍然是「线上那一行」。
 *
 * ⚠️ **`afterEach` 自动还原，且逐档装逐档拆是对的**：那一格是**全进程一个**，故
 * 「装上不还原」的症状不是本档红，而是**下一个档**莫名其妙地收不到请求（vitest 的
 * `pool: "forks"` 让每个档一个 worker，于是同档内漏还原平时看不出来 —— 而那正是它危险的原因）。
 * 故 `restore` 同时做两件事：拆掉**自己**装的那一个（嵌套的那几档要靠它逐层收），
 * 并**注销**那条 `afterEach`（否则它会在收尾时把别人刚装上的那个拆掉）。
 * @example const stub = fakeClient({ "GET /api/status": async () => statusBody() })
 */
export function fakeClient(over: Overrides): {
  target: ManagerTarget;
  calls: string[];
  restore(): void;
} {
  const calls: string[] = [];
  const original = axios.defaults.adapter;
  const mine = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    // ⚠️ axios 在适配器之前已经把 `method` **小写化**、把对象体**序列化成字符串**了
    const line = `${String(config.method ?? "get").toUpperCase()} ${String(config.url ?? "")}`;
    calls.push(line);
    const work = over[line as WireLine];
    if (work === undefined) return Promise.reject(new Error(`本档没有安排 ${line}`));
    return { status: 200, statusText: "OK", data: await work(), headers: {}, config };
  };
  axios.defaults.adapter = mine;
  let live = true;
  // ⚠️ 「只拆自己装的那一个」而不是无条件还原：后者在两个替身嵌套时会把外层那个也拆掉
  const off = (): void => {
    live = false;
    if (axios.defaults.adapter === mine) axios.defaults.adapter = original;
  };
  afterEach(off);
  return {
    target: { baseUrl: "http://127.0.0.1:1", token: "t0ken", timeoutMs: 1000 },
    calls,
    // ⚠️ `afterEach` 也会调它，故这两条路径必须**幂等**（`live` 是那道闸）
    restore: (): void => {
      if (live) off();
    },
  };
}

/** 默认的执行上下文：宽 80 的一行，原文默认是那一条命令 */
export function deps(over: Partial<ExecDeps> = {}, line = "/status"): ExecDeps {
  return {
    target: null,
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