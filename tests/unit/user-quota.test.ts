/**
 * `users.json` 的 `quota` 字段（数据层：形状校验 + 读取面）
 *
 * @description
 * 判定与计量在 `tests/unit/traffic-account.test.ts` 与
 * `tests/integration/traffic-quota.test.ts`；本文件只答一个问题：
 * **磁盘上这份配置能不能被读成一份可信的配额表**。
 *
 * 三组护栏：
 * 1. **形状校验**（可选 / `bytes` 缺省补 0 / 非负安全整数 / 未知键 fail-closed，含**分方向上限
 *    字段名一律非法**）
 * 2. **`ACCOUNT_KEYS` 联动**（带 `quota` 的文件必须校验通过——漏加白名单会让**所有**带配额的
 *    账号文件被判非法，这是一条专门断言 + 一次变异测试锁住的）
 * 3. **读取面**（`loadUserQuota` 复用账号表同一条读取路径、热加载语义、深度冻结、热路径零分配）
 *
 * ### 本档锁住的决策：四个**已否决**的方向（文档里出现即为错，除非同时改掉这里的负向护栏）
 *
 * **① 禁限速 / 速率整形。** 只能到 chunk 粒度（TLS record ~16KB），低限速值要靠延迟换平滑；
 * 且整形必然要 `pause()`/`resume()`，会与 `guardDialing` 的半关闭联动形成**第三层流控**。牙齿：
 * `未知子键 fail-closed` 里的 `expect(bad({ bytes: 1, rateBps: 100 })).toBeUndefined()` /
 * `rate` / `bytesPerSecond`，外加 `本文件不出现任何限速/并发字段名` 那条源码级负向。
 *
 * **② 禁每用户最大并发连接数。** 那是「连接数配额」不是「流量配额」，与窗口 / 字节两条轴都
 * 正交；真要做必须先定义「并发数按哪个窗口重置」。牙齿：同上那条里的
 * `expect(bad({ bytes: 1, maxConnections: 4 })).toBeUndefined()` / `concurrency`。
 *
 * **③ 禁滚动时间窗。** 理由（解释成本 / 聚合成本 / 不预留占位值）写在「窗口化」与
 * `window.ts` 文件头。牙齿：`非法 window 整组非法` 里的 `expect(bad("week")).toBeUndefined()` /
 * `bad("hour")` / `bad("rolling")` / `bad("weekly")` / `bad("DAY")` / `bad("Month")` 整组，
 * 外加源码级负向 `expect(quotaWindowSet).not.toMatch(/week|hour|rolling/)`。
 *
 * **④ 禁跨 worker 共享账本。** 每个 worker 写自己那份，**没有**中心聚合、没有文件锁、没有 IPC
 * 汇总。代价是「同一用户被分到两个 worker 时额度各算各的」——`cluster.fork()` 的负载分配不
 * 保证粘性，理论上可被绕开一点额度；接受它换来的是「账本 IO 完全不跨进程协调」这个简单得多
 * 的模型。真要共享必须先引入跨进程互斥，那与「`consume` 同步无锁」那条论证**直接冲突**。
 * ⚠️ **这一条没有任何断言会红**（跨进程共享在单进程测试里根本不可观测）；它靠
 * `tests/unit/traffic-ledger.test.ts` 那条源码级断言「零裸 `cluster.fork()`、`forkWorker()`
 * 调用点恰好 3 个」间接兜住**引入面**，但「不共享」这个事实本身测不出来。
 *
 * ### 另外四条同样有牙齿的裁决
 *
 * **⑤ 缺省 `month` 的归一在消费侧**（`core/traffic/window.ts:quotaWindow`）**，不在本层补默认值**
 * — 归一化产物只回显磁盘上写了什么；缺省时**不写 `window` 键**（写了就等于在产物里塞一个运维
 * 没配过的值，并让「旧文件产物逐字不变」那条不变量失效）。故 `UserQuota.window` 是可选键，
 * `QUOTA_KEYS` 是**含 `window` 的闭合集合**（漏加 → 所有写了窗口的文件因「未知子键」整组作废）。
 * 牙齿（本档「缺省**不写** window 键」那条）：
 * `expect(Object.keys(out[0]!.quota!).sort()).toEqual(["bytes"])`
 * ——补一个 `window: "month"` 就红；同档
 * `expect(Object.keys(bare[0]!)).toEqual(["username", "password"])` 是「旧格式逐字不变」那一面。
 *
 * **⑥ `quota` 与 `acl` 互不影响，但各自独立决定整份文件是否作废**（一个合法一个非法 → **整份文件判非法**）
 * — 否掉「只丢非法的那一个、另一个照常生效」— 那会造出「我配了名单但它没生效」这种要读源码才能
 * 查出来的问题。牙齿（本档「quota 与 acl 互不影响：各自独立校验、各自独立决定整份文件是否作废」那条）：
 * 两个都合法时逐字 `toEqual`（互不干扰）；一个非法时 `toBeUndefined()`（**整份文件作废**，
 * 不是「只丢非法的那一个」）。本档「window 与 acl 各自独立」那条是同一裁决的第四种组合。
 *
 * **⑦ 热路径零分配是硬要求** — `loadUserPolicy` / `loadUserQuota` 是**每请求**调用的
 * （`consume` 甚至是**每 chunk** 调用，一次大文件传输几万次），故用下标循环定位账号
 * （`find` 的闭包也是分配）+ `WeakMap` 按**源对象身份**记忆冻结副本，连续两次查询返回**同一对象身份**。
 * 牙齿（本档「热路径零分配：同一用户连续两次查询返回同一对象身份」那条）：
 * `expect(second).toBe(first)` ——判据用 `toBe`（同身份）而不是 `toEqual`，后者对「重新冻结了一份
 * 内容相同的新对象」照样通过，**锁不住分配**；同档
 * `expect(loadUserQuota("alice", testConfig)).not.toBe(first)` 钉住「按用户名分槽，不串号」。
 * 记忆表外仍**新建**冻结副本，故「拿到的对象与缓存内部引用无关」由本档「返回值只读且与缓存内部引用无关」
 * 那条（`expect(() => { (q as {bytes:number}).bytes = 1; }).toThrow(TypeError)`）独立锁住。
 *
 * **⑧ `acl` 与 `quota`（含 `window`）对凭证索引都不可见** —
 * `core/helpers/credentials.ts` 消费的是 core 那份两字段 `AuthAccount`（`core/types/proxy.ts`），
 * 两个可选字段既不进 `basic`/`uidUsers` 索引也不改变任何比对行为——加进索引会让「同一个用户名+密码
 * 在不同文件里表现不同」。牙齿（本档「凭证索引不受 quota 影响」与「window 对凭证索引同样不可见」两条）：
 * 两侧**账号集合必须相同**（否则比的是「多了一个账号」而不是「quota 有没有污染索引」），
 * 另加 `expect([...b.basic.keys()].some((k) => k.includes("1024"))).toBe(false)` /
 * `…includes("corp.com")` / `…includes("day")` 三条——配额数字、名单条目、窗口字面量**一个都不许进索引**。
 * 配额的另一半在 `tests/unit/auth-users.test.ts`（`acl` 那一侧），两档合起来才是这句话的全部含义。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAuthUsers, loadUserQuota, readAuthUsers, validateAuthUsers } from "@/config/files/users.js";
import { credentialIndexesFor, matchBasicCredential, encodeBasicCredentials } from "@/core/helpers/index.js";
import { restoreConfig, set, snapshotConfig, testConfig } from "../helpers/config.js";
import { codeOf } from "../helpers/source-scan.js";

/** bytes 为 0 = 不限流（与「没配」语义相同，故不计入「真配了配额」） */
const UNLIMITED = { bytes: 0 };

