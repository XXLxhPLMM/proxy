import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OpsError,
  addAccount,
  addAclEntry,
  applyPatch,
  getAccount,
  listAccounts,
  readAcl,
  readUsage,
  removeAccount,
  reportConfig,
  requireAclWrite,
  setAccount,
  setAccountEnabled,
  usageFor,
} from "@/ops/index.js";
import type { AclSource } from "@/datasource/acl/index.js";
import { ACCOUNT, ACCOUNT_DOC, dir, ops, writeUsers } from "./_ops.js";

/**
 * `ops` 读面与失败分类（`src/ops/`）
 *
 * @description
 * 本档管两件事：**读面出结构化数据**（不渲染）与 **`OpsError.code` 这个原因分类**。
 * 主题级不变量（`@/ops` 的五条、为什么幂等那档要用替身名单驱动）见 `./AGENTS.md`；
 * 层边界的源码级断言在 `./source-guards.test.ts`。
 */

function usersPath(): string {
  return path.join(dir, "cfg", "users.json");
}

function aclPath(): string {
  return path.join(dir, "cfg", "acl.json");
}

/** 目录下的全部文件名（**相对路径、排序**）——用来断言「这个动作没有造出任何文件」 */
function treeFiles(): string[] {
  const out: string[] = [];
  const walk = (prefix: string): void => {
    for (const name of fs.readdirSync(path.join(dir, prefix)).sort()) {
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (fs.statSync(path.join(dir, rel)).isDirectory()) {
        walk(rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk("");
  return out;
}

describe("ops 读面：出结构化数据，形状取自数据源层", () => {
  it("账号表出归一化账号数组，单账号按名取", async () => {
    writeUsers([ACCOUNT_DOC]);
    const sources = await ops();

    const accounts = listAccounts(sources);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.username).toBe("alice");
    // 出的是**结构体**（quota 的 bytes 仍是一个数），不是已经格式化好的 `1.0 GiB`
    expect(accounts[0]?.quota).toEqual({ bytes: 1073741824, window: "day" });
    expect(getAccount(sources, "alice").password).toBe("pw1");
  });

  it("名单出三组齐备的 AclConfig 文档", async () => {
    fs.mkdirSync(path.dirname(aclPath()), { recursive: true });
    fs.writeFileSync(aclPath(), '{ "target": { "blacklist": ["evil.com"] } }');
    const acl = readAcl(await ops());
    // 缺省组与缺省方向都被补齐了——读面出的是**归一后的整份**，不是原始 JSON
    expect(Object.keys(acl).sort()).toEqual(["clientIp", "target", "upstream"]);
    expect(acl.target.blacklist).toEqual(["evil.com"]);
    expect(acl.clientIp.whitelist).toEqual([]);
  });

  it("账本出 Map + 误差上界，不出表格", async () => {
    const reading = await readUsage(await ops());
    expect(reading.usage).toBeInstanceOf(Map);
    expect(reading.errors).toEqual([]);
    expect(typeof reading.lagMs).toBe("number");
  });

  it("配置报告是**字段**，且一个文件都不造（为多打一行造数据源会把无副作用动作变成建文件）", async () => {
    const sources = await ops();
    const before = treeFiles();

    const report = reportConfig(sources);

    expect(treeFiles(), "读配置不许造出任何文件（账本尤其）").toEqual(before);
    expect(report.configDir).toBe(dir);
    expect(report.accounts.path).toBe(usersPath());
    expect(report.acl.path).toBe(aclPath());
    expect(report.auth).toEqual({ enabled: false, type: "none" });
    // ⚠️ **只有目录**：文件名的算法住在两个数据源实现器里，报告里没有它
    expect(report.usage.dir).not.toBe("");
    expect("file" in report.usage).toBe(false);
  });

  it("写面出 { changed, message }，message 是中性事实陈述（不含 CLI 语气与通道前缀）", async () => {
    writeUsers([ACCOUNT_DOC]);
    const sources = await ops();

    const added = addAccount(sources, "bob", "pw2", {});
    expect(added.changed).toBe(true);
    expect(added.message).toBe("已新建账号 bob");
    expect(added.message, "返回值不许带前缀/换行，那是渲染层的事").not.toMatch(/\n|失败|错误/);

    expect(setAccount(sources, "bob", { quotaBytes: 42 }).message).toBe("账号 bob 已更新");
    expect(setAccountEnabled(sources, "bob", true).message).toBe("账号 bob 已禁用");
    expect(removeAccount(sources, "bob").message).toBe("已删除账号 bob");
  });
});

describe("ops 失败：OpsError.code 是原因的唯一机器可读形状", () => {
  /** 断言「抛的是 OpsError 且 code 是这个」——顺带证明 code 不是靠 message 猜的 */
  async function expectCode(fn: () => unknown | Promise<unknown>, code: string): Promise<Error> {
    let caught: unknown;
    try {
      await fn();
    } catch (error) {
      caught = error;
    }
    expect(caught, "这次调用必须失败").toBeInstanceOf(OpsError);
    expect((caught as OpsError).code).toBe(code);
    return caught as Error;
  }

  it("目标不存在 → not-found", async () => {
    writeUsers([]);
    const sources = await ops();
    await expectCode(() => getAccount(sources, "nobody"), "not-found");
    await expectCode(() => removeAccount(sources, "nobody"), "not-found");
    await expectCode(() => setAccount(sources, "nobody", { disabled: true }), "not-found");
  });

  it("目标已存在 → already-exists，且**一个字节都没动**", async () => {
    writeUsers([ACCOUNT_DOC]);
    const sources = await ops();
    const before = fs.readFileSync(usersPath(), "utf8");

    const error = await expectCode(
      () => addAccount(sources, "alice", "hacked", {}),
      "already-exists",
    );
    expect(error.message).toContain("user set");
    expect(fs.readFileSync(usersPath(), "utf8")).toBe(before);
  });

  it("参数组合 / 条目语法不成立 → invalid", async () => {
    // window 不可能脱离 quota 单独存在：别造一条「没上限、只有窗口」的记录
    writeUsers([{ username: "u", password: "p" }]);
    const sources = await ops();
    await expectCode(() => setAccount(sources, "u", { quotaWindow: "day" }), "invalid");
    // 时刻形态的判据归数据源层那个唯一的归一，ops 不自己 Date.parse
    await expectCode(() => applyPatch(ACCOUNT, { expiresAt: "2027-01-01" }), "invalid");
    // 条目语法判据归名单规则层
    await expectCode(
      () => addAclEntry(sources, "clientip", "whitelist", "example.com"),
      "invalid",
    );
  });

  it("只读驱动 → read-only-driver（绝不静默成功）", () => {
    const readOnly: AclSource = {
      driver: "readonly-driver",
      locator: () => "/nowhere/acl.json",
      read: () => ({ value: {} as never, path: "/nowhere/acl.json", exists: false }),
      readStartup: async () => ({ value: {} as never, path: "/nowhere/acl.json", exists: false }),
    };
    let caught: unknown;
    try {
      requireAclWrite(readOnly);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpsError);
    expect((caught as OpsError).code).toBe("read-only-driver");
    expect((caught as Error).message).toContain("readonly-driver");
  });

  it("内容读不到 / 形状非法 → source-unreadable，**绝不当成空表**", async () => {
    const sources = await ops();
    fs.mkdirSync(path.dirname(usersPath()), { recursive: true });
    fs.writeFileSync(usersPath(), '[{ "username": "alice", "password": "pw1", "disabled": "yes" }]');
    await expectCode(() => listAccounts(sources), "source-unreadable");

    fs.writeFileSync(aclPath(), '{ "nope": { "whitelist": [] } }');
    await expectCode(() => readAcl(sources), "source-unreadable");
  });

  it("账本里没有这个用户 → not-found，且说清「没记录」是什么意思", async () => {
    const reading = await readUsage(await ops());
    const error = await expectCode(() => usageFor(reading, "nobody"), "not-found");
    expect(error.message).toContain("从没被计量过");
  });

  it("**code 集合是闭合的**：new OpsError 的 code 只能取那五个之一", () => {
    // 这条是给「将来那个 HTTP 面」留的牙齿：`code` 一旦增殖成自由字符串，映射状态码就只能靠
    // grep 文案，而文案每条都不同。断言的是**联合类型**本身，故编译期与运行期同时生效。
    const codes = new Set<string>();
    for (const error of [
      new OpsError("not-found", ""),
      new OpsError("already-exists", ""),
      new OpsError("invalid", ""),
      new OpsError("read-only-driver", ""),
      new OpsError("source-unreadable", ""),
    ]) {
      codes.add(error.code);
    }
    expect([...codes].sort()).toEqual([
      "already-exists",
      "invalid",
      "not-found",
      "read-only-driver",
      "source-unreadable",
    ]);
  });
});