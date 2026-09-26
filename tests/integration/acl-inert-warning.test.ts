/**
 * `acl-inert` 启动期告警的端到端护栏（真 runtime + 真 `ProxyServer`）。
 *
 * @description
 * **这条告警在防什么**：`createProxyRuntime({ services: { access } })` 注入自定义 `access`
 * 之后，`buildDefaultServices` **不会**去解析 `createFileAccessControl(config)`，
 * 于是 `acl.json` 里那份名单**根本没被读**。这是**正当**用法（端口的意义就是换实现），
 * 但运维视角是「我配了名单怎么没生效」——零信号。
 *
 * **为什么这条必须是真 runtime 断言而不是源码断言**：判据两个输入都在装配期产生
 * （`overrides.access` 与 accessor 指向的名单文件），源码上「它们被 AND 在一起」看得见，
 * 但「两个判据各自的真值」只有真跑一次才知道（尤其是**负向**那两条：没配名单、
 * 没用自定义 access——它们是防「告警变噪音」的唯一护栏）。
 *
 * ⚠️ **「只报一次」**：告警是启动期一次性事实，不许每请求报。故用
 * `warnings.filter((w) => w.code === "acl-inert")` 断言**恰好**条数（不是 `>= 1`）。
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigContext } from "@/config/index.js";
import { ACL_INERT_DETAIL, LogEvent } from "@/core/log-events.js";
import type { AccessControl, AccessDecision, AccessTargetInput } from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime, RuntimeWarning } from "@/runtime/index.js";
import { ProxyServer } from "@/server/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { HttpProxy } from "@/core/server/http.js";
import { testConfigStore, testLogger, testContext } from "../helpers/config.js";
import { getFreePort } from "../helpers/net.js";
import { withProxy } from "../helpers/proxy.js";
import { blockAfter, codeOf, codeOnly } from "../helpers/source-scan.js";

/** 共享测试上下文（`withProxy` 的 ctx 缺省也是这一份，这里显式传只为让档内自足） */
function runtimeContext(): typeof testContext {
  return testContext;
}

/** 发一条 absolute-form 明文 HTTP 请求，读到首个响应就返回状态码 */
function absoluteGet(
  proxyPort: number,
  target: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: `http://${target}/`,
        method: "GET",
        headers: { Host: target },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 会**记账**的访问控制替身：证明注入的那份真的被判过了（而不是「原样透传就算生效」）。 */
function countingAccess(answers: { target?: AccessDecision } = {}): AccessControl & {
  targetCalls: AccessTargetInput[];
} {
  const targetCalls: AccessTargetInput[] = [];
  return {
    targetCalls,
    checkClient: () => ({ allowed: true }),
    checkTarget: (input) => {
      targetCalls.push(input);
      return answers.target ?? { allowed: true };
    },
    checkRoute: () => ({ direct: false }),
  };
}

let dir = "";
let seq = 0;
let runtime: ProxyRuntime | undefined;
let server: ProxyServer | undefined;
/** 每档独立 acl.json 路径：`readJsonCached` 的 1s 节流缓存是模块级、键为 `label + path` */
function freshAcl(body: unknown): string {
  seq += 1;
  const p = path.join(dir, `acl-${seq}.json`);
  fs.writeFileSync(p, JSON.stringify(body));
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acl-inert-"));
});

afterEach(async () => {
  await runtime?.stop().catch(() => undefined);
  runtime = undefined;
  await server?.stop().catch(() => undefined);
  server = undefined;
  vi.restoreAllMocks();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不应遮蔽用例结论
  }
});

/** 起一个真 runtime（端口 1 = 不会真的监听成功也无所谓，本档只关心启动期告警） */
async function startRuntime(options: {
  aclFile: string;
  access?: AccessControl;
}): Promise<RuntimeWarning[]> {
  const warnings: RuntimeWarning[] = [];
  const port = await getFreePort();
  const lib = createProxyRuntime({
    config: { host: "127.0.0.1", port, authEnabled: false, aclFile: options.aclFile },
    logger: testLogger,
    services: options.access ? { access: options.access } : {},
    onWarning: (w) => warnings.push(w),
  });
  runtime = lib;
  await lib.start();
  return warnings;
}

const aclWarnings = (warnings: RuntimeWarning[]): RuntimeWarning[] =>
  warnings.filter((w) => w.code === "acl-inert");

// ---------------------------------------------------------------------------
// 1. 正向：配了名单 + 注入了自定义 access → 恰好一条
// ---------------------------------------------------------------------------