const MIXED = [
  { username: "alice", password: "pw1" },
  // acl 刻意写成**已归一**形态（whitelist/blacklist 都在）：本文件多处拿 MIXED 同时当
  // 「输入」与「期望产物」用，产物侧必定补出空名单。
  { username: "bob", password: "pw2", acl: { target: { whitelist: ["*.corp.com"], blacklist: [] } } },
  { username: "carol", password: "pw3", quota: { bytes: 1024 } },
];

describe("config/auth-users quota.window（只认 day/month 两个日历窗）", () => {
  it("白名单联动：带 window 的文件校验通过（把 window 从 QUOTA_KEYS 删掉 → 本条立刻红）", () => {
    // 这是「最容易漏的联动点」的第二处（第一处是 ACCOUNT_KEYS 里的 `quota` 本身）：
    // `QUOTA_KEY_SET` 是**闭合集合**，漏掉 `window` 会让所有写了窗口的文件因「未知子键」
    // 整组非法 → 启动期 abort。**已变异测试验证**：把它从 QUOTA_KEYS 删掉 → 本条红。
    expect(
      validateAuthUsers([
        { username: "a", password: "x", quota: { bytes: 10, window: "day" } },
        { username: "b", password: "x", quota: { bytes: 1, window: "month" } },
      ]),
    ).toEqual([
      { username: "a", password: "x", quota: { bytes: 10, window: "day" } },
      { username: "b", password: "x", quota: { bytes: 1, window: "month" } },
    ]);
  });

  it("合法值只有 day / month，且原样回显在归一化产物里", () => {
    for (const w of ["day", "month"]) {
      const out = validateAuthUsers([{ username: "a", password: "x", quota: { window: w } }]);
      expect(out).toEqual([
        { username: "a", password: "x", quota: { bytes: 0, window: w } },
      ]);
    }
  });

  it("缺省**不写** window 键（缺省 month 是消费侧裁决，不许塞进配置产物）", () => {
    // 为什么不在这里补 month：归一化产物只回显磁盘上写了什么。补了会让「旧文件产物逐字不变」
    // 那条不变量失效（运维没配 window，产物里却凭空多出一个值）。缺省归一在
    // `core/traffic/window.ts:quotaWindow` —— 那是消费侧裁决，不是文件事实。
    const out = validateAuthUsers([{ username: "a", password: "x", quota: { bytes: 5 } }])!;
    expect(out[0]!.quota).toEqual({ bytes: 5 });
    expect(Object.keys(out[0]!.quota!).sort()).toEqual(["bytes"]);
    // 旧格式（没 quota）同样不凭空长出 quota/window 键
    const bare = validateAuthUsers([{ username: "a", password: "x" }])!;
    expect(Object.keys(bare[0]!)).toEqual(["username", "password"]);
  });

  it("非法 window 整组非法（其它字面量 / 大小写变体 / 空串 / 非字符串全部 abort）", () => {
    const bad = (window: unknown): unknown =>
      validateAuthUsers([{ username: "a", password: "x", quota: { bytes: 1, window } }]);
    // 不做滚动窗：week/hour 都是「看起来合理但明确不做」的值，必须 fail-closed
    expect(bad("week")).toBeUndefined();
    expect(bad("hour")).toBeUndefined();
    expect(bad("rolling")).toBeUndefined();
    expect(bad("weekly")).toBeUndefined();
    expect(bad("")).toBeUndefined();
    // 大小写敏感：枚举值一律精确匹配，"DAY" 这种"看懂了"的手滑必须报错而不是回退
    expect(bad("DAY")).toBeUndefined();
    expect(bad("Month")).toBeUndefined();
    expect(bad(true)).toBeUndefined();
    expect(bad(null)).toBeUndefined();
    expect(bad(1)).toBeUndefined();
    expect(bad(["day"])).toBeUndefined();
    // window 非法时**整组作废**（连字节字段一起丢），绝不是「只丢 window」
    expect(bad("week")).toBeUndefined();
  });

  it("window 与字节字段互不救场：任一非法即整组非法（fail-closed，与 acl 同语义）", () => {
    expect(
      validateAuthUsers([{ username: "a", password: "x", quota: { bytes: -1, window: "day" } }]),
    ).toBeUndefined();
    expect(
      validateAuthUsers([{ username: "a", password: "x", quota: { window: "day", rateBps: 1 } }]),
    ).toBeUndefined();
  });

  it("window 与 acl 各自独立：一个合法一个非法 → 整份文件作废", () => {
    expect(
      validateAuthUsers([
        {
          username: "a",
          password: "x",
          acl: { target: { whitelist: ["*.corp.com"] } },
          quota: { bytes: 10, window: "day" },
        },
      ]),
    ).toEqual([
      {
        username: "a",
        password: "x",
        acl: { target: { whitelist: ["*.corp.com"], blacklist: [] } },
        quota: { bytes: 10, window: "day" },
      },
    ]);
    expect(
      validateAuthUsers([
        {
          username: "a",
          password: "x",
          acl: { target: { whitelist: ["*.corp.com"] } },
          quota: { window: "week" },
        },
      ]),
    ).toBeUndefined();
    expect(
      validateAuthUsers([
        { username: "a", password: "x", acl: { target: { whitelist: ["a.com:80"] } }, quota: { window: "day" } },
      ]),
    ).toBeUndefined();
  });

  it("window 对凭证索引同样不可见（与 acl/quota 一样不进 basic/uidUsers）", () => {
    const plain = validateAuthUsers([{ username: "alice", password: "pw1" }])!;
    const withWindow = validateAuthUsers([
      { username: "alice", password: "pw1", quota: { bytes: 10, window: "day" } },
    ])!;
    const a = credentialIndexesFor(plain);
    const b = credentialIndexesFor(withWindow);
    expect([...b.basic.entries()].sort()).toEqual([...a.basic.entries()].sort());
    expect([...b.uidUsers].sort()).toEqual([...a.uidUsers].sort());
    expect([...b.basic.keys()].some((k) => k.includes("day"))).toBe(false);
  });

  it("本文件不出现任何滚动窗/速率/并发字段名（不预留占位值）", () => {
    const code = codeOf("config", "files", "users.ts");
    expect(code).not.toMatch(/rateBps|maxConnections|\bconcurrency\b/);
    // 滚动窗的字面量也不许出现在校验表里（真要支持必须连同账本形态一起设计）
    const quotaWindowSet = code.slice(code.indexOf("QUOTA_WINDOW_VALUES"), code.indexOf("USER_POLICY_GROUP_KEYS"));
    expect(quotaWindowSet).not.toMatch(/week|hour|rolling/);
  });
});

