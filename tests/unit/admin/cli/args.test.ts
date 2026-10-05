/**
 * 参数解析档：用法错是退出码 2，且每一条错都必须**点名**
 *
 * @description
 * 退出码 0/1/2 分开是给脚本用的（`2` = 敲错了重敲，`1` = 命令没错但没做成），合成一个码的话脚本
 * 只能去 grep stderr 文本；而「列出全部可用子命令 / 全部认识的 flag」必须真的含对方想写的那一个，
 * 否则那句话就是一句空话。
 *
 * @module tests/unit/admin/cli
 * 共享的不变量（判据只有一份 / 坏内容硬失败 / 临时目录隔离）在 `./AGENTS.md`。
 */
import { describe, expect, it } from "vitest";
import { AdminUsageError, parseAdminArgs } from "@/admin/args.js";
import { ACCOUNT_WITH_EVERYTHING, run, writeUsers } from "./_admin-cli.js";

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
