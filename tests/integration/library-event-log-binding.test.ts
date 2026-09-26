/**
 * 事件 → 落盘绑定的护栏（绑定住在 `runtime/event-log.ts`，CLI 与库共用同一份）
 *
 * @description
 * 本档锁的是**库调用方能落盘**这件事：`bindProxyEventLogs` 挂在 `runtime/event-log.ts`，
 * 由 `createProxyRuntime` 装配——库调用方走 `createProxyRuntime()` 直接就有落盘，
 * 没有任何前置条件（挂到「拥有进程」那一层就会让嵌入方只剩两条烂路：① 接受没有落盘日志；
 * ② 自己重写那 11 个订阅，还要自己记得在 stop 时退订，漏了就泄漏监听器）。
 *
 * 七档：
 * 1. **纯库路径（`config` 模式）真落盘** —— 断言 JSONL 文件真实存在且含 `[forward]` /
 *    `[auth] deny` / `[route]` 三种行。
 * 2. **纯库路径（`context` 模式）同样落盘** —— 证明绑定长在 runtime 上、不是长在某条装配路径上。
 * 3. **`eventLogs: false` → 零落盘行**，且**事件仍照常发布**（证明关掉的只是「事件 → 这一个
 *    logger」这一跳，不是事件面本身）。
 * 4. **`start → stop → start` 落盘行数不翻倍** —— 防订阅叠加。已变异验证。
 * 5. **退订函数幂等** —— 调两次不炸、第二次是空转；**且只摘自己挂的订阅**（同一条总线上
 *    宿主自己的订阅必须原样存活，**绝不许**改用 `hub.removeAll()`）。
 *    ⚠️ 这条判据是**重瞄过**的：初版只断言「调两次不炸、监听归零」，变异验证时发现摘掉实现里
 *    那个 `released` 布尔标志**照样全绿**——因为 `splice(0)` 清空数组后第二次迭代的就是空数组，
 *    而 `EventSubscription.dispose()` 自己也是幂等的。**一个红不了的不变式就是假绿**
 *    （本仓 `tests/AGENTS.md`「负向断言锚在已删除符号上」那条教训的同型）。处置有两条：
 *    ① 实现侧**删掉那个冗余标志**（死可选性）；② 判据侧改钉**真会坏的那条**——
 *    「只摘自己的订阅」与「重新绑一次仍能收」，前者对 `hub.removeAll()` 立刻变红。
 * 6. **源码级双绑/14 变体** —— `ProxyServer` 零 `bindProxyEventLogs`（防双绑）、
 *    `src/**` 全文**恰好两处**（定义 + runtime 里那一个调用点）、
 *    `pipe` switch **仍是 14 变体**（数出来，防有人顺手「优化」）。
 * 7. **CLI 等价性** —— 同一份流量分别经真 `ProxyServer` 与纯库 runtime 跑一遍，
 *    事件落盘行**逐字段相等**（证明 CLI 与库是同一份绑定，不是一条多一条少）。
 *
 * 全部用**临时目录**（`mkdtemp`）当 `configDir` 与落盘基址，测完 `rmSync` 清理，
 * **绝不写仓库的 `log/`**。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ConfigStore, configAccessorFromStore, createConfigContext } from "@/config/index.js";
import { EventHub } from "@/core/events/index.js";
import { bindProxyEventLogs } from "@/runtime/event-log.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { ProxyServer } from "@/server/index.js";
import { createLogger } from "@/utils/logger/index.js";
import type { Logger } from "@/utils/logger/index.js";
import { getFreePort, listen } from "../helpers/net.js";
import { codeOf, offendingLines } from "../helpers/source-scan.js";

const ALICE_PW = "pw1";
const TARGET_IP = "127.0.0.1";

/** 一条 JSONL 记录（去掉 `ts` 之后逐字段比较用）。 */
type Record_ = Record<string, unknown>;

/** `PipeEvent` 判别联合的 14 个变体（与 `unit/pipe-event.test.ts` 的编译期契约同一份清单）。 */
const PIPE_VARIANTS: readonly string[] = [
  "target-unresolved",
  "loop-detected",
  "route",
  "upstream-refused",
  "upstream-error",
  "upstream-timeout",
  "ip-denied",
  "target-denied",
  "socks",
  "bad-request",
  "dial",
  "established",
  "client-error",
  "debug",
];