describe("config/auth-users loadUserQuota 的 window（读取面）", () => {
  let dir: string;
  let snap: Record<string, unknown>;
  let file: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-quota-window-test-"));
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

  it("读出的配额带 window（缺省时该键不存在，由消费侧归一为 month）", () => {
    fs.writeFileSync(
      file,
      JSON.stringify([
        { username: "a", password: "x", quota: { bytes: 10, window: "day" } },
        { username: "b", password: "x", quota: { bytes: 10 } },
      ]),
    );
    expect(loadUserQuota("a", testConfig)).toEqual({
      bytes: 10,
      window: "day",
    });
    expect(loadUserQuota("b", testConfig)).toEqual({ bytes: 10 });
  });

  it("带 window 的返回值深度冻结，且热路径零分配（toBe 同身份）", () => {
    fs.writeFileSync(
      file,
      JSON.stringify([{ username: "a", password: "x", quota: { bytes: 10, window: "day" } }]),
    );
    const first = loadUserQuota("a", testConfig)!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as { window?: string }).window = "month";
    }).toThrow(TypeError);
    // 记忆表按源对象身份命中：连续两次查询同一对象（带 window 的形态也必须成立）
    expect(loadUserQuota("a", testConfig)).toBe(first);
  });

  it("坏 window 保留上一份有效值（与字节字段同一条缓存与坏文件策略）", () => {
    fs.writeFileSync(
      file,
      JSON.stringify([{ username: "a", password: "x", quota: { bytes: 10, window: "day" } }]),
    );
    expect(loadUserQuota("a", testConfig)?.window).toBe("day");
    fs.writeFileSync(
      file,
      JSON.stringify([{ username: "a", password: "x", quota: { bytes: 10, window: "week" } }]),
    );
    expect(readAuthUsers({ config: testConfig, force: true }).error).toBeTruthy();
    expect(loadUserQuota("a", testConfig)?.window).toBe("day");
  });
});

