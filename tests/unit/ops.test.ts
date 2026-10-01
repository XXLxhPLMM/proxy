import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OpsError,
  addAclEntry,
  addAccount,
  applyPatch,
  getAccount,
  inertNoticeFor,
  listAccounts,
  readAcl,
  readUsage,
  removeAclEntry,
  removeAccount,
  reportConfig,
  requireAclWrite,
  resolveOpsSources,
  setAccount,
  setAccountEnabled,
  usageFor,
  type OpsSources,
} from "@/ops/index.js";
import type { AclConfig, AclSource } from "@/datasource/acl/index.js";
import type { AuthAccount } from "@/datasource/users/index.js";
import { codeOf, sourceFiles } from "../helpers/source-scan.js";

/**
 * 数据源操作层（`src/ops/`）的单测
 *
 * @description
 * ## 本档盯的东西，按「错了会怎样」排序
 *
 * 1. **ops 必须返回结构化数据、绝不渲染**（第 5 组，源码级）。它是「换个界面不用改数据层」这条
 *    设计唯一的牙齿：一旦 `ops` 打出表格或拼起面向人的文案，它就绑死在某一个界面上了，而这一层
 *    存在的全部理由就是不再绑死。
 * 2. **依赖方向单向**（第 5 组，源码级）。`ops → admin` 一旦出现，「数据操作」与「终端呈现」就
 *    互为对方的实现细节，两边都不能单独测试；而反向依赖会顺着 `renderTable` 一路拖到 `console`。
 *    判据刻意做成**两面都断言**：只断言 ops 不引 admin 的话，把整个实现搬回 admin 就能让这组恒绿。
 * 3. **失败必须带原因分类**（第 2 组）。`OpsError.code` 是将来 HTTP 面映射状态码的唯一依据；
 *    没有它，传输层只能靠 grep 文案，而文案每条都不同。
 * 4. **幂等 no-op 要如实返回**（第 3 组）。名单里已经有那条 / 本来就没有那条——那**不是失败**
 *    （用户达到了目的），但也**不是成功**（一个字节都没落盘）。断言的是「**没有调用 `write`**」，
 *    而不只是「返回值是 false」：后者挡不住「算了还是重写一遍反正内容一样」。
 * 5. **判据只有一份**（第 4 组）。`--expires` 的时刻形态与名单条目语法的判据都取自数据源层 /
 *    名单规则层，`ops` 不重写。
 *
 * ## 为什么第 3 组用替身 `AclSource` 而不是真文件
 *
 * 「有没有落盘」这件事**在文件上看不出来**（`writeJsonAtomic` 重写同样的字节，内容逐字相同）。
 * 唯一能判「第二次调用在实现上凭什么不同」的观测点是 **`write` 有没有被调用**，而那只在替身上
 * 看得见。
 */

/** 磁盘形态（`users.json` 里那个样子）：`expiresAt` 是带时区偏移的 ISO 串 */
const ACCOUNT_DOC = {
  username: "alice",
  password: "pw1",
  quota: { bytes: 1073741824, window: "day" },
  // 落盘恒为带 `.000Z` 的 UTC 串（`toAccountDoc` 用 `toISOString()`，正则同样收 `Z`）。
  expiresAt: "2030-01-01T00:00:00.000Z",
  disabled: false,
  acl: { target: { whitelist: ["example.com"], blacklist: ["evil.com"] } },
};

/** 归一化形态（ops 交出的那种）：`expiresAt` 已是 epoch 毫秒 */
const ACCOUNT: AuthAccount = {
  username: "alice",
  password: "pw1",
  quota: { bytes: 1073741824, window: "day" },
  expiresAt: 1893456000000,
  disabled: false,
  acl: { target: { whitelist: ["example.com"], blacklist: ["evil.com"] } },
};

let dir = "";

