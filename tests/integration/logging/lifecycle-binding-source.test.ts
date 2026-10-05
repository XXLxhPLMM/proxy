/**
 * `[lifecycle]` 那一族的**纯库路径真落盘**（②：`[lifecycle]` 恰好 4 行逐字 + `eventLogs: false` 零行）
 * 与**源码级**四档（⑥：双绑零容忍 / `src/**` 恰好两处 / 绑定与释放落点 / 文本契约逐字）。
 *
 * @module tests/integration/logging
 *
 * 主题级不变量（两族同层、三条装配裁决、零落盘与行序纪律、防假绿的位置）见 `./AGENTS.md`；
 * 共用的临时目录 / 真 logger / 跃迁逐字契约见 `./lifecycle-fixture.ts`。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { EventHub } from "@/core/events/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import { srcFilesRecursive } from "../../helpers/src-files.js";
import { codeOf, offendingLines } from "../../helpers/source-scan.js";
import {
  TRANSITIONS,
  baseConfig,
  dir,
  libraryLogger,
  lifecycleLines,
  logDir,
  readRecords,
} from "./lifecycle-fixture.js";

describe("logging · lifecycle-binding-source", () => {
  describe("② 纯库路径真落盘", () => {
    it("createProxyRuntime 一次 start/stop → [lifecycle] 恰好 4 行且逐字", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = libraryLogger();
      // ⚠️ 全程**不经过 `ProxyServer`**：本档验的正是纯库路径自己就能落这一行
      const runtime = createProxyRuntime({ config: baseConfig(), configDir: dir, events, logger });

      await runtime.start();
      await runtime.stop();

      const lines = await readRecords(logger);
      const mine = lines.filter((l) => String(l.msg).startsWith("[lifecycle]"));
      // 正向证据（防「零行 → 逐字相等」那种假绿）与防叠加：恰好四次跃迁
      expect(mine).toHaveLength(4);
      //
      // ⚠️ **断言必须与行序无关**：落盘是**并发** `fs.promises.appendFile`，只在
      // `flushPendingWrites()` 里**等完成、不保序**（threadpool 多个槽 ⇒ 两次 append 可以
      // 乱序落地）。实测同一轮 `stop` 的 `stopping->stopped` 会落在下一轮 `stopped->starting`
      // **之后**。**按发生顺序逐条比是本仓最贵的一种 flaky**，一律用多重集合口径
      // （排序后比 / 逐条数次数），与 `./event-binding-source.test.ts` 的 ⑦「按 JSON 排序」同纪律。
      expect(mine.map((l) => l.msg).slice().sort()).toEqual(TRANSITIONS.slice().sort());
      expect(mine.every((l) => l.level === "debug")).toBe(true);
      expect(mine.every((l) => l.prefix === "[proxy]")).toBe(true);
    });

    it("eventLogs: false → 零行（关掉的只是「事件 → 这一个 logger」这一跳）", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = libraryLogger();
      // 宿主自己接生命周期观察面（这正是 `eventLogs: false` 的正当场景）
      const seen: string[] = [];
      events.subscribe("lifecycle.changed", (e) => {
        seen.push(`${e.data.prev}->${e.data.next}`);
      });
      const runtime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events,
        logger,
        eventLogs: false,
      });

      await runtime.start();
      await runtime.stop();

      // 零落盘行；目录压根没被建出来（IO 在 logger 那一侧，它一次都没被叫到）
      expect(lifecycleLines(await readRecords(logger))).toEqual([]);
      expect(fs.existsSync(logDir) ? fs.readdirSync(logDir).length : 0).toBe(0);
      // 但**事件面照常**（不绑 ≠ 事件没了）：四次跃迁宿主自己一条不少
      expect(seen).toEqual(["idle->starting", "starting->running", "running->stopping", "stopping->stopped"]);
    });
  });

  describe("⑥ 源码级：双绑零容忍 + 绑定/释放都落在 runtime 的那一轮里", () => {
    it("ProxyServer 源码面零 bindRuntimeLifecycle / lifecycleSubscriptions / unbindRuntimeObservers", () => {
      const code = codeOf("server", "index.ts");
      // ⚠️ 三条都是**负向**断言，锚点是**今天已不存在**的符号 —— 它们防的是「搬走一半」
      // （方法又长回来）或「删了方法、订阅退订那一半还留着」。因此**必须配下面的判据自检**：
      // 探测器套在合成脏源码上必须真的命中，否则这三条是恒绿的。
      expect(offendingLines(code, /bindRuntimeLifecycle/)).toEqual([]);
      expect(offendingLines(code, /lifecycleSubscriptions/)).toEqual([]);
      expect(offendingLines(code, /unbindRuntimeObservers/)).toEqual([]);
      // 判据自查：正向证据证明文件真的被读到了（`toContain` 今天仍存在的形状）
      expect(code).toContain("class ProxyServer");
      expect(code).toContain("createProxyRuntime(");
      expect(code.length).toBeGreaterThan(2000);
      // 判据自检：合成脏样本上探测器必须有牙齿
      for (const re of [/bindRuntimeLifecycle/, /lifecycleSubscriptions/, /unbindRuntimeObservers/]) {
        expect(offendingLines(`  private x = 1; // ${re.source}`, re), `${re} 判据恒绿`).toHaveLength(1);
      }
    });

    it("src/** 全文恰好两处 bindLifecycleLog：event-log.ts 的定义 + runtime.ts 的那一个调用点", () => {
      const hits: string[] = [];
      for (const rel of srcFilesRecursive()) {
        const code = codeOf(...rel.split("/"));
        for (const line of offendingLines(code, /bindLifecycleLog\s*\(/)) {
          hits.push(`src/${rel} ${line}`);
        }
      }
      // 多一处 = 第二个绑定点 = 同一条 [lifecycle] 落两遍
      expect(hits, `bindLifecycleLog 调用/定义点：\n${hits.join("\n")}`).toHaveLength(2);
      expect(hits.filter((h) => h.includes("event-log.ts"))).toHaveLength(1);
      expect(hits.filter((h) => h.includes("runtime/runtime.ts"))).toHaveLength(1);
    });

    it("绑定点在 activateSubscriptions 体内、释放点在 releaseSubscriptions 体内（防漏在外面导致叠加）", () => {
      const code = codeOf("runtime", "runtime.ts");
      const activate = code.slice(
        code.indexOf("private activateSubscriptions("),
        code.indexOf("private releaseSubscriptions("),
      );
      const release = code.slice(
        code.indexOf("private releaseSubscriptions("),
        code.indexOf("private reportQuotaGate("),
      );
      expect(activate).toContain("bindLifecycleLog(");
      expect(release).toContain("unbindLifecycleLog?.();");
      // 订阅组的幂等旗标必须同时管住它（漏了旗标 = 每轮 start 都再叠一份）
      expect(activate).toContain("if (this.subscriptionsActive)");
      // ⚠️ **worker 门必须在装配点**：那一行是 master 独有的，判据是调用方申报的
      // `this.isWorker`（runtime 自己绝不读 `cluster.isWorker`）。
      expect(activate).toContain("if (!this.isWorker)");
      // 装配失败回滚路径也得退它，否则「不留下半轮订阅」这条对这一族不成立
      expect(activate).toContain("unbindLifecycleLog = unbindLifecycleLog;");
    });

    it("文本契约逐字写在 event-log.ts 里，且该文件零 process 触点", () => {
      const code = codeOf("runtime", "event-log.ts");
      // 逐字：模板串与前缀都在（改文案即改日志文本，护栏必须跟着红）
      expect(code).toContain("[lifecycle] state ${data.prev} -> ${data.next} protocol=${protocol}");
      // 零 process 任何一面（它不拥有进程）
      expect(code).not.toMatch(/process\.(env|on|exit|argv)/);
      // 反向：core / utils / config 三层都不得再 import 它（`runtime → core` 单向）
      // —— 判据写成「src/** 全文的 import 面」，实现上就是上面那条「恰好两处」。
    });
  });
});