describe("config/auth-users validateAuthUsers 的 quota 形状", () => {
  it("ACCOUNT_KEYS 联动：带 quota 的文件校验通过（漏加白名单 → 整份文件被判非法）", () => {
    // 这条是「最容易漏的联动点」的专门断言：`ACCOUNT_KEYS` 不含 `quota` 时，
    // 上面 MIXED 里所有带配额的账号文件都会因「未知顶层键」整份作废。
    expect(validateAuthUsers(MIXED)).toEqual(MIXED);
  });

  it("旧格式逐字不变：不写 quota 键，键集合恰为 username/password", () => {
    const out = validateAuthUsers([{ username: "alice", password: "pw1" }])!;
    expect(out).toEqual([{ username: "alice", password: "pw1" }]);
    expect(Object.keys(out[0]!)).toEqual(["username", "password"]);
  });

  it("quota 可选：空对象补成 0（= 不限流），只写 window 时 bytes 也补 0", () => {
    expect(validateAuthUsers([{ username: "a", password: "x", quota: {} }])).toEqual([
      { username: "a", password: "x", quota: UNLIMITED },
    ]);
    expect(validateAuthUsers([{ username: "a", password: "x", quota: { window: "day" } }])).toEqual([
      { username: "a", password: "x", quota: { bytes: 0, window: "day" } },
    ]);
  });

  it("非负安全整数都合法：0 / 1 / 2^53-1（边界）", () => {
    const max = Number.MAX_SAFE_INTEGER;
    for (const bytes of [0, 1, max]) {
      expect(validateAuthUsers([{ username: "a", password: "x", quota: { bytes } }])).toEqual([
        { username: "a", password: "x", quota: { bytes } },
      ]);
    }
  });

  it("非法值一律整组非法：负数 / 小数 / 字符串 / 布尔 / null / NaN / Infinity / 超安全整数", () => {
    const bad = (quota: unknown): unknown =>
      validateAuthUsers([{ username: "a", password: "x", quota }]);
    expect(bad({ bytes: -1 })).toBeUndefined();
    expect(bad({ bytes: 1.5 })).toBeUndefined();
    expect(bad({ bytes: "1024" })).toBeUndefined();
    expect(bad({ bytes: true })).toBeUndefined();
    expect(bad({ bytes: null })).toBeUndefined();
    expect(bad({ bytes: Number.NaN })).toBeUndefined();
    expect(bad({ bytes: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(bad({ bytes: Number.MAX_SAFE_INTEGER + 2 })).toBeUndefined();
    // quota 本身不是对象
    expect(bad("x")).toBeUndefined();
    expect(bad(null)).toBeUndefined();
    expect(bad([])).toBeUndefined();
    expect(bad(1024)).toBeUndefined();
  });

  it("未知子键 fail-closed（不写 rateBps / concurrency 之类：限速与并发数明确不做）", () => {
    const bad = (quota: unknown): unknown =>
      validateAuthUsers([{ username: "a", password: "x", quota }]);
    expect(bad({ bytes: 1, rateBps: 100 })).toBeUndefined();
    expect(bad({ bytes: 1, maxConnections: 4 })).toBeUndefined();
    expect(bad({ bytes: 1, concurrency: 2 })).toBeUndefined();
    expect(bad({ bytes: 1, rate: 1 })).toBeUndefined();
    expect(bad({ bytesPerSecond: 1 })).toBeUndefined();
  });

  it("分方向上限字段一律非法（quota 只有一个合计上限，不做 aliases）", () => {
    // 零兼容：这两个名字**不在** QUOTA_KEYS 里，故出现即「未知子键」→ 整组非法 → 启动 abort。
    // 刻意不认它们：认下旧名等于给「我配了分向上限」一个假的安全感，而实际上判定是账号级封禁，
    // 配出来的语义与运维想的不同（见 `src/config/files/users.ts` 的 `UserQuota`）。
    const bad = (quota: unknown): unknown =>
      validateAuthUsers([{ username: "a", password: "x", quota }]);
    expect(bad({ bytesUp: 1 })).toBeUndefined();
    expect(bad({ bytesDown: 1 })).toBeUndefined();
    expect(bad({ bytes: 1, bytesUp: 1 })).toBeUndefined();
    expect(bad({ bytes: 1, bytesDown: 1 })).toBeUndefined();
    expect(bad({ bytesPerSecond: 1 })).toBeUndefined();
  });

  it("quota 与 acl 互不影响：各自独立校验、各自独立决定整份文件是否作废", () => {
    // 两者都合法 → 互不干扰
    expect(
      validateAuthUsers([
        {
          username: "a",
          password: "x",
          acl: { target: { blacklist: ["ads.io"] } },
          quota: { bytes: 10 },
        },
      ]),
    ).toEqual([
      {
        username: "a",
        password: "x",
        acl: { target: { whitelist: [], blacklist: ["ads.io"] } },
        quota: { bytes: 10 },
      },
    ]);
    // 一个合法一个非法 → **整份文件非法**（fail-closed），不是「只丢非法的那一个」
    expect(
      validateAuthUsers([
        { username: "a", password: "x", acl: { target: { blacklist: ["ads.io"] } }, quota: { bytes: -1 } },
      ]),
    ).toBeUndefined();
    expect(
      validateAuthUsers([
        { username: "a", password: "x", acl: { target: { blacklist: ["ads.io:80"] } }, quota: { bytes: 1 } },
      ]),
    ).toBeUndefined();
  });

  it("quota 不让原有账号规则退让（重复用户名 / 含 ':' / 未知顶层键 / 密码类型）", () => {
    expect(
      validateAuthUsers([
        { username: "a", password: "x", quota: {} },
        { username: "a", password: "y" },
      ]),
    ).toBeUndefined();
    expect(validateAuthUsers([{ username: "a:b", password: "x", quota: {} }])).toBeUndefined();
    expect(validateAuthUsers([{ username: "", password: "x", quota: {} }])).toBeUndefined();
    expect(
      validateAuthUsers([{ username: "a", password: "x", quota: {}, role: "admin" }]),
    ).toBeUndefined();
    expect(validateAuthUsers([{ username: "a", quota: {} }])).toBeUndefined();
    expect(validateAuthUsers([{ username: "a", password: 1, quota: {} }])).toBeUndefined();
  });

  it("凭证索引不受 quota 影响（quota 与 acl 一样对索引不可见）", () => {
    // 两侧**账号集合必须相同**，否则比的是「多了一个账号」而不是「quota 有没有污染索引」
    const plain = validateAuthUsers([
      { username: "alice", password: "pw1" },
      { username: "bob", password: "pw2" },
      { username: "carol", password: "pw3" },
    ])!;
    const withQuota = validateAuthUsers(MIXED)!;
    const a = credentialIndexesFor(plain);
    const b = credentialIndexesFor(withQuota);
    expect([...b.basic.entries()].sort()).toEqual([...a.basic.entries()].sort());
    expect([...b.uidUsers].sort()).toEqual([...a.uidUsers].sort());
    expect(matchBasicCredential(encodeBasicCredentials("carol", "pw3"), b)).toBe("carol");
    // 配额数字绝不进索引（basic 键只可能是 b64(user:pass) / user:pass 两种形态）
    expect([...b.basic.keys()].some((k) => k.includes("1024"))).toBe(false);
    expect([...b.basic.keys()].some((k) => k.includes("corp.com"))).toBe(false);
  });
});

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
    expect(loadUserQuota("carol", testConfig)).toEqual({
      bytes: 1024,
    });
    // 「未配 quota」与「用户不存在」都返回 undefined（= 不限流），不是空对象、更不是抛错
    expect(loadUserQuota("alice", testConfig)).toBeUndefined();
    expect(loadUserQuota("nobody", testConfig)).toBeUndefined();
    expect(loadUserQuota("", testConfig)).toBeUndefined();
  });

  it("配了但 bytes 为 0 → 返回 0 配额（消费层据此判「不限流」）", () => {
    write([{ username: "dave", password: "p", quota: { bytes: 0 } }]);
    expect(loadUserQuota("dave", testConfig)).toEqual(UNLIMITED);
  });

  it("文件缺失 → undefined 且不算错误", () => {
    const r = readAuthUsers({ config: testConfig, force: true });
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(loadUserQuota("carol", testConfig)).toBeUndefined();
  });

  it("坏文件保留上一份有效值（与账号表同一缓存条目，不是另开读取器）", () => {
    write(MIXED);
    expect(loadUserQuota("carol", testConfig)?.bytes).toBe(1024);
    write([{ username: "carol", password: "pw3", quota: { bytes: -5 } }]);
    // 强制重读让「这份内容非法」落到缓存条目上
    expect(readAuthUsers({ config: testConfig, force: true }).error).toBeTruthy();
    // 同一缓存条目：非强制的读取也能看到那个 error（独立读取器做不到这点）
    expect(readAuthUsers({ config: testConfig }).error).toBeTruthy();
    expect(loadUserQuota("carol", testConfig)?.bytes).toBe(1024);
  });

  it("热加载完整循环：改配额越过 1s 节流后对新请求生效", () => {
    vi.useFakeTimers();
    try {
      write([{ username: "carol", password: "pw3", quota: { bytes: 100 } }]);
      expect(loadUserQuota("carol", testConfig)?.bytes).toBe(100);

      // 未越过节流 → 仍是上一份
      write([{ username: "carol", password: "pw3", quota: { bytes: 200 } }]);
      expect(loadUserQuota("carol", testConfig)?.bytes).toBe(100);

      // 越过节流 → 新配额生效
      vi.advanceTimersByTime(1500);
      expect(loadUserQuota("carol", testConfig)?.bytes).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("返回值只读且与缓存内部引用无关（深度冻结的独立副本）", () => {
    write(MIXED);
    const q = loadUserQuota("carol", testConfig)!;
    expect(Object.isFrozen(q)).toBe(true);
    // 改拿到的对象不影响缓存里的那份
    expect(() => {
      (q as { bytes: number }).bytes = 1;
    }).toThrow(TypeError);
    expect(loadUserQuota("carol", testConfig)?.bytes).toBe(1024);
    expect(loadAuthUsers(testConfig)[2]?.quota?.bytes).toBe(1024);
  });

  it("热路径零分配：同一用户连续两次查询返回同一对象身份", () => {
    // 保护：`consume` 是**每 chunk** 调用（一次大文件传输几万次），「每次新建一份冻结对象」
    // 在这种频次上是纯浪费。判据用 toBe（同身份）而不是 toEqual —— 后者对「重新冻结了一份
    // 内容相同的新对象」照样通过，锁不住分配。
    write(MIXED);
    const first = loadUserQuota("carol", testConfig);
    const second = loadUserQuota("carol", testConfig);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    // 按用户名分槽，不串号
    expect(loadUserQuota("alice", testConfig)).not.toBe(first);
  });

  it("事件回调经账号表同一条观察面抛出（一次内容变更只报一次 reloaded）", () => {
    write(MIXED);
    const events: string[] = [];
    const onEvent = (e: { type: string; label: string }): void => {
      events.push(`${e.label}:${e.type}`);
    };
    loadUserQuota("carol", testConfig, onEvent);
    write([{ username: "carol", password: "pw3" }]);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1500);
      expect(loadUserQuota("carol", testConfig, onEvent)).toBeUndefined();
      expect(events).toEqual(["用户账号文件:reloaded"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("config/auth-users 跨层一致性护栏（quota 读取面）", () => {
  it("账号表只有一条读取通路：users.ts 零直接读取器，两个后端各一处", () => {
    const code = codeOf("config", "files", "users.ts");
    const store = codeOf("config", "files", "account-store.ts");
    // 另开一个读取器会造成两份节流缓存、两份解析、两套坏文件处理并互相污染同一缓存键。
    // 读取点**搬进了 `account-store.ts`**（两个后端各一个实现器），所以判据改成
    // 「每个后端恰好一处，且 `users.ts` 一处都没有」——锚的是**今天仍存在的形状**
    // （函数调用 / 文件名），不是已搬走的那个符号（点不存在的符号，断言会恒真）。
    expect(code, "users.ts 不许自己开读取器").not.toMatch(/readJsonCached\(|readCachedSource\(/);
    expect((store.match(/readJsonCached\(/g) ?? []).length, "json 后端恰好一处").toBe(1);
    expect(
      (store.match(/readCachedSource\s*[<(]/g) ?? []).length,
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
    const code = codeOf("config", "files", "users.ts");
    expect(code).not.toMatch(/rateBps|maxConnections|\bconcurrency\b/);
  });

  it("启动期强校验对带 quota 的文件同样 fail-closed（readAuthUsersAsync 共用同一份形状校验）", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "user-quota-async-"));
    try {
      const ok = path.join(d, "ok.json");
      fs.writeFileSync(ok, JSON.stringify(MIXED));
      const good = await import("@/config/files/users.js").then((m) => m.readAuthUsersAsync(ok));
      expect(good.error).toBeUndefined();
      expect(good.value).toEqual(MIXED);

      const bad = path.join(d, "bad.json");
      fs.writeFileSync(bad, JSON.stringify([{ username: "c", password: "p", quota: { bytes: -1 } }]));
      const r = await import("@/config/files/users.js").then((m) => m.readAuthUsersAsync(bad));
      expect(r.error).toBeTruthy();
      expect(r.exists).toBe(true);
      expect(r.value).toEqual([]);

      // 缺失文件仍只算缺失
      const missing = await import("@/config/files/users.js").then((m) =>
        m.readAuthUsersAsync(path.join(d, "absent.json")),
      );
      expect(missing.exists).toBe(false);
      expect(missing.error).toBeUndefined();
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
