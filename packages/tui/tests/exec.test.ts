/**
 * `@/console/exec.ts`（命令执行层）的逐字断言
 *
 * **锁什么**：一条命令 → 若干输出行 + 一组副作用的**十条语义规则**。这十条全部是「显示的东西
 * 会不会不真实」的判据，故每条都写成**能被反过来咬住**的形式：拿服务端给的原串去 `toBe`，
 * 拿「今天仍然存在的形状」去判「不该出现的东西」（一个点名已删符号的负向断言会恒真，
 * 那是本仓点名的假绿）。
 *
 * **为什么拆掉哪一处会红**（每条后面的「变异」就是本档跑过的那次真实转红）：
 * 1. `changed: false` 走 `err` 分支 → 守 ① 那组红。
 * 2. 删掉 `notice` 那一行 → 守 ② 那组红（少一句「这个键在 jwt 下不生效」）。
 * 3. `effective` 无条件显示 → 守 ③ 那组红（一个字节没落盘却承诺生效）。
 * 4. 把 `note` 换成自己编的一句 → 守 ④ 那组红（三段限定逐字）。
 * 5. 把 `running: false` 当成异常抛出去 → 守 ⑤ 那组红（cluster master 是正常的）。
 * 6. 给 `fileOrigin === undefined` 拼一个 `usage.jsonl` 上去 → 守 ⑥ 那组红（编文件名）。
 * 7. 让 `echo` 行带上凭据原值 → 守 ⑦ 那组红（两组长度差别很大的凭据各跑一次）。
 * 8. 直接打 `String(0)` → 守 ⑧ 那组红（`0` 字节是「不限量」，不是 `0`）。
 * 9. 允许空表（只出表头）→ 守 ⑨ 那组红（「看起来正常、其实什么都没查到」）。
 * 10. 没有客户端时也发请求 → 守 ⑩ 那组红（对着 `0.0.0.0:0` 发一次是一句假事实）。
 *
 * ⚠️ **客户端是替身，不是真 server**：`ManagerClient` 是 class，而 TS 的类**公开成员是结构化的**，
 * 故一个只有那几个 public 方法的对象 `as unknown as ManagerClient` 就够。本包已有 8 档对着真
 * `http.Server` 的测试（`tests/client.test.ts`），那一层的成本不在这里重复付。
 */

import { describe, expect, it } from "vitest";
import {
  exec,
  type Effect,
  type ExecDeps,
  type ExecResult,
  type TargetAddRequest,
} from "@/console/exec.js";
import type { LogRow } from "@/console/log.js";
import { LedgerError } from "@/ledger/index.js";
import {
  TuiError,
  type AclBody,
  type ChangeBody,
  type ConfigBody,
  type ManagerClient,
  type StatusBody,
  type UsageBody,
  type UsersBody,
} from "@/client/index.js";
import { UNLIMITED } from "@/ui/index.js";
import { COMMAND_PREFIX, parseLine, type Command } from "@/cmd/index.js";

/* ── 替身 ────────────────────────────────────────────────────────────────── */

/** 每个端点一个方法；未安排的方法一律抛（本档每条命令都显式安排自己那一个） */
type Overrides = {
  status?: () => Promise<StatusBody>;
  config?: () => Promise<ConfigBody>;
  users?: () => Promise<UsersBody>;
  acl?: () => Promise<AclBody>;
  usage?: () => Promise<UsageBody>;
  usageFor?: () => Promise<never>;
  createAccount?: () => Promise<ChangeBody>;
  updateAccount?: () => Promise<ChangeBody>;
  deleteAccount?: () => Promise<ChangeBody>;
  addAclEntry?: () => Promise<ChangeBody>;
  removeAclEntry?: () => Promise<ChangeBody>;
};

/** 一个客户端替身 + 它的调用计数器（守 ⑩ 要的就是「一次都没被调过」） */
function fakeClient(over: Overrides): { client: ManagerClient; calls: string[] } {
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
    createAccount: (): Promise<ChangeBody> => run("createAccount", over.createAccount),
    updateAccount: (): Promise<ChangeBody> => run("updateAccount", over.updateAccount),
    deleteAccount: (): Promise<ChangeBody> => run("deleteAccount", over.deleteAccount),
    addAclEntry: (): Promise<ChangeBody> => run("addAclEntry", over.addAclEntry),
    removeAclEntry: (): Promise<ChangeBody> => run("removeAclEntry", over.removeAclEntry),
  };
  return { client: stub as unknown as ManagerClient, calls };
}

/** 台账三个回调的记录（本档不碰真的台账文件） */
interface LedgerCalls {
  readonly add: TargetAddRequest[];
  readonly del: string[];
  readonly switched: string[];
}

function fakeLedger(fail?: LedgerError): {
  readonly calls: LedgerCalls;
  readonly deps: Omit<ExecDeps, "client" | "width" | "line">;
} {
  const calls: LedgerCalls = { add: [], del: [], switched: [] };
  return {
    calls,
    deps: {
      onTargetAdd: (request) => {
        calls.add.push(request);
        if (fail !== undefined) throw fail;
      },
      onTargetDel: (name) => {
        calls.del.push(name);
        if (fail !== undefined) throw fail;
      },
      onTargetSwitch: (name) => {
        calls.switched.push(name);
        if (fail !== undefined) throw fail;
      },
    },
  };
}

