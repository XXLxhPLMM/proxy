/**
 * 账本驱动**注册表**：判据是「有没有注册」，未注册即抛错，自定义驱动真的被装配用上
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`（本目录只放「这一档管哪一段 + 指向 `AGENTS.md`」）。
 * 抽象最容易腐烂成「注册表接好了，配置那条线却还写死在两支三元里」——那是一个**静默失效**的
 * 注入位（`registerUsageSource` 编译通过、`listUsageSourceDrivers()` 返回自定义名、而
 * `buildDefaultServices` 压根不问注册表），于是 `quotaUsageDriver=mysql` 真跑起来接的还是内置的
 * 某个后端：**用户以为接上了自己的后端，实际没有**。
 * 判据分三段（行为面 / 编译期面 / 源码级面）与那次变异实测记在同目录 `AGENTS.md`。
 * 两个内置后端的等价性与能力边界在 `equivalence.test.ts`。
 */

import { describe, expect, it } from "vitest";
import { ConfigStore, createConfigContext } from "@/config/index.js";
import {
  listUsageSourceDrivers,
  registerUsageSource,
  resolveUsageSource,
  type UsageQuota,
} from "@/datasource/quota/index.js";
import { buildDefaultServices } from "@/runtime/services.js";
import { testContextFor } from "../../../../helpers/config.js";
import { blockAfter, codeOf } from "../../../../helpers/source-scan.js";
import { day12, dir, harness } from "./_usage-drivers.js";

describe("账本驱动注册表：判据是「有没有注册」，未注册即抛错", () => {
  it("内置两项随注册表一起就位（错误信息里的「已注册」从第一次装配起就完整）", () => {
    expect(listUsageSourceDrivers().sort()).toEqual(["json", "sqlite"]);
  });

  it("未注册的驱动名**抛错**并列出全部已注册项，绝不静默落到某一支", () => {
    // 判据是「抛错」+「错误文本里点名了驱动名与已注册项」。后者不是锦上添花：拼错是部署出错
    // 最常见的成因，只说「未知驱动」等于让人去翻源码。
    // ⚠️ **不许把它改成断言「装出来的是某个内置后端」**：那正是静默回落，而回落会让用户以为
    // 配生效了。负向断言锚的是**今天仍存在的形状**（注册表 API），不是被删掉的符号名。
    let caught: unknown;
    try {
      resolveUsageSource("sqlit");
    } catch (error) {
      caught = error;
    }
    expect(caught, "未注册驱动必须抛错").toBeInstanceOf(Error);
    const text = (caught as Error).message;
    expect(text, "错误文本点名那个驱动名").toContain("sqlit");
    expect(text, "错误文本列出已注册项").toContain("sqlite");
    expect(text, "错误文本列出已注册项").toContain("json");

    // 装配侧同样：配置里写一个没注册的名字，`buildDefaultServices` 就要在装配期炸掉
    const store = new ConfigStore();
    store.set("quotaUsageDir", dir);
    store.set("quotaUsageDriver", "nope");
    const ctx = createConfigContext({ store, configDir: dir });
    expect(() =>
      buildDefaultServices(testContextFor(ctx.accessor), {}, () => undefined, {}),
    ).toThrow(/未注册/);
  });

  it("装配只经注册表查表，不许出现「与内置驱动名比较」的三元/开关", () => {
    // 行为面那两条锁的是「注册表被问了」；这一条锁的是「**只有**注册表被问」——
    // 写死三元 `driver === "json" ? A : B` 的退回方式上面两条**一条都不会红**（未注册的
    // 名字会静默拿到 B），而那恰恰是最贵的退化形态。
    // 锚点用 `blockAfter` 的返回类型那一行（同 `sqlite/durability.test.ts` 的手法：
    // `export function buildDefaultServices(` 后面第一个 `{` 是**参数**里的花括号，切错块的
    // 表现是「零命中」而不是报错，所以先有一条正向断言证明切对了块）。
    const fn = blockAfter(codeOf("runtime", "services.ts"), "): RuntimeServices");
    expect(fn, "锚点失效：没切到 buildDefaultServices 的函数体").toContain("overrides.usageSource");
    expect(fn, "驱动必须经注册表解析").toContain("resolveUsageSource(");
    // 负向：与内置名字做比较的三元/开关/查表都判为「接了内置两支的某个副本」
    expect(fn, "不许拿驱动名与内置两个字面量做比较（那是写死的两支）").not.toMatch(
      /quotaUsageDriver\)\s*(===|!==|==)/,
    );
    expect(fn, "不许出现裸的驱动名字面量（json/sqlite 应由 BUILTIN_USAGE_DRIVERS 提供）").not.toMatch(
      /"(json|sqlite)"/,
    );
  });
});

