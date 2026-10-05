/**
 * `core/identity/factory.ts` 记忆表的判据链 + 零定时器（**源码级**）
 *
 * @description
 * 行为面管不到记忆化「命中」那一侧（不命中就重建，重建结果与命中那份一致 ⇒ 不可观测），
 * 故这一档全在源码文本上：六项判据一条都不能少、必须是一条纯 `&&` 链、六样输入每次判定都现读、
 * 记忆表是按 accessor 隔离的模块级 `WeakMap`、零定时器 / 零 TTL / 零轮询。
 *
 * ⚠️ 每一条负向断言都配了「判据自检」：正则逐个正向样本证明它认得出那些词、`code.length` 与
 * `liveSnapshots` 证明扫到的是正文而不是空文本、那个正则**刻意不带 `g` flag**（`test()` 在 `g` 下
 * 会推进 `lastIndex`，多次调用时结果依赖调用顺序）。理由与那张变异表归 `AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import { codeOf, offendingLines } from "../../../helpers/source-scan.js";

describe("identity/factory 记忆表的判据链（源码级）", () => {
  const code = codeOf("core", "identity", "factory.ts");

  /** 六个输入的名字与其本地变量名（判据链两侧同名，逐条比对） */
  const SIX_INPUTS: ReadonlyArray<readonly [string, string]> = [
    ["accounts", "accounts"],
    ["enabled", "enabled"],
    ["type", "type"],
    ["jwtSecret", "jwtSecret"],
    ["enableLogging", "enableLogging"],
    ["jwtVerify", "jwtVerify"],
  ];

  /** 记忆表取用点起、到 `return memo.snapshot;` 止的那一段（判据链本体） */
  function memoRegion(): string {
    const at = code.indexOf("const memo = liveSnapshots.get(config);");
    expect(at, "factory.ts 里的记忆表取用点不见了（结构变了，护栏需显式更新）").toBeGreaterThanOrEqual(0);
    const end = code.indexOf("return memo.snapshot;", at);
    expect(end, "判据命中后必须复用上一份快照").toBeGreaterThan(at);
    return code.slice(at, end + "return memo.snapshot;".length);
  }

  it("防假绿：扫描到的确实是 factory.ts 的 live() 判据链（读到了正文，不是空文本）", () => {
    // 负向源码断言最危险的形态是「锚点已消失 → 恒真」。先证明锚点在今天仍然存在。
    expect(code.length).toBeGreaterThan(2000);
    expect(code).toContain("liveSnapshots");
    expect((code.match(/liveSnapshots\.get\(/g) ?? []).length).toBe(1);
    expect(memoRegion()).toContain("memo.snapshot");
  });

  it("六项判据一条都不能少，且是一条纯 && 链（少比一项 = 一处能悄悄失效的热加载）", () => {
    const region = memoRegion();

    expect(region).toContain("memo !== undefined");
    for (const [field, local] of SIX_INPUTS) {
      expect(region, `判据链缺 memo.${field} === ${local}`).toContain(
        `memo.${field} === ${local}`,
      );
      expect(
        (region.match(new RegExp(`memo\\.${field} === ${local}`, "g")) ?? []).length,
        `memo.${field} 只能比一次`,
      ).toBe(1);
    }
    // 恰好七个 `memo.<字段>`：六项判据 + 命中后复用的 snapshot。
    // 多一项 = 判据里混进了不该判的东西；少一项 = 少比一样输入。
    expect((region.match(/\bmemo\.[A-Za-z]+/g) ?? []).length).toBe(7);
    // 纯 && 链：出现 || 就是「任一项命中即复用」= 判据形同虚设
    expect(region, "判据必须是 && 链，不许出现 ||").not.toContain("||");
  });

  it("六样输入每次判定都现读（判据比的是本次现读的值，不是构造期冻结的）", () => {
    const at = code.indexOf("const live = (): FileAccountIdentity =>");
    expect(at, "live() 闭包不见了（结构变了，护栏需显式更新）").toBeGreaterThanOrEqual(0);
    // 判据之前那一段：六个本地变量的取数处，一个都不许省
    const reads = code.slice(at, code.indexOf("const memo = liveSnapshots.get(config);", at));
    for (const needle of [
      'config.get("authEnabled")',
      'config.get("authType")',
      "loadAuthUsers(",
      'config.get("jwtSecret")',
      'config.get("authLogging")',
      "snap.jwtVerify",
    ]) {
      expect(reads, `live() 必须现读 ${needle}`).toContain(needle);
    }
  });
});

