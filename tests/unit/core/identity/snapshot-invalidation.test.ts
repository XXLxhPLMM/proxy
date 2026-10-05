/**
 * `core/identity/factory.ts` 快照记忆化：**失效**判据（行为面）
 *
 * @description
 * `createIdentityFromConfig` 的动态门面按**输入身份**记忆 `FileAccountIdentity` 快照
 * （`liveSnapshots`，按 `ConfigAccessor` 隔离）。这一档钉六样输入里的第一样：`accounts`
 * （`loadAuthUsers` 返回数组的**对象身份**）。
 *
 * ⚠️ **这一档存在的理由（一个零覆盖缺口的补齐）**：`memo.accounts === accounts` 这一句曾
 * **完全没有护栏** —— 删掉它，全量用例**逐条全绿**，而 `users.json` 的热加载从此**永久失效**。
 * 本档三条纪律、私有 store + 假时钟的夹具理由、以及「命中面行为不可观测、只有源码级断言能锁」
 * 这条诚实记录，逐条在 `AGENTS.md`；命中面本身在 `snapshot-source-guards.test.ts`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIdentityFromConfig } from "@/core/identity.js";
import { ConfigStore, accountLocatorFor, configAccessorFromStore, type ConfigAccessor } from "@/config/index.js";
import { loadAuthUsers } from "@/datasource/users/index.js";
import type { CoreContext } from "@/core/context.js";
import type { AuthAccount, IdentityOptions, IdentityProvider } from "@/core/types/identity.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";
import { testContextFor } from "../../../helpers/config.js";
import { b64, basicHeader, ctxWith } from "./_identity-snapshot-memo.js";

/** 观察面占位：只用来给 `loadAuthUsers` 做前提断言，不需要任何事件 */
const noopOnEvent = (): void => undefined;