describe("账本驱动注册表：自定义驱动真的被装配用上（护栏牙齿，见文件头）", () => {
  it("registerUsageSource + quotaUsageDriver=<自定义名> → 装出来的就是它", () => {
    // 行为面：判据是**自定义工厂造出的那个对象的可观察身份**（`file` 是本驱动独有的哨兵），
    // 不是「不是内置两档之一」——后者在退回的内置恰好不是 json 时会假绿。
    let built = 0;
    // 规格本身也校验一下：驱动拿到的必须是**平值闭包**，不是 `ConfigAccessor`。
    // 判据锚的是「值都是函数」这个今天成立的形状——`spec` 若改成收 `ConfigAccessor`，
    // 这里会立刻红（`typeof spec.dir` 变成 `"object"`），而那正是数据源层零配置依赖那条的破口。
    let seenSpec: Record<string, unknown> = {};
    const off = registerUsageSource("mem", (spec) => {
      built += 1;
      seenSpec = spec as unknown as Record<string, unknown>;
      return {
        file: "<mem:in-memory>",
        enabled: false,
        queued: 0,
        async open(): Promise<void> {
          /* 零副作用替身 */
        },
        async close(): Promise<void> {
          /* 零副作用替身 */
        },
        record: (): void => undefined,
      };
    });
    try {
      expect(listUsageSourceDrivers(), "注册后立刻出现在已注册列表里").toContain("mem");

      const store = new ConfigStore();
      store.set("quotaUsageDir", dir);
      store.set("quotaUsageDriver", "mem");
      const ctx = createConfigContext({ store, configDir: dir });
      const services = buildDefaultServices(
        testContextFor(ctx.accessor),
        {},
        () => undefined,
        {},
      );
      expect(built, "自定义工厂真的被调用了一次").toBe(1);
      for (const key of ["dir", "flushMs", "resetHour", "windowFor"] as const) {
        expect(typeof seenSpec[key], `spec.${key} 是闭包（平值 + 热读，装配层负责从 config 取值）`)
          .toBe("function");
      }
      // ⚠️ `enabled` **刻意不在上面那张表里**：它曾是「有没有人配了非 0 配额」的判据，
      // 而账本落盘已经无条件（不变量：在判定 ⇒ 一定在记账），那个闭包连同它带来的
      // 「判定生效、落库不生效」一起删掉了。列进来会让这条断言要求一个已删除的接线复活。
      expect(seenSpec, "spec 上不该再有 enabled（落盘无条件的代价：这条接线已删除）").not.toHaveProperty("enabled");
      expect(services.usageSource?.file, "装配用的是自定义驱动，不是内置两档的任何一个").toBe(
        "<mem:in-memory>",
      );
      // 退订之后同一个名字回到「未注册」——证明装配确实只认注册表
      off();
      expect(listUsageSourceDrivers()).not.toContain("mem");
      expect(() => resolveUsageSource("mem"), "退订后未注册即抛错").toThrow(/未注册/);
    } finally {
      off();
    }
  });

  it("重名注册必须抛错（不静默替换），除非显式 override", () => {
    const make = (): (() => void) =>
      registerUsageSource("dup", () => {
        throw new Error("不该被构造");
      });
    const off1 = make();
    try {
      expect(make, "重名且未给 override 即抛错").toThrow(/已注册/);
      const off2 = registerUsageSource("dup", () => {
        throw new Error("不该被构造");
      }, { override: true });
      // 覆盖之后，先前那个注册方的退订**不许**把新项删掉
      off1();
      expect(listUsageSourceDrivers(), "已被覆盖的那项不许被旧退订删掉").toContain("dup");
      off2();
    } finally {
      off1();
    }
  });
});

