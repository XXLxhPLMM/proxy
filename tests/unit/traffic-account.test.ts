/**
 * `UsageAccount` 端口与内存实现（判定层）
 *
 * @description
 * 计量落点与协议收尾在 `tests/integration/traffic-quota.test.ts`（真代理 + 真字节）；本文件
 * 只答「**判定本身**对不对」：
 *
 * 1. **恒 allow 的四种情形**（未配 / `bytes` 为 0 / 用户不存在 / 非正字节数）——必须是**显式分支**，
 *    不是「默认上限 0 恰好放行」的蒙混
 * 2. **只有一个合计上限**（`quota.bytes`，上传 + 下载算在一起）触发；两个方向共享同一份额度
 * 3. **边界裁决**：`bytes: 100` **允许用满 100 字节**（`<=` 语义，判据是「累计 > 上限才拒」）
 * 4. **超限必须在本次返回 `allow:false`**（不允许「先放行下次再说」）+ 累计值照实不截断
 * 5. **`consume` 确实是同步函数**（无锁论证的前提，见 `@/datasource/quota/mirror.ts` 文件头）
 * 6. **计量落点是被动计数**：`meterStream` 只挂 `data` 监听器、**不** push / pause / resume，
 *    且无身份时**一个监听器都不挂**
 * 7. **配额判定只答本地内存**：`mirror.ts` 零 `node:` 内置模块 import，`consume` 体内零
 *    IO / DB / 网络 / 阻塞等待（**同步 ≠ 无 IO**，见下面第 ⑧ 条）
 *
 * ### 本档锁住的七条决策（结论 — 否掉了什么 — 为什么）
 *
 * **① `consume` 必须同步、无锁的全部论证建立在此。** 被否掉的是「改成 `async`（例如顺便把
 * 账本落盘）」——那条论证当场失效，必须先补互斥。落盘只许在 `consume` 的**同步区间内**做
 * 一次数组 push（`sink?.record(...)`），IO 全在账本侧。牙齿：返回的不是 Promise、实现体零
 * `async` / 零 `await` / 零定时器 / 零微任务（源码级），以及「挂了落盘账本之后 consume 仍
 * 同步、无定时器」那条。
 *
 * **② 窗口滚动绝不起 `setInterval`。** 被否掉的是「到点清账」：① 引入让出点 → ①那条论证失效；
 * ② 让进程多一个要 `unref` / 要摘的后台任务。真实需求只是「**跨过边界后别拿旧账当新账**」，
 * 而这在每次访问槽位时判一次就完备——没人访问的槽位清不清账**语义上不可观测**（`usage` 一读
 * 就现算）。牙齿：源码级零 `setTimeout|setInterval|setImmediate|nextTick|queueMicrotask`。
 *
 * **③ 超限必须在本次就返回 `allow:false`。** 被否掉的是「先放行、下次再说」以及**两段式
 * 「先查后加」API**——两段式在并发下必然留窗口。牙齿：「超限必须在本次就返回 allow:false
 * （绝不允许「先放行下次再说」）」+「耗尽后继续传 → 持续拒绝（不会因为「已经超了」而放行）」。
 *
 * **④ 只有一个合计上限 `quota.bytes`，任一方向把它推过就拒。** 上传 + 下载**算在一起**，
 * 刻意**不分方向**：耗尽判定是**账号级封禁**（两个方向一起拒），所以「只配一个方向的上限」
 * 实际等于「整号断网，且要先把那个方向撞满才触发」——伪控制力 + 隐性运维坑。真要分方向
 * 限流是限速问题。代价是硬切后该账号在**当前窗口内**彻底不可用。**恰好等于上限放行**（`<=`
 * 语义）：配额是**上限**而不是「额度 + 1 的坑」，写成 1GiB 的运维最难受的就是「差一个字节传
 * 不完」。牙齿：「单个合计上限触发、`usage`/`limit` 同为合计口径」+「上限突破是账号级封禁
 * （两个方向都被拒）」+「恰好等于上限 → 放行」+「两个方向共享同一份额度」。
 *
 * **⑤ `dir` 由挂点如实上报，判定方无从反推。** 被否掉的是「让判定方告诉调用方是哪个方向」——
 * 只有一个上限、任一方向都能撞破它，所以「本次是哪个方向」**只有**挂点知道（它清楚自己在数
 * 哪条流）。而 `dir` 是事件载荷必填项，**假的比没有更糟**。故 `QuotaExceededHandler` 收
 * `(dir, verdict)` 两个参数，且 `verdict` 上**没有**「哪个上限」可归因。牙齿：「耗尽回调带上
 * 方向（由挂点如实上报）」里两个挂点分别报 `["up"]` / `["down"]`，加上 `usage`/`limit`
 * 断言是**合计**数。
 *
 * **⑥ 未配 / `bytes` 为 0 / 用户不存在 → 恒 allow，但未配也照常累加 usage。** 被否掉的是「没上限就
 * 不计量」——「没有上限」≠「不计量」，这样 `usage` 恒为真用量，将来加上限即刻按真账判定。
 * 唯一「不计量」的情形是**没有身份**。恒 allow 必须是**显式分支**，不是「默认上限 0 恰好
 * 放行」。牙齿：那一整组 describe（用户未配 / 配了但为 0 / 用户不存在 / 非正字节数 / inert 档），
 * 外加「未配配额也照常累加 usage」。
 *
 * **⑦ 计量落点是被动计数，不许整形。** 在**源流**上挂 `data` 监听器只读 `chunk.length`，
 * **不插 Transform、不改 pipe、不用 pause/resume**。牙齿：`meterStream 只挂一个 data 监听器：
 * 不 push / 不 pause / 不 resume / 不改管道`（零 `\bTransform\b`、零 `.pause(`、零 `.resume(`、
 * 零 `.push(`、零 `.pipe(`，且 `data` 监听器恰好 1 处）。
 *
 * **⑧ 配额判定只答本地内存：`mirror.ts` 零 `node:` 内置模块 import，且 `consume` 体内零
 * IO / DB / 网络 / 阻塞等待。** 被否掉的是「为了顺手也把账查一下，把 IO 塞进 `consume`」——
 * **① 锁的是同步性，而同步性不等于无 IO**：`db.prepare("SELECT …").get(user)`（`DatabaseSync`
 * 本来就是同步的）、`fs.readFileSync` 这类调用里既没有 `await` 也没有定时器，①②⑦ 那十几条
 * **一条都不会红**，而无锁论证已经悄悄从「单线程无让出点」退化成「跨连接共享内存」或
 * 「每 chunk 一次 SQL」。这条不是洁癖：换存储后端（本地 SQLite / SAB / 远程库）时它是
 * **唯一**能挡住「把 DB 顺手塞进热路径」的东西——实测每 chunk 一次点查是 20.6 µs（1M 账号下
 * 占事件循环 16%），每 chunk 一次 `UPDATE…RETURNING` 是 61 µs（47.6%）。牙齿两层，缺一缝就留：
 * ① **import 面**（本文件零 `node:` 内置模块——是「只准相对引用本模块」的正面声明，绕不过去，
 *    且顺带把 SAB 的形状钉死为「**由装配点注入**、不许在这里 import」，这正是「对集群无感」在
 *    代码层的样子）；② **函数体**（`consume` 体内零文件系统 / DB / 网络 / `Atomics.wait`）——
 *    因为一个叫 `store` 或 `cache` 的注入协作者照样能把 `SELECT` 带进来。
 *    禁用词表**刻意不收 `.get(` / `.all(`**：`Map.prototype.get` 是合法内存操作，收了就是一条
 *    会假红的护栏，而会假红的护栏比没有护栏更坏——它教下一个人「这条可以注释掉」。
 *    同样**刻意不收 `Atomics.load/store/add`**：那正是 SAB 后端要用的（实测 131 ns/chunk），
 *    真正会阻塞事件循环的只有 `Atomics.wait` / `waitAsync`。
 */

