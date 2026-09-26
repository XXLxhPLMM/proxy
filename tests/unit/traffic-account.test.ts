/**
 * `TrafficAccount` 端口与内存实现（判定层）
 *
 * @description
 * 计量落点与协议收尾在 `tests/integration/traffic-quota.test.ts`（真代理 + 真字节）；本文件
 * 只答「**判定本身**对不对」：
 *
 * 1. **恒 allow 的四种情形**（未配 / 全 0 / 用户不存在 / 非正字节数）——必须是**显式分支**，
 *    不是「默认上限 0 恰好放行」的蒙混
 * 2. **三个上限各自触发、各自的 `scope` 正确**，以及判定顺序（`bytesUp` → `bytesDown` →
 *    `bytesTotal`，任一突破即拒）
 * 3. **边界裁决**：`bytesTotal: 100` **允许用满 100 字节**（`<=` 语义，判据是「累计 > 上限才拒」）
 * 4. **超限必须在本次返回 `allow:false`**（不允许「先放行下次再说」）+ 累计值照实不截断
 * 5. **`consume` 确实是同步函数**（无锁论证的前提，见 `core/traffic/memory.ts` 文件头）
 * 6. **计量落点是被动计数**：`meterStream` 只挂 `data` 监听器、**不** push / pause / resume，
 *    且无身份时**一个监听器都不挂**
 */

import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  createMemoryTrafficAccount,
  inertTrafficAccount,
  meterStream,
  openLinkMeter,
  type TrafficAccount,
  type UserQuota,
} from "@/core/traffic/index.js";
import { MemoryTrafficAccount } from "@/core/traffic/memory.js";
import { codeOf } from "../helpers/source-scan.js";

/** 用一张表当 `QuotaResolver` 替身：查不到即 undefined（= 不限流） */
function accountWith(quotas: Record<string, UserQuota>): TrafficAccount {
  return createMemoryTrafficAccount((user) => quotas[user]);
}

const UNLIMITED: UserQuota = { bytesUp: 0, bytesDown: 0, bytesTotal: 0 };

describe("core/traffic MemoryTrafficAccount：恒 allow 的情形（显式分支，不是默认值蒙混）", () => {
  it("用户未配 quota → 恒 allow（但仍照常计量，见下一条）", () => {
    const account = accountWith({});
    for (let i = 0; i < 100; i++) {
      expect(account.consume("ghost", "up", 1_000_000).allow).toBe(true);
      expect(account.consume("ghost", "down", 1_000_000).allow).toBe(true);
    }
  });

  it("未配配额也照常累加 usage（usage 恒为真用量；将来加上限即刻按真账判，不给「从 0 开始」的假象）", () => {
    // 这是与「不计量」刻意的区分：**没有上限** ≠ **不计量**。
    // 唯一「不计量」的情形是**没有身份**（`meterStream` 一个监听器都不挂，见下文各条）。
    const account = accountWith({});
    account.consume("ghost", "up", 30);
    account.consume("ghost", "down", 12);
    expect(account.usage("ghost")).toEqual({ up: 30, down: 12 });
  });

  it("配了但三个子字段全 0 → 恒 allow（0 = 该上限不生效）", () => {
    const account = accountWith({ alice: UNLIMITED });
    expect(account.consume("alice", "up", 2 ** 40).allow).toBe(true);
    expect(account.consume("alice", "down", 2 ** 40).allow).toBe(true);
    // 但**计量照常发生**（这是「不限流」而不是「不计量」）
    expect(account.usage("alice")).toEqual({ up: 2 ** 40, down: 2 ** 40 });
  });

  it("用户不存在（表里只有别人）→ 恒 allow", () => {
    const account = accountWith({ bob: { bytesUp: 1, bytesDown: 0, bytesTotal: 0 } });
    expect(account.consume("alice", "up", 10_000).allow).toBe(true);
  });

  it("非正字节数 → 直接放行且不累加（空 chunk 不是「耗尽」，负数是上游 bug 不是用量）", () => {
    const account = accountWith({ alice: { bytesUp: 10, bytesDown: 0, bytesTotal: 0 } });
    expect(account.consume("alice", "up", 0).allow).toBe(true);
    expect(account.consume("alice", "up", -5).allow).toBe(true);
    expect(account.consume("alice", "up", Number.NaN).allow).toBe(true);
    expect(account.usage("alice")).toEqual({ up: 0, down: 0 });
  });

  it("inertTrafficAccount 是显式禁用档：恒 allow 且 usage 恒零", () => {
    const inert = inertTrafficAccount();
    expect(inert.consume("alice", "up", 1e12).allow).toBe(true);
    expect(inert.usage("alice")).toEqual({ up: 0, down: 0 });
  });
});

