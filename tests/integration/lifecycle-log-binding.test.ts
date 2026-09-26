/**
 * `[lifecycle] state …` 那一行落盘绑定的护栏（绑定住在 `runtime/event-log.ts`）
 *
 * @description
 * 上一刀把「代理事实 → 落盘」（`bindProxyEventLogs`）搬进了 runtime 层，`[lifecycle] state …`
 * 那一族留在 `ProxyServer.bindRuntimeLifecycle()`。**那种不对称本身就是缺陷**：两条的判据逐条
 * 同源（零 `process` 触点 / 落盘不拥有进程 / 同一轮 `activateSubscriptions`+`releaseSubscriptions`
 * 装配与退订），而「凭什么这个不搬」会变成下一个人凭直觉做错事的起点。
 * **「它是 CLI 的文本契约」不构成不搬的理由**——`bindProxyEventLogs` 的十几条文本契约也全是契约，
 * 照样搬了。契约约束的是**搬完之后那几行逐字不变**，不是「不许搬」。
 *
 * 交付两件事，缺一不可：
 * ① **库调用方能落这一行**（绑定在 runtime 层，`createProxyRuntime` 一条路就有）；
 * ② **CLI 与库是同一份绑定**（第 ⑧ 档逐字段相等；`library-event-log-binding.test.ts` 的第 ⑦ 档
 *    也已把 `[lifecycle]` 从它的豁免名单里删掉，两处互为对照）。
 *
 * 六档：
 * 1. **文本 / 等级 / 字段逐字** —— 直接调 `bindLifecycleLog` 拿一条
 *    `[lifecycle] state idle -> starting protocol=http`，断言**恰好一次 `debug`、msg 逐字、
 *    无结构化字段**（末位不是 plain object）。
 * 2. **库路径真落盘** —— 真 runtime 一次 start/stop → JSONL 里 `[lifecycle]` **恰好 4 行**、
 *    四次跃迁的文本逐字（`starting/running/stopping/stopped`）。
 * 3. **CLI 与库逐字段相等** —— 同一份 start/stop 流量，真 `ProxyServer` 侧与纯库 runtime 侧的
 *    `[lifecycle]` 行剥掉 `ts`/`pid`、按 JSON 排序后 `toEqual`。**两侧都必须非空**（防「两边都空
 *    → 逐字相等」那种假绿）。
 * 4. **`start → stop → start` 不叠加** —— 两轮各 4 行（共 8，不翻倍），且
 *    `lifecycle.changed` 的 `listenerCount` 轮次为 `0 → 2 → 0 → 2 → 0`
 *    （**2** = runtime 自己的 `runtime.*` 派生订阅 + 本落盘绑定；叠加会是 3）。
 * 5. **`isWorker: true` → 零行** —— 那一行是 **cluster master 独有**的（worker 的 ready 面走 IPC
 *    上报、由 master 汇总），而**其余代理事件照旧落盘**（证明关掉的只是这一族，不是全部）。
 *    这一档是本次唯一一处**必须接一条新通道**（`ProxyRuntimeOptions.isWorker`）的理由：runtime
 *    零 `cluster` 零 `process`，worker 身份只能由调用方如实申报。
 * 6. **源码级** —— `ProxyServer` **零** `bindRuntimeLifecycle` / `lifecycleSubscriptions` /
 *    `unbindRuntimeObservers`（防双绑与「搬走一半」）；`src/**` 全文**恰好两处** `bindLifecycleLog(`
 *    （`event-log.ts` 的定义 + `runtime.ts` 的那一个调用点）；绑定在 `activateSubscriptions` 体内、
 *    释放在 `releaseSubscriptions` 体内（且受 `subscriptionsActive` 旗标管）；文本契约逐字出现在
 *    `event-log.ts`；`event-log.ts` 零 `process.*`。
 *    ⚠️ **判据自检**：探测器套在合成脏源码上必须真的命中，否则那些负向断言全是恒绿的
 *    （本仓吃过两次的假绿：锚在已删除符号上 / 判据自证不了）。
 *
 * 零落盘纪律：全部用 `fs.mkdtempSync` 临时目录当 `configDir` 与落盘基址，`afterEach` 里
 * `rmSync` 清理，**绝不写仓库的 `log/`**。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore, configAccessorFromStore, createConfigContext } from "@/config/index.js";
import { EventHub } from "@/core/events/index.js";
import { bindLifecycleLog } from "@/runtime/event-log.js";
import { createProxyRuntime } from "@/runtime/index.js";
import { ProxyServer } from "@/server/index.js";
import { createLogger } from "@/utils/logger/index.js";
import type { Logger } from "@/utils/logger/index.js";
import { getFreePort } from "../helpers/net.js";
import { codeOf, offendingLines } from "../helpers/source-scan.js";

/** 一条 JSONL 记录（剥 `ts` 之后逐字段比较用）。 */
type Record_ = Record<string, unknown>;