async function ops(): Promise<OpsSources> {
  return resolveOpsSources({ NODE_ENV: "development" }, dir);
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

/** 一个**记账数**的名单数据源替身：`read` 永远给同一份，写面每被调一次计数 +1 */
function countingAcl(initial: AclConfig): { acl: AclSource; writes: number } {
  let next = initial;
  const box = { acl: undefined as unknown as AclSource, writes: 0 };
  box.acl = {
    driver: "counting",
    locator: () => "/nowhere/acl.json",
    read: () => ({ value: next, path: "/nowhere/acl.json", exists: true }),
    readStartup: async () => ({ value: next, path: "/nowhere/acl.json", exists: true }),
    write: (value) => {
      box.writes += 1;
      next = value;
    },
  };
  return box;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ops-"));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不应遮蔽用例结论
  }
});

// ---------------------------------------------------------------------------
// 1. 结构化返回值（不是渲染好的字符串）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 2. 失败必须带原因分类
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 3. 幂等 no-op：changed: false，且**没有调用 write**
// ---------------------------------------------------------------------------

describe("ops 名单写：幂等 no-op 如实返回 changed:false，且绝不重写", () => {
  const base: AclConfig = {
    clientIp: { whitelist: ["10.0.0.0/8"], blacklist: [] },
    target: { whitelist: [], blacklist: ["evil.com"] },
    upstream: { whitelist: [], blacklist: [] },
  };

  it("重复 add → changed:false，且 write **一次都没被调**", async () => {
    const spy = countingAcl(base);
    const sources = { ...(await ops()), acl: spy.acl };

    const first = addAclEntry(sources, "clientip", "whitelist", "192.168.0.0/16");
    expect(first.changed).toBe(true);
    expect(spy.writes).toBe(1);

    const again = addAclEntry(sources, "clientip", "whitelist", "192.168.0.0/16");
    expect(again.changed).toBe(false);
    expect(again.message).toContain("没动");
    // ⚠️ **牙齿在这里**：不是「返回值是 false」，而是「底层写面**没被调用**」。内容逐字相同地
    // 重写一遍，文件上根本看不出来 —— 而那正是「幂等」这个词最容易变成假绿的地方。
    expect(spy.writes, "第二次调用必须连 write 都不碰").toBe(1);
  });

  it("移出本来就没有的 → changed:false，且 write 一次都没被调", async () => {
    const spy = countingAcl(base);
    const sources = { ...(await ops()), acl: spy.acl };

    const miss = removeAclEntry(sources, "upstream", "blacklist", "never.example.com");
    expect(miss.changed).toBe(false);
    expect(miss.message).toContain("没动");
    expect(spy.writes).toBe(0);
  });

  it("真的移出 → changed:true，且只动那一个格子", async () => {
    const spy = countingAcl(base);
    const sources = { ...(await ops()), acl: spy.acl };

    const gone = removeAclEntry(sources, "target", "blacklist", "evil.com");
    expect(gone.changed).toBe(true);
    expect(spy.writes).toBe(1);
    const after = readAcl(sources);
    expect(after.target.blacklist).toEqual([]);
    expect(after.clientIp.whitelist, "别的格子逐字不动").toEqual(["10.0.0.0/8"]);
  });
});

// ---------------------------------------------------------------------------
// 4. 判据只有一份 / 字段保全（ops 侧的不变量）
// ---------------------------------------------------------------------------

describe("ops 账号写：判据只有一份，未指定字段逐字保留", () => {
  it("applyPatch 是纯函数且只动 patch 里出现的字段", () => {
    const next = applyPatch(ACCOUNT, { disabled: true });
    expect(next.disabled).toBe(true);
    expect(next.quota).toEqual(ACCOUNT.quota);
    expect(next.expiresAt).toBe(ACCOUNT.expiresAt);
    expect(next.acl).toEqual(ACCOUNT.acl);
    // 原对象逐字不动（纯函数，不是就地改）
    expect(ACCOUNT.disabled).toBe(false);
  });

  it("`--expires` 的时刻形态由数据源层那个唯一的归一判定（ops 不自己 Date.parse）", () => {
    // `Date.parse("2027-01-01")` 返回一个**有限值**（UTC 午夜），`Date.parse("2027-01-01 00:00")`
    // 返回**本地**午夜 —— 同一份配置在 UTC 机器与 +08:00 机器上差 8 小时，而运维写它时心里想的
    // 一定是本地零点。ops 若自己 Date.parse 判，就成了「这一层认得、代理不认得」的那一档。
    expect(() => applyPatch(ACCOUNT, { expiresAt: "2027-01-01" })).toThrow(OpsError);
    expect(() => applyPatch(ACCOUNT, { expiresAt: "2027-02-30T00:00:00Z" })).toThrow(
      OpsError,
    );
    const ok = applyPatch(ACCOUNT, { expiresAt: "2027-03-01T12:00:00+08:00" });
    expect(typeof ok.expiresAt).toBe("number");
  });

  it("jwt 模式下提醒、非 jwt 不提醒（提醒是纯查询，不改数据）", async () => {
    writeUsers([{ ...ACCOUNT_DOC, disabled: true }]);
    const at = (authType: string): Promise<OpsSources> =>
      resolveOpsSources({ NODE_ENV: "development", AUTH_TYPE: authType }, dir);
    expect(inertNoticeFor(await at("basic"))).toBeUndefined();
    expect(inertNoticeFor(await at("jwt"))).toContain("不会生效");
  });
});

