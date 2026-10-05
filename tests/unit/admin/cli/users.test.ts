/**
 * 账号写族档：**读-改-整条写回**时未指定的字段必须逐字保留
 *
 * @description
 * `AccountSource.put` 的注释自己点过名「这是本仓最容易造成『配额莫名其妙没了』的一个动作」，而 CLI
 * 正是把那个动作摆到人面前的地方；json/sqlite 两档里 `put` 是两条不同实现，「未指定字段被保留」是它的
 * **契约**而不是实现细节。读面同理：坏内容不许被当成空表改写（数据源层「保留上一份 / 空表 + 一个
 * `error`」的语义对代理是对的，对要写数据的工具是错的）。
 *
 * @module tests/unit/admin/cli
 * 共享的不变量（判据只有一份 / 坏内容硬失败 / 退出码三档语义 / 临时目录隔离）在 `./AGENTS.md`。
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_WITH_EVERYTHING,
  aclPath,
  dir,
  readUsers,
  run,
  usersPath,
  writeUsers,
} from "./_admin-cli.js";

describe("proxy-cli 读面：坏内容必须硬失败，不许当成空表", () => {
  it("users.json 内容非法时 user add 拒绝，且**不碰那个文件**", async () => {
    // 这条是读面那一组的核心。若按数据源层的「保留上一份 / 空表」语义继续，`put` 就会把
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