/** 采集一次原始 HTTP 往返（绝对形式请求直发代理） */
function rawRequest(
  port: number,
  requestLine: string,
  headers: string[],
): Promise<{ status: string; raw: string }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, TARGET_IP, () => {
      sock.write([requestLine, ...headers, "Connection: close", "", ""].join("\r\n"));
    });
    let buf = "";
    sock.on("data", (c: Buffer) => {
      buf += c.toString();
    });
    sock.on("close", () => resolve({ status: buf.split("\r\n")[0] ?? "", raw: buf }));
    sock.on("error", () => {
      // close 仍会触发
    });
  });
}

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/**
 * 递归列出 `src/` 下所有 `.ts` 文件（**相对 src/**，`codeOf()` 收的就是这个形态）。
 *
 * ⚠️ 刻意用 `readdirSync` + `statSync` 的**字符串**形态而不是 `withFileTypes`：
 * 后者每一项都要写 `entry.name`，而 `name` 是真实 TLD，零外网扫描器会把
 * `entry.name` 判成公网引用，逼本文件进 `PUBLIC_HOST_ALLOWLIST`（那等于为一段
 * 与网络毫无关系的遍历代码申报一条公网豁免）。`tests/AGENTS.md` 的纪律是
 * 「**不靠豁免掩盖能改掉的命中**」。
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

describe("integration/library-event-log-binding", () => {
  let dir: string;
  let logDir: string;
  let origin: http.Server;
  let originPort: number;
  let port: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-liblog-"));
    // 落盘基址与 configDir 分开两个子目录：断言「哪些文件是日志」时不被别的产物混进来
    logDir = path.join(dir, "logs");
    // 账号表
    fs.writeFileSync(
      path.join(dir, "users.json"),
      JSON.stringify([{ username: "alice", password: ALICE_PW }]),
    );
    // 上游路由黑名单：让 client 模式回落直连**并带 reason**（`[route]` 行的 jq 契约字段）
    fs.writeFileSync(
      path.join(dir, "acl.json"),
      JSON.stringify({ upstream: { blacklist: [TARGET_IP] } }),
    );

    origin = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("origin-ok");
    });
    originPort = await getFreePort();
    await listen(origin, originPort);
    port = await getFreePort();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      origin.closeAllConnections?.();
      origin.close(() => resolve());
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 落盘用的库侧配置：控制台静音，落盘 info 级，基址钉死到本例临时目录 */
  function baseConfig(): Record<string, unknown> {
    return {
      host: TARGET_IP,
      port,
      logLevel: "silent",
      logFileLevel: "debug",
      proxyProtocol: "http",
      proxyMode: "client",
      upstreamProtocol: "http",
      upstreamHost: TARGET_IP,
      upstreamPort: originPort,
      authEnabled: true,
      authType: "basic",
      authUsersFile: path.join(dir, "users.json"),
      authLogging: true,
      aclFile: path.join(dir, "acl.json"),
    };
  }

  /**
   * 库调用方注入的真 logger：`createLogger` 是包入口**唯一**导出的构造入口
   * （`LoggerImpl` 在 `src/index.ts` 上是 **type-only** re-export，库调用方压根 new 不出来），
   * 所以走 `createLogger({ config })` 才是真实的库故事而不是测试专用捷径。
   */
  function libraryLogger(): ReturnType<typeof createLogger> {
    const store = new ConfigStore({
      logLevel: "silent",
      logFileLevel: "debug",
      logFile: logDir,
    });
    return createLogger({ config: configAccessorFromStore(store) });
  }

  /** 读全部 JSONL 记录（逐行 JSON.parse）；`logger.flush()` 之后不必轮询 */
  async function readRecords(logger: { flush?(): Promise<void> }): Promise<Record_[]> {
    await logger.flush?.();
    const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl")) : [];
    const lines: Record_[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(logDir, f), "utf8");
      for (const l of text.split("\n")) {
        if (l.trim() !== "") {
          lines.push(JSON.parse(l) as Record_);
        }
      }
    }
    return lines;
  }

  /** 一次完整往返：好凭证 200（`[forward]` + `[route]`）→ 坏凭证 407（`[auth] deny`） */
  async function driveTraffic(proxyPort: number): Promise<void> {
    const good = await rawRequest(
      proxyPort,
      `GET http://${TARGET_IP}:${originPort}/ok HTTP/1.1`,
      [`Host: ${TARGET_IP}:${originPort}`, `Proxy-Authorization: ${basic("alice", ALICE_PW)}`],
    );
    expect(good.status.startsWith("HTTP/1.1 200")).toBe(true);
    expect(good.raw).toContain("origin-ok");

    const bad = await rawRequest(
      proxyPort,
      `GET http://${TARGET_IP}:${originPort}/deny HTTP/1.1`,
      [`Host: ${TARGET_IP}:${originPort}`, `Proxy-Authorization: ${basic("mallory", "pw")}`],
    );
    expect(bad.status.startsWith("HTTP/1.1 407")).toBe(true);
  }

  describe("① 纯库路径真落盘（config 模式）—— 本次交付的直接证据", () => {
    it("createProxyRuntime({ config, configDir }) 跑一次真请求 → JSONL 真存在且含 [forward] / [auth] deny / [route]", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = libraryLogger();
      // ⚠️ 全程**不经过 ProxyServer**：这正是「库调用方拿不到落盘日志」那条现状的对照组
      const runtime: ProxyRuntime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events,
        logger,
      });

      await runtime.start();
      try {
        await driveTraffic(port);
      } finally {
        await runtime.stop();
      }

      // ① 文件真实存在
      const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl")) : [];
      expect(files.length, "落盘目录里必须有按小时的 .jsonl").toBeGreaterThanOrEqual(1);

      const lines = await readRecords(logger);

      // ② `[forward]` info 行：带身份维度（user/client/target/kind/method）
      const forward = lines.find((l) => l.msg === "[forward]");
      expect(forward, "必须有 [forward] 行").toBeTruthy();
      expect(forward?.level).toBe("info");
      expect(forward?.prefix).toBe("[proxy]");
      expect(forward?.user).toBe("alice");
      expect(forward?.client).toBe(TARGET_IP);
      expect(forward?.kind).toBe("http");
      expect(forward?.method).toBe("GET");
      expect(String(forward?.target)).toContain(String(originPort));

      // ③ `[auth] deny` info 行：带 attempted / reason
      const deny = lines.find((l) => l.msg === "[auth] deny");
      expect(deny, "必须有 [auth] deny 行").toBeTruthy();
      expect(deny?.level).toBe("info");
      expect(deny?.attempted).toBe("mallory");
      expect(deny?.client).toBe(TARGET_IP);

      // ④ `[route]` info 行：与 route 事件 1:1（target/route/reason 是 jq 契约）
      const route = lines.find((l) => l.msg === "[route]");
      expect(route, "必须有 [route] 行").toBeTruthy();
      expect(route?.level).toBe("info");
      expect(route?.route).toBe("direct");
      expect(route?.reason).toBe("blacklist");
      expect(String(route?.target)).toBe(`${TARGET_IP}:${originPort}`);

      // ⑤ `[{kind}] headers` debug 行也在（fileLevel=debug 才看得到）
      const dump = lines.find((l) => l.msg === "[http] headers");
      expect(dump, "必须有 [http] headers 行").toBeTruthy();
      expect(dump?.level).toBe("debug");
      expect(dump?.user).toBe("alice");
    });
  });

  describe("② 纯库路径（context 模式）同样落盘", () => {
    it("共享 live store 的 context 模式下落盘行逐字相同（绑定长在 runtime 上、不是长在某条装配路径上）", async () => {
      const store = new ConfigStore(baseConfig());
      const context = createConfigContext({ store, configDir: dir });
      const logger = libraryLogger();
      const runtime = createProxyRuntime({
        context,
        events: new EventHub({ onListenerError: () => undefined }),
        logger,
      });

      await runtime.start();
      try {
        await driveTraffic(port);
      } finally {
        await runtime.stop();
      }

      const lines = await readRecords(logger);
      expect(lines.find((l) => l.msg === "[forward]")?.user).toBe("alice");
      expect(lines.find((l) => l.msg === "[auth] deny")?.attempted).toBe("mallory");
      expect(lines.find((l) => l.msg === "[route]")?.route).toBe("direct");
    });
  });

  describe("③ eventLogs: false —— 关掉的只是「事件 → 这一个 logger」这一跳", () => {
    it("显式 false：零落盘行，但公共事件面一条不少", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const seen: string[] = [];
      // 宿主自己接事件桥（这正是 `eventLogs: false` 的正当场景）
      for (const name of ["request.started", "auth.decided", "route.selected"] as const) {
        events.subscribe(name, () => {
          seen.push(name);
        });
      }
      const logger = libraryLogger();
      const runtime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events,
        logger,
        eventLogs: false,
      });

      await runtime.start();
      try {
        await driveTraffic(port);
      } finally {
        await runtime.stop();
      }

      const lines = await readRecords(logger);
      // ⚠️ 零落盘行：logger 一行都没写（不只是「没有代理事件那几行」）
      expect(lines, `不该有任何落盘行，实际：${JSON.stringify(lines.map((l) => l.msg))}`).toEqual([]);
      // 目录压根没被建出来（落盘 IO 在 logger 那一侧，它一次都没被叫到）
      expect(fs.existsSync(logDir) ? fs.readdirSync(logDir).length : 0).toBe(0);
      // 但事件面照常：宿主自己拿得到三条事实
      expect(seen).toContain("request.started");
      expect(seen).toContain("auth.decided");
      expect(seen).toContain("route.selected");
    });
  });

  describe("④ start → stop → start 落盘行数不翻倍（防订阅叠加）", () => {
    it("两轮各一个请求：[forward] 恰好 2 条，且 start 之后 request.started 恰好 1 个订阅者", async () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = libraryLogger();
      const runtime = createProxyRuntime({
        config: baseConfig(),
        configDir: dir,
        events,
        logger,
      });

      // 停机后订阅必须全部退掉（否则下一轮 start 会叠加）
      expect(events.listenerCount("request.started")).toBe(0);

      await runtime.start();
      try {
        // 一个订阅者就是事件落盘绑定本身（bridge 订阅的是 pipe、lifecycle 订阅的是 lifecycle.changed）
        expect(events.listenerCount("request.started")).toBe(1);
        const r = await rawRequest(
          port,
          `GET http://${TARGET_IP}:${originPort}/r1 HTTP/1.1`,
          [`Host: ${TARGET_IP}:${originPort}`, `Proxy-Authorization: ${basic("alice", ALICE_PW)}`],
        );
        expect(r.status.startsWith("HTTP/1.1 200")).toBe(true);
      } finally {
        await runtime.stop();
      }
      expect(events.listenerCount("request.started")).toBe(0);

      await runtime.start();
      try {
        expect(events.listenerCount("request.started")).toBe(1);
        const r = await rawRequest(
          port,
          `GET http://${TARGET_IP}:${originPort}/r2 HTTP/1.1`,
          [`Host: ${TARGET_IP}:${originPort}`, `Proxy-Authorization: ${basic("alice", ALICE_PW)}`],
        );
        expect(r.status.startsWith("HTTP/1.1 200")).toBe(true);
      } finally {
        await runtime.stop();
      }
      expect(events.listenerCount("request.started")).toBe(0);

      const lines = await readRecords(logger);
      const forwards = lines.filter((l) => l.msg === "[forward]");
      // 叠加的话这里会是 3 条（第 2 轮的请求被落两遍）
      expect(forwards).toHaveLength(2);
      expect(forwards.every((l) => l.user === "alice")).toBe(true);
    });
  });

  describe("⑤ 退订函数幂等", () => {
    it("调两次不炸、第二次是空转；且只摘自己挂的订阅（宿主自己的订阅必须原样存活）", () => {
      const events = new EventHub({ onListenerError: () => undefined });
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;

      // 宿主自己的一条订阅（模拟「库调用方把自己的遥测挂在同一条总线上」）
      const hostCalls: string[] = [];
      const hostSub = events.subscribe("runtime.started", () => {
        hostCalls.push("started");
      });

      const release = bindProxyEventLogs(events, logger);
      // 正向证据：绑定确实落了 11 类订阅（不数具体条数，只要求「远大于 0」且退订后归零）
      expect(events.listenerCount()).toBeGreaterThan(1);

      release();
      // 只剩宿主那一条
      expect(events.listenerCount(), "退订后必须只剩宿主自己那一条").toBe(1);
      // ⚠️ **不许图省事改用 `hub.removeAll()`**：总线可能属于宿主，连带清掉别人的订阅就是越权
      events.publish("runtime.started", { host: "127.0.0.1", port: 1, protocol: "http" });
      expect(hostCalls, "宿主自己的订阅必须仍生效").toEqual(["started"]);

      // 第二次必须是空转：既不抛，也不改变任何状态
      expect(() => release()).not.toThrow();
      expect(() => release()).not.toThrow();
      expect(events.listenerCount()).toBe(1);

      // 退订之后再发事件：一个字段都不许落到 logger 上
      logger.debug.mockClear();
      logger.info.mockClear();
      logger.warn.mockClear();
      logger.error.mockClear();
      events.publish("request.started", { kind: "http" }, { client: "client-a" });
      events.publish("server.listening", { host: "127.0.0.1", port: 1 }, { runtimeId: events.runtimeId, protocol: "http" });
      expect(logger.debug).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();

      // 「退订干净」而不是「把总线搞坏」的正向证据：重新绑一次仍然能收，宿主那条也还在
      const release2 = bindProxyEventLogs(events, logger);
      expect(events.listenerCount()).toBeGreaterThan(1);
      events.publish("server.listening", { host: "127.0.0.1", port: 1 }, { runtimeId: events.runtimeId, protocol: "http" });
      expect(logger.debug).toHaveBeenCalledTimes(1);
      release2();
      expect(events.listenerCount()).toBe(1);
      hostSub.dispose();
    });
  });

  describe("⑥ 源码级：双绑零容忍 + pipe switch 仍是 14 变体", () => {
    it("ProxyServer 源码面零 bindProxyEventLogs（防双绑）", () => {
      const code = codeOf("server", "index.ts");
      expect(offendingLines(code, /bindProxyEventLogs/)).toEqual([]);
      // ⚠️ 判据自查（防「锚在已删除符号上恒真」）：上一版这里断言 `code` 含
      // `lifecycleSubscriptions`。那一族绑定（`[lifecycle] state …`）已于后续一刀整体搬进
      // `runtime/event-log.ts`，那个符号现在**不存在**了——留着就是一条恒真的正向断言。
      // 换成**今天仍存在**的形状：同一个文件仍然经 `createProxyRuntime(` 装配 runtime，
      // 且源码面非空（读文件本身没失败）。
      expect(code).toContain("createProxyRuntime(");
      expect(code).toContain("class ProxyServer");
      expect(code.length).toBeGreaterThan(2000);
      expect(code).not.toContain("eventDisposers");
      // 判据自检：探测器套在**合成脏源码**上必须真的命中，否则上面那条负向断言是恒绿的
      expect(offendingLines("  void bindProxyEventLogs(hub, logger);", /bindProxyEventLogs/)).toHaveLength(1);
    });

    it("src/** 全文恰好两处 bindProxyEventLogs：event-log.ts 的定义 + runtime.ts 的那一个调用点", () => {
      const hits: string[] = [];
      for (const rel of listSrcFiles()) {
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
        "traffic.quota-exceeded",
        "traffic.ledger-error",
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
     * `ProxyServer` 独有的那一批日志行（配置快照 / ready 提示 / 停机），
     * 与本次迁移**无关**：它们是「拥有进程」那一侧的面，库调用方本来就不该有。
     * ⚠️ 逐条写明而不是「过滤掉就算了」——把这条豁免名单收窄或放宽都会让下面那次
     * `toEqual` 变成另一种含义，而它此刻正是「CLI 与库同一份绑定」的唯一直接证据。
     *
     * ⚠️ **`[lifecycle]` 不在豁免名单里**：那一族绑定同样住在
     * `runtime/event-log.ts`，CLI 与库两侧**都**落这四行，且逐字段相等——见
     * `lifecycle-log-binding.test.ts` 专门钉它（那边另有一条「必须非空」的正向证据，
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