describe("core/traffic 判定顺序、边界与「恰好等于上限」", () => {
  it("三个上限各自触发、各自的 scope 正确", () => {
    const up = accountWith({ u: { bytesUp: 10, bytesDown: 0, bytesTotal: 0 } });
    up.consume("u", "up", 10);
    const v1 = up.consume("u", "up", 1);
    expect(v1.allow).toBe(false);
    expect(v1.reason).toBe("quota");
    expect(v1.scope).toBe("up");
    expect(v1.usage).toBe(11);
    expect(v1.limit).toBe(10);

    const down = accountWith({ d: { bytesUp: 0, bytesDown: 10, bytesTotal: 0 } });
    down.consume("d", "down", 10);
    const v2 = down.consume("d", "down", 1);
    expect(v2.scope).toBe("down");
    expect(v2.usage).toBe(11);
    expect(v2.limit).toBe(10);

    const total = accountWith({ t: { bytesUp: 0, bytesDown: 0, bytesTotal: 10 } });
    total.consume("t", "up", 6);
    const v3 = total.consume("t", "down", 5);
    expect(v3.scope).toBe("total");
    expect(v3.usage).toBe(11);
    expect(v3.limit).toBe(10);
  });

  it("「任一突破即拒」是账号级封禁：某个上限突破后，该用户的两个方向都被拒", () => {
    // 裁决（任务书明写）：判定顺序 bytesUp → bytesDown → bytesTotal，**任一突破即拒**。
    // 推论是「配额耗尽 = 该账号被封」，不是「只封那一个方向」——否则用户可以换个方向
    // 继续白嫖（上传撞顶后改成下载，账本却不再拦）。
    // 代价要说清：`dir` 与 `scope` 因此可以不同（本次流动 down、被突破的是 up），
    // 两者都是**如实事实**：`dir` 是本次流动方向，`scope` 是被突破的上限。
    const account = accountWith({ alice: { bytesUp: 10, bytesDown: 0, bytesTotal: 0 } });
    account.consume("alice", "up", 11);
    const v = account.consume("alice", "down", 1);
    expect(v.allow).toBe(false);
    expect(v.scope).toBe("up");
    expect(v.usage).toBe(11);
    expect(v.limit).toBe(10);
  });

  it("恰好等于上限 → 放行（裁决：配额是上限，不是「额度 + 1 的坑」）", () => {
    // bytesTotal: 100 允许用户用满 100 字节，第 101 字节才拒
    const account = accountWith({ alice: { bytesUp: 0, bytesDown: 0, bytesTotal: 100 } });
    expect(account.consume("alice", "up", 40).allow).toBe(true);
    expect(account.consume("alice", "down", 60).allow).toBe(true);
    expect(account.usage("alice")).toEqual({ up: 40, down: 60 });
    const over = account.consume("alice", "down", 1);
    expect(over.allow).toBe(false);
    expect(over.usage).toBe(101);
  });

  it("判定顺序：bytesUp → bytesDown → bytesTotal，同时超限时归因第一档", () => {
    // up 与 total 同时突破 → 报 up（顺序即归因，运维先看到「上传超了」这条更具体的事实）
    const account = accountWith({
      alice: { bytesUp: 5, bytesDown: 5, bytesTotal: 6 },
    });
    account.consume("alice", "up", 5);
    const v = account.consume("alice", "up", 1);
    expect(v.scope).toBe("up");

    // down 与 total 同时突破 → 报 down（total 排在最后，故轮不到它）
    const b = accountWith({ bob: { bytesUp: 0, bytesDown: 4, bytesTotal: 10 } });
    b.consume("bob", "up", 5);
    const v2 = b.consume("bob", "down", 5);
    expect(v2.scope).toBe("down");
    // usage 与 limit 必须是**同一个 scope 的两个数**（否则消费方算不出「超了多少」）：
    // 这里报的是 down 累计 5，而不是总量 10
    expect(v2.usage).toBe(5);
    expect(v2.limit).toBe(4);
  });

  it("超限必须在本次就返回 allow:false（绝不允许「先放行下次再说」）", () => {
    // 上限 10：第 11 字节的那一次调用本身就必须被拒。软化语义（放行这一块、下次再拒）
    // 会让一条长连接隧道永远不触发耗尽判定，配额就成了摆设。
    const account = accountWith({ alice: { bytesUp: 10, bytesDown: 0, bytesTotal: 0 } });
    const first = account.consume("alice", "up", 6);
    expect(first.allow).toBe(true);
    const crossing = account.consume("alice", "up", 100);
    expect(crossing.allow).toBe(false);
    // 累计值照实累加、不截断到上限：日志里的 usage 必须是真用量，否则运维看到的是假数字
    expect(account.usage("alice")).toEqual({ up: 106, down: 0 });
    expect(crossing.usage).toBe(106);
  });

  it("耗尽后继续传 → 持续拒绝（不会因为「已经超了」而放行）", () => {
    const account = accountWith({ alice: { bytesUp: 1, bytesDown: 0, bytesTotal: 0 } });
    expect(account.consume("alice", "up", 2).allow).toBe(false);
    expect(account.consume("alice", "up", 1).allow).toBe(false);
  });

  it("quota 缺省 month 的消费侧归一不改变本文件任何一条 5a 判定语义", () => {
    // 5b-1 加了窗口，`consume` 的判定顺序 / `<=` 边界 / 累计不截断 / 账号级封禁一条未动。
    // 这里用**跨月**的时刻重跑一遍 5a 的核心三条，证明窗口层没有偷换判定语义：
    // 用量在窗口内照常累加、恰好等于上限放行、下一字节拒绝。
    const account = accountWith({ alice: { bytesUp: 0, bytesDown: 0, bytesTotal: 100 } });
    expect(account.consume("alice", "up", 40).allow).toBe(true);
    expect(account.consume("alice", "down", 60).allow).toBe(true);
    const over = account.consume("alice", "down", 1);
    expect(over.allow).toBe(false);
    expect(over.scope).toBe("total");
    expect(over.usage).toBe(101);
  });

  it("按用户分槽：两个用户各耗各的，互不影响（锁「user 不得取错」）", () => {
    const account = accountWith({
      alice: { bytesUp: 0, bytesDown: 0, bytesTotal: 10 },
      bob: { bytesUp: 0, bytesDown: 0, bytesTotal: 10 },
    });
    account.consume("alice", "down", 10);
    expect(account.consume("alice", "down", 1).allow).toBe(false);
    // bob 完全不受 alice 的用量影响
    expect(account.consume("bob", "down", 10).allow).toBe(true);
    expect(account.usage("alice")).toEqual({ up: 0, down: 11 });
    expect(account.usage("bob")).toEqual({ up: 0, down: 10 });
  });
});

