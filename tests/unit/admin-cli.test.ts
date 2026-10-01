import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdminCli } from "@/admin/index.js";
import type { AdminIo } from "@/admin/index.js";
import { parseAdminArgs, AdminUsageError } from "@/admin/args.js";
import { requireAclWrite } from "@/ops/index.js";
import type { AclSource } from "@/datasource/acl/index.js";
import { codeOf, sourceFiles, sourceOf } from "../helpers/source-scan.js";

/**
 * `proxy-cli`（管理命令层）的单测
 *
 * @description
 * ## 本档盯的东西，按「错了会怎样」排序
 *
 * 1. **不许悄悄弄丢别人的配置**（第 3 组）。账号表底层只有「整条替换」一个写出口，于是本工具
 *    全部的设计都围绕「别让运维在不知情的情况下丢掉配额」：`user add` 遇已存在的账号**直接拒绝**，
 *    `set` / `disable` / `enable` / `passwd` 一律**读-改-整条写回**且未指定字段逐字保留。
 *    这组是本档存在的主要理由 —— `AccountSource.put` 的注释自己点过名「这是本仓最容易造成
 *    「配额莫名其妙没了」的一个动作」，而 CLI 正是把那个动作摆到人面前的地方。
 * 2. **坏内容不许被当成空表改写**（第 2 组）。数据源层的读语义是「坏内容 → 保留上一份 / 空表 +
 *    一个 `error`」，那对**代理**是对的（判据永不因手滑失效），对**要写数据的工具**是错的 ——
 *    在「我读到的其实是空表」这个前提上 `put`，结果就是把整份真配置清空。故 `readAccountsOrFail`
 *    把 `error` 升级成硬失败。本组用一份**故意写坏**的 `users.json` 断言「拒绝」而不是「清空」。
 * 3. **用法错必须可区分**（第 1 组）。退出码 0/1/2 分开，是给脚本用的：`2` 意味着「敲错了，
 *    重敲」，`1` 意味着「命令没错但没做成」。合成一个码的话脚本只能 grep stderr 文本。
 * 4. **判据只有一份**（第 5 组）。`--expires` 的时刻形态、`--quota` 的数值形态、名单条目语法，
 *    三者的判据全部取自数据源层 / 名单规则层，CLI **不重写**——「CLI 认得、代理不认得」是最坏的
 *    失败形态（用户以为设上了）。
 * 5. **绝不启动代理**（第 6 组，源码级）。`proxy-cli` 不 import `@/core` / `@/runtime` / `@/server`：
 *    它只读配置与数据源。这条只能源码级断言——「没有 import」在运行期完全不可观测，而它一旦破了
 *    后果是管理工具把代理起起来。
 *
 * ## 两档数据源都要跑
 *
 * 账号表有 json / sqlite 两个后端（第 4 组两档都跑）。**等价性不是理所当然的**：`put` 在两档里
 * 是两条不同的实现（重写整文件 vs 单行 UPSERT），而 CLI 的「读-改-写」依赖「未指定字段被保留」，
 * 那是 `put` 的一条**契约**而不是实现细节 —— 两档里任何一档漂了，用户就在其中一档上丢配额。
 */

const ACCOUNT_WITH_EVERYTHING = {
  username: "alice",
  password: "pw1",
  quota: { bytes: 1073741824, window: "day" },
  // 归一后的磁盘形态：`AccountSource.put` 走 `toAccountDoc`，而它用
  // `new Date(epoch).toISOString()`，故落盘恒为带 `.000Z` 的 UTC 串（正则同样收 `Z`）。
  // 基准必须写成这个形态 —— 本组断言的是「**别的键逐字未变**」，基准本身不对就整组无意义。
  expiresAt: "2030-01-01T00:00:00.000Z",
  disabled: false,
  acl: { target: { whitelist: ["example.com"], blacklist: ["evil.com"] } },
};

let dir = "";