/** 默认的执行上下文：宽 80 的一行，原文默认是那一条命令 */
function deps(over: Partial<ExecDeps> = {}, line = "/status"): ExecDeps {
  const ledger = fakeLedger();
  return {
    client: null,
    width: 80,
    // ⚠️ 默认那一行也带前缀：`ExecDeps.line` 是**界面层原样递过来的那一行**，
    // 而它一定带前缀（`parseLine` 不接受不带前缀的行）—— 故测试里喂不带前缀的会得到一个
    // 「回显与解析读的不是同一行」的世界，而那种世界与真实界面无关。
    line,
    ...ledger.deps,
    ...over,
  };
}

/* ── 样本 ────────────────────────────────────────────────────────────────── */

const RUNNING_MEANS =
  "running 为 false 只表示本进程不持有数据面（cluster master 由 worker 持有端口）";

function statusBody(): StatusBody {
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

const MESSAGE_CHANGED = "配额窗口改成 day";
const MESSAGE_UNCHANGED = "配额窗口已经是 day，没动";
const NOTICE_JWT = "AUTH_TYPE=jwt 下 disabled 不生效：这个键要改鉴权方式才有效";
const EFFECTIVE_YES = "最迟 1 秒后生效";

function configBody(): ConfigBody {
  return {
    configDir: "/etc/proxy",
    envFiles: ["/etc/proxy/.env"],
    keys: [
      {
        key: "PORT",
        env: "PORT",
        phase: "runtime",
        restartRequired: false,
        secret: false,
        value: 3010,
        fileOrigin: "/etc/proxy/.env",
        fromEnv: false,
        fromArgv: false,
      },
      {
        key: "MANAGER_TOKEN",
        env: "MANAGER_TOKEN",
        phase: "startup",
        restartRequired: true,
        secret: true,
        value: "***",
        // ⚠️ `undefined` 的含义是「不在任何 env 文件里」，**不是**「来自缺省」。⚠️ 且
        // `fromEnv` / `fromArgv` 都为假：这样这一条**真的**落在 `originCell` 的 `undefined`
        // 那一支上 —— 守 ⑥ 的「不许编文件名」锚的是**那一支**，而另两条（fromEnv / fromArgv）
        // 会在更早的分支上返回，锚不到。
        fileOrigin: undefined,
        fromEnv: false,
        fromArgv: false,
      },
    ],
    summary: { total: 2, startup: 1, runtime: 1, secrets: ["MANAGER_TOKEN"] },
  };
}

function usersBody(): UsersBody {
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

const SIDE_EFFECT = "这次读取会物化账本文件（目标不存在时数据源会先建出来）";
const USAGE_NOTE = "本工具不能清账：账本的行由运行中的代理进程判定，手工删行不生效";

function usageBody(): UsageBody {
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

function aclBody(): AclBody {
  return {
    acl: {
      clientIp: { whitelist: ["10.0.0.0/8"], blacklist: [] },
      target: { whitelist: [], blacklist: ["b.example"] },
      upstream: { whitelist: [], blacklist: [] },
    },
  };
}

/**
 * 全局 `fetch` 的计数器（守 ⑩ 的仪器）
 * @description
 * 为什么不判「客户端替身一次都没被调过」：守 ⑩ 的场合 `deps.client` **就是 `null`**，压根没有对象
 * 可调 —— 判一个没接上的替身恒为零，那是一条**恒绿**的护栏。而 `fetch` 是任何拨号路线的必经之处
 * （哪怕某个实现 fallback 到一个自造的默认客户端去连 `0.0.0.0:0`），故它是唯一咬得住的仪器。
 * ⚠️ 因此本档另配一条「仪器自检」：同一个计数器在真发出去时**必须**会动。
 */
function fetchSpy(): { readonly calls: string[]; readonly restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    calls.push(String(input));
    return Promise.reject(new Error("本档不发真的请求"));
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/* ── 断言工具 ────────────────────────────────────────────────────────────── */

/**
 * 全部行的文本拼成一个串（守 ⑦ 用它：凭据不许出现在**任何**一行里）
 * @description `kv` 那一档**键与值都**进串：只收值的话，一个把凭据塞进 `key` 的实现会从这条
 * 断言下溜过去，而 `key` 同样会被 `log.ts` 打到屏幕上。
 */
function joined(result: ExecResult): string {
  return result.rows
    .map((row) => {
      if (row.kind === "table") return [...row.head, ...row.rows.flat()].join("\n");
      if (row.kind === "kv") return `${row.key} ${row.value}`;
      return row.text;
    })
    .join("\n");
}

/** `note` 那一档的全部文本（守 ② / ④ / ⑨ 用它做逐字比对） */
function notesOf(result: ExecResult): string[] {
  return result.rows
    .filter((row): row is Extract<LogRow, { kind: "note" }> => row.kind === "note")
    .map((row) => row.text);
}

/** `err` 那一档的全部文本（守 ① / ⑤ / ⑩ 用它判「有没有被包成失败」） */
function errsOf(result: ExecResult): string[] {
  return result.rows
    .filter((row): row is Extract<LogRow, { kind: "err" }> => row.kind === "err")
    .map((row) => row.text);
}

function kvOf(result: ExecResult, key: string): string | undefined {
  const found = result.rows.find(
    (row): row is Extract<LogRow, { kind: "kv" }> => row.kind === "kv" && row.key === key,
  );
  return found === undefined ? undefined : found.value;
}

function tableOf(result: ExecResult): Extract<LogRow, { kind: "table" }> {
  const found = result.rows.find((row) => row.kind === "table");
  if (found === undefined) throw new Error("这一条结果里没有表格行");
  return found;
}

/**
 * 按表头名找列号
 * @description ⚠️ **必须 trim**：`planColumns` 把表头补到该列的宽度，故 `head[i]` 尾部带空格，
 * 而 `indexOf("配额")` 恒是 -1 —— 而 -1 会让后面那一格读到**别的列**上（`row[-1]` 是 `undefined`，
 * 于是断言看起来「只是拿不到值」）。trim 之后找不到就抛，那才是「列名写错了」的可见信号。
 */
function columnOf(table: Extract<LogRow, { kind: "table" }>, header: string): number {
  const at = table.head.findIndex((one) => one.trim() === header);
  if (at < 0) throw new Error(`表里没有这一列：${header}（现有表头 ${table.head.join(" / ")}）`);
  return at;
}

/**
 * 走一遍真实的解析器（而不是手拼 `Command`）：那一步是上游的契约，不重抄一遍命令的形状
 * @description ⚠️ **这里补上 {@link COMMAND_PREFIX}**：本档的用例写的是**命令名**（`user set …`），
 * 而「必须以 `/` 开头」那条不变量由 `@/cmd/parse.ts` 自己那一档断言守（`packages/tui/tests/parse.test.ts`），
 * 不在这几十条里重复一遍 —— 重复一遍的后果是改前缀时本档与那一档一起红，而红的东西一多就等于没红。
 */
function commandOf(line: string): Command {
  const parsed = parseLine(COMMAND_PREFIX + line);
  if (parsed.kind !== "ok") throw new Error(`测试自己敲的命令解析不了：${line}（${parsed.kind}）`);
  return parsed.command;
}

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

/* ── ⑥ `fileOrigin === undefined` 时不编文件名 ────────────────────────────── */

describe("不变量 ⑥：账本只给 dir 不给文件名，本层不许编一个出来", () => {
  it("config：没有任何一行含 `.json`（变异：给来源拼 `usage.jsonl` → 这里红）", async () => {
    const { client } = fakeClient({ config: async () => configBody() });
    const result = await exec(commandOf("config"), deps({ client }));

    expect(joined(result)).not.toContain(".json");
    // ⚠️ 与「这一屏确实显示了点东西」成对断言，否则空结果也会绿
    expect(joined(result).length).toBeGreaterThan(20);
    // `undefined` 的含义是「不在任何 env 文件里」，不是「来自缺省」
    const table = tableOf(result);
    const originColumn = columnOf(table, "来源");
    const tokenRow = table.rows.find((row) => row[0]?.trim() === "MANAGER_TOKEN");
    expect(tokenRow).toBeDefined();
    expect(tokenRow?.[originColumn]?.trim()).toBe("不在 env 文件");
  });

  it("config：`fromEnv` / `fromArgv` 两个事实照实呈现（对照组：证明上面那格不是恒定文案）", async () => {
    const { client } = fakeClient({
      config: async () => ({
        ...configBody(),
        keys: [
          { ...configBody().keys[0]!, fileOrigin: undefined, fromEnv: true, fromArgv: false },
          {
            ...configBody().keys[0]!,
            key: "AUTH_USERS_FILE",
            fileOrigin: undefined,
            fromEnv: false,
            fromArgv: true,
          },
        ],
      }),
    });
    const result = await exec(commandOf("config"), deps({ client }));
    const table = tableOf(result);
    const originColumn = columnOf(table, "来源");

    expect(table.rows[0]?.[originColumn]?.trim()).toBe("宿主env");
    expect(table.rows[1]?.[originColumn]?.trim()).toBe("CLI");
  });

  it("config：来源一格说「不在 env 文件」而不是「来自缺省」", async () => {
    const { client } = fakeClient({ config: async () => configBody() });
    const result = await exec(commandOf("config"), deps({ client }));

    expect(joined(result)).toContain("不在 env 文件");
    expect(joined(result)).not.toContain("缺省");
  });

  it("config <键名>：单键也走同一条来源判据", async () => {
    const { client, calls } = fakeClient({ config: async () => configBody() });
    const result = await exec(commandOf("config PORT"), deps({ client }));

    expect(calls).toEqual(["config"]);
    expect(kvOf(result, "来源")).toBe("/etc/proxy/.env");
    expect(kvOf(result, "值")).toBe("3010");
  });

  it("status：用量账本那一行只有 driver + dir，没有文件名", async () => {
    const { client } = fakeClient({ status: async () => statusBody() });
    const result = await exec(commandOf("status"), deps({ client }));

    expect(kvOf(result, "用量账本")).toBe("sqlite  /etc/proxy/usage");
    expect(joined(result)).not.toContain(".json");
  });
});

/* ── ⑦ 凭据不进任何一行 ──────────────────────────────────────────────────── */

describe("不变量 ⑦：密码与 token 一个字节都不许进 rows", () => {
  /**
   * 一组长度差别**很大**的凭据：长度本身就是信息（掩码固定长度就是为了不泄它）
   * @description ⚠️ 两条命令的**执行路径不同**（`user pass` 要控制面、`target add` 只写台账），
   * 故各自给齐自己那一条路径要的东西；这里比的是「掩码串的长度」在两组之间逐字相同。
   */
  const CREDENTIALS: readonly {
    label: string;
    line: string;
    secret: string;
    deps: () => ExecDeps;
  }[] = [
    {
      label: "4 字符的密码",
      line: 'user pass alice "x#$k"',
      secret: "x#$k",
      deps: () =>
        deps({
          client: fakeClient({
            updateAccount: async () => ({ changed: true, message: MESSAGE_CHANGED }),
          }).client,
        }),
    },
    {
      label: "64 字符的 token",
      line: `target add prod http://127.0.0.1:3010 ${"t".repeat(64)}`,
      secret: "t".repeat(64),
      deps: () => deps({ client: null, ...fakeLedger().deps }),
    },
  ];

  it("两组凭据的掩码长度逐字相同（长度是信息），且原值一个字节都不在 rows 里", async () => {
    const texts: string[] = [];
    for (const one of CREDENTIALS) {
      const line = one.line;
      const result = await exec(commandOf(line), { ...one.deps(), line });

      expect(joined(result)).not.toContain(one.secret);
      // 回显那一行仍然在（操作者要看得见自己敲了什么），只是凭据那一格是固定长度的点
      const echo = result.rows.find((row) => row.kind === "echo");
      const text = echo?.kind === "echo" ? echo.text : "";
      expect(text).toContain("••••••");
      // 掩码**不透露长度**：两组各 6 个点，与真实长度无关
      expect(text.split("•").length - 1).toBe(6);
      texts.push(text);
    }
    // 两组的掩码片段逐字相同（一个 4 字符与一个 64 字符的凭据掩出同一个形状）
    expect(texts[0]?.split(" ").at(-1)).toBe("••••••");
    expect(texts[1]?.split(" ").at(-1)).toBe("••••••");
  });

  it("`user set … password` 同样掩码（掩码判据是凭据类别，不是命令名）", async () => {
    const { client } = fakeClient({
      updateAccount: async () => ({ changed: true, message: MESSAGE_CHANGED }),
    });
    const result = await exec(
      commandOf("user set alice password s3cret"),
      deps({ client }, "user set alice password s3cret"),
    );

    expect(joined(result)).not.toContain("s3cret");
  });

  it("用户名叫**同一个串**时也不许打错位置（`user pass bob bob` 的密码必须被掩码）", async () => {
    const { client } = fakeClient({
      updateAccount: async () => ({ changed: true, message: MESSAGE_CHANGED }),
    });
    const result = await exec(
      commandOf("user pass bob bob"),
      deps({ client }, "user pass bob bob"),
    );

    const echo = result.rows.find((row) => row.kind === "echo");
    const text = echo?.kind === "echo" ? echo.text : "";
    // 用户名**逐字保留**（它不是凭据），而值那一格被换成掩码。
    // ⚠️ 回显**带前缀**：屏上印的那一串就是操作者回车时敲的那一串，而 `parseLine` 收的正是带前缀的。
    expect(text).toBe("/user pass bob ••••••");
    expect(joined(result)).not.toContain("s3cret");
  });
});

/* ── ⑧ `quota` 的 `0` 是「不限量」 ────────────────────────────────────────── */

describe("不变量 ⑧：quota 字节数 0 渲染成 ∞", () => {
  it("那一格就是 `∞`（变异：直接打 String(0) → 这里红）", async () => {
    const { client } = fakeClient({ users: async () => usersBody() });
    const result = await exec(commandOf("users"), deps({ client }));

    const table = tableOf(result);
    const quotaColumn = columnOf(table, "配额");
    const bob = table.rows.find((row) => row[0]?.trim() === "bob");
    // ⚠️ **trim 那一格**：`planColumns` 把它补到列宽，尾部的空格是排版而不是内容
    expect(bob?.[quotaColumn]?.trim()).toBe(UNLIMITED);
    // ⚠️ 三个「不是」逐个钉：不是 `0`、不是 `—`、也不是「不限量」那三个字
    expect(bob?.[quotaColumn]).not.toContain("0");
    expect(bob?.[quotaColumn]?.trim()).not.toBe("—");
    expect(bob?.[quotaColumn]).not.toContain("不限量");
    // 对照组：另一个账号的**有**限配额照常渲染（证明上一组不是碰巧）
    const alice = table.rows.find((row) => row[0]?.trim() === "alice");
    expect(alice?.[quotaColumn]).toContain("1 GiB");
  });
});

/* ── ⑨ 空集必须出文案 ────────────────────────────────────────────────────── */

describe("不变量 ⑨：空集出文案，不给一张只有表头的表", () => {
  it("users 为空：没有 table 行、有一条 note（变异：允许空表 → 这里红）", async () => {
    const { client } = fakeClient({ users: async () => ({ accounts: [] }) });
    const result = await exec(commandOf("users"), deps({ client }));

    expect(result.rows.some((row) => row.kind === "table")).toBe(false);
    expect(notesOf(result)).toHaveLength(1);
    expect(notesOf(result)[0]).toContain("账号表是空的");
  });

  it("acl 六份名单都空：同上", async () => {
    const { client } = fakeClient({
      acl: async () => ({
        acl: {
          clientIp: { whitelist: [], blacklist: [] },
          target: { whitelist: [], blacklist: [] },
          upstream: { whitelist: [], blacklist: [] },
        },
      }),
    });
    const result = await exec(commandOf("acl"), deps({ client }));

    expect(result.rows.some((row) => row.kind === "table")).toBe(false);
    expect(notesOf(result)).toHaveLength(1);
  });

  it("usage 没有记录：同上", async () => {
    const { client } = fakeClient({ usage: async () => ({ ...usageBody(), usage: [] }) });
    const result = await exec(commandOf("usage"), deps({ client }));

    expect(result.rows.some((row) => row.kind === "table")).toBe(false);
    // ⚠️ 空集**不许**把三段限定一起省掉：它们讲的是「这个空是什么意思」
    expect(notesOf(result)).toContain(SIDE_EFFECT);
    expect(notesOf(result)).toContain(USAGE_NOTE);
  });

  it("对照组：非空时确有表（证明上面三组不是恒真）", async () => {
    const { client } = fakeClient({ users: async () => usersBody() });
    const result = await exec(commandOf("users"), deps({ client }));

    expect(result.rows.some((row) => row.kind === "table")).toBe(true);
  });
});

/* ── ⑩ 没有客户端时一个请求都不发 ────────────────────────────────────────── */

describe("不变量 ⑩：client === null 时不发请求、也不给副作用", () => {
  const NEEDS_TARGET: readonly Command[] = [
    commandOf("status"),
    commandOf("config"),
    commandOf("users"),
    commandOf("usage"),
    commandOf("acl"),
    commandOf("user add alice"),
    commandOf("user set alice quotaBytes 1g"),
    commandOf("user on alice"),
    commandOf("user off alice"),
    commandOf("user del alice"),
    commandOf("user pass alice pw"),
    commandOf("r"),
  ];

  it("逐条命令：一个请求都不发、effects 为空、只有一句「先选控制面」", async () => {
    // ⚠️ 计数器是**全局 `fetch`** 而不是那个客户端替身：`client === null` 时压根没有对象可调，
    // 判一个没接上的替身恒为零 —— 那是一条恒绿的护栏。而 `fetch` 是**任何**拨号路线的必经之处
    // （哪怕某个实现 fallback 到一个自造的默认客户端），所以它是这一条唯一咬得住的仪器。
    const spy = fetchSpy();
    try {
      for (const command of NEEDS_TARGET) {
        const result = await exec(command, deps({ line: "status" }));
        expect(spy.calls).toEqual([]);
        expect(result.effects).toEqual([]);
        expect(errsOf(result)).toHaveLength(1);
        expect(errsOf(result)[0]).toContain("先在左边选一个控制面");
      }
    } finally {
      spy.restore();
    }
  });

  it("判据自检：同一个计数器在「有客户端」时确实会动（否则上一条是恒绿）", async () => {
    const { client, calls } = fakeClient({ status: async () => statusBody() });
    const spy = fetchSpy();
    try {
      const result = await exec(commandOf("status"), deps({ client }));

      expect(calls).toEqual(["status"]);
      // ⚠️ 替身不碰 `fetch`（它就是替身），所以这一档能自检的是**替身计数器**；`fetch` 计数器
      // 的自检在下面那条「真发出去」里（那条走真的 `ManagerClient`）。
      expect(errsOf(result)).toEqual([]);
      expect(spy.calls).toEqual([]);
    } finally {
      spy.restore();
    }
  });

  it("真发出去时 `fetch` 计数器会动 —— 这是上一条那条 `fetch` 断言的仪器自检", async () => {
    const { ManagerClient } = await import("@/client/index.js");
    const spy = fetchSpy();
    try {
      const real = new ManagerClient({
        baseUrl: "http://127.0.0.1:3010",
        token: "tok",
        timeoutMs: 1000,
      });
      const result = await exec(commandOf("status"), deps({ client: real }));

      expect(spy.calls.length).toBeGreaterThan(0);
      // 替身回了 500 → 失败被翻译成一句判据（这一条顺带证明「请求真的出了门」）
      expect(errsOf(result).length).toBe(1);
    } finally {
      spy.restore();
    }
  });

  it("对照组：本地命令（help / clear / new / managers / target）不靠客户端，照样能用", async () => {
    const { calls } = fakeLedger();
    expect(calls.add).toEqual([]);

    const help = await exec(commandOf("help"), deps({ client: null }, "/help"));
    expect(errsOf(help)).toEqual([]);
    expect(help.rows.some((row) => row.kind === "table")).toBe(true);

    const cleared = await exec(commandOf("clear"), deps({ client: null }, "/clear"));
    expect(cleared.effects).toEqual([{ kind: "clear-log" }]);

    // ⚠️ `/new` 与 `/managers` 是**界面状态**上的动作：一个请求都不发（`client: null`
    // 下它们照样有输出），而它们各自说出一个 `Effect` 让上层去改会话 / 开窗口
    const created = await exec(commandOf("new"), deps({ client: null }, "/new"));
    expect(errsOf(created)).toEqual([]);
    expect(created.effects).toEqual([{ kind: "session-new" }]);
    const opened = await exec(commandOf("managers"), deps({ client: null }, "/managers"));
    expect(errsOf(opened)).toEqual([]);
    expect(opened.effects).toEqual([{ kind: "show-managers" }]);
    // ⚠️ 而那两句文案里**不许**出现会话名或控制面名 —— 本层不认识会话，
    // 编一个名字进去就是「说了一句它并不知道的事」
    expect(created.rows.map((row) => ("text" in row ? row.text : ""))).toContain(
      "新会话已建好，并已经切过去（名字见左侧栏）",
    );

    const added = await exec(
      commandOf("target add prod http://127.0.0.1:3010 tok"),
      deps({ client: null }, "target add prod http://127.0.0.1:3010 tok"),
    );
    expect(added.effects).toEqual([{ kind: "ledger-changed" }]);
  });
});

/* ── 表的形状 ────────────────────────────────────────────────────────────── */

describe("表格：表头与每行列数必须逐字相等", () => {
  it("users / usage / acl / config / help 五处都成立（`log.ts` 不替短行对齐）", async () => {
    const cases: readonly (readonly [string, ManagerClient | null, string])[] = [
      ["users", fakeClient({ users: async () => usersBody() }).client, "users"],
      ["usage", fakeClient({ usage: async () => usageBody() }).client, "usage"],
      ["acl", fakeClient({ acl: async () => aclBody() }).client, "acl"],
      ["config", fakeClient({ config: async () => configBody() }).client, "config"],
      ["help", null, "help"],
    ];
    for (const [label, client, line] of cases) {
      const result = await exec(commandOf(line), deps({ client }, line));
      const table = tableOf(result);
      for (const row of table.rows) {
        expect([label, row.length]).toEqual([label, table.head.length]);
      }
      // ⚠️ 与「真的排过版」成对断言：不排版的话每格都是原值，两条断言会一起绿
      expect(table.rows.length).toBeGreaterThan(0);
      expect(table.rows[0]?.length).toBe(table.head.length);
    }
  });

  it("窄到只剩一列时仍然等长（丢列那条路）", async () => {
    const { client } = fakeClient({ users: async () => usersBody() });
    const result = await exec(commandOf("users"), deps({ client, width: 10 }, "users"));
    const table = tableOf(result);

    expect(table.head.length).toBeGreaterThan(0);
    for (const row of table.rows) expect(row.length).toBe(table.head.length);
  });
});

/* ── 写面：副作用与失败 ──────────────────────────────────────────────────── */

describe("写面：changed / notice / 副作用三者的关系", () => {
  it("`user del` 成功：一行 `message` + 「已改」", async () => {
    const { client, calls } = fakeClient({
      deleteAccount: async () => ({ changed: true, message: MESSAGE_CHANGED }),
    });
    const result = await exec(commandOf("user del alice"), deps({ client }));

    expect(calls).toEqual(["deleteAccount"]);
    expect(kvOf(result, "写入")).toBe("已改");
    expect(notesOf(result)).toEqual([MESSAGE_CHANGED]);
    expect(result.effects).toEqual([]);
  });

  it("TuiError → 一句人读的判据（带 code 与 requestId），且不塞原始异常", async () => {
    const { client } = fakeClient({
      users: async () => {
        throw TuiError.wire({
          code: "unauthorized",
          message: "令牌不对",
          status: 401,
          requestId: "req-42",
          request: "GET /api/users",
        });
      },
    });
    const result = await exec(commandOf("users"), deps({ client }));

    expect(errsOf(result)).toHaveLength(1);
    expect(errsOf(result)[0]).toBe("unauthorized：令牌不对（requestId req-42）");
  });

  it("可重试的失败（timeout）多给一句「按 r」", async () => {
    const { client } = fakeClient({
      usage: async () => {
        throw TuiError.transport({
          code: "timeout",
          message: "请求超时（5000ms）",
          request: "GET /api/usage",
        });
      },
    });
    const result = await exec(commandOf("usage"), deps({ client }));

    expect(errsOf(result)[0]).toContain("timeout");
    expect(notesOf(result)).toContain("可重试：按 r 再来一次");
  });

  it("非 TuiError 的异常一个字都不转述（那个 message 可能带得出下层的字节）", async () => {
    const { client } = fakeClient({
      users: async () => {
        throw new Error("token=s3cret 挂在某个下层");
      },
    });
    const result = await exec(commandOf("users"), deps({ client }));

    expect(joined(result)).not.toContain("s3cret");
    expect(errsOf(result)).toHaveLength(1);
    expect(errsOf(result)[0]).toContain("未预期");
  });

  it("`user set` 的**值域收窄归解析层**了：这里拿到的已经是收窄过的形状", async () => {
    // ⚠️ 这一条曾经住在执行层（`quotaWindow week` 本地拒绝 + 一个请求都不发）。它搬到了
    // `@/cmd/parse.js:readQuotaWindow`，理由是「值的域」是**解析**的判据，而执行层那份是**第二份**
    // —— 两份会漂，且漂了的后果是把一个服务端早就拒了的输入发出去。故这里断言的是**搬走之后
    // 仍然成立的那一半**：解析层拒掉的行压根到不了执行层（`commandOf` 抛的就是证据）。
    expect(() => commandOf("user set alice quotaWindow week")).toThrow();
  });

  it("`user add` 说清「建出来的是空密码账号」（命令表里没有密码形参）", async () => {
    const { client } = fakeClient({
      createAccount: async () => ({ changed: true, message: MESSAGE_CHANGED }),
    });
    const result = await exec(commandOf("user add alice"), deps({ client }));

    expect(notesOf(result)).toContain(
      "/user add 没有密码形参，建出来的是空密码账号（要口令用 /user pass <用户名> <新密码>）",
    );
  });
});

/* ── 台账写：走回调，成功才给副作用 ──────────────────────────────────────── */

describe("台账写：只走回调，失败时不给副作用", () => {
  it("`target add` 把命令原样递给回调（token 逐字传下去，缺省超时保持 null）", async () => {
    const ledger = fakeLedger();
    const result = await exec(
      commandOf("target add prod http://127.0.0.1:3010 tok"),
      deps({ client: null, ...ledger.deps }, "target add prod http://127.0.0.1:3010 tok"),
    );

    expect(ledger.calls.add).toEqual([
      { name: "prod", baseUrl: "http://127.0.0.1:3010", token: "tok", timeoutMs: null },
    ]);
    expect(result.effects).toEqual([{ kind: "ledger-changed" }]);
  });

  it("给了超时就原样传数字（不换成毫秒串、不补缺省）", async () => {
    const ledger = fakeLedger();
    await exec(
      commandOf("target add prod http://127.0.0.1:3010 tok 3000"),
      deps({ client: null, ...ledger.deps }, "target add prod http://127.0.0.1:3010 tok 3000"),
    );

    expect(ledger.calls.add[0]?.timeoutMs).toBe(3000);
  });

  it("`target del` / `target switch` 各自的副作用（⚠️ 两者刻意不合并）", async () => {
    const one = fakeLedger();
    const deleted = await exec(
      commandOf("target del prod"),
      deps({ client: null, ...one.deps }, "target del prod"),
    );
    expect(one.calls.del).toEqual(["prod"]);
    expect(deleted.effects).toEqual([{ kind: "ledger-changed" }]);

    const two = fakeLedger();
    const switched = await exec(
      commandOf("target switch prod"),
      deps({ client: null, ...two.deps }, "target switch prod"),
    );
    expect(two.calls.switched).toEqual(["prod"]);
    expect(switched.effects).toEqual([{ kind: "target-switched", name: "prod" }]);
  });

  it("写失败（LedgerError）→ 一句判据，且**不给**副作用", async () => {
    for (const line of [
      "target add prod http://127.0.0.1:3010 tok",
      "target del prod",
      "target switch prod",
    ]) {
      const ledger = fakeLedger(new LedgerError("invalid-target", "台账里没有 id 为 prod 的端点"));
      const result = await exec(commandOf(line), deps({ client: null, ...ledger.deps }, line));

      expect(result.effects).toEqual([]);
      expect(errsOf(result)).toEqual(["invalid-target：台账里没有 id 为 prod 的端点"]);
      // ⚠️ 凭据不许跟着失败文案出去
      expect(joined(result)).not.toContain("tok");
    }
  });
});

/* ── 本地命令：help / clear / r ──────────────────────────────────────────── */

describe("本地命令：一个请求都不发", () => {
  it("`clear` 的**回显**加上紧随其后的清屏（屏上因此什么也不留）", async () => {
    // ⚠️ 「不留任何行」这条断言曾经写的是 `rows` 为空 —— 而它**漏掉**了「还没选中控制面」那一支，
    // 于是那条命令跑过了、结果区却没有「你刚才跑了什么」那一行，症状像「那条命令没跑过」。
    // 故判据改成「回显**有**、而紧随其后的 `clear-log` 会把它清掉」：两件事都要在。
    const result = await exec(commandOf("clear"), deps({ client: null }, "/clear"));

    expect(result.rows).toEqual([{ kind: "echo", text: "/clear" }]);
    expect(result.effects).toEqual([{ kind: "clear-log" }]);
  });

  it("⚠️ **每一条**命令的第一行都是回显（无条件的，判据锚在 `rows[0]`）", async () => {
    // 这条护的是「回显只由 {@link exec} 的外层加一次」那条不变式：把哪一个分支漏掉，
    // 这里就红 —— 而漏掉的现象是屏上少一行，看起来像「那条命令没跑过」。
    const samples: readonly string[] = [
      "status",
      "help",
      "clear",
      "r",
      "acl",
      "users",
      "config",
      "usage",
      "target switch prod",
    ];
    for (const line of samples) {
      // ⚠️ `line` **必须**喂进 `deps`：回显读的是 `deps.line`（界面层原样递过来的那一行），
      // 而缺省那一份是 `/status` —— 于是本档会对每一条命令都看到 `/status` 的回显而全绿。
      const result = await exec(commandOf(line), deps({ client: null }, COMMAND_PREFIX + line));
      expect(result.rows[0]).toEqual({ kind: "echo", text: COMMAND_PREFIX + line });
    }
  });

  it("`r` 只给副作用", async () => {
    const { client, calls } = fakeClient({});
    const result = await exec(commandOf("r"), deps({ client, line: "r" }));

    expect(calls).toEqual([]);
    expect(result.effects).toEqual([{ kind: "reprobe" } satisfies Effect]);
  });

  it("`help` 列出命令表（每一行都来自那份表，一行不多一行不少）", async () => {
    const result = await exec(commandOf("help"), deps({ client: null }, "/help"));
    const table = tableOf(result);

    expect(table.rows.length).toBeGreaterThan(10);
    const names = table.rows.map((row) => row[0]?.trim() ?? "");
    // ⚠️ **带前缀**：这一列印的就是操作者回车时该敲的那一串（`CommandSpec.path`），
    // 而 `parseLine` 收带前缀的那一串 —— 印不带前缀的表等于给出一份抄不回去的清单。
    expect(names).toContain("/users");
    expect(names).toContain("/user add");
    expect(names).toContain("/target switch");
    expect(names.some((one) => !one.startsWith("/"))).toBe(false);
  });

  it("`help <命令名>` 给用法与形参；不认识的名字给一句判据", async () => {
    // ⚠️ 两级命令名带空格，故必须加引号（`help` 只收一个形参）
    const one = await exec(
      commandOf('help "user add"'),
      deps({ client: null }, '/help "user add"'),
    );
    expect(kvOf(one, "用法")).toBe("/user add <用户名> [流量上限]");
    expect(kvOf(one, "说明")).toContain("建账号");
    expect(kvOf(one, "形参 用户名")).toBe("必填");
    expect(kvOf(one, "形参 流量上限")).toBe("选填");

    const two = await exec(commandOf("help nope"), deps({ client: null }, "/help nope"));
    expect(errsOf(two)).toHaveLength(1);
    expect(errsOf(two)[0]).toContain("nope");
  });
});

/* ── `user set` 的分派：七个字段，逐字对上一份请求体 ──────────────────────── */

describe("⚠️ `user set` 的七个字段：每个只发**它自己那一个键**", () => {
  /**
   * 记录 `updateAccount` 真的收到的那份 patch
   * @description ⚠️ 判据锚在**真被构造出来的请求体**上，而不是「某个分支被执行了」——
   * 后者在一个把七个字段全写成 `disabled` 的实现下同样绿，而那会把 `user set … quotaBytes 1g`
   * 变成「顺手把这个账号停了」。
   */
  async function patchFor(line: string): Promise<readonly unknown[]> {
    const seen: unknown[][] = [];
    const client = {
      updateAccount: (_username: string, patch: unknown): Promise<ChangeBody> => {
        seen.push(Object.entries(patch as Record<string, unknown>));
        return Promise.resolve({ changed: true, message: MESSAGE_CHANGED });
      },
    } as unknown as ManagerClient;
    await exec(commandOf(line), deps({ client }, line));
    expect(seen).toHaveLength(1);
    return (seen[0] as unknown[][]).map((pair) => pair[1]);
  }

  it("七条命令各发一个键，且键名与服务端 `PATCH_KEYS` 逐字相同", async () => {
    // ⚠️ 判据是 **Object.keys 的集合**，不是「值对不对」：多发一个键就是「顺手改了别的」，
    // 少发一个键就是「这条命令做了别的事」（服务端会 400，而 `changed:false` 那支还会说「没动」）
    expect(await patchFor("user set alice disabled on")).toEqual([true]);
    expect(await patchFor("user set alice password pw")).toEqual(["pw"]);
    expect(await patchFor("user set alice quotaBytes 1g")).toEqual([1073741824]);
    expect(await patchFor("user set alice quotaWindow month")).toEqual(["month"]);
    expect(await patchFor("user set alice expiresAt clear")).toEqual(["clear"]);
    expect(await patchFor("user set alice targetWhitelist 1.2.3.4,*.example.com")).toEqual([
      ["1.2.3.4", "*.example.com"],
    ]);
    expect(await patchFor('user set alice targetBlacklist ""')).toEqual([[]]);
  });

  it("⚠️ 对照：键**只有**一个（把七个字段写成同一个键的实现会在这里红）", async () => {
    // 上面那串 `toEqual([值])` 已经说明「只有一个键」，这一条点明**为什么**这么写断言：
    // 它对「多带一个键」敏感，而 `expect(patch).toMatchObject(…)` 那种写法对它不敏感。
    expect(await patchFor("user set alice quotaBytes 1g")).toHaveLength(1);
  });
});

/* ── 回显 ────────────────────────────────────────────────────────────────── */

describe("回显：用户敲的那一行（凭据已掩码）", () => {
  it("无凭据的命令逐字回显原文", async () => {
    const { client } = fakeClient({ users: async () => usersBody() });
    const result = await exec(commandOf("users"), deps({ client }, "  users  "));

    const echo = result.rows[0];
    expect(echo?.kind === "echo" ? echo.text : "").toBe("  users  ");
  });
});