describe("identity/factory 零定时器 / 零 TTL / 零轮询（源码级）", () => {
  /**
   * 判据必须是「输入的身份」而不是「时间过了没有」——时间判据会把正确性耦合到
   * `readJsonCached` 的 1s `maxAgeMs` 上，那正是本仓记过的「第二真相源」同类。
   * 纪律本身**没有护栏**，这里钉成源码级事实。
   *
   * ⚠️ **刻意不带 `g` flag**：`RegExp.prototype.test` 在 `g` 下会推进 `lastIndex`，
   * 复用同一个正则对象做多次 `.test()`（或交给逐行调用的 `offendingLines`）时结果
   * **依赖调用顺序**——那是本仓「假绿」的另一个同型形态：判据看起来在生效，
   * 实际第 N 次调用恒为 false。
   */
  const TIMER_OR_CLOCK =
    /setTimeout|setInterval|setImmediate|queueMicrotask|nextTick|performance\s*\.\s*now|Date\s*\.\s*now/;

  it("防假绿：判据本身能真的命中（负向断言不许是恒真的空断言）", () => {
    // 逐个正向样本：每一条纪律都必须有牙齿，否则下面那条「零命中」证明不了任何东西
    for (const sample of [
      "setTimeout(f, 1)",
      "setInterval(f, 1)",
      "setImmediate(f)",
      "queueMicrotask(f)",
      "process.nextTick(f)",
      "const t = Date.now();",
      "const t = performance.now();",
      'import { setTimeout as sleep } from "node:timers/promises";',
    ]) {
      expect(TIMER_OR_CLOCK.test(sample), `判据漏掉了：${sample}`).toBe(true);
    }
    // 而一行干净的代码不该被误判
    expect(TIMER_OR_CLOCK.test("const accounts = loadAuthUsers(config, observeFileEvent);")).toBe(
      false,
    );
  });

  it("factory.ts 零 setTimeout / setInterval / setImmediate / nextTick / queueMicrotask / Date.now / performance.now", () => {
    const code = codeOf("core", "identity", "factory.ts");

    // 防假绿：先证明扫到的是正文而不是空文本（负向断言在「锚点消失」时会静默恒真）
    expect(code.length).toBeGreaterThan(2000);
    expect(code).toContain("liveSnapshots");

    expect(
      offendingLines(code, TIMER_OR_CLOCK),
      "记忆化方案的判据是「输入身份」不是「时间」：引入定时器/TTL/轮询会把正确性耦合到时间上",
    ).toEqual([]);
  });

  it("记忆表是模块级 WeakMap（构造期不写它，故「构造期零副作用」仍然成立）", () => {
    const code = codeOf("core", "identity", "factory.ts");

    expect(code).toContain("new WeakMap<ConfigAccessor, LiveSnapshot>()");
    // 按 accessor 隔离：两个 accessor 交替判定不互相挤掉（模块级单槽的老坑）
    expect((code.match(/liveSnapshots\.(get|set)\(config\b/g) ?? []).length).toBe(2);
    // 写入点只在 live() 内部（不在工厂构造期）
    const ctorAt = code.indexOf("export function createIdentityFromConfig(");
    const liveAt = code.indexOf("const live = (): FileAccountIdentity =>");
    expect(ctorAt).toBeGreaterThanOrEqual(0);
    expect(liveAt).toBeGreaterThan(ctorAt);
    expect(code.lastIndexOf("liveSnapshots.set(")).toBeGreaterThan(liveAt);
  });
});