/** 一份把 stdout / stderr / 成功提示**分开**收集的写入面（与真实进程的三条通道逐字对应） */
function makeIo(): AdminIo & { out: string[]; err: string[]; changes: string[] } {
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
async function run(
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

function usersPath(): string {
  return path.join(dir, "cfg", "users.json");
}

function aclPath(): string {
  return path.join(dir, "cfg", "acl.json");
}

function writeUsers(body: unknown): void {
  fs.mkdirSync(path.dirname(usersPath()), { recursive: true });
  fs.writeFileSync(usersPath(), JSON.stringify(body, null, 2));
}

function readUsers(): unknown[] {
  return JSON.parse(fs.readFileSync(usersPath(), "utf8")) as unknown[];
}

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

// ---------------------------------------------------------------------------
// 1. 参数解析与退出码
// ---------------------------------------------------------------------------

describe("proxy-cli 参数解析：用法错是退出码 2，且必须点名", () => {
  it("空 argv 打总帮助、退出 0（不是「未知命令」）", async () => {
    const { code, io } = await run([]);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("proxy-cli");
    // 总帮助必须包含「不做的事」那段：查不到的功能只在源码里写理由，使用者的体感是「没做完」
    expect(io.out.join("\n")).toContain("不做的事");
  });

  it("子命令不存在 → 2，且列出全部可用子命令", async () => {
    const { code, io } = await run(["users", "list"]);
    expect(code).toBe(2);
    expect(io.err.join("\n")).toContain("没有这个命令");
    expect(io.err.join("\n")).toContain("user / acl / usage / config");
  });

  it("flag 拼错 → 2，且列出本命令认识的全部 flag（拼错最常见的形态）", async () => {
    const { code, io } = await run(["user", "set", "alice", "--passwrod", "x"]);
    expect(code).toBe(2);
    expect(io.err.join("\n")).toContain("未知参数 --passwrod");
    // 建议里必须含真正想写的那个，否则「列出认识的 flag」就是一句空话
    expect(io.err.join("\n")).toContain("--password");
  });

  it("flag 缺值 → 2", async () => {
    expect((await run(["user", "set", "alice", "--password"])).code).toBe(2);
  });

  it("位置参数个数不对 → 2，且指名多了什么", async () => {
    const { code, io } = await run(["user", "show", "alice", "bob"]);
    expect(code).toBe(2);
    expect(io.err.join("\n")).toContain("多余");
  });

  it("user set 一个字段都不给 → 2（否则会是一次「什么都没改却报成功」）", async () => {
    writeUsers([ACCOUNT_WITH_EVERYTHING]);
    const { code, io } = await run(["user", "set", "alice"]);
    expect(code).toBe(2);
    expect(io.err.join("\n")).toContain("至少要给一个");
  });

  it("user add 不给密码 → 2", async () => {
    expect((await run(["user", "add", "alice"])).code).toBe(2);
  });

  it("--help 在任何位置都优先（拼错子命令时它是唯一出路）", () => {
    expect(parseAdminArgs(["user", "disable", "alice", "--help"])).toEqual({
      kind: "help",
      topic: "user",
    });
    expect(parseAdminArgs(["--help"])).toEqual({ kind: "help" });
  });

  it("`--flag=value` 与 `--flag value` 等价", () => {
    const a = parseAdminArgs(["user", "set", "alice", "--quota", "100"]);
    const b = parseAdminArgs(["user", "set", "alice", "--quota=100"]);
    expect(b).toEqual(a);
  });

  it("三个退出码的语义互不重叠：0 成功 / 1 操作失败 / 2 用法错", async () => {
    expect((await run(["help"])).code).toBe(0);
    expect((await run(["user", "show", "nobody"])).code).toBe(1);
    expect((await run(["nope"])).code).toBe(2);
  });

  it("解析期就把 --quota 的非法值挡住（不给自己一份「静默回落缺省」的机会）", () => {
    expect(() => parseAdminArgs(["user", "set", "a", "--quota", "-5"])).toThrow(AdminUsageError);
    expect(() => parseAdminArgs(["user", "set", "a", "--quota", "1.5"])).toThrow(AdminUsageError);
    expect(() => parseAdminArgs(["user", "set", "a", "--window", "week"])).toThrow(AdminUsageError);
  });
});

// ---------------------------------------------------------------------------
// 2. 坏内容不许被当成空表改写
// ---------------------------------------------------------------------------

describe("proxy-cli 读面：坏内容必须硬失败，不许当成空表", () => {
  it("users.json 内容非法时 user add 拒绝，且**不碰那个文件**", async () => {
    // 这条是本档第 2 组的核心。若读面按数据源层的「保留上一份 / 空表」语义继续，`put` 就会把
    // 这份**写坏但仍然存在**的账号表整份换成一条新记录 —— 一次手滑的文件错误被放大成账号全丢。
    fs.mkdirSync(path.join(dir, "cfg"), { recursive: true });
    fs.writeFileSync(
      usersPath(),
      '[{ "username": "alice", "password": "pw1", "disabled": "yes" }]',
    );
    const before = fs.readFileSync(usersPath(), "utf8");

    const { code, io } = await run(["user", "add", "bob", "pw2"]);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("账号表读不到或内容非法");
    expect(fs.readFileSync(usersPath(), "utf8"), "文件必须逐字未变").toBe(before);
  });

  it("acl.json 内容非法时 acl add 拒绝，且不碰那个文件", async () => {
    fs.mkdirSync(path.join(dir, "cfg"), { recursive: true });
    // 未知的组键 → 整份作废（`validateAcl` 闭合组集合）。⚠️ **不能**拿「少写了某个组」当坏内容：
    // 缺省组与缺省方向都会被补齐，`{ "target": { "whitelist": [] } }` 是**合法**的。
    fs.writeFileSync(aclPath(), '{ "nope": { "whitelist": [] } }');
    const before = fs.readFileSync(aclPath(), "utf8");

    const { code } = await run(["acl", "add", "target", "blacklist", "evil.com"]);
    expect(code).toBe(1);
    expect(fs.readFileSync(aclPath(), "utf8"), "文件必须逐字未变").toBe(before);
  });

  it("`disabled` 不是布尔 → 整份账号表判非法（fail-closed 到整份表）", async () => {
    // 这条同时锁住数据源层那条纪律：`disabled: "yes"` 绝不能被归一成 `false`（= 启用），
    // 那正是「看着配了禁用、实际按没配跑」的假安全感。
    writeUsers([{ username: "a", password: "x", disabled: "yes" }]);
    const { code, io } = await run(["user", "list"]);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("账号表读不到或内容非法");
  });
});

// ---------------------------------------------------------------------------
// 3. 账号写族：字段保全（本档的主要理由）
// ---------------------------------------------------------------------------

describe("proxy-cli user：写操作绝不许弄丢未指定的字段", () => {
  beforeEach(() => {
    writeUsers([ACCOUNT_WITH_EVERYTHING]);
  });

  it("user add 撞上已存在的账号 → 拒绝，并**逐字保留**他原有的 quota/expires/acl", async () => {
    const { code, io } = await run(["user", "add", "alice", "hacked"]);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("user set");
    // 牙齿：底层 `put` 是整条替换，让 add 静默成功 = 「我以为在新建」变成「我清掉了他的配额」
    expect(readUsers()).toEqual([ACCOUNT_WITH_EVERYTHING]);
  });

  it("user disable 只动 disabled，quota / expiresAt / acl 逐字保留", async () => {
    expect((await run(["user", "disable", "alice"])).code).toBe(0);
    expect(readUsers()).toEqual([{ ...ACCOUNT_WITH_EVERYTHING, disabled: true }]);
  });

  it("user enable 把 disabled 显式写回 false（而不是删键 —— 那是运维刚写下的意图）", async () => {
    await run(["user", "disable", "alice"]);
    expect((await run(["user", "enable", "alice"])).code).toBe(0);
    expect(readUsers()).toEqual([ACCOUNT_WITH_EVERYTHING]);
  });

  it("user passwd 只动 password", async () => {
    expect((await run(["user", "passwd", "alice", "newpw"])).code).toBe(0);
    expect(readUsers()).toEqual([{ ...ACCOUNT_WITH_EVERYTHING, password: "newpw" }]);
  });

  it("user set --quota 只动 quota，expiresAt 与 acl 逐字保留", async () => {
    expect((await run(["user", "set", "alice", "--quota", "500"])).code).toBe(0);
    const [alice] = readUsers() as Record<string, unknown>[];
    expect(alice?.quota).toEqual({ bytes: 500, window: "day" });
    expect(alice?.expiresAt).toBe(ACCOUNT_WITH_EVERYTHING.expiresAt);
    expect(alice?.acl).toEqual(ACCOUNT_WITH_EVERYTHING.acl);
  });

  it("user set --quota clear 删掉整个 quota，expiresAt 与 acl 逐字保留", async () => {
    expect((await run(["user", "set", "alice", "--quota", "clear"])).code).toBe(0);
    const [alice] = readUsers() as Record<string, unknown>[];
    expect("quota" in (alice ?? {})).toBe(false);
    expect(alice?.expiresAt).toBe(ACCOUNT_WITH_EVERYTHING.expiresAt);
    expect(alice?.acl).toEqual(ACCOUNT_WITH_EVERYTHING.acl);
  });

  it("user set --target-whitelist 整份替换白名单，黑名单逐字保留", async () => {
    expect((await run(["user", "set", "alice", "--target-whitelist", "a.com,b.com"])).code).toBe(0);
    const [alice] = readUsers() as Record<string, unknown>[];
    expect(alice?.acl).toEqual({
      target: { whitelist: ["a.com", "b.com"], blacklist: ["evil.com"] },
    });
  });

  it("--target-whitelist 空串 = 清空成空名单（**不是「没给」）", async () => {
    expect((await run(["user", "set", "alice", "--target-whitelist", ""])).code).toBe(0);
    const [alice] = readUsers() as Record<string, unknown>[];
    expect(alice?.acl).toEqual({ target: { whitelist: [], blacklist: ["evil.com"] } });
  });

  it("一次 set 改多个字段：未提及的键全部保留", async () => {
    expect(
      (await run(["user", "set", "alice", "--quota", "42", "--disabled", "--password", "z"])).code,
    ).toBe(0);
    expect(readUsers()).toEqual([
      {
        ...ACCOUNT_WITH_EVERYTHING,
        password: "z",
        quota: { bytes: 42, window: "day" },
        disabled: true,
      },
    ]);
  });

  it("user remove 之后 list 为空；remove 不存在的账号 → 1", async () => {
    expect((await run(["user", "remove", "alice"])).code).toBe(0);
    expect((await run(["user", "list"])).io.out.join("\n")).toContain("账号表为空");
    expect((await run(["user", "remove", "alice"])).code).toBe(1);
  });

  it("user show 一个不存在的账号 → 1（不静默打空表）", async () => {
    const { code, io } = await run(["user", "show", "nobody"]);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("没有 nobody");
  });

  it("user list 的表体里有配额与状态，但**不泄露密码**", async () => {
    const { code, io } = await run(["user", "list"]);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("alice");
    expect(text).toContain("1.0 GiB");
    expect(text).not.toContain("pw1");
  });
});

// ---------------------------------------------------------------------------
// 4. 两档数据源等价 + 只读驱动报错
// ---------------------------------------------------------------------------

describe("proxy-cli：账号表两档后端的行为必须逐条一致", () => {
  const sqliteEnv = { AUTH_USERS_DRIVER: "sqlite", AUTH_USERS_DB: "cfg/users.db" };

  it("sqlite 档：add / set / disable / remove 走通，且字段保全与 json 档同一套判据", async () => {
    // `put` 在两档里是两条不同实现（重写整文件 vs 单行 UPSERT），而「未指定字段被保留」是它的
    // **契约**不是实现细节。任何一档漂了，用户就在那一档上丢配额。
    expect((await run(["user", "add", "alice", "pw1"], sqliteEnv)).code).toBe(0);
    expect(
      (await run(["user", "set", "alice", "--quota", "1000", "--window", "day"], sqliteEnv)).code,
    ).toBe(0);
    expect(
      (await run(["user", "set", "alice", "--expires", "2030-01-01T00:00:00Z"], sqliteEnv)).code,
    ).toBe(0);
    expect((await run(["user", "disable", "alice"], sqliteEnv)).code).toBe(0);

    const { code, io } = await run(["user", "show", "alice"], sqliteEnv);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("1000 B");
    expect(text).toContain("day");
    expect(text).toContain("2030-01-01T00:00:00.000Z");
    expect(text).toContain("已禁用");

    expect((await run(["user", "add", "alice", "again"], sqliteEnv)).code).toBe(1);
    expect((await run(["user", "remove", "alice"], sqliteEnv)).code).toBe(0);
  });

  it("sqlite 档：坏内容同样硬失败（不是 json 档独有的讲究）", async () => {
    expect((await run(["user", "add", "alice", "pw1"], sqliteEnv)).code).toBe(0);
    // 直接写库绕过 CLI 是不可能的（doc 列是整条文档），故这里改走「形状非法的账号」路径：
    // 用一个 SQLite 档独有的判据 —— 非法条目语法的个人名单
    expect(
      (await run(["user", "set", "alice", "--target-whitelist", "not a host!"], sqliteEnv)).code,
    ).toBe(1);
  });
});

describe("proxy-cli acl：写面缺失必须明确报错，绝不静默成功", () => {
  it("只读名单驱动 → 1，文案点名驱动名与「只读」", () => {
    // `AclSource.write` 是**可选成员**（第三方名单驱动完全可能只读）。若 CLI 把它当必填，
    // 每个只读驱动就得造一个「假装写成功」的实现 —— 那是最贵的一种假绿。
    const readOnly: AclSource = {
      driver: "readonly-driver",
      locator: () => "/nowhere/acl.json",
      read: () => ({ value: {} as never, path: "/nowhere/acl.json", exists: false }),
      readStartup: async () => ({ value: {} as never, path: "/nowhere/acl.json", exists: false }),
    };
    expect(() => requireAclWrite(readOnly)).toThrow(/只读/);
    try {
      requireAclWrite(readOnly);
    } catch (error) {
      expect((error as Error).message).toContain("readonly-driver");
    }
  });

  it("有写面的驱动 → 返回一个可调用的函数（探测路径本身是正向的）", () => {
    const written: unknown[] = [];
    const writable: AclSource = {
      driver: "json",
      locator: () => "/nowhere/acl.json",
      read: () => ({ value: {} as never, path: "/nowhere/acl.json", exists: false }),
      readStartup: async () => ({ value: {} as never, path: "/nowhere/acl.json", exists: false }),
      write: (next) => written.push(next),
    };
    const write = requireAclWrite(writable);
    write({} as never);
    expect(written).toHaveLength(1);
  });
});

describe("proxy-cli acl：名单读与写", () => {
  it("add / remove 走通并落盘；重复 add 与不存在的 remove 都说「没动」", async () => {
    expect((await run(["acl", "add", "target", "blacklist", "evil.com"])).code).toBe(0);
    expect((await run(["acl", "add", "clientip", "whitelist", "10.0.0.0/8"])).code).toBe(0);

    const acl = JSON.parse(fs.readFileSync(aclPath(), "utf8")) as {
      clientIp: { whitelist: string[] };
      target: { blacklist: string[] };
    };
    expect(acl.clientIp.whitelist).toEqual(["10.0.0.0/8"]);
    expect(acl.target.blacklist).toEqual(["evil.com"]);

    const again = await run(["acl", "add", "target", "blacklist", "evil.com"]);
    expect(again.code).toBe(0);
    expect(again.io.changes.join("\n")).toContain("没动");

    const missing = await run(["acl", "remove", "target", "blacklist", "never.com"]);
    expect(missing.code).toBe(0);
    expect(missing.io.changes.join("\n")).toContain("没动");

    expect((await run(["acl", "remove", "target", "blacklist", "evil.com"])).code).toBe(0);
  });

  it("条目非法 → 1，且错误**点名那个条目**并给出该组的正确语法", async () => {
    // 整份名单校验只会说「形状非法」，对着三组六数组猜是哪个错。CLI 的增量价值就在这里。
    const bad = await run(["acl", "add", "clientip", "whitelist", "example.com"]);
    expect(bad.code).toBe(1);
    expect(bad.io.err.join("\n")).toContain("example.com");
    expect(bad.io.err.join("\n")).toContain("只收 IP");
  });

  it("组名 / 名单方向 / 条目语法三层都在写之前挡住", async () => {
    expect((await run(["acl", "add", "nope", "whitelist", "1.2.3.4"])).code).toBe(2);
    expect((await run(["acl", "add", "target", "nope", "1.2.3.4"])).code).toBe(2);
    // target 组不收端口（名单按 host 字符串匹配，不含端口）
    expect((await run(["acl", "add", "target", "blacklist", "1.2.3.4:8080"])).code).toBe(1);
  });

  it("acl show 打的是解析后的绝对路径与驱动名", async () => {
    const { code, io } = await run(["acl", "show"]);
    expect(code).toBe(0);
    expect(io.err.join("\n")).toContain(path.join(dir, "cfg", "acl.json"));
    expect(io.err.join("\n")).toContain("json");
  });
});

// ---------------------------------------------------------------------------
// 5. 判据只有一份（expires 的时刻形态）
// ---------------------------------------------------------------------------

describe("proxy-cli：--expires 的判据必须取自数据源层，不许自己 Date.parse", () => {
  beforeEach(() => {
    writeUsers([{ username: "alice", password: "pw1" }]);
  });

  it.each([
    ["无时区偏移", "2027-01-01"],
    ["空格分隔", "2027-01-01 00:00"],
    ["日历上不存在的日", "2027-02-30T00:00:00Z"],
    ["月 13", "2027-13-01T00:00:00Z"],
    ["时 24", "2027-01-01T24:00:00Z"],
  ])("%s → 拒绝，且文件逐字未变", async (_why, value) => {
    // `Date.parse("2027-01-01")` 返回一个**有限值**（UTC 午夜），`Date.parse("2027-01-01 00:00")`
    // 返回**本地**午夜 —— 同一份配置在 UTC 机器与 +08:00 机器上差 8 小时，而运维写它时心里想
    // 的一定是本地零点。CLI 若自己用 Date.parse 判，就成了「CLI 认得、代理不认得」的那一档。
    const before = fs.readFileSync(usersPath(), "utf8");
    const { code } = await run(["user", "set", "alice", "--expires", value]);
    expect(code).toBe(1);
    expect(fs.readFileSync(usersPath(), "utf8")).toBe(before);
  });

  it.each([
    ["带 +08:00 偏移", "2027-03-01T12:00:00+08:00"],
    ["带 Z", "2027-03-01T04:00:00Z"],
  ])("%s → 接受，且落盘是合法形态", async (_why, value) => {
    expect((await run(["user", "set", "alice", "--expires", value])).code).toBe(0);
    const [alice] = readUsers() as { expiresAt?: string }[];
    // 落盘形态经 `toAccountDoc` 归一成 UTC `Z` —— 那也是合法磁盘形态（正则收 `Z`）
    expect(alice?.expiresAt).toMatch(/Z$/);
  });

  it("--expires clear 删键", async () => {
    await run(["user", "set", "alice", "--expires", "2030-01-01T00:00:00Z"]);
    expect((await run(["user", "set", "alice", "--expires", "clear"])).code).toBe(0);
    const [alice] = readUsers() as Record<string, unknown>[];
    expect("expiresAt" in (alice ?? {})).toBe(false);
  });

  it("--window 挂在没有 quota 的账号上 → 拒绝（别造一条「没上限、只有窗口」的记录）", async () => {
    const { code, io } = await run(["user", "set", "alice", "--window", "day"]);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("没有 quota");
  });
});

// ---------------------------------------------------------------------------
// 6. 名单条目很多时的**行宽**（`acl show` / `user show`）
// ---------------------------------------------------------------------------

/**
 * 名单呈现：**一条目一行，且行宽与名单规模无关**
 *
 * @description
 * **锁的不变量**：输出的**每一行**都得窄到在任何终端里不软换行。理由不是好看 —— 整份名单挤进
 * 表格一格时，那格宽过终端就会软换行，而「组 / 方向」列只在**第一**视觉行上，于是绝大多数条目
 * 屏幕上**没有主人的名字**。`acl show` 唯一的职责就是回答「哪些条目在哪个名单里」，那个形状让
 * 它在一屏之内答不出来。
 *
 * **为什么断言「行宽上界」而不是断言某几行逐字相同**：上界是对**规模**的断言（40 条和 400 条
 * 同样过），把 `join(", ")` 塞回任何一格都会立刻破它；而逐字快照只锁住今天这 40 个域名，
 * 换个测试数据就绿，护栏会假绿。
 *
 * **拆掉哪一处会红**：`renderSections` 被换回「一格 join(", ")」的表格（`acl show` 与 `user show`
 * 都经它，故两条都红）；或者 `items` 改成只打条数不打条目（归属断言红，宽上界仍绿）。
 */
describe("proxy-cli 名单呈现：条目逐行，行宽不随名单规模增长", () => {
  /** 一份**条目多到必然撑爆窄终端**的名单（40 条 × 每条 ~20 字符 = 单行约 800 字符） */
  const MANY = Array.from({ length: 40 }, (_, i) => `host-${i}.a-fairly-long-domain.example`);

  function writeAcl(acl: unknown): void {
    fs.mkdirSync(path.dirname(aclPath()), { recursive: true });
    fs.writeFileSync(aclPath(), JSON.stringify(acl));
  }

  /** 输出里最宽的一行（按**显示宽度**算，中文与全角不能按字节数算） */
  function widestLine(io: ReturnType<typeof makeIo>): number {
    return io.out
      .join("\n")
      .split("\n")
      .reduce((w, line) => Math.max(w, [...line].length), 0);
  }

  it("acl show：40 条一格装不下时，行宽仍远窄于数据量", async () => {
    writeAcl({ upstream: { whitelist: MANY } });
    const { code, io } = await run(["acl", "show"]);
    expect(code).toBe(0);
    const lines = io.out.join("\n").split("\n");
    // 判据是上界而不是快照：这条与「今天放了多少条」无关，40 条与 400 条同样过
    expect(widestLine(io), "没有任何一行接近数据规模").toBeLessThan(40);
    // 对照：把 40 条挤进一格会有 ~800 字符的一行 —— 上面那条上界就是在钉它
    expect(MANY.join(", ").length).toBeGreaterThan(700);
    expect(io.out.join("\n")).toContain("upstream.whitelist  40 条");
    // 归属可读：每个条目自己占一行（`io.write` 收的是整块，行要从块里拆出来）
    expect(lines.filter((l) => l === `  ${MANY[7]}`), "每个条目逐字独占一行").toHaveLength(1);
  });

  it("acl show：每条目的主人就是它**上面那一行**（六个格子都出标题，空的也出）", async () => {
    writeAcl({ upstream: { whitelist: MANY, blacklist: ["blocked.example"] } });
    const lines = (await run(["acl", "show"])).io.out.join("\n").split("\n");
    // 六个格子全在，且**空的也列出** —— 省掉空格子就分不清「空的」与「没列出来的」
    for (const title of [
      "clientip.whitelist",
      "clientip.blacklist",
      "target.whitelist",
      "target.blacklist",
      "upstream.whitelist",
      "upstream.blacklist",
    ]) {
      expect(lines.some((l) => l.startsWith(`${title} `)), `${title} 必须出标题行`).toBe(true);
    }
    // 归属判据：条目的主人 = 往上第一条**非缩进**的行
    const ownerOf = (entry: string): string =>
      (() => {
        const at = lines.indexOf(`  ${entry}`);
        return lines.slice(0, at).filter((l) => !l.startsWith("  ")).at(-1) ?? "";
      })();
    for (const entry of MANY) {
      expect(ownerOf(entry)).toMatch(/^upstream\.whitelist\s+40 条$/);
    }
    expect(ownerOf("blocked.example")).toMatch(/^upstream\.blacklist\s+1 条$/);
    // 白名单最后一个**不**被算成黑名单的条目：黑名单那节的标题行之后不许再有白名单的条目
    const blacklistAt = lines.findIndex((l) => l.startsWith("upstream.blacklist"));
    expect(lines.slice(blacklistAt).join("\n")).not.toContain(MANY[0]);
  });

  it("user show：账号自己的 acl.target 两张名单同样是逐条一行", async () => {
    writeUsers([
      { username: "bob", password: "pw", acl: { target: { whitelist: MANY, blacklist: [] } } },
    ]);
    const { code, io } = await run(["user", "show", "bob"]);
    expect(code).toBe(0);
    expect(widestLine(io), "账号名下的名单不许撑宽任何一行").toBeLessThan(40);
    const lines = io.out.join("\n").split("\n");
    expect(lines.filter((l) => l === `  ${MANY[3]}`)).toHaveLength(1);
    expect(io.out.join("\n")).toContain("acl.target.whitelist  40 条");
    expect(io.out.join("\n")).toContain("acl.target.blacklist  0 条");
  });
});

// ---------------------------------------------------------------------------
// 7. config / usage / jwt 提醒 / 源码级护栏
// ---------------------------------------------------------------------------

describe("proxy-cli config show：操作的是哪三份数据必须可核对", () => {
  it("打的是解析后的绝对路径 + 驱动名 + 配置目录", async () => {
    const { code, io } = await run(["config", "show"]);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain(dir);
    expect(text).toContain(path.join(dir, "cfg", "users.json"));
    expect(text).toContain(path.join(dir, "cfg", "acl.json"));
    expect(text).toMatch(/驱动 json/);
  });

  it("驱动名写错 → 1，且**不改任何数据**（未注册驱动必须抛错并列出已注册项）", async () => {
    // `AUTH_USERS_DRIVER=mysql` 静默按 json 跑 = 「以为接上了数据库、实际读的是 users.json」。
    const { code, io } = await run(["user", "list"], { AUTH_USERS_DRIVER: "mysql" });
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("mysql");
  });

  it("sqlite 档打的是 AUTH_USERS_DB 而不是 AUTH_USERS_FILE", async () => {
    const { io } = await run(["config", "show"], {
      AUTH_USERS_DRIVER: "sqlite",
      AUTH_USERS_DB: "cfg/other.db",
    });
    expect(io.out.join("\n")).toContain(path.join(dir, "cfg", "other.db"));
  });
});

describe("proxy-cli usage：只读，且必须说清它不能清账", () => {
  it("空账本 → 0，输出「没有任何计量记录」", async () => {
    const { code, io } = await run(["usage", "show"]);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("没有任何计量记录");
  });

  it("只读：usage 后面除了 show 没有任何子命令（没有 reset）", () => {
    // 这不是「还没做」，是**做不到**：判定读进程内镜像、合并用 max，从第二个进程删账本里的行
    // 对运行中的代理永不生效，而退出码会是 0。完整推导在 `src/ops/usage.ts` 文件头。
    expect(() => parseAdminArgs(["usage", "reset", "alice"])).toThrow(AdminUsageError);
    expect(() => parseAdminArgs(["usage", "clear"])).toThrow(AdminUsageError);
  });

  it("输出里必须带那句「不能清账 + 为什么」，否则使用者会当成工具没做完", async () => {
    const { io } = await run(["usage", "show"]);
    expect(io.err.join("\n")).toContain("不能清账");
  });

  it("查一个没有记录的用户 → 1，并说清「没记录」是什么意思", async () => {
    const { code, io } = await run(["usage", "show", "nobody"]);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("从没被计量过");
  });
});

describe("proxy-cli：jwt 模式下改完要当场提醒字段不生效", () => {
  it("AUTH_TYPE=jwt + disable → 提醒；basic → 不提醒", async () => {
    writeUsers([{ username: "alice", password: "pw1" }]);
    const jwt = await run(["user", "disable", "alice"], { AUTH_TYPE: "jwt", AUTH_ENABLED: "true" });
    expect(jwt.code).toBe(0);
    expect(jwt.io.err.join("\n")).toContain("不会生效");
    expect(jwt.io.err.join("\n")).toContain("disabled");

    const basic = await run(["user", "enable", "alice"], { AUTH_TYPE: "basic" });
    expect(basic.io.err.join("\n")).not.toContain("不会生效");
  });

  it("只读命令不提醒（提醒是给「刚写进去的东西」的）", async () => {
    writeUsers([{ username: "alice", password: "pw1", disabled: true }]);
    const { io } = await run(["user", "list"], { AUTH_TYPE: "jwt" });
    expect(io.err.join("\n")).not.toContain("不会生效");
  });
});

describe("proxy-cli 源码级护栏", () => {
  // `proxy-cli` 的**全部**源文件：传输层（`src/admin/`：解析 / 派发 / 渲染）与数据源操作层
  // （`src/ops/`：装配 / 读 / 写 / 账本读 / 配置事实）。两条禁令对两层**都**成立：ops 不启动
  // 代理（它只是不碰进程），它也必须零 console —— 否则「结构化返回、渲染归传输层」就是一句空话，
  // 而这条断言是那句话唯一的牙齿。
  // **列目录而不是写死文件名**：新增的文件必须自动进扫描范围，否则它对这两条护栏恒绿。
  const toolFiles = sourceFiles("admin", "ops");

  it("**绝不启动代理**：零 `@/core` / `@/runtime` / `@/server` import", () => {
    // ⚠️ **先证明扫描范围非空**：下面两个 for 循环若拿到空数组就**整组恒绿**——而那正是「护栏
    // 看起来在生效、实际什么都没扫」。判据取两个真实存在的文件（传输层与 ops 各一个）。
    expect(toolFiles).toContain("admin/index.ts");
    expect(toolFiles).toContain("ops/sources.ts");
    // 这条只能源码级：运行期完全观测不到「没 import 什么」，而它一旦破了后果是「管理工具把代理
    // 起起来了」——那会让一条 `user list` 占着一个监听端口。
    for (const file of toolFiles) {
      const code = codeOf(file);
      expect(code, `${file} 不许 import 代理侧`).not.toMatch(/from\s+"@\/(core|runtime|server)\//);
    }
    expect(codeOf("cli-admin.ts")).not.toMatch(/from\s+"@\/(core|runtime|server)\//);
    // 而组合根不许碰起进程的那些东西
    const root = codeOf("cli-admin.ts");
    expect(root).not.toMatch(/runServer|ProxyServer|createProxyRuntime/);
  });

  it("零 console / 零 process.*：写入面必须经 AdminIo 注入", () => {
    // 命令层要能在单测里直接断言输出；捕获 console 是一种会漏（异步交错、格式化被重定向）的
    // 间接做法，而 `.eslintrc.js` 的 `no-console` 在本目录同样是 error。ops 层连注入的面都没有，
    // 它只能返回结构化数据 —— 它一旦有 console，「渲染归传输层」当场失效。
    for (const file of toolFiles) {
      expect(codeOf(file), `${file} 不许有 console`).not.toMatch(/\bconsole\./);
      expect(codeOf(file), `${file} 不许碰 process`).not.toMatch(/\bprocess\./);
    }
    // 例外只有组合根：它**就是**宿主环境采集与进程退出的边界
    expect(codeOf("cli-admin.ts")).toMatch(/process\./);
  });

  it("argv 不进 loadConfig：那个调用点的 argv 必须是空数组", () => {
    // 混进同一条通路的两种做法都更坏（在未知键闸门前剥掉 ⇒ 自己的参数拼错零信号；把子命令词
    // 塞进 NON_CONFIG_ENV_KEYS ⇒ 那是配置键的容忍名单）。判据是「那一个调用点的 argv 形状」。
    const body = codeOf("ops/sources.ts");
    expect(body).toMatch(/argv:\s*\[\]/);
  });

  it("跳过启动期文件校验（否则「加第一个账号」在 basic + 空表时会被启动中止挡住）", () => {
    expect(codeOf("ops/sources.ts")).toMatch(/skipFileValidation:\s*true/);
  });

  it("config show 用的是与 CLI 同一份接线（不许自己折一份「哪个键装哪个驱动」）", () => {
    const body = codeOf("ops/sources.ts");
    expect(body).toMatch(/accountLocatorFor/);
    expect(body).toMatch(/aclLocatorFor/);
    expect(body).toMatch(/defaultEnvFileNames/);
  });
});

describe("proxy-cli：成功提示走 stderr，stdout 保持干净", () => {
  it("user list 的 stdout 里没有「已…」这类成功提示", async () => {
    // 运维常在管道里跑脚本；成功提示混进 stdout 会污染下游（`> list.txt` 之后再 `awk` 就炸了）。
    writeUsers([{ username: "alice", password: "pw1" }]);
    const { io } = await run(["user", "list"]);
    expect(io.out.join("\n")).not.toContain("已");
    expect(io.out.join("\n")).toContain("USERNAME");
  });

  it("写操作的提示落在 changed 通道（stderr 侧）", async () => {
    const { io } = await run(["user", "add", "alice", "pw1"]);
    expect(io.changes.join("\n")).toContain("已新建账号 alice");
    expect(io.out.join("\n")).toBe("");
  });
});

describe("proxy-cli 组合根（src/cli-admin.ts）", () => {
  it("import 本模块零副作用：不读 argv、不解析配置、不退出进程", () => {
    // 与 `src/cli.ts` 同纪律：只有 `require.main === module` 时才采集宿主来源。
    // 判据是「快照与 runAdminCli 都锁在那个门控里」——它在文件尾，故从门控起切到文件末。
    const code = codeOf("cli-admin.ts");
    const gate = code.indexOf("require.main === module");
    expect(gate).toBeGreaterThanOrEqual(0);
    const before = code.slice(0, gate);
    expect(before, "门控之前不许有 process.argv / process.env / process.cwd").not.toMatch(
      /process\.(argv|env|cwd)/,
    );
    expect(code).toMatch(/process\.exitCode/);
  });

  it("它与代理 CLI 是两个文件（两个组合根，一个进程一个）", () => {
    expect(fs.existsSync(path.join(__dirname, "..", "..", "src", "cli-admin.ts"))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, "..", "..", "src", "cli.ts"))).toBe(true);
    // 名字对齐：组合根文件 → 产物名
    expect(sourceOf("cli-admin.ts")).toContain("proxy-cli");
  });
});