import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  createUsageMirror,
  inertUsageAccount,
  type UsageAccount,
  type UsageQuota,
} from "@/datasource/quota/index.js";
import { UsageMirror } from "@/datasource/quota/mirror.js";
import { meterStream, openLinkMeter } from "@/core/quota-meter.js";
import { blockAfter, codeOf, offendingLines } from "../helpers/source-scan.js";

/** 用一张表当 `QuotaResolver` 替身：查不到即 undefined（= 不限流） */
function accountWith(quotas: Record<string, UsageQuota>): UsageAccount {
  return createUsageMirror((user) => quotas[user]);
}

const UNLIMITED: UsageQuota = { bytes: 0 };

describe("@/datasource/quota UsageMirror：恒 allow 的情形（显式分支，不是默认值蒙混）", () => {
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
    expect(account.usage("ghost")).toBe(42);
  });

  it("配了但 bytes 为 0 → 恒 allow（0 = 不限流）", () => {
    const account = accountWith({ alice: UNLIMITED });
    expect(account.consume("alice", "up", 2 ** 40).allow).toBe(true);
    expect(account.consume("alice", "down", 2 ** 40).allow).toBe(true);
    // 但**计量照常发生**（这是「不限流」而不是「不计量」）
    expect(account.usage("alice")).toBe(2 ** 41);
  });

  it("用户不存在（表里只有别人）→ 恒 allow", () => {
    const account = accountWith({ bob: { bytes: 1 } });
    expect(account.consume("alice", "up", 10_000).allow).toBe(true);
  });

  it("非正字节数 → 直接放行且不累加（空 chunk 不是「耗尽」，负数是上游 bug 不是用量）", () => {
    const account = accountWith({ alice: { bytes: 10 } });
    expect(account.consume("alice", "up", 0).allow).toBe(true);
    expect(account.consume("alice", "up", -5).allow).toBe(true);
    expect(account.consume("alice", "up", Number.NaN).allow).toBe(true);
    expect(account.usage("alice")).toBe(0);
  });

  it("inertUsageAccount 是显式禁用档：恒 allow 且 usage 恒零", () => {
    const inert = inertUsageAccount();
    expect(inert.consume("alice", "up", 1e12).allow).toBe(true);
    expect(inert.usage("alice")).toBe(0);
  });
});

