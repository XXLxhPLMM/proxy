/**
 * 只读面的档：`config show` 打的是哪三份数据、`usage` 为什么不能清账、jwt 提醒的触发时机
 *
 * @description
 * 「未注册驱动必须抛错」防的是 `AUTH_USERS_DRIVER=mysql` 静默按 json 跑（那等于让人以为接上了数据库、
 * 实际读的是 users.json）；「不能清账」那句必须留在输出里，否则使用者会当成工具没做完。
 *
 * @module tests/unit/admin/cli
 * 共享的不变量（判据只有一份 / 坏内容硬失败 / 退出码三档语义 / 临时目录隔离）在 `./AGENTS.md`。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { AdminUsageError, parseAdminArgs } from "@/admin/args.js";
import { dir, run, writeUsers } from "./_admin-cli.js";

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