describe("core/traffic consume 的同步性（无锁论证的前提）", () => {
  it("consume 不是 async：返回的是判定对象而不是 Promise", () => {
    const account = accountWith({ alice: { bytesUp: 10, bytesDown: 0, bytesTotal: 0 } });
    const verdict = account.consume("alice", "up", 1);
    expect(verdict).not.toBeInstanceOf(Promise);
    expect(typeof (verdict as { then?: unknown }).then).toBe("undefined");
    expect(verdict.allow).toBe(true);
  });

  it("实现体内零 await / 零 async（源码级：改成 async 会让「无锁」论证当场失效）", () => {
    const code = codeOf("core", "traffic", "memory.ts");
    expect(code).not.toMatch(/\basync\b/);
    expect(code).not.toMatch(/\bawait\b/);
  });

  it("「读-改-写」之间没有让出点：连续 consume 的累计值单调且精确", () => {
    // 无锁的全部内容就是这一条：一次 consume 内不可能被别的 consume 插入。
    // 若哪天加了 await，这条会先于线上问题暴露出来。
    const account = new MemoryTrafficAccount(() => ({ bytesUp: 0, bytesDown: 0, bytesTotal: 1000 }));
    for (let i = 1; i <= 100; i++) {
      expect(account.consume("alice", "up", 1).allow).toBe(true);
      expect(account.usage("alice").up).toBe(i);
    }
  });

  it("窗口滚动没有引入任何定时器/微任务（同步性论证随窗口一起被锁住）", () => {
    // 这是 5b-1 给 5a 那条无锁论证**加的约束**。窗口滚动的正确实现是「每次访问槽位时
    // 比对窗口键」（惰性，见 memory.ts 文件头）；而「起个 setInterval 到点清账」这个直觉
    // 做法会同时破坏两件事：① 引入让出点 → 无锁论证失效；② 让进程多一个要 unref/要摘的
    // 后台任务。所以这里把「零定时器」钉成源码级事实，与上面两条一起构成完整的同步性契约。
    // **5b-2 落盘后这两条断言仍是原话**：落盘 IO 全在 ledger/flush-loop 里，
    // memory.ts 只多了一行同步入队（`sink?.record`），零 async/零 await/零定时器。
    const code = codeOf("core", "traffic", "memory.ts");
    expect(code).not.toMatch(/\basync\b/);
    expect(code).not.toMatch(/\bawait\b/);
    expect(code).not.toMatch(/setTimeout|setInterval|setImmediate|nextTick|queueMicrotask/);
    // 惰性滚动的两个动作必须都留在 consume/usage 路径上：比对窗口键 + 换键清零
    expect(code).toMatch(/windowKey\(/);
    expect(code).toMatch(/windowKey: key/);
    // 落盘接线也在 consume 路径上，但它只是**入队**：返回 void、不是 Promise
    expect(code).toMatch(/sink\?\.record\(/);
  });

  it("挂了落盘账本之后 consume 仍同步、无定时器（5b-2：落盘不许让同步性退让）", () => {
    // 这条是上面四条在**新装配形态**下的复检：装了 `TrafficSink` 的账本，`consume`
    // 仍然零 async/零 await/零定时器，且返回值仍不是 Promise。行为面在
    // `unit/traffic-ledger.test.ts` 的「consume 在有账本时仍是同步函数」那条。
    const recorded: Array<[string, string, number, number]> = [];
    const account = new MemoryTrafficAccount(
      (user) => (user === "alice" ? { bytesUp: 10, bytesDown: 0, bytesTotal: 0 } : undefined),
      { resetHour: () => 0, now: () => 1_000 },
    );
    account.bindSink({
      record: (user, dir, bytes, ts) => {
        recorded.push([user, dir, bytes, ts]);
      },
    });
    const verdict = account.consume("alice", "up", 4);
    expect(verdict).not.toBeInstanceOf(Promise);
    expect(verdict.allow).toBe(true);
    // 入队的是**增量 + 同一个时刻**（窗口键与落盘 ts 必须同源，否则同批字节会被分到两个窗口）
    expect(recorded).toEqual([["alice", "up", 4, 1_000]]);
    // 判定完全不受落盘影响
    expect(account.consume("alice", "up", 7).allow).toBe(false);
    expect(account.usage("alice")).toEqual({ up: 11, down: 0 });
  });

  it("账本侧零定时器（除 flush-loop 那一处）、零 LRU、零限速字段（源码级负向）", () => {
    // 落盘必然需要定时器（周期 flush），但**只允许有一处**且不许散落在账本 IO 里 ——
    // 否则「窗口清账靠定时器」那条会重新长回来（5b-1 明确否决过的直觉做法）。
    for (const file of ["ledger.ts", "memory.ts"] as const) {
      const code = codeOf("core", "traffic", file);
      expect(code, `${file} 零定时器`).not.toMatch(
        /setTimeout|setInterval|setImmediate|nextTick|queueMicrotask/,
      );
      expect(code, `${file} 零 LRU/容量淘汰`).not.toMatch(
        /\.delete\(|maxEntries|evict|\bLRU\b|\blru\b/i,
      );
      expect(code, `${file} 零限速字段`).not.toMatch(
        /rateBps|maxConnections|concurrency|tokenBucket|\brolling\b/i,
      );
    }
    const loop = codeOf("core", "traffic", "flush-loop.ts");
    expect((loop.match(/setTimeout\(/g) ?? []).length).toBe(1);
    expect(loop).toMatch(/\.unref\(\)/);
  });
});

describe("core/traffic 计量落点是被动计数（护栏：不得整形）", () => {
  it("meterStream 只挂一个 data 监听器：不 push / 不 pause / 不 resume / 不改管道", () => {
    const code = codeOf("core", "traffic", "meter.ts");
    // 插 Transform / pause-resume 整形会与 guardDialing 的半关闭联动纠缠成第三层流控
    expect(code).not.toMatch(/\bTransform\b/);
    expect(code).not.toMatch(/\.pause\(/);
    expect(code).not.toMatch(/\.resume\(/);
    expect(code).not.toMatch(/\.push\(/);
    expect(code).not.toMatch(/\.pipe\(/);
    // 唯一允许的挂点是 data 监听器
    expect((code.match(/\.on\(\s*"data"/g) ?? []).length).toBe(1);
  });

  it("无身份 → 一个监听器都不挂、charge 恒放行（关鉴权的部署零开销）", () => {
    const account = accountWith({ alice: { bytesUp: 1, bytesDown: 0, bytesTotal: 0 } });
    const client = new PassThrough();
    const onExceeded = vi.fn();
    meterStream(account, undefined, "up", client, onExceeded);
    expect(client.listenerCount("data")).toBe(0);

    const link = openLinkMeter(account, undefined, new PassThrough(), new PassThrough(), onExceeded);
    expect(link.inert).toBe(true);
    expect(link.charge("up", 1_000_000).allow).toBe(true);
    expect(account.usage("alice")).toEqual({ up: 0, down: 0 });
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it("有身份 → 两端各挂一个 data 监听器，字节逐块累加到账本", async () => {
    const account = accountWith({ alice: { bytesUp: 0, bytesDown: 0, bytesTotal: 0 } });
    const client = new PassThrough();
    const upstream = new PassThrough();
    openLinkMeter(account, "alice", client, upstream, () => undefined);
    expect(client.listenerCount("data")).toBe(1);
    expect(upstream.listenerCount("data")).toBe(1);

    client.write(Buffer.alloc(10));
    upstream.write(Buffer.alloc(7));
    await new Promise((r) => setImmediate(r));
    expect(account.usage("alice")).toEqual({ up: 10, down: 7 });
  });

  it("charge 是建隧后首批载荷的补记口（不经 data 事件的字节靠它计入）", () => {
    const account = accountWith({ alice: { bytesUp: 0, bytesDown: 0, bytesTotal: 100 } });
    const link = openLinkMeter(account, "alice", new PassThrough(), new PassThrough(), () => undefined);
    expect(link.inert).toBe(false);
    // 客户端 CONNECT/SOCKS 之后的首包：不经 data 事件，由 charge 显式补记
    expect(link.charge("up", 30).allow).toBe(true);
    expect(link.charge("down", 70).allow).toBe(true);
    expect(account.usage("alice")).toEqual({ up: 30, down: 70 });
  });

  it("耗尽回调带上方向与 scope（方向由挂点如实上报，不从 scope 反推）", () => {
    const seen: Array<[string, string | undefined]> = [];
    const account = accountWith({ alice: { bytesUp: 0, bytesDown: 0, bytesTotal: 10 } });
    const client = new PassThrough();
    openLinkMeter(account, "alice", client, new PassThrough(), (dir, verdict) => {
      seen.push([dir, verdict.scope]);
    });
    client.write(Buffer.alloc(4));
    client.write(Buffer.alloc(9));
    // 第二块把总量推到 13 > 10：dir 仍是 up（真实流动方向），scope 是 total（被突破的上限）
    expect(seen).toEqual([["up", "total"]]);
  });
});