/**
 * 一次完整 start/stop 的**恰好四次**跃迁。
 *
 * 口径取自 `core/server/base.ts` 的 `setState`（相同状态直接 return ⇒ 每跃迁恰好一条）：
 * `start()` 发 `idle→starting` / `starting→running`，`stop()` 发 `running→stopping` /
 * `stopping→stopped`。**这四条文本就是本档的逐字契约**。
 */
const TRANSITIONS: readonly string[] = [
  "[lifecycle] state idle -> starting protocol=http",
  "[lifecycle] state starting -> running protocol=http",
  "[lifecycle] state running -> stopping protocol=http",
  "[lifecycle] state stopping -> stopped protocol=http",
];

/**
 * 第二轮 `start` 的四条 —— **与第一轮只差 `prev`**：停机后状态是 `stopped` 而不是 `idle`
 * （`BaseProxy.start()` 允许从 `stopped` 重入），所以那一条是 `stopped -> starting`。
 * 逐条列出来而不是「第一轮的清单 ×2」：第二轮的 `prev` 变了，那正是「`prev` 取自信封
 * 而不是自己记一份状态」的直接证据。
 */
const TRANSITIONS_ROUND2: readonly string[] = [
  "[lifecycle] state stopped -> starting protocol=http",
  "[lifecycle] state starting -> running protocol=http",
  "[lifecycle] state running -> stopping protocol=http",
  "[lifecycle] state stopping -> stopped protocol=http",
];

/**
 * 递归列出 `src/` 下所有 `.ts` 文件（**相对 src/**，`codeOf()` 收的就是这个形态）。
 *
 * ⚠️ 与 `library-event-log-binding.test.ts` 同一条纪律：用 `readdirSync` + `statSync` 的
 * **字符串**形态而不是 `withFileTypes`——后者每项都要写 `entry.name`，而 `name` 是真实 TLD，
 * 会被零外网扫描器判成公网引用，逼本文件进 `PUBLIC_HOST_ALLOWLIST`（那等于为一段与网络毫无
 * 关系的遍历代码申报公网豁免）。**能改掉的命中不靠豁免掩盖**。
 */
function listSrcFiles(rel = ""): string[] {
  const abs = path.join(__dirname, "..", "..", "src", rel);
  const out: string[] = [];
  for (const label of fs.readdirSync(abs)) {
    const child = rel === "" ? label : `${rel}/${label}`;
    if (fs.statSync(path.join(abs, label)).isDirectory()) {
      out.push(...listSrcFiles(child));
    } else if (label.endsWith(".ts")) {
      out.push(child);
    }
  }
  return out;
}