describe("identity/factory 快照记忆化的失效判据", () => {
  let dir: string;
  let usersFile: string;
  let store: ConfigStore;
  let accessor: ConfigAccessor;
  let ctx: CoreContext;
  /**
   * 单调递增的 mtime 写入：绕开文件系统时间戳粒度，让「内容已变」这件事是确定的
   * （手法照抄 `config/auth-users/read.test.ts`，不自己发明）
   */
  let mtime = 0;

  /** 把账号表写进 users.json 并返回该文件路径 */
  function writeUsers(accounts: AuthAccount[]): string {
    mtime += 1000;
    fs.writeFileSync(usersFile, JSON.stringify(accounts));
    fs.utimesSync(usersFile, mtime / 1000, mtime / 1000);
    return usersFile;
  }

  /** 越过 `readJsonCached` 的 1s stat 节流窗口（fake timers 控时钟，同既有手法） */
  function crossThrottle(): void {
    vi.advanceTimersByTime(1500);
  }

  /** 用当前 store 的值建一个动态门面（形参是 CoreContext 三件套整体注入） */
  function newProvider(): IdentityProvider & { jwtVerify?: IdentityOptions["jwtVerify"] } {
    return createIdentityFromConfig(ctx);
  }

  beforeEach(() => {
    // 假时钟必须在**第一次**读账号表之前装上：`readJsonCached` 的节流窗口用 `Date.now()`
    // 算 `checkedAt`，不装假时钟就只能靠真 `sleep(1100)`（慢且依赖墙钟）
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-snapshot-memo-"));
    usersFile = path.join(dir, "users.json");
    mtime = 0;
    // 每例一份**私有** store：记忆表 `liveSnapshots` 与 `readJsonCached` 的节流缓存都按
    // accessor / 路径隔离，私有实例让用例之间零串号
    store = new ConfigStore();
    // ⚠️ 必须显式钉住 `authUsersFile`：不钉的话 `ConfigStore` 的缺省是相对路径
    // `cfg/users.json`（按 cwd 解析 = 仓库根），会**静默读到开发者本地的账号表**——
    // 症状是断言里凭空多出别人机器上的账号，且本机红、CI 绿。
    store.set("authUsersFile", usersFile);
    accessor = configAccessorFromStore(store);
    ctx = testContextFor(accessor);
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── 0. 前提：对象身份判据为什么成立 ──────────────────────────────────────────
  // 这一条不是热加载用例，而是**热加载用例的地基**：`memo.accounts === accounts` 之所以
  // 能当判据，前提是「内容未变时 `loadAuthUsers` 返回同一个数组对象；内容真变了才换」。
  // 地基塌了，上面那几条即便全绿也证明不了任何东西。
  it("前提：内容未变时 loadAuthUsers 返回同一个数组对象，越过节流且内容变了才换新对象", () => {
    writeUsers([{ username: "alice", password: "pw1" }]);
    const first = loadAuthUsers(accountLocatorFor(accessor), noopOnEvent);
    expect(first).toHaveLength(1);

    // 内容未变（连写都不写）：跨过节流窗口也仍是**同一个对象**
    crossThrottle();
    const unchanged = loadAuthUsers(accountLocatorFor(accessor), noopOnEvent);
    expect(unchanged, "内容未变时必须复用同一个对象，否则对象身份判据站不住").toBe(first);

    // 内容真变了 + 越过节流：换新对象（这正是判据要捕捉的那一次变化）
    writeUsers([{ username: "bob", password: "pw2" }]);
    crossThrottle();
    const changed = loadAuthUsers(accountLocatorFor(accessor), noopOnEvent);
    expect(changed, "内容变了必须换新对象").not.toBe(first);
    expect(changed.map((a) => a.username)).toEqual(["bob"]);
  });

  // ── 1. accounts（对象身份）—— 本档的核心交付 ────────────────────────────────
  it("改写 users.json 后新账号放行、旧账号不再放行（identify 与 isOwnCredential 两条路径）", async () => {
    store.set("authEnabled", true);
    store.set("authType", "basic");
    store.set("authLogging", true);
    writeUsers([{ username: "alice", password: "pw1" }]);

    const provider = newProvider();
    expect((await provider.identify(ctxWith(basicHeader("alice", "pw1")))).passed).toBe(true);
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(true);

    // 前提断言：这一轮改写**真的**让输入换了对象（否则下面的红绿分不清是判据没生效
    // 还是输入压根没变——这是「红在正确的地方」的保证）
    const before = loadAuthUsers(accountLocatorFor(accessor), noopOnEvent);

    // 改写 users.json：alice 换成 bob（账号名与密码都不同，size 与 mtime 同时变）
    writeUsers([{ username: "bob", password: "pw2" }]);
    crossThrottle();
    const after = loadAuthUsers(accountLocatorFor(accessor), noopOnEvent);
    expect(after, "前提：输入对象确实换了").not.toBe(before);

    // 识别路径：旧凭证不再放行，新凭证放行
    expect((await provider.identify(ctxWith(basicHeader("alice", "pw1")))).passed).toBe(false);
    const bob = await provider.identify(ctxWith(basicHeader("bob", "pw2")));
    expect(bob.passed).toBe(true);
    expect(bob.username).toBe("bob");

    // 出站剥离路径：**同一份** live 闭包，两条路径必须同步换
    // （判据读一份、识别读另一份 = 能过鉴权的凭证没被剥 = 凭证泄漏）
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(false);
    expect(provider.isOwnCredential("authorization", `Basic ${b64("bob:pw2")}`)).toBe(true);
  });

  it("同一个账号换密码（口令轮换）同样立刻生效，且审计事件跟着换", async () => {
    store.set("authEnabled", true);
    store.set("authType", "basic");
    store.set("authLogging", true);
    writeUsers([{ username: "alice", password: "pw1" }]);

    const provider = newProvider();
    const seen: ProxyAuthEvent[] = [];
    const onAuthEvent = (e: ProxyAuthEvent): void => {
      seen.push(e);
    };
    // 口令轮换是「用户名不变、密码变」——上一条（换用户名）不覆盖这个形态
    const ok = await provider.identify(ctxWith(basicHeader("alice", "pw1"), onAuthEvent));
    expect(ok.passed).toBe(true);
    expect(ok.username).toBe("alice");
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(true);

    writeUsers([{ username: "alice", password: "pw2" }]);
    crossThrottle();

    // 旧口令在两条路径上都必须失效
    expect((await provider.identify(ctxWith(basicHeader("alice", "pw1"), onAuthEvent))).passed).toBe(
      false,
    );
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(false);
    // 新口令放行（否则这条会退化成「换密码 = 全员拒」）
    const rotated = await provider.identify(ctxWith(basicHeader("alice", "pw2"), onAuthEvent));
    expect(rotated.passed).toBe(true);
    expect(rotated.username).toBe("alice");
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw2")}`)).toBe(true);

    // 审计：三轮各一条，结论与身份跟着快照换（`user` 只在放行时写）
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ passed: true, user: "alice" });
    expect(seen[1]).toMatchObject({ passed: false, attempted: "alice" });
    expect(seen[2]).toMatchObject({ passed: true, user: "alice" });
  });
});