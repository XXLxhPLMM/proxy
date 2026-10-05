/**
 * 账号驱动的**开放集合**：注册进去的名字经 `AUTH_USERS_DRIVER` 真的被装配使用。
 *
 * @description
 * 这组护的是「抽象真的可扩展」，最典型的腐坏形态是**静默回落**（`else → JsonAccountSource`
 * ⇒ `AUTH_USERS_DRIVER=mysql` 静默按 json 跑、零告警）。判据一律取**读出来的数据**或
 * **抛出的错误文本**，不取「实例类型」——后者会被「按 driver 分别记忆」这类实现细节满足。
 * 变异实测与形状见同目录 `AGENTS.md`。
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLocatorFor, ConfigStore } from "@/config/index.js";
import {
  accountSourceFor,
  listAccountSourceDrivers,
  readAuthUsers,
  registerAccountSource,
  type AccountLocator,
  type AccountSource,
  type AuthAccount,
} from "@/datasource/users/index.js";
import { dbFile, dir, jsonFile, makeStoreDir, removeStoreDir } from "./_account-store.js";

const CUSTOM = "custom-mem";
let off: (() => void) | undefined;
let seenLocator: string | undefined;

beforeEach(() => {
  makeStoreDir();
});

afterEach(() => {
  removeStoreDir();
  off?.();
  off = undefined;
  seenLocator = undefined;
});

/**
 * 一个内存账号源：数据不落盘，故「读到的是它」只可能是它真的被装配上了
 * @description `seenLocator` 在 **`list()` 时刻**取，而不是构造期——判据是「工厂拿到的是
 * 闭包、装配层每次现读」，不是「构造期烤死了什么」。构造期取一次只能证明「传进来过什么」，
 * 证明不了「路径可热改」。
 */
class MemoryAccountSource implements AccountSource {
  public readonly kind = CUSTOM;
  public constructor(private readonly resolvePath: () => string) {}
  public list(): { value: AuthAccount[]; path: string; exists: boolean; error?: string } {
    seenLocator = this.resolvePath();
    return {
      value: [{ username: "from-custom", password: "p" }],
      path: this.resolvePath(),
      exists: true,
    };
  }
  public put(account: AuthAccount): AuthAccount {
    return account;
  }
  public delete(): void {
    /* 内存档无需实现写路径，本组只锁读 */
  }
}

describe("account-source：驱动注册表（开放集合：自定义驱动必须真的被装配）", () => {
  it("① 自定义驱动经 AUTH_USERS_DRIVER 真的被装配（读到的是它的数据，不是内置档的）", () => {
    off = registerAccountSource(CUSTOM, (locator) => new MemoryAccountSource(locator));
    // 装配点拿到的那份**接线**：驱动名与路径都是闭包，装配层只负责「从 config 取值后传入」。
    const store = new ConfigStore();
    store.set("authUsersDriver", CUSTOM);
    store.set("authUsersFile", jsonFile);
    store.set("authUsersDb", dbFile);
    // 先在 json 档放一份**内容不同**的账号表：若接线误落到内置档，下面的断言会立刻对不上。
    fs.writeFileSync(jsonFile, JSON.stringify([{ username: "from-json", password: "p" }]), "utf8");

    const accounts: AccountLocator = accountLocatorFor(store);
    const read = readAuthUsers({ locator: accounts, force: true });
    expect(read.error, "自定义档无错误").toBeUndefined();
    // 判据是**内容**且与 json 档那份**不同**：若接线误落到内置档，这里会读到 `from-json`。
    // 「两边都读到空表」那种假绿被上面那句 json 文件的存在排除掉了。
    expect(read.value.map((a) => a.username), "读到的是自定义档的数据，不是 json 档那份").toEqual([
      "from-custom",
    ]);
    // 工厂收到的是**路径闭包**（数据源层零配置依赖的形状），且闭包现取：热改路径即时生效。
    expect(typeof seenLocator, "工厂收到的是路径闭包而不是烤死的字符串").toBe("string");
    store.set("authUsersFile", path.join(dir, "moved.json"));
    accountSourceFor(accounts).list();
    expect(seenLocator, "闭包现取：改 AUTH_USERS_FILE 后工厂看到的是新路径").toBe(
      path.resolve(path.join(dir, "moved.json")),
    );
  });

  it("② 未注册驱动必须抛错、点名驱动名并列出全部已注册项（绝不静默回落到 json 档）", () => {
    const accounts: AccountLocator = accountLocatorFor(
      Object.assign(new ConfigStore(), { get: (k: string) => (k === "authUsersDriver" ? "nope" : "") }) as never,
    );
    let thrown: Error | undefined;
    try {
      accountSourceFor(accounts).list();
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown, "未注册驱动必须抛错而不是静默按 json 跑").toBeDefined();
    expect(thrown?.message).toContain("nope");
    // 已注册项必须**全部**列出：拼错驱动名（`sqlit` ← `sqlite`）是最常见的部署错误，
    // 只说「未知驱动」而不说「有哪些」等于把「打开配置看一眼」变成「去翻源码」。
    for (const driver of listAccountSourceDrivers()) {
      expect(thrown?.message, `错误文本点名已注册驱动 ${driver}`).toContain(driver);
    }
    expect(listAccountSourceDrivers(), "内置两档始终在列").toEqual(
      expect.arrayContaining(["json", "sqlite"]),
    );
  });

  it("③ 退订是幂等的，且已被别人覆盖时退订不许删掉别人的项", () => {
    const before = listAccountSourceDrivers();
    const first = registerAccountSource("dup-driver", () => new MemoryAccountSource(() => ""));
    // 重名未给 override → 抛错（不静默替换）
    expect(() => registerAccountSource("dup-driver", () => new MemoryAccountSource(() => ""))).toThrow();
    first();
    first();
    expect(listAccountSourceDrivers(), "退订后回到原状（调两次不炸）").toEqual(before);
  });
});