describe("integration/lifecycle-log-binding", () => {
  let dir: string;
  let logDir: string;
  let port: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-lifelog-"));
    // 落盘基址与 configDir 分开两个子目录：断言「哪些文件是日志」时不被别的产物混进来
    logDir = path.join(dir, "logs");
    port = await getFreePort();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 落盘基址钉死到本例临时目录；控制台静音、落盘 debug 级（`[lifecycle]` 是 debug） */
  function baseConfig(): Record<string, unknown> {
    return {
      host: "127.0.0.1",
      port,
      logLevel: "silent",
      logFileLevel: "debug",
      proxyProtocol: "http",
      proxyMode: "server",
      upstreamProtocol: "http",
    };
  }

  /**
   * 库调用方注入的真 logger：`createLogger` 是包入口**唯一**导出的构造入口
   * （`LoggerImpl` 在 `src/index.ts` 上是 **type-only** re-export），所以走它才是真实的库故事。
   */
  function libraryLogger(): ReturnType<typeof createLogger> {
    const store = new ConfigStore({ logLevel: "silent", logFileLevel: "debug", logFile: logDir });
    return createLogger({ config: configAccessorFromStore(store) });
  }

  /** 读全部 JSONL 记录；`logger.flush()` 之后不必轮询 */
  async function readRecords(logger: { flush?(): Promise<void> }): Promise<Record_[]> {
    await logger.flush?.();
    const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl")) : [];
    const lines: Record_[] = [];
    for (const f of files) {
      for (const l of fs.readFileSync(path.join(logDir, f), "utf8").split("\n")) {
        if (l.trim() !== "") {
          lines.push(JSON.parse(l) as Record_);
        }
      }
    }
    return lines;
  }

  /** 只挑 `[lifecycle]` 那几行，剥 `ts`/`pid`（跨路径必然不同的两个字段）后按 JSON 排序 */
  function lifecycleLines(lines: Record_[]): Record_[] {
    return lines
      .filter((l) => String(l.msg).startsWith("[lifecycle]"))
      .map((l) => {
        const copy = { ...l };
        delete copy.ts;
        delete copy.pid;
        return copy;
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  describe("① 文本 / 等级 / 字段逐字（这一行搬走之后一个字都不许变）", () => {
    it("恰好一次 debug、msg 逐字、末位不是 plain object（无结构化字段）", () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;

      const release = bindLifecycleLog(events, logger, "http");
      events.publish("lifecycle.changed", { next: "starting", prev: "idle" });

      // 恰好一次、恰好 debug（不是 info/warn/error）
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      // 文本逐字
      expect(logger.debug.mock.calls[0]![0]).toBe("[lifecycle] state idle -> starting protocol=http");
      // 末位不是 plain object ⇒ 这一行**无结构化字段**（三条身份维度一个都不带）
      expect(logger.debug.mock.calls[0]).toHaveLength(1);
      // info / warn / error 档一条都不许有
      expect(logger.debug.mock.calls[0]![0]).not.toMatch(/\[(proxy|config|shutdown)\]/);

      // 退订后一个字都不许再落
      release();
      logger.debug.mockClear();
      events.publish("lifecycle.changed", { next: "running", prev: "starting" });
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it("退订函数幂等：调两次不炸、第二次是空转，且只摘自己那一条订阅", () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
      // 宿主自己的一条订阅（模拟「库调用方把自己的遥测挂在同一条总线上」）
      const hostCalls: string[] = [];
      const hostSub = events.subscribe("lifecycle.changed", () => {
        hostCalls.push("host");
      });

      const release = bindLifecycleLog(events, logger, "socks5");
      expect(events.listenerCount("lifecycle.changed")).toBe(2);
      release();
      // ⚠️ **不许图省事改用 `hub.removeAll()`**：总线可能属于宿主，连带清掉别人的订阅就是越权
      expect(events.listenerCount("lifecycle.changed")).toBe(1);
      events.publish("lifecycle.changed", { next: "starting", prev: "idle" });
      expect(hostCalls, "宿主自己的订阅必须仍生效").toEqual(["host"]);

      // 幂等：两次都不炸、不改状态
      expect(() => release()).not.toThrow();
      expect(() => release()).not.toThrow();
      expect(events.listenerCount("lifecycle.changed")).toBe(1);
      hostSub.dispose();
    });
  });

  describe("② 纯库路径真落盘（本次交付的直接证据）", () => {
    it("createProxyRuntime 一次 start/stop → [lifecycle] 恰好 4 行且逐字", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = libraryLogger();
      // ⚠️ 全程**不经过 ProxyServer**：这正是「库调用方拿不到这一行」那条现状的对照组
      const runtime = createProxyRuntime({ config: baseConfig(), configDir: dir, events, logger });

      await runtime.start();
      await runtime.stop();

      const lines = await readRecords(logger);
      const mine = lines.filter((l) => String(l.msg).startsWith("[lifecycle]"));
      // 正向证据（防「零行 → 逐字相等」那种假绿）与防叠加：恰好四次跃迁
      expect(mine).toHaveLength(4);
      //
      // ⚠️ **断言必须与行序无关**（本档第一版就踩了，记在这里免得下一个人改回去）：
      // `utils/logger/jsonl.ts` 是**并发** `fs.promises.appendFile`，只在 `flushPendingWrites()`
      // 里**等完成、不保序**（threadpool 多个槽 ⇒ 两次 append 可以乱序落地）。实测同一轮
      // `stop` 的 `stopping->stopped` 会落在下一轮 `stopped->starting` **之后**，而这条用例
      // 单独跑又是另一种顺序 —— **按发生顺序逐条比是本仓最贵的一种 flaky**。一律用多重集合
      // 口径（排序后比 / 逐条数次数），与 `library-event-log-binding` 第 ⑦ 档「按 JSON 排序」同纪律。
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

  describe("③ CLI 与库逐字段相等（同一份绑定，不是「一条多一条少」）", () => {
    it("同一份 start/stop：真 ProxyServer 侧与纯库 runtime 侧的 [lifecycle] 行 toEqual", async () => {
      // —— 库路径 ——
      const libLogger = libraryLogger();
      const libRuntime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events: new EventHub({ onListenerError: () => undefined }),
        logger: libLogger,
      });
      await libRuntime.start();
      await libRuntime.stop();
      const libLines = lifecycleLines(await readRecords(libLogger));

      // —— CLI 路径（真 ProxyServer；worker=false 以便真落盘）——
      fs.rmSync(logDir, { recursive: true, force: true });
      const store = new ConfigStore(baseConfig());
      const cliLogger = libraryLogger();
      const server = new ProxyServer({
        context: createConfigContext({ store, configDir: dir }),
        logger: cliLogger,
        noColor: true,
        isWorker: false,
      });
      await server.start();
      await server.stop(3000);
      const cliLines = lifecycleLines(await readRecords(cliLogger));

      // 两侧都真的落了东西（**防「两边都空 → 逐字相等」这种假绿**）
      expect(libLines).toHaveLength(4);
      expect(cliLines).toHaveLength(4);
      // 逐字段相等
      expect(cliLines).toEqual(libLines);
      // 文本逐字（顺带钉住 CLI 那一行一个字没变）
      expect(cliLines.map((l) => l.msg).slice().sort()).toEqual(TRANSITIONS.slice().sort());
    });
  });

  describe("④ start → stop → start 不叠加（防订阅叠加）", () => {
    it("两轮各 4 行（共 8），lifecycle.changed 的 listenerCount 轮次 0→2→0→2→0", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = libraryLogger();
      const runtime = createProxyRuntime({ config: baseConfig(), configDir: dir, events, logger });

      // 停机后订阅必须全部退掉（否则下一轮 start 会叠加）
      expect(events.listenerCount("lifecycle.changed")).toBe(0);

      await runtime.start();
      // **2** = runtime 自己的 `runtime.*` 派生订阅 + 本落盘绑定。叠加的话这里是 3。
      expect(events.listenerCount("lifecycle.changed")).toBe(2);
      await runtime.stop();
      expect(events.listenerCount("lifecycle.changed")).toBe(0);

      await runtime.start();
      expect(events.listenerCount("lifecycle.changed")).toBe(2);
      await runtime.stop();
      expect(events.listenerCount("lifecycle.changed")).toBe(0);

      const mine = (await readRecords(logger)).filter((l) => String(l.msg).startsWith("[lifecycle]"));
      // 叠加的话这里是 12（第 2 轮的四次跃迁被落两遍）
      expect(mine).toHaveLength(8);
      // 逐条数次数（**多重集合**口径，理由见 ② 那段注释：JSONL 行序不保证）：
      // 两轮**各四条**。`starting->running` / `running->stopping` / `stopping->stopped`
      // 各 2 次；`idle->starting` 与 `stopped->starting` 各 1 次 —— 后者正是「第二轮从
      // `stopped` 重入、且 `prev` 取自信封而不是自己记一份状态」的直接证据。
      const counts = new Map<string, number>();
      for (const l of mine) {
        counts.set(String(l.msg), (counts.get(String(l.msg)) ?? 0) + 1);
      }
      expect(Object.fromEntries(counts)).toEqual({
        [TRANSITIONS[0]!]: 1,
        [TRANSITIONS_ROUND2[0]!]: 1,
        [TRANSITIONS[1]!]: 2,
        [TRANSITIONS[2]!]: 2,
        [TRANSITIONS[3]!]: 2,
      });
    });
  });

  describe("⑤ isWorker: true → 零行（那一族是 cluster master 独有的）", () => {
    it("零 [lifecycle] 行，但其余代理事件照旧落盘（证明关掉的只是这一族）", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = libraryLogger();
      const runtime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events,
        logger,
        isWorker: true,
      });

      await runtime.start();
      // 运行期订阅数 = 1：**只剩 runtime 自己派生 `runtime.*` 那条**，落盘绑定**没有**装上。
      // （stop 之后两条都被释放、回到 0，所以这条必须**在 stop 之前**取样。）
      expect(events.listenerCount("lifecycle.changed")).toBe(1);
      await runtime.stop();
      expect(events.listenerCount("lifecycle.changed")).toBe(0);

      const lines = await readRecords(logger);
      expect(lines.filter((l) => String(l.msg).startsWith("[lifecycle]")), "worker 档必须零行").toEqual([]);
      // 正向对照：落盘面**整体**仍然在（`server.listening` 是 `bindProxyEventLogs` 那族，不看 isWorker）
      expect(lines.some((l) => String(l.msg).startsWith("listening on ")), "其余代理事件照旧落盘").toBe(true);
    });

    it("ProxyServer 真的把它判出来的 isWorker 传下去了（否则这一档在库路径测了也白测）", async () => {
      const store = new ConfigStore(baseConfig());
      const logger = libraryLogger();
      const server = new ProxyServer({
        context: createConfigContext({ store, configDir: dir }),
        logger,
        noColor: true,
        isWorker: true,
      });
      await server.start();
      await server.stop(3000);

      const lines = await readRecords(logger);
      expect(lines.filter((l) => String(l.msg).startsWith("[lifecycle]")), "worker 档必须零行").toEqual([]);
      expect(lines.some((l) => String(l.msg).startsWith("listening on "))).toBe(true);
    });
  });

  describe("⑥ 源码级：双绑零容忍 + 绑定/释放都落在 runtime 的那一轮里", () => {
    it("ProxyServer 源码面零 bindRuntimeLifecycle / lifecycleSubscriptions / unbindRuntimeObservers", () => {
      const code = codeOf("server", "index.ts");
      // ⚠️ 三条都是**负向**断言，锚点是**今天已不存在**的符号 —— 它们防的是「搬走一半」
      // （方法又长回来）或「删了方法、订阅退订那一半还留着」。因此**必须配下面的判据自检**：
      // 探测器套在合成脏源码上必须真的命中，否则这三条是恒绿的（本仓吃过两次这种假绿）。
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
      for (const rel of listSrcFiles()) {
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
      // —— 判据写成「src/** 全文的 import 面」，实现上就是下面那条「恰好两处」。
    });
  });
});
