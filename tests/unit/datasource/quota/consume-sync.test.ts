/**
 * `consume` 的同步性：`UsageMirror` 无锁论证的全部前提
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`（本目录只放「这一档管哪一段 + 指向 `AGENTS.md`」）。
 * 本档答一件事：**「读-改-写之间没有让出点」**——零 `async` / 零 `await` / 零定时器 / 零微任务，
 * 再加上两层互为补充的「零 IO」牙齿（**import 面**与**函数体面**）。
 * 判定语义（恒 allow / 合计上限 / `<=` 边界）在 `mirror-allow.test.ts`，窗口键在 `window-key.test.ts`。
 */

import { describe, expect, it } from "vitest";
import { UsageMirror } from "@/datasource/quota/mirror.js";
import { blockAfter, codeOf, offendingLines } from "../../../helpers/source-scan.js";
import { accountWith } from "./_traffic-account.js";

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
    // `datasource/quota/sqlite/durability.test.ts` 的「consume 在有账本时仍是同步函数」那条。
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