describe("镜像的误差上界：另一个实例写的字节在一个上界内对本进程可见", () => {
  it("两个实例指向同一个库：B 记的量在 A 的下一轮回读里出现，且判定随之收紧", async () => {
    // 「多进程判定是每进程一份」是本仓最重要也最容易被**记成好消息**的事实（听起来像「没共享」）。
    // 它现在有了精确的形状：判定落后于权威值至多 `2 × quotaFlushInterval`
    // （`mirrorLagBoundMs`，推导见 `@/datasource/quota/mirror.ts` 文件头）。锚是那个**声明过的量**，
    // 不是「等一会儿就看见了」—— 后者会随机器快慢漂移，且测不出「回读从周期循环里被摘掉」这种退化。
    const { mirrorLagBoundMs } = await import("@/datasource/quota/mirror.js");
    const P = 20;
    expect(mirrorLagBoundMs(P), "上界 = 2 × 周期（一个给写入方落库，一个给读出方回读）").toBe(2 * P);

    // 上限 300：A 自己的 100 看不见 B 的 250 时它判定「还有 200 可用」，
    // 看见之后立刻只剩不到 0 —— **判定收紧的那一刻就是「权威不再是权威」被抓住的那一刻**
    const limit: UsageQuota = { bytes: 300, window: "day" };
    const a = harness("sqlite", limit);
    const b = harness("sqlite", limit);
    try {
      await a.source.open();
      await b.source.open();
      a.at(day12);
      b.at(day12);

      a.account.consume("alice", "up", 100);
      b.account.consume("alice", "up", 250);
      await b.source.sync();

      // A 还没回读：A 的镜像只有自己的 100，于是它判定「还能用 200」——
      // ⚠️ **这一条是本机制最重要的事实**：判定是每进程一份的，权威那一份此刻是 250 而 A 看不见。
      expect(a.account.usage("alice"), "回读之前 A 看不到 B 的字节").toBe(100);
      expect(a.account.consume("alice", "up", 200).allow, "A 此刻按自己那份放行（恰好等于上限）").toBe(
        true,
      );

      // A 的下一轮：先落盘（它自己那 300 进库），再回读（库里 = A 300 + B 250 = 550）
      await a.source.sync();
      expect(a.account.usage("alice"), "回读后 A 看到权威总量（两者之和）").toBe(550);
      expect(
        a.account.consume("alice", "up", 1).allow,
        "吸收别人的量之后，判定立刻按合计上限收紧",
      ).toBe(false);
    } finally {
      await a.source.close();
      await b.source.close();
    }
  });

  it("回读用 max 合并：本地未落盘的字节不会被回读抹掉（也不重复计账）", async () => {
    // 这条锁的是「合并语义」本身。写盘失败 → 库里比镜像少；重复回读 → 库里的值会被再次读到。
    // 两种情形下镜像都必须保持**单调不减**，否则「写盘失败一次」就等于把用户的用量清零。
    const h = harness("sqlite");
    await h.source.open();
    h.at(day12);
    for (let i = 0; i < 3; i++) {
      h.account.consume("alice", "up", 10);
      await h.source.sync();
    }
    expect(h.account.usage("alice"), "三轮同步后不回退").toBe(30);
    // 再回读一次（值不变）仍然不能变成 60
    await h.source.sync();
    expect(h.account.usage("alice"), "重复回读不重复计账").toBe(30);
    await h.source.close();
  });
});
