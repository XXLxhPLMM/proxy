/**
 * sqlite 档的**文件布局**与三条负向层边界（零槽位 / 零定时器 / 零 `process.env` / 零代理配置依赖）
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`（本目录只放「这一档管哪一段 + 指向 `AGENTS.md`」）。
 * 本档全部是**源码级**判据：不起库、不写文件，只读 `src/**` 的文本形状与两个导出常量。
 * 共享库真跑的那几档（共享同一本权威账 / 重启恢复 / 落盘无条件 / 停机落盘）在 `durability.test.ts`，
 * 失败韧性与窗口过期清理在 `resilience.test.ts`，驱动分流在 `driver-split.test.ts`。
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { USAGE_DB_NAME, usageDbFileName } from "@/datasource/quota/index.js";
import { codeOf } from "../../../../helpers/source-scan.js";

describe("@/datasource/quota sqlite-source：文件布局与「无槽位」", () => {
  it("账本是 <dir>/usage.db，所有进程共用这一个文件", () => {
    expect(USAGE_DB_NAME).toBe("usage.db");
    expect(usageDbFileName(path.join("q", "usage"))).toBe(path.join("q", "usage", "usage.db"));
  });

  it("槽位机制全仓已消失（分槽让配额变成「每进程一份封禁」）", () => {
    // 这不是「新符号叫什么」的问题，而是**分槽必须不再存在**的问题：真相源只有一份。
    // 锁点用**今天仍然存在的形状**当锚（`cluster.fork(` / env 名 / 文件名模板），
    // 而**不是**点名已删除的符号——点一个不存在的符号，断言会恒真而不是失败。
    const cluster = codeOf("server", "cluster.ts");
    expect(cluster, "fork 不再注入任何账本槽位").toMatch(/cluster\.fork\(\)/);
    expect(cluster, "不再有槽位派发与释放").not.toMatch(/takeSlot|slotByPid|normalizeSlot/);
    const cli = codeOf("cli.ts");
    expect(cli, "CLI 不再从 env 快照取槽位").not.toContain("PROXY_WORKER_SLOT");
    const services = codeOf("runtime", "services.ts");
    expect(services, "装配层不再透传 slot").not.toMatch(/\bslot\b/);
    // 旧文件名模板绝不能复活（`worker-<slot>.jsonl` 是分槽的**可观察证据**）
    for (const file of [
      codeOf("cli.ts"),
      codeOf("server", "cluster.ts"),
      codeOf("server", "index.ts"),
      codeOf("runtime", "services.ts"),
      codeOf("runtime", "types.ts"),
      codeOf("runtime", "runtime.ts"),
      codeOf("datasource", "quota", "sqlite-source.ts"),
    ]) {
      expect(file, "旧的分槽文件名不得复活").not.toContain("worker-");
    }
  });

  it("回读与压缩按用户记忆窗口类型（逐行查表是 O(行数 × 查表)，实测能堵死事件循环）", () => {
    // `windowFor` 的下游是账号表读取。一轮回读里**每一条账本行 / 每一条 jsonl 条目**都要问一次
    // 「这个用户用哪个窗口」，而账本行数远大于账号数（主键 `(u,w)` 允许同一用户留多行旧窗口）。
    // 逐行查表实测：50000 行 × 50000 账号 = 单轮 9001 ms —— 而 `sweep` 是**同步**函数，
    // 跑在 flush 回调里且全程无 await，那 9 秒里代理一个包都处理不了（`busy_timeout` 只管写锁，
    // 救不了纯 CPU）。
    //
    // 判据是**形状**：`windowFor` 必须落在一个按用户记忆的 Map 之后被调用，且 Map 的 miss 分支
    // 里只有一次调用。用计时断言不合适（CI 机器必抖，而形状不会抖）。
    const sqlite = codeOf("datasource", "quota", "sqlite-source.ts");
    const jsonl = codeOf("datasource", "quota", "jsonl-source.ts");

    // `sweep`：账本每行一次窗口类型
    expect(sqlite, "sweep 必须先查每用户记忆表").toMatch(/windows\.get\(/);
    expect(sqlite, "sweep 的记忆 miss 分支里才调 windowFor").toMatch(
      /if\s*\(window === undefined\)\s*\{\s*window = this\.windowFor\(/,
    );
    // jsonl 档的 entry 是**每 chunk 一条**（不是每用户一条），故条目数随流量线性增长
    //
    // ⚠️ **判据必须锚「调用点在 miss 分支之内」的相邻关系**，不能只断言「`windowFor(entry.u)`
    // 这个字符串存在」—— 后者对「把查表提到 `if` 外面」这个正是 bug 的形状恒真，而性能完全
    // 退化（实测变异验证：提到分支外后全部断言仍绿）。故下面两条用 `\s*` 要求 miss 分支的
    // 紧邻下一行就是那次查表：把 `const window = …` 提到 `if` 之前，间隔消失，断言变红。
    expect(jsonl, "compactEntries 的查表必须在记忆 miss 分支内").toMatch(
      /if\s*\(cur === undefined\)\s*\{\s*const window = windowFor\(entry\.u\);/,
    );
    // 增量回读的 fold 同样按用户记忆窗口类型（它是一轮里唯一碰 `windowFor` 的地方）
    expect(jsonl, "foldText 的查表必须在记忆 miss 分支内").toMatch(
      /if\s*\(window === undefined\)\s*\{\s*window = this\.windowFor\(entry\.u\);/,
    );
    // ⚠️ **这里刻意不数「窗口归属判据出现了几次」**：那样的护栏只对**逐字照抄**的那份副本
    // 有效，换一种写法（换形参名、把 `now` 折成局部变量）就绕过去了 —— 实测这么变异过一次，
    // 计数断言全绿而第二份真相源已经就位。一个只对精确副本生效的守卫比没有守卫更坏（它让人
    // 以为这件事被管住了）。要真管住它得走 AST，那是另一笔账。
    // **能钉住的是上面那三条**（两处实现各自的形状），它们让「新增第三处」的人至少得先撞上
    // 这三条才能落地，而那三条是关于**形状**的，不挑写法。
  });

  it("数据源零定时器（flush-loop 是本目录唯一的定时器站点）", () => {
    const ledger = codeOf("datasource", "quota", "sqlite-source.ts");
    const memory = codeOf("datasource", "quota", "mirror.ts");
    for (const [name, code] of [
      ["sqlite-source.ts", ledger],
      ["mirror.ts", memory],
    ] as const) {
      expect(code, `${name} 零定时器`).not.toMatch(/setTimeout|setInterval|setImmediate/);
      expect(code, `${name} 零 nextTick/queueMicrotask`).not.toMatch(/nextTick|queueMicrotask/);
    }
    const loop = codeOf("datasource", "quota", "flush-loop.ts");
    expect(loop, "flush-loop 恰好一处 setTimeout").toMatch(/setTimeout/);
    expect(loop, "flush-loop 零 setInterval").not.toMatch(/setInterval/);
  });

  it("datasource/** 与 runtime/** 零 process.env（配置与时刻全部显式注入）", () => {
    for (const name of [
      ["datasource", "quota", "sqlite-source.ts"],
      ["datasource", "quota", "jsonl-source.ts"],
      ["datasource", "quota", "mirror.ts"],
      ["runtime", "services.ts"],
    ] as const) {
      expect(codeOf(...name), `${name.join("/")} 零 process.env`).not.toContain("process.env");
    }
  });

  it("datasource/** 零 @/config / @/core / @/runtime / @/server import（数据源独立于代理与配置）", () => {
    // **判据锚的是 import 说明符**（`codeOnly` 只去注释、保留字符串字面量，故 import 一定还在），
    // 不是「文件里没出现 config 这个词」——后者会被注释与文案里的字样误伤。
    // 形状取自 `../consume-sync.test.ts` 那条「零 node: 内置模块」的同一手法。
    for (const file of ["types.ts", "mirror.ts", "jsonl-source.ts", "sqlite-source.ts"] as const) {
      const specs = [
        ...codeOf("datasource", "quota", file).matchAll(/\bfrom\s*["']([^"']+)["']/g),
      ].map((m) => m[1]!);
      expect(specs.length, `${file} import 提取口径自检`).toBeGreaterThanOrEqual(1);
      for (const banned of ["@/config", "@/core", "@/runtime", "@/server"]) {
        expect(
          specs.filter((s) => s.startsWith(banned)),
          `${file} 不许 import ${banned}（数据源层零代理/配置依赖）`,
        ).toEqual([]);
      }
    }
  });
});