describe("@/datasource/quota 单个合计上限、边界与「恰好等于上限」", () => {
  it("唯一上限被推过时拒绝，usage / limit 同为合计口径", () => {
    const account = accountWith({ alice: { bytes: 10 } });
    account.consume("alice", "up", 10);
    const v = account.consume("alice", "up", 1);
    expect(v.allow).toBe(false);
    expect(v.reason).toBe("quota");
    // usage / limit 必须是**同一口径的两个数**，消费方才算得出「超了多少」/「还剩多少」
    expect(v.usage).toBe(11);
    expect(v.limit).toBe(10);
  });

  it("两个方向共享同一份额度（上传吃掉的那份把下载也一起算掉）", () => {
    // 裁决：只有**一个**合计上限，故上传与下载是**同一份额度**的两半。
    // 推论：上传撞顶之后**下载同样被拒**（否则可以上传撞顶后改走下载继续白嫖），
    // 代价是该账号在当前窗口内彻底不可用 —— 这也正是**不分方向**的根由：
    // 既然分方向也封不住另一半，「只配一个方向的上限」就只是伪控制力。
    const account = accountWith({ alice: { bytes: 10 } });
    account.consume("alice", "up", 11);
    const v = account.consume("alice", "down", 1);
    expect(v.allow).toBe(false);
    expect(v.usage).toBe(12);
    expect(v.limit).toBe(10);
  });

  it("恰好等于上限 → 放行（裁决：配额是上限，不是「额度 + 1 的坑」）", () => {
    // bytes: 100 允许用户用满 100 字节，第 101 字节才拒
    const account = accountWith({ alice: { bytes: 100 } });
    expect(account.consume("alice", "up", 40).allow).toBe(true);
    expect(account.consume("alice", "down", 60).allow).toBe(true);
    expect(account.usage("alice")).toBe(100);
    const over = account.consume("alice", "down", 1);
    expect(over.allow).toBe(false);
    expect(over.usage).toBe(101);
  });

  it("usage 是合计数：两个方向的消耗加在一起（不按方向切分）", () => {
    // 判据形状是 usage 的**返回值本身**：一个数。上传 5 + 下载 7 = 12。
    // 「剩余 = bytes - usage(user)」这条减法就是靠这个单数成立的。
    const account = accountWith({ alice: { bytes: 100 } });
    account.consume("alice", "up", 5);
    account.consume("alice", "down", 7);
    expect(account.usage("alice")).toBe(12);
  });

  it("超限必须在本次就返回 allow:false（绝不允许「先放行下次再说」）", () => {
    // 上限 10：第 11 字节的那一次调用本身就必须被拒。软化语义（放行这一块、下次再拒）
    // 会让一条长连接隧道永远不触发耗尽判定，配额就成了摆设。
    const account = accountWith({ alice: { bytes: 10 } });
    const first = account.consume("alice", "up", 6);
    expect(first.allow).toBe(true);
    const crossing = account.consume("alice", "up", 100);
    expect(crossing.allow).toBe(false);
    // 累计值照实累加、不截断到上限：日志里的 usage 必须是真用量，否则运维看到的是假数字
    expect(account.usage("alice")).toBe(106);
    expect(crossing.usage).toBe(106);
  });

  it("耗尽后继续传 → 持续拒绝（不会因为「已经超了」而放行）", () => {
    const account = accountWith({ alice: { bytes: 1 } });
    expect(account.consume("alice", "up", 2).allow).toBe(false);
    expect(account.consume("alice", "up", 1).allow).toBe(false);
  });

  it("quota 缺省 month 的消费侧归一不改变本文件任何一条判定语义", () => {
    // 加了窗口之后，`consume` 的 `<=` 边界 / 累计不截断 / 账号级封禁一条未动。
    // 这里重跑一遍核心三条，证明窗口层没有偷换判定语义：
    // 用量在窗口内照常累加、恰好等于上限放行、下一字节拒绝。
    const account = accountWith({ alice: { bytes: 100 } });
    expect(account.consume("alice", "up", 40).allow).toBe(true);
    expect(account.consume("alice", "down", 60).allow).toBe(true);
    const over = account.consume("alice", "down", 1);
    expect(over.allow).toBe(false);
    expect(over.usage).toBe(101);
  });

  it("按用户分槽：两个用户各耗各的，互不影响（锁「user 不得取错」）", () => {
    const account = accountWith({
      alice: { bytes: 10 },
      bob: { bytes: 10 },
    });
    account.consume("alice", "down", 10);
    expect(account.consume("alice", "down", 1).allow).toBe(false);
    // bob 完全不受 alice 的用量影响
    expect(account.consume("bob", "down", 10).allow).toBe(true);
    expect(account.usage("alice")).toBe(11);
    expect(account.usage("bob")).toBe(10);
  });
});