// ---------------------------------------------------------------------------
// 5. 层边界（源码级）
// ---------------------------------------------------------------------------

describe("ops 层边界：结构化 + 单向依赖", () => {
  // 与 `admin-cli.test.ts` 那组共用同一个「列目录」helper，零 console / 零 process / 不 import
  // 代理侧三条**不在这里重复断言**（那是整工具的护栏，它的牙齿在那份档里）。
  const opsFiles = sourceFiles("ops");

  it("扫描范围非空且含本层的出口（否则下面两条断言会整组恒绿）", () => {
    expect(opsFiles).toContain("ops/index.ts");
    expect(opsFiles.length).toBeGreaterThanOrEqual(5);
  });

  it("**ops 绝不 import `@/admin/*`**（数据操作不该知道谁在显示它的结果）", () => {
    for (const file of opsFiles) {
      expect(codeOf(file), `${file} 不许反向依赖传输层`).not.toMatch(/from\s+"@\/admin\//);
    }
    // ⚠️ **双向判据自检**：单看上面那条的话，把实现整份搬回 admin 就能让这组恒绿。正向这一侧证明
    // 「admin → ops」这条边今天真的存在，于是「ops → admin」才是真的没有。
    expect(codeOf("admin/users.ts")).toMatch(/from\s+"@\/ops\/index\.js"/);
    expect(codeOf("admin/index.ts")).toMatch(/from\s+"@\/ops\/index\.js"/);
  });

  it("ops 对 `@/config` 只用那一个 barrel 出口（条目语法原语走 `@/addr`）", () => {
    // 与本仓「目录对外只暴露一个 barrel」同纪律：ops 破一次，配置层的内部布局就跟着它漂。
    for (const file of opsFiles) {
      for (const match of codeOf(file).matchAll(/from\s+"@\/config\/([^"]+)"/g)) {
        expect(["index.js"], `${file} 引了 @/config/${match[1]}（只有 barrel 是合法的）`).toContain(
          match[1],
        );
      }
    }
  });

  it("ops 引 `@/addr` 时只引它那一个 barrel（地址语法层不对外露深层路径）", () => {
    // ⚠️ **双向判据自检**：单看允许集的话，把 `acl.ts` 整份搬走就没人引 `@/addr` 了、这组恒绿。
    // 正向这一侧证明「ops → addr」这条边今天真的存在（`acl.ts` 是名单条目语法的消费方）。
    expect(codeOf("ops/acl.ts")).toContain('from "@/addr/index.js"');
    for (const file of opsFiles) {
      for (const match of codeOf(file).matchAll(/from\s+"@\/addr\/([^"]+)"/g)) {
        expect(["index.js"], `${file} 引了 @/addr/${match[1]}（只有 barrel 是合法的）`).toContain(
          match[1],
        );
      }
    }
  });

  it("ops 不 import `@/core` / `@/runtime` / `@/server`（管理工具不启动代理）", () => {
    for (const file of opsFiles) {
      expect(codeOf(file), `${file} 不许 import 代理侧`).not.toMatch(/from\s+"@\/(core|runtime|server)\//);
    }
  });
});