describe("acl-inert：配了 acl.json + 注入自定义 access", () => {
  it("恰好一条 acl-inert，且 message 就是文案常量（库路径）", async () => {
    const access = countingAccess();
    const aclFile = freshAcl({ target: { blacklist: ["203.0.113.9"] } });

    const warnings = await startRuntime({ aclFile, access });

    expect(aclWarnings(warnings)).toHaveLength(1);
    expect(aclWarnings(warnings)[0].message).toBe(ACL_INERT_DETAIL);
    // 注入的替身真的被判过（只断言「`runtime.services.access` 是我给的那个对象」证明的
    // 仅仅是赋值发生 —— 一份没人调用的替身照样通过）
    expect(runtime!.services.access).toBe(access);
  });

  it("真的在判名单：acl.json 的黑名单**没有**被内置引擎采信，替身说的是放行就放行", async () => {
    // 告警的价值全在这条上：它之所以必须报，是因为 acl.json 真的不生效。
    // 只断言「报了一条告警」而不验证「那份文件确实被忽略」，等于报了个假的。
    const aclFile = freshAcl({ target: { blacklist: ["203.0.113.9"] } });
    const access = countingAccess();
    await startRuntime({ aclFile, access });

    const lib = runtime!;
    // 替身说放行 ⇒ 放行（内置引擎对着同一个文件会判 `blacklist` 拒）
    expect(lib.options.access.checkTarget({ host: "203.0.113.9" })).toEqual({ allowed: true });
    expect(access.targetCalls).toHaveLength(1);
    // 对照组：默认实现对着同一份文件确实会拒 —— 证明「acl.json 写了东西」不是空话
    const { createFileAccessControl } = await import("@/core/access-control.js");
    const fileAccess = createFileAccessControl(lib.context.accessor);
    expect(fileAccess.checkTarget({ host: "203.0.113.9" })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "global",
    });
  });

  it("只有 `upstream` 路由名单非空也算「配了」（文案点名的那一类失效也必须报）", async () => {
    const aclFile = freshAcl({ upstream: { whitelist: ["intranet.example.com"] } });
    const warnings = await startRuntime({ aclFile, access: countingAccess() });
    expect(aclWarnings(warnings)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. 负向 A：配了名单 + **没有**自定义 access → 零条（防「告警变噪音」）
// ---------------------------------------------------------------------------

describe("acl-inert：配了 acl.json 但没有注入自定义 access → 零条", () => {
  it("走默认实现时**不报**（内置引擎真的在判那份名单，没有「有东西没生效」）", async () => {
    const aclFile = freshAcl({ target: { blacklist: ["203.0.113.9"] } });
    const warnings = await startRuntime({ aclFile });

    expect(aclWarnings(warnings)).toHaveLength(0);
    // 正向证据：默认实现真的在按那份文件判定（否则这条只是「什么都没发生」）
    expect(runtime!.options.access.checkTarget({ host: "203.0.113.9" })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "global",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. 负向 B：没配名单 + 注入了自定义 access → 零条（防误报）
// ---------------------------------------------------------------------------

describe("acl-inert：没配 acl.json 但注入了自定义 access → 零条", () => {
  it("整份缺失 → 零条（注入替身是常态，不该报）", async () => {
    const warnings = await startRuntime({
      aclFile: path.join(dir, "definitely-absent.json"),
      access: countingAccess(),
    });
    expect(aclWarnings(warnings)).toHaveLength(0);
  });

  it("文件在但三组全空 → 零条（判据看「非空」不看「文件在不在」）", async () => {
    const aclFile = freshAcl({
      clientIp: {},
      target: { whitelist: [], blacklist: [] },
      upstream: {},
    });
    const warnings = await startRuntime({ aclFile, access: countingAccess() });
    expect(aclWarnings(warnings)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. CLI 落盘行：文案逐字
// ---------------------------------------------------------------------------

describe("CLI 落盘行 `[acl-inert]`", () => {
  it("落一条 warn 行，文案与文案常量逐字相同（运维真的看得见）", async () => {
    const aclFile = freshAcl({ clientIp: { blacklist: ["203.0.113.9"] } });
    const port = await getFreePort();
    testConfigStore.set("port", port);
    testConfigStore.set("host", "127.0.0.1");
    testConfigStore.set("aclFile", aclFile);
    testConfigStore.set("logFile", "");

    const logger = new LoggerImpl({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    server = new ProxyServer({
      context: createConfigContext({ store: testConfigStore, configDir: dir }),
      logger,
      noColor: true,
      isWorker: true,
      services: { access: countingAccess() },
    });
    await server.start();

    const lines = warn.mock.calls.filter((c) => String(c[0]).startsWith(`[${LogEvent.AclInert}]`));
    expect(lines, "注入 access + 配了名单 → 启动必须告警").toHaveLength(1);
    expect(String(lines[0][0])).toBe(`[${LogEvent.AclInert}] ${ACL_INERT_DETAIL}`);
    // 文案必须回答「怎么办」与「哪几组不生效」——只说「出问题了」等于没报
    expect(String(lines[0][0])).toContain("clientIp/target");
    expect(String(lines[0][0])).toContain("upstream");
    expect(String(lines[0][0])).toContain("createFileAccessControl");
  });

  it("没注入 access 时不落这一行（`onWarning` 白名单只接两条，不是整体转发）", async () => {
    const aclFile = freshAcl({ target: { blacklist: ["203.0.113.9"] } });
    const port = await getFreePort();
    testConfigStore.set("port", port);
    testConfigStore.set("host", "127.0.0.1");
    testConfigStore.set("aclFile", aclFile);
    testConfigStore.set("logFile", "");

    const logger = new LoggerImpl({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    server = new ProxyServer({
      context: createConfigContext({ store: testConfigStore, configDir: dir }),
      logger,
      noColor: true,
      isWorker: true,
    });
    await server.start();

    const lines = warn.mock.calls.filter((c) => String(c[0]).startsWith(`[${LogEvent.AclInert}]`));
    expect(lines).toHaveLength(0);
  });

  it("源码级：`onWarning` 是**白名单**（两条），刻意不整体转发", () => {
    // 锁的是「只接白名单、不整体转发」这条裁决。**已变异验证**：给 handler 加一档
    // `else { this.logger.warn(w.message); }` 立刻红本条。
    //
    // ⚠️ 为什么这条只能源码级：`config-normalized` / `start-failed` 要经
    // `prepareRuntimeConfigStore` 的拆项覆盖告警或启动抛错才触发，那两条路径的触发条件
    // 属于配置归一那一面（改动它要连带改这里的断言）。而这条纪律的**全部内容**就是
    // 「handler 长什么样」，文本面才是它的直接对象。
    const code = codeOf("server", "index.ts");
    const at = code.indexOf("onWarning: (w) =>");
    expect(at, "server/index.ts 里的 onWarning handler 必须在").toBeGreaterThanOrEqual(0);
    const body = blockAfter(code, "onWarning: (w) =>");

    // ① 白名单里的两条都真的接了
    expect(body).toContain('w.code === "quota-inert"');
    expect(body).toContain('w.code === "acl-inert"');
    // ② **不许有兜底分支**：整体转发就长成「else 支把 w.message 原样 warn 出去」
    expect(body, "onWarning 不许整体转发").not.toMatch(/\belse\s*\{/);
    expect(body).not.toMatch(/this\.logger\.warn\(\s*w\./);
  });
});

// ---------------------------------------------------------------------------
// 5. 测试脚手架：`withProxy` 的 `access` 缺省档是**生产那一份**，不是放行桩
// ---------------------------------------------------------------------------

describe("测试脚手架：withProxy 的 access 缺省不是放行桩", () => {
  it("经 withProxy 起了代理、**没有**显式注入 access → 名单照样生效（403）", async () => {
    // 锁的是 `tests/helpers/proxy.ts` 的那条裁决：`opts.access ?? createFileAccessControl(ctx.config)`。
    //
    // **为什么这条必须存在**：`ProxyOptions.access` 现在是编译期必填，core 侧零缺省解析；
    // 而 `withProxy` 收的是 `Partial<ProxyOptions>`，若脚手架不管，TypeScript 不会逼每个
    // 调用点表态。届时「补救」最自然的形态就是补一个**恒放行桩**——那等于把本仓吃过两次的
    // 「配了名单、请求照过、测试全绿」从 core 搬到脚手架。本条把「脚手架的缺省档是真判定」
    // 变成可观测事实：忘了注入 → 按配置真的拒，而不是静默放行。
    const aclFile = freshAcl({ clientIp: { blacklist: ["127.0.0.1"] } });
    const port = await getFreePort();
    const prev = testConfigStore.get("aclFile");
    testConfigStore.set("aclFile", aclFile);
    try {
      await withProxy(
        HttpProxy,
        { ctx: runtimeContext() },
        async (proxyPort) => {
          const res = await absoluteGet(proxyPort, `127.0.0.1:${port}`);
          expect(res.status, "withProxy 的缺省 access 必须真的按 acl.json 拒").toBe(403);
        },
      );
    } finally {
      testConfigStore.set("aclFile", prev);
    }
  });

  it("源码级：withProxy 的缺省是 createFileAccessControl，**不是** openAccessControl", () => {
    // 上一条是行为面（强），这条是文本面（钉住「哪一份」）：万一有人把实现换成放行桩却
    // 恰好让上一条仍绿（例如把黑名单目标换成测试自己写的桩），本条会点名是谁。
    //
    // ⚠️ 读的是 `tests/helpers/proxy.ts` 本身（`source-scan.ts:sourceOf` 只认 `src/` 下的
    // 路径，那不是它能覆盖的目录）。
    const raw = fs.readFileSync(path.join(__dirname, "..", "helpers", "proxy.ts"), "utf8");
    expect(raw).toMatch(/access:\s*opts\.access\s*\?\?\s*createFileAccessControl\(ctx\.config\)/);
    expect(codeOnly(raw), "脚手架里不许出现放行桩").not.toContain("openAccessControl");
  });
});