describe("@/datasource/quota consume 的同步性（无锁论证的前提）", () => {
  it("consume 不是 async：返回的是判定对象而不是 Promise", () => {
    const account = accountWith({ alice: { bytes: 10 } });
    const verdict = account.consume("alice", "up", 1);
    expect(verdict).not.toBeInstanceOf(Promise);
    expect(typeof (verdict as { then?: unknown }).then).toBe("undefined");
    expect(verdict.allow).toBe(true);
  });

  it("实现体内零 await / 零 async（源码级：改成 async 会让「无锁」论证当场失效）", () => {
    const code = codeOf("datasource", "quota", "mirror.ts");
    expect(code).not.toMatch(/\basync\b/);
    expect(code).not.toMatch(/\bawait\b/);
  });

  it("「读-改-写」之间没有让出点：连续 consume 的累计值单调且精确", () => {
    // 无锁的全部内容就是这一条：一次 consume 内不可能被别的 consume 插入。
    // 若哪天加了 await，这条会先于线上问题暴露出来。
    const account = new UsageMirror(() => ({ bytes: 1000 }));
    for (let i = 1; i <= 100; i++) {
      expect(account.consume("alice", "up", 1).allow).toBe(true);
      expect(account.usage("alice")).toBe(i);
    }
  });

  it("窗口滚动没有引入任何定时器/微任务（同步性论证随窗口一起被锁住）", () => {
    // 这是 5b-1 给 5a 那条无锁论证**加的约束**。窗口滚动的正确实现是「每次访问槽位时
    // 比对窗口键」（惰性，见 mirror.ts 文件头）；而「起个 setInterval 到点清账」这个直觉
    // 做法会同时破坏两件事：① 引入让出点 → 无锁论证失效；② 让进程多一个要 unref/要摘的
    // 后台任务。所以这里把「零定时器」钉成源码级事实，与上面两条一起构成完整的同步性契约。
    // **落盘 + 周期回读全在数据源侧**：flush-loop 是那一条定时器，sqlite/jsonl 两个数据源
    // 文件里全是 IO；mirror.ts 只多了一行同步入队（`sink?.record`）与一个 `absorb`（在数据源
    // 自己的周期循环里调，不在请求热路径上），零 async/零 await/零定时器。
    const code = codeOf("datasource", "quota", "mirror.ts");
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
    // 这条是上面四条在**接了数据源**的形态下的复检：挂了 `UsageSink` 的数据源，`consume`
    // 仍然零 async/零 await/零定时器，且返回值仍不是 Promise。行为面在
    // `unit/traffic-ledger.test.ts` 的「consume 在有账本时仍是同步函数」那条。
    const recorded: Array<[string, string, number, number]> = [];
    const account = new UsageMirror(
      (user) => (user === "alice" ? { bytes: 10 } : undefined),
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
    expect(account.usage("alice")).toBe(11);
  });

  it("账本侧零定时器（除 flush-loop 那一处）、零 LRU、零限速字段（源码级负向）", () => {
    // 落盘必然需要定时器（周期 flush），但**只允许有一处**且不许散落在账本 IO 里 ——
    // 否则「窗口清账靠定时器」那条会重新长回来（5b-1 明确否决过的直觉做法）。
    // 数据源文件锚**当前存在的文件名**——点一个已删除的名字，断言会恒真。
    for (const file of ["sqlite-source.ts", "mirror.ts"] as const) {
      const code = codeOf("datasource", "quota", file);
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
    const loop = codeOf("datasource", "quota", "flush-loop.ts");
    expect((loop.match(/setTimeout\(/g) ?? []).length).toBe(1);
    expect(loop).toMatch(/\.unref\(\)/);
  });

  it("零 IO 边界：本文件不许 import 任何 node: 内置模块（同步 ≠ 无 IO）", () => {
    // 上面七条锁的是**同步性**（无 await / 无定时器 ⇒ 无让出点 ⇒ 无锁论证成立）。但同步性
    // **不等于**无 IO：`db.prepare("SELECT …").get(user)`（DatabaseSync 本来就是同步的）、
    // `fs.readFileSync` 这类调用里既没有 `await` 也没有定时器，上面七条**一条都不会红**。
    // 而「配额判定只答本地内存」正是本切片最贵的那条契约——SQLite / SAB / Redis 三种后端
    // 全靠它才敢上；一旦有人为了「顺手也把账查一下」把 IO 塞进 consume，无锁论证会**悄悄**
    // 退化成「跨连接共享内存」或「每 chunk 一次 SQL」，而 CI 一声不响。
    //
    // 所以这里锁一个**更强、也更难绕过**的形状：本文件零 `node:` 内置模块 import。三条好处：
    // ① 它是「只准相对引用本模块」的正面声明，不是一串能被 `globalThis` 之类写法绕过的禁用词；
    // ② 它顺带把 SAB 的形状钉死——共享内存必须**由装配点注入**（master 建、worker 收），
    //    不许在这里 import；这正是「对集群无感」在代码层的样子，而不是一句口号；
    // ③ 本文件自己的类注释已声明「不读配置、不读文件、不打日志」，这条断言是那句话的可执行版。
    //
    // 口径：`codeOnly` 只去注释、**保留字符串字面量**，故 import 的模块说明符一定还在（`source-scan.ts`
    // 的设计意图正是「字符串里出现被禁词汇往往正是要盯的泄漏形态」）。行尾 `from "…"` 两侧的
    // `import type` / `import {` / 单行 import 形态一律收敛到同一个捕获。
    const specs = [...codeOf("datasource", "quota", "mirror.ts").matchAll(/\bfrom\s*["']([^"']+)["']/g)].map(
      (m) => m[1]!,
    );
    // 口径自检：正则今天必须匹配得到东西，否则下面那条「零 node:」是恒绿的假护栏
    expect(specs.length, "import 提取口径自检（今天有 quota-window.js / flush-loop.js / types.js 三条）")
      .toBeGreaterThanOrEqual(3);
    expect(
      specs.filter((s) => s.startsWith("node:")),
      "mirror.ts 不许 import node: 内置模块（判定热路径只答本地内存）",
    ).toEqual([]);
  });

  it("consume 体内零同步 IO / DB / 阻塞等待（与上一条互为两层，缺一缝就留）", () => {
    // 分工：
    //   ① 上一条从 **import 面**封 —— 本文件根本不认识 node: 的 IO 能力；
    //   ② 这一条从 **函数体**封 —— 即使 IO 能力是别人注入进来的（一个叫 `store` / `cache` 的
    //      协作者照样能把 `SELECT` 带进来），`consume` 自己也不发起 IO / DB / 阻塞等待。
    // 只留 ①：一个注入协作者就能绕过。只留 ②：禁用词表能被 `globalThis` 之类写法绕过。
    // **两条都在才不留缝**，而这条缝隙正好是接下来换存储后端时最容易被踩的那一脚。
    const body = blockAfter(codeOf("datasource", "quota", "mirror.ts"), "public consume(");
    // 口径自检：锚点今天命中，且两条注入调用今天都在（否则下面那四组「零」全是恒绿）
    expect(body).toMatch(/this\.slotFor\(/);
    expect(body).toMatch(/this\.sink\?\.record\(/);
    const banned: ReadonlyArray<readonly [string, RegExp]> = [
      ["文件系统", /readFileSync|writeFileSync|openSync|readSync|writeSync|createReadStream|createWriteStream/],
      // ⚠️ **刻意不收 `.get(` / `.all(`**：`Map.prototype.get` 是**合法的**内存操作（SAB/LRU
      // 后端里 `this.cache.get(user)` 是正确写法），把它列进禁用词表会造出一条**假红**护栏——
      // 而会假红的护栏比没有护栏更坏，它教下一个人「这条可以注释掉」。判据只收**无歧义**的
      // DB 形态：`DatabaseSync` 是构造名、`.prepare(` 是语句句柄、`.exec(` 是 DDL/DML，两者在
      // 纯内存实现里都不可能出现。
      ["数据库", /DatabaseSync|\.prepare\(|\.exec\(|createSession/],
      ["网络", /createServer|createConnection|new Socket|\.connect\(/],
      // 注意这一组的**反向**取舍：`Atomics.load/store/add` 是 SAB 后端**将来要用的**
      // （共享内存上的原子加减，且实测 131 ns/chunk），绝不能被这条误伤；真正会**阻塞整个
      // 事件循环**的只有 `Atomics.wait` / `waitAsync`，它们在任何形态下都不许进 consume。
      ["阻塞等待", /Atomics\.wait\b|\bwaitAsync\(/],
    ];
    for (const [label, re] of banned) {
      expect(offendingLines(body, re), `consume 体内零${label}`).toEqual([]);
    }
  });
});

describe("@/datasource/quota 计量落点是被动计数（护栏：不得整形）", () => {
  it("meterStream 只挂一个 data 监听器：不 push / 不 pause / 不 resume / 不改管道", () => {
    const code = codeOf("core", "quota-meter.ts");
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
    const account = accountWith({ alice: { bytes: 1 } });
    const client = new PassThrough();
    const onExceeded = vi.fn();
    meterStream(account, undefined, "up", client, onExceeded);
    expect(client.listenerCount("data")).toBe(0);

    const link = openLinkMeter(account, undefined, new PassThrough(), new PassThrough(), onExceeded);
    expect(link.inert).toBe(true);
    expect(link.charge("up", 1_000_000).allow).toBe(true);
    expect(account.usage("alice")).toBe(0);
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it("有身份 → 两端各挂一个 data 监听器，字节逐块累加到账本", async () => {
    const account = accountWith({ alice: { bytes: 0 } });
    const client = new PassThrough();
    const upstream = new PassThrough();
    openLinkMeter(account, "alice", client, upstream, () => undefined);
    expect(client.listenerCount("data")).toBe(1);
    expect(upstream.listenerCount("data")).toBe(1);

    client.write(Buffer.alloc(10));
    upstream.write(Buffer.alloc(7));
    await new Promise((r) => setImmediate(r));
    expect(account.usage("alice")).toBe(17);
  });

  it("charge 是建隧后首批载荷的补记口（不经 data 事件的字节靠它计入）", () => {
    const account = accountWith({ alice: { bytes: 100 } });
    const link = openLinkMeter(account, "alice", new PassThrough(), new PassThrough(), () => undefined);
    expect(link.inert).toBe(false);
    // 客户端 CONNECT/SOCKS 之后的首包：不经 data 事件，由 charge 显式补记
    expect(link.charge("up", 30).allow).toBe(true);
    expect(link.charge("down", 70).allow).toBe(true);
    expect(account.usage("alice")).toBe(100);
  });

  it("耗尽回调带上方向（由挂点如实上报，两个挂点各报各的）", () => {
    // 只有一个上限 → **任一方向都能撞破它**，所以「本次是哪个方向」只有挂点知道
    // （它清楚自己在数哪条流）。两个挂点分别上报自己的方向，谁也不许反推。
    const seen: Array<[string, number, number]> = [];
    const account = accountWith({ alice: { bytes: 10 } });
    openLinkMeter(
      account,
      "alice",
      new PassThrough(),
      new PassThrough(),
      (dir, verdict) => {
        seen.push([dir, verdict.usage ?? 0, verdict.limit ?? 0]);
      },
    );
    const client = new PassThrough();
    const upstream = new PassThrough();
    openLinkMeter(account, "alice", client, upstream, (dir, verdict) => {
      seen.push([dir, verdict.usage ?? 0, verdict.limit ?? 0]);
    });
    client.write(Buffer.alloc(4));
    client.write(Buffer.alloc(9));
    // 第二块把合计推到 13 > 10：dir 是 up（真实流动方向），usage/limit 是合计口径
    expect(seen).toEqual([["up", 13, 10]]);

    // 另一条流撞顶时报的是 down，且 usage 仍是**合计**数（11 + 9 = 20）
    upstream.write(Buffer.alloc(9));
    expect(seen[1]).toEqual(["down", 22, 10]);
  });
});
