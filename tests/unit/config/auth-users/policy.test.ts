/**
 * `loadUserPolicy`：**每请求**调用的个人名单读面 —— 热加载、坏文件保留、深度冻结、零分配。
 *
 * 热路径零分配（判据用 `toBe` 同身份而不是 `toEqual`）与「一次内容变更只报一次 `reloaded`」
 * 的理由在 `./AGENTS.md`。
 *
 * @module tests/unit/config/auth-users
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAuthUsers, loadUserPolicy, readAuthUsers } from "@/datasource/users/index.js";
import { restoreConfig, set, snapshotConfig } from "../../../helpers/config.js";
import { MIXED_ACCOUNTS, acc } from "./_auth-users.js";

describe("config/auth-users loadUserPolicy", () => {
  let dir: string;
  let snap: Record<string, unknown>;
  /** 单调递增的 mtime 写入：绕开文件系统时间戳粒度，让「内容已变」这件事是确定的 */
  let clock = 0;
  let file: string;

  const write = (data: unknown): void => {
    clock += 1000;
    fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
    fs.utimesSync(file, clock / 1000, clock / 1000);
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-policy-test-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // 保存并静音日志，避免非法文件用例把 warn 写进项目 log 目录
    snap = snapshotConfig(["authUsersFile", "logLevel", "logFile"]);
    set("logLevel", "silent");
    set("logFile", "");
    file = path.join(dir, `users-${Math.random().toString(36).slice(2)}.json`);
    set("authUsersFile", file);
  });

  afterEach(() => {
    restoreConfig(snap);
  });

  it("用户存在且配了 acl → 返回该用户的策略；未配 acl 的账号返回 undefined", () => {
    write(MIXED_ACCOUNTS);
    expect(loadUserPolicy("bob", acc())).toEqual({
      target: { whitelist: ["*.corp.com"], blacklist: ["ads.io"] },
    });
    expect(loadUserPolicy("alice", acc())).toBeUndefined();
  });

  it("用户不存在 → undefined（不是抛错，也不是空策略）", () => {
    write(MIXED_ACCOUNTS);
    expect(loadUserPolicy("nobody", acc())).toBeUndefined();
    expect(loadUserPolicy("", acc())).toBeUndefined();
  });

  it("文件缺失 → undefined 且不算错误", () => {
    const r = readAuthUsers({ locator: acc(), force: true });
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(loadUserPolicy("bob", acc())).toBeUndefined();
  });

  it("坏文件保留上一份有效值：改坏后策略仍是旧的那份（经账号表同一缓存条目）", () => {
    write(MIXED_ACCOUNTS);
    expect(loadUserPolicy("bob", acc())).toEqual({
      target: { whitelist: ["*.corp.com"], blacklist: ["ads.io"] },
    });

    // 改坏：acl 出现未知组（fail-closed 形态）
    write([{ username: "bob", password: "pw2", acl: { clientIp: { blacklist: ["1.2.3.4"] } } }]);
    // 强制重读一次，让「这份内容非法」这件事真正落到缓存条目上
    const forced = readAuthUsers({ locator: acc(), force: true });
    expect(forced.error).toBeTruthy();
    // 同一缓存条目：非强制的账号表读也能看到那个 error（独立读取器做不到这点）
    expect(readAuthUsers({ locator: acc() }).error).toBeTruthy();
    // 策略仍是上一份有效值，没有被清成「无限制」
    expect(loadUserPolicy("bob", acc())).toEqual({
      target: { whitelist: ["*.corp.com"], blacklist: ["ads.io"] },
    });
  });

  it("非法 JSON 同样保留上一份有效值", () => {
    write(MIXED_ACCOUNTS);
    expect(loadUserPolicy("bob", acc())?.target.blacklist).toEqual(["ads.io"]);
    write("{ 坏 JSON");
    expect(readAuthUsers({ locator: acc(), force: true }).error).toBeTruthy();
    expect(loadUserPolicy("bob", acc())?.target.blacklist).toEqual(["ads.io"]);
  });

  it("热加载完整循环：改好 → 越过 1s 节流后新策略生效", () => {
    vi.useFakeTimers();
    try {
      write([{ username: "bob", password: "pw2", acl: { target: { blacklist: ["ads.io"] } } }]);
      expect(loadUserPolicy("bob", acc())).toEqual({
        target: { whitelist: [], blacklist: ["ads.io"] },
      });

      // 改坏：未越过节流，读到的仍是上一份有效值
      write([{ username: "bob", password: "pw2", acl: { target: { blacklist: ["ads.io:80"] } } }]);
      expect(loadUserPolicy("bob", acc())?.target.blacklist).toEqual(["ads.io"]);

      // 越过节流：坏内容不接管
      vi.advanceTimersByTime(1500);
      expect(loadUserPolicy("bob", acc())?.target.blacklist).toEqual(["ads.io"]);

      // 修好并越过节流：新策略生效
      write([{ username: "bob", password: "pw2", acl: { target: { whitelist: ["*.corp.com"] } } }]);
      vi.advanceTimersByTime(1500);
      expect(loadUserPolicy("bob", acc())).toEqual({
        target: { whitelist: ["*.corp.com"], blacklist: [] },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("返回值只读：深度冻结，且改动拿到的对象不污染缓存", () => {
    write(MIXED_ACCOUNTS);
    const policy = loadUserPolicy("bob", acc())!;
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.target)).toBe(true);
    expect(Object.isFrozen(policy.target.whitelist)).toBe(true);
    expect(Object.isFrozen(policy.target.blacklist)).toBe(true);
    expect(() => (policy.target.whitelist as string[]).push("evil.com")).toThrow(TypeError);
    expect(loadUserPolicy("bob", acc())?.target.whitelist).toEqual(["*.corp.com"]);
    // 账号表里那份也仍是原值（缓存没被调用方改坏）
    expect(loadAuthUsers(acc())[1]?.acl?.target.whitelist).toEqual(["*.corp.com"]);
  });

  it("热路径零分配：同一用户连续两次查询返回同一对象身份", () => {
    // 保护：`loadUserPolicy` 是**每请求**调用（core/access-control.ts:checkTargetHost 的个人层），
    // 「每次调用深冻结一份新对象」在热路径上是纯浪费。判据用 toBe（同身份）而不是 toEqual：
    // 后者对「重新冻结了一份内容相同的新对象」照样通过，锁不住分配。
    write(MIXED_ACCOUNTS);
    const first = loadUserPolicy("bob", acc());
    const second = loadUserPolicy("bob", acc());
    expect(first).toBeDefined();
    expect(second).toBe(first);
    // 复用不放宽只读：那份对象仍是深度冻结的，且与缓存里的内部数组无关
    expect(Object.isFrozen(first!.target.whitelist)).toBe(true);
    // 按用户名分槽，不串号
    expect(loadUserPolicy("alice", acc())).not.toBe(first);
  });

  it("事件回调经账号表同一条观察面抛出（与 loadAuthUsers 同一份 label/path 契约）", () => {
    write(MIXED_ACCOUNTS);
    const events: string[] = [];
    const onEvent = (e: { type: string; label: string }): void => {
      events.push(`${e.label}:${e.type}`);
    };
    loadUserPolicy("bob", acc(), onEvent);
    write([{ username: "bob", password: "pw2" }]);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1500);
      // 一次内容变更只报一次（两个读取器共用同一缓存条目与去重状态）
      expect(loadUserPolicy("bob", acc(), onEvent)).toBeUndefined();
      expect(events).toEqual(["用户账号文件:reloaded"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
