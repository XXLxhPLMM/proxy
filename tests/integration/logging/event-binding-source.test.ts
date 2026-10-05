/**
 * `bindProxyEventLogs` 的**源码级**六档（双绑零容忍 / `src/**` 恰好两处 / 绑定与释放落点 /
 * `pipe` switch 14 变体 / 11 类订阅一条不少）加**第 ⑦ 档 CLI 与库逐字段相等**。
 *
 * @module tests/integration/logging
 *
 * 主题级不变量（两族同层、三条装配裁决、零落盘与行序纪律、防假绿的位置）见 `./AGENTS.md`；
 * 共用的临时目录 / 账号表 / 真 logger / 往返采集见 `./event-binding-fixture.ts`。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { ConfigStore, createConfigContext } from "@/config/index.js";
import { EventHub } from "@/core/events/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import { ProxyServer } from "@/server/index.js";
import { srcFilesRecursive } from "../../helpers/src-files.js";
import { codeOf, offendingLines } from "../../helpers/source-scan.js";
import {
  PIPE_VARIANTS,
  baseConfig,
  dir,
  driveTraffic,
  libraryLogger,
  logDir,
  port,
  readRecords,
} from "./event-binding-fixture.js";
import type { Record_ } from "./event-binding-fixture.js";

describe("logging · event-binding-source", () => {
  describe("⑥ 源码级：双绑零容忍 + pipe switch 仍是 14 变体", () => {
    it("ProxyServer 源码面零 bindProxyEventLogs（防双绑）", () => {
      const code = codeOf("server", "index.ts");
      expect(offendingLines(code, /bindProxyEventLogs/)).toEqual([]);
      // ⚠️ 正向证据只钉**今天仍存在**的形状（锚在已删除符号上的断言恒真，不是护栏）：
      // 同一个文件仍然经 `createProxyRuntime(` 装配 runtime，且源码面非空（读文件本身没失败）。
      expect(code).toContain("createProxyRuntime(");
      expect(code).toContain("class ProxyServer");
      expect(code.length).toBeGreaterThan(2000);
      expect(code).not.toContain("eventDisposers");
      // 判据自检：探测器套在**合成脏源码**上必须真的命中，否则上面那条负向断言是恒绿的
      expect(offendingLines("  void bindProxyEventLogs(hub, logger);", /bindProxyEventLogs/)).toHaveLength(1);
    });

    it("src/** 全文恰好两处 bindProxyEventLogs：event-log.ts 的定义 + runtime.ts 的那一个调用点", () => {
      const hits: string[] = [];
      for (const rel of srcFilesRecursive()) {
        const code = codeOf(...rel.split("/"));
        for (const line of offendingLines(code, /bindProxyEventLogs\s*\(/)) {
          hits.push(`src/${rel} ${line}`);
        }
      }
      // 多一处 = 第二个绑定点 = 同一批事件落两遍
      expect(hits, `bindProxyEventLogs 调用/定义点：\n${hits.join("\n")}`).toHaveLength(2);
      expect(hits.filter((h) => h.includes("event-log.ts"))).toHaveLength(1);
      expect(hits.filter((h) => h.includes("runtime/runtime.ts"))).toHaveLength(1);
    });

    it("绑定点在 activateSubscriptions 体内、释放点在 releaseSubscriptions 体内（防漏在外面导致 start→stop→start 叠加）", () => {
      const code = codeOf("runtime", "runtime.ts");
      const activate = code.slice(
        code.indexOf("private activateSubscriptions("),
        code.indexOf("private releaseSubscriptions("),
      );
      const release = code.slice(
        code.indexOf("private releaseSubscriptions("),
        code.indexOf("private reportQuotaGate("),
      );
      expect(activate).toContain("bindProxyEventLogs(");
      expect(release).toContain("unbindEventLogs?.();");
      // 订阅组的幂等旗标必须同时管住它（漏了旗标 = 每轮 start 都再叠一份）
      expect(activate).toContain("if (this.subscriptionsActive)");
    });

    it("pipe switch 仍是 14 变体（数出来，防有人顺手「优化」）", () => {
      const code = codeOf("runtime", "event-log.ts");
      const block = code.slice(code.indexOf('bind("pipe", (event) =>'));
      // 只切到 `bind("server.closed"` 之前 —— 那是 pipe 订阅体的末尾
      const body = block.slice(0, block.indexOf('bind("server.closed"'));
      const cases = [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!);
      expect(cases.slice().sort()).toEqual(PIPE_VARIANTS.slice().sort());
      expect(new Set(cases).size).toBe(14);
      // 穷尽性收口不许被删（删了它新增变体就会被静默吞进兜底分支）
      expect(body).toContain("e satisfies never;");
    });

    it("11 类公共事件订阅一条不少（映射表是文本契约的可读索引，必须与代码同步）", () => {
      const code = codeOf("runtime", "event-log.ts");
      for (const name of [
        "forward.request-headers",
        "request.started",
        "forward.error",
        "server.error",
        "server.client-error",
        "auth.decided",
        "server.listening",
        "usage.quota-exceeded",
        "usage.write-error",
        "server.closed",
        "pipe",
      ]) {
        expect(code, `必须订阅 ${name}`).toContain(`bind("${name}"`);
      }
      // 反向：event-log.ts 不得碰 process 任何一面（它零副作用）
      expect(code).not.toMatch(/process\.(env|on|exit|argv)/);
    });
  });

  describe("⑦ CLI 等价性：真 ProxyServer 与纯库 runtime 的落盘行逐字段相等", () => {
    /**
     * `ProxyServer` 独有的那一批日志行（配置快照 / ready 提示 / 停机）：它们是「拥有进程」
     * 那一侧的面，库调用方本来就不该有。
     * ⚠️ 逐条写明而不是「过滤掉就算了」——把这条豁免名单收窄或放宽都会让下面那次
     * `toEqual` 变成另一种含义，而它此刻正是「CLI 与库同一份绑定」的唯一直接证据。
     *
     * ⚠️ **`[lifecycle]` 不在豁免名单里**：那一族绑定同样住在
     * `runtime/event-log.ts`，CLI 与库两侧**都**落这四行，且逐字段相等——见
     * `./lifecycle-binding-rows.test.ts` 的 ③ 专门钉它（那边有「两侧各 4 行」的正向证据，
     * 免得哪天两侧一起变成空数组时 `toEqual` 变成恒绿）。
     */
    const CLI_ONLY_PREFIXES = [
      "=== config ===", // config-log 的小标题（`logConfig`）
      "[config]", // 配置快照 5 行
      "proxy started:", // ProxyServer.start() 的 ready 行
      "[shutdown]", // ProxyServer.stop() 的收尾行
      "[start]", // 并发注入告警时可能出现
    ];

    function normalize(lines: Record_[]): Record_[] {
      return lines
        .filter((l) => !CLI_ONLY_PREFIXES.some((p) => String(l.msg).startsWith(p)))
        // ts/pid 是「什么时候、哪个进程」，跨路径必然不同，比较时要剥掉
        .map((l) => {
          const copy = { ...l };
          delete copy.ts;
          delete copy.pid;
          return copy;
        })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }

    it("同一份流量：两条路径的事件落盘行逐字段相等（CLI 与库是同一份绑定）", async () => {
      // —— 库路径 ——
      const libLogger = libraryLogger();
      const libRuntime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events: new EventHub({ onListenerError: () => undefined }),
        logger: libLogger,
      });
      await libRuntime.start();
      try {
        await driveTraffic(port);
      } finally {
        await libRuntime.stop();
      }
      const libLines = normalize(await readRecords(libLogger));

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
      try {
        await driveTraffic(port);
      } finally {
        await server.stop(3000);
      }
      const cliLines = normalize(await readRecords(cliLogger));

      // 两侧都真的落了东西（防「两边都空 → 逐字相等」这种假绿）
      expect(libLines.length).toBeGreaterThan(0);
      expect(cliLines.length).toBeGreaterThan(0);
      expect(cliLines).toEqual(libLines);
    });
  });
});
