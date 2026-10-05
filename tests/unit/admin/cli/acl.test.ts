/**
 * 名单档：写面缺失必须硬失败、条目语法逐层挡住、呈现必须一条目一行
 *
 * @description
 * `AclSource.write` 是**可选成员**（第三方名单驱动完全可能只读），所以「写面缺失」这一格只能是一条
 * 响亮的硬失败；呈现那一组钉的是**行宽上界**而不是逐字快照（上界是对规模的断言，40 条和 400 条同样过）。
 *
 * @module tests/unit/admin/cli
 * 共享的不变量（判据只有一份 / 坏内容硬失败 / 退出码三档语义 / 临时目录隔离）在 `./AGENTS.md`。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AclSource } from "@/datasource/acl/index.js";
import { requireAclWrite } from "@/ops/index.js";
import { aclPath, dir, makeIo, run, writeUsers } from "./_admin-cli.js";

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

/**
 * 名单呈现：**一条目一行，且行宽与名单规模无关**
 *
 * @description
 * **锁的不变量**：输出的**每一行**都得窄到在任何终端里不软换行。理由不是好看 —— 整份名单挤进
 * 表格一格时，那格宽过终端就会软换行，而「组 / 方向」列只在**第一**视觉行上，于是绝大多数条目
 * 屏幕上**没有主人的名字**。`acl show` 唯一的职责就是回答「哪些条目在哪个名单里」，那个形状让
 * 它在一屏之内答不出来。
 *
 * 为什么断言「行宽上界」而不是逐字快照，以及**拆掉哪一处会红**，见 `./AGENTS.md`
 * 「防假绿的位置」——**上界是对规模的断言（40 条与 400 条同样过）**，逐字快照只锁住今天这 40 个域名。
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
