/**
 * `loadUserQuota` 读面 + quota 侧的跨层一致性护栏：热加载、深度冻结、零分配、O(1) 身份索引。
 *
 * 「禁跨 worker 共享账本」（**没有任何断言会红** —— 单进程里不可观测，靠源码级断言兜住引入面）
 * 与「读面零直接读取器」在 `./AGENTS.md`。
 *
 * @module tests/unit/config/auth-users
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAuthUsers, loadUserQuota, readAuthUsers } from "@/datasource/users/index.js";
import { restoreConfig, set, snapshotConfig } from "../../../helpers/config.js";
import { codeOf } from "../../../helpers/source-scan.js";
import { MIXED, UNLIMITED, acc } from "./_user-quota.js";

describe("config/auth-users loadUserQuota", () => {
  let dir: string;
  let snap: Record<string, unknown>;
  let clock = 0;
  let file: string;

  const write = (data: unknown): void => {
    clock += 1000;
    fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
    fs.utimesSync(file, clock / 1000, clock / 1000);
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-quota-test-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    snap = snapshotConfig(["authUsersFile", "logLevel", "logFile"]);
    set("logLevel", "silent");
    set("logFile", "");
    file = path.join(dir, `users-${Math.random().toString(36).slice(2)}.json`);
    set("authUsersFile", file);
  });

  afterEach(() => {
    restoreConfig(snap);
  });

  it("配了 quota → 返回该用户的配额；未配 / 用户不存在 → undefined", () => {
    write(MIXED);
    expect(loadUserQuota("carol", acc())).toEqual({
      bytes: 1024,
    });
    // 「未配 quota」与「用户不存在」都返回 undefined（= 不限流），不是空对象、更不是抛错
    expect(loadUserQuota("alice", acc())).toBeUndefined();
    expect(loadUserQuota("nobody", acc())).toBeUndefined();
    expect(loadUserQuota("", acc())).toBeUndefined();
  });

  it("配了但 bytes 为 0 → 返回 0 配额（消费层据此判「不限流」）", () => {
    write([{ username: "dave", password: "p", quota: { bytes: 0 } }]);
    expect(loadUserQuota("dave", acc())).toEqual(UNLIMITED);
  });

  it("文件缺失 → undefined 且不算错误", () => {
    const r = readAuthUsers({ locator: acc(), force: true });
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(loadUserQuota("carol", acc())).toBeUndefined();
  });

  it("坏文件保留上一份有效值（与账号表同一缓存条目，不是另开读取器）", () => {
    write(MIXED);
    expect(loadUserQuota("carol", acc())?.bytes).toBe(1024);
    write([{ username: "carol", password: "pw3", quota: { bytes: -5 } }]);
    // 强制重读让「这份内容非法」落到缓存条目上
    expect(readAuthUsers({ locator: acc(), force: true }).error).toBeTruthy();
    // 同一缓存条目：非强制的读取也能看到那个 error（独立读取器做不到这点）
    expect(readAuthUsers({ locator: acc() }).error).toBeTruthy();
    expect(loadUserQuota("carol", acc())?.bytes).toBe(1024);
  });

  it("热加载完整循环：改配额越过 1s 节流后对新请求生效", () => {
    vi.useFakeTimers();
    try {
      write([{ username: "carol", password: "pw3", quota: { bytes: 100 } }]);
      expect(loadUserQuota("carol", acc())?.bytes).toBe(100);

      // 未越过节流 → 仍是上一份
      write([{ username: "carol", password: "pw3", quota: { bytes: 200 } }]);
      expect(loadUserQuota("carol", acc())?.bytes).toBe(100);

      // 越过节流 → 新配额生效
      vi.advanceTimersByTime(1500);
      expect(loadUserQuota("carol", acc())?.bytes).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("返回值只读且与缓存内部引用无关（深度冻结的独立副本）", () => {
    write(MIXED);
    const q = loadUserQuota("carol", acc())!;
    expect(Object.isFrozen(q)).toBe(true);
    // 改拿到的对象不影响缓存里的那份
    expect(() => {
      (q as { bytes: number }).bytes = 1;
    }).toThrow(TypeError);
    expect(loadUserQuota("carol", acc())?.bytes).toBe(1024);
    expect(loadAuthUsers(acc())[2]?.quota?.bytes).toBe(1024);
  });

  it("热路径零分配：同一用户连续两次查询返回同一对象身份", () => {
    // 保护：`consume` 是**每 chunk** 调用（一次大文件传输几万次），「每次新建一份冻结对象」
    // 在这种频次上是纯浪费。判据用 toBe（同身份）而不是 toEqual —— 后者对「重新冻结了一份
    // 内容相同的新对象」照样通过，锁不住分配。
    write(MIXED);
    const first = loadUserQuota("carol", acc());
    const second = loadUserQuota("carol", acc());
    expect(first).toBeDefined();
    expect(second).toBe(first);
    // 按用户名分槽，不串号
    expect(loadUserQuota("alice", acc())).not.toBe(first);
  });

  it("查找是 O(1) 身份索引，不是线性扫（每 chunk / 每请求都走这条）", () => {
    // 保护：`loadUserQuota` 由 `UsageMirror.consume` **每 chunk** 调用一次（一次大文件传输
    // 几万次），而它下游的 `windowFor` 在 `sweep` / `summarizeCurrent` 里还要**按账本行**调用。
    // 线性扫在这个频次上是热路径本身的成本：实测末尾用户 n=10000 时 65 µs/次、n=100000 时
    // 899 µs/次（事件循环占比分别 >100% 与 >1400%）。
    // 判据是**形状而非计时**：计时断言在 CI 机器上必然抖，而「建索引 / 查索引」这两个动作
    // 出现且「扫全表」不出现，是不会抖的。
    const code = codeOf("datasource", "users", "read.ts");
    expect(code, "查找必须经身份索引").toMatch(/accountIndex\(/);
    expect(code, "不许退回按账号数增长的线性扫").not.toMatch(
      /for\s*\(\s*let\s+\w+\s*=\s*0;\s*\w+\s*<\s*\w+\.length;\s*\w\+\+\s*\)\s*\{[^}]*username\s*===/,
    );
    // 索引的判据是**账号数组对象身份**，故它与读取缓存同生共死：内容没变零重建（热路径零分配），
    // 内容变了（新数组）自然重建 —— 「索引与账号表一致」不是需要维护的不变量。
    expect(code, "索引必须按数组身份记忆（WeakMap）").toMatch(
      /new WeakMap<\s*AuthAccount\[\]/,
    );
  });

  it("索引逐项同结果：缺 quota 的账号与不存在的用户都是 undefined", () => {
    // 索引与线性扫必须对**每一个**用户给同一个答案，包括「账号存在但没配 quota」（返回
    // undefined = 不限流）与「账号不存在」两种「查得到但没有值」的情形 —— 它们是配额判定
    // 的两条放行分支，索引若在这里返回了别的形状，判定就会静默变成「有上限」。
    write([
      { username: "dave", password: "pw", quota: { bytes: 1, window: "day" } },
      { username: "erin", password: "pw3" },
    ]);
    const locator = acc();
    expect(loadUserQuota("dave", locator)?.window).toBe("day");
    expect(loadUserQuota("dave", locator)?.bytes).toBe(1);
    expect(loadUserQuota("erin", locator)).toBeUndefined();
    expect(loadUserQuota("nobody-here", locator)).toBeUndefined();
  });

  it("内容变更后索引跟着换（不返回上一份快照里的账号）", () => {
    // 索引挂在**数组对象身份**上。若它错挂在「装配接线」或某个别的稳定对象上，账号表热更新
    // 之后索引就会与内容脱节 —— 而读到的还是「看起来正常」的旧值，没有任何告警。
    write([{ username: "carol", password: "pw3", quota: { bytes: 1024 } }]);
    expect(loadUserQuota("carol", acc())?.bytes).toBe(1024);
    write([{ username: "carol", password: "pw3", quota: { bytes: 2048 } }]);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1500);
      expect(loadUserQuota("carol", acc())?.bytes).toBe(2048);
    } finally {
      vi.useRealTimers();
    }
  });

  it("事件回调经账号表同一条观察面抛出（一次内容变更只报一次 reloaded）", () => {
    write(MIXED);
    const events: string[] = [];
    const onEvent = (e: { type: string; label: string }): void => {
      events.push(`${e.label}:${e.type}`);
    };
    loadUserQuota("carol", acc(), onEvent);
    write([{ username: "carol", password: "pw3" }]);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1500);
      expect(loadUserQuota("carol", acc(), onEvent)).toBeUndefined();
      expect(events).toEqual(["用户账号文件:reloaded"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("config/auth-users 跨层一致性护栏（quota 读取面）", () => {
  it("账号表只有一条读取通路：读面零直接读取器，两个后端各一处", () => {
    const code = codeOf("datasource", "users", "read.ts");
    // 另开一个读取器会造成两份节流缓存、两份解析、两套坏文件处理并互相污染同一缓存键。
    // 判据是「每个后端恰好一处，且读面一处都没有」——锚的是**今天仍存在的形状**
    // （函数调用 + 文件名），不是某个已被删掉的模块名（点不存在的符号，断言会恒真）。
    expect(code, "读面不许自己开读取器").not.toMatch(/readJsonCached\(|readCachedSource\(/);
    expect(
      (codeOf("datasource", "users", "json-source.ts").match(/readJsonCached\(/g) ?? []).length,
      "json 后端恰好一处",
    ).toBe(1);
    expect(
      (codeOf("datasource", "users", "sqlite-source.ts").match(/readCachedSource\s*[<(]/g) ?? [])
        .length,
      "sqlite 后端恰好一处（与 json 共用同一套节流/事件机制）",
    ).toBe(1);

    for (const fn of ["export function loadUserPolicy(", "export function loadUserQuota("]) {
      const body = code.slice(code.indexOf(fn));
      expect(body, `${fn} 必须复用 readAuthUsers`).toContain("readAuthUsers(");
      expect(body, `${fn} 不许自己开读取器`).not.toMatch(/readJsonCached\(|readCachedSource\(/);
      expect(body).not.toContain("readFileSync(");
      expect(body).not.toContain("promises");
    }
  });

  it("本文件不出现任何限速/并发字段名（明确不做，留占位即违规）", () => {
    const code = codeOf("datasource", "users", "read.ts");
    expect(code).not.toMatch(/rateBps|maxConnections|\bconcurrency\b/);
  });

  it("启动期强校验对带 quota 的文件同样 fail-closed（readAuthUsersAsync 共用同一份形状校验）", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "user-quota-async-"));
    try {
      const ok = path.join(d, "ok.json");
      fs.writeFileSync(ok, JSON.stringify(MIXED));
      const good = await import("@/datasource/users/index.js").then((m) => m.readAuthUsersAsync(ok));
      expect(good.error).toBeUndefined();
      expect(good.value).toEqual(MIXED);

      const bad = path.join(d, "bad.json");
      fs.writeFileSync(bad, JSON.stringify([{ username: "c", password: "p", quota: { bytes: -1 } }]));
      const r = await import("@/datasource/users/index.js").then((m) => m.readAuthUsersAsync(bad));
      expect(r.error).toBeTruthy();
      expect(r.exists).toBe(true);
      expect(r.value).toEqual([]);

      // 缺失文件仍只算缺失
      const missing = await import("@/datasource/users/index.js").then((m) =>
        m.readAuthUsersAsync(path.join(d, "absent.json")),
      );
      expect(missing.exists).toBe(false);
      expect(missing.error).toBeUndefined();
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
