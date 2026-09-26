/**
 * **访问控制端口的接缝护栏**（`AccessControl` 可注入化的四条性质）
 *
 * @description
 * `AccessControl` 与 `IdentityProvider` 是两个可插值端口，`checkClient` /
 * `checkTarget` / `checkRoute` 从三个**每请求导出函数**收成**一个注入对象**。收口之后
 * 判据本身一条没改（`acl.test.ts` 与 `user-acl-merge.test.ts` 逐字迁到了新结构上），
 * 变的是**接线**。而接线是最容易悄悄坏掉、又最难在行为面看出来的东西，所以本档专锁它：
 *
 * 1. **注入的替身真的被调用**（不是「原样透传到 options」就当生效了 —— 那只证明赋值发生）
 * 2. `createFileAccessControl` 三个方法的行为真值表
 * 3. **`access` 必填、core 侧零缺省解析**（core **没有**「`access` 缺省 = 放行档」这种东西：
 *    缺席 = 取消防护，必须编译期拦住，护栏是「声明行不带 `?`」+「`base.ts` 零
 *    `OPEN_ACCESS_CONTROL`」两条源码级断言——后者是「不许它回来」的负向守卫）
 * 4. **源码级**：`createFileAccessControl(` 与三个判定方法的**无接收者调用**在 `core/` 里
 *    **恰好 0 个** —— 「core 一律走端口」这条不变量
 *    （⚠️ 这条断言**曾经恒真**：旧版锚在 `checkClientIp` / `checkTargetHost` /
 *    `checkUpstreamRoute` 三个**已删除**的导出名上，而它们在 `src/**` 的全部命中都在注释里，
 *    `codeOnly` 逐条剥掉之后「零调用」恒成立。教训与自检清单见 `tests/AGENTS.md`
 *    「负向源码断言里点名一个已删除的符号」）
 * 5. **自定义 reason 能表达**：替身返回表外 reason 时 `access.target-denied` 照常发布
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileAccessControl } from "@/core/access-control.js";
import type { AppConfig, ConfigKey } from "@/config/index.js";
import { EventHub } from "@/core/events/index.js";
import type { EventEnvelope } from "@/core/events/index.js";
import { HttpProxy } from "@/core/server/http.js";
import { resolveRoute } from "@/core/helpers/index.js";
import { noneIdentity } from "@/core/identity.js";
import type {
  AccessClientInput,
  AccessControl,
  AccessDecision,
  AccessRouteDecision,
  AccessRouteInput,
  AccessTargetInput,
} from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { getFreePort } from "../helpers/net.js";
import { restoreConfig, set, silenceLogs, snapshotConfig, testConfig, testLogger } from "../helpers/config.js";
import { openAccessControl } from "../helpers/access.js";
import { codeOnly, codeOf, offendingLines, sourceOf } from "../helpers/source-scan.js";

const KEYS = ["aclFile", "authUsersFile", "proxyMode", "logLevel", "logFile"] as const;
const HOST = "target.test";

/**
 * 会**记账**的访问控制替身：三个方法各自计数并逐条记录入参。
 * @description 计数是必需的：只断言「`runtime.services.access` 是我给的那个对象」证明的
 * 仅仅是赋值发生 —— 一份没人调用的替身照样通过。真正要锁的是「**转发路径真的问过它**」。
 */
function countingAccess(
  answers: {
    client?: AccessDecision;
    target?: AccessDecision;
    route?: AccessRouteDecision;
  } = {},
): AccessControl & {
  calls: { client: AccessClientInput[]; target: AccessTargetInput[]; route: AccessRouteInput[] };
} {
  const calls = { client: [], target: [], route: [] } as {
    client: AccessClientInput[];
    target: AccessTargetInput[];
    route: AccessRouteInput[];
  };
  return {
    calls,
    checkClient: (input) => {
      calls.client.push(input);
      return answers.client ?? { allowed: true };
    },
    checkTarget: (input) => {
      calls.target.push(input);
      return answers.target ?? { allowed: true };
    },
    checkRoute: (input) => {
      calls.route.push(input);
      return answers.route ?? { direct: false };
    },
  };
}

const activeRuntimes: ProxyRuntime[] = [];

afterEach(async () => {
  for (const r of activeRuntimes.splice(0)) {
    await r.stop().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// 1. 注入的替身真的被调用（行为级：走一次真请求）
// ---------------------------------------------------------------------------

describe("注入的 AccessControl 替身真的被转发路径调用", () => {
  it("经 createProxyRuntime 注入 → 三个方法在一次真请求里各被调用", async () => {
    // client 模式（`checkRoute` 只在 client 模式被问，server 模式零开销短路）+
    // 一个**通配上游**占位（checkRoute 说 direct 时根本不会用到它）。
    // 目标打一个死端口：请求最终 502 没关系 —— 本条只关心三个判定都被问过。
    const port = await getFreePort();
    const deadTarget = await getFreePort();
    const access = countingAccess();
    const runtime = createProxyRuntime({
      config: {
        host: "127.0.0.1",
        port,
        authEnabled: false,
        proxyMode: "client",
        upstreamHost: "127.0.0.1",
        upstreamPort: deadTarget,
        upstreamTimeout: 300,
      },
      services: { access },
    });
    activeRuntimes.push(runtime);

    // 对象同一性：替身原样透传到 runtime 的服务视图与 core 的归一化选项
    expect(runtime.services.access).toBe(access);
    expect(runtime.options.access).toBe(access);

    await runtime.start();
    await absoluteGet(port, `127.0.0.1:${deadTarget}`).catch(() => undefined);

    // ① 入站对端准入：每条连接一次
    expect(access.calls.client.length).toBeGreaterThan(0);
    expect(access.calls.client[0].client).toBe("127.0.0.1");
    // ② 出站目标准入：拨号前一次，入参带客户端请求的目标主机
    // （**只有 host、没有端口**：`parseTargetParts` 解析时已把端口剥开，名单条目也不带端口）
    expect(access.calls.target.length).toBeGreaterThan(0);
    expect(access.calls.target[0].host).toBe("127.0.0.1");
    // ③ 路由判定：client 模式问一次，入参只有 host（不带 user —— 路由与身份正交）
    expect(access.calls.route.length).toBeGreaterThan(0);
    expect(access.calls.route[0].host).toBe("127.0.0.1");
    // 路由判定入参刻意**没有** user 维度（个人名单绝不参与路由，见 user-acl-merge 护栏 4）
    expect(access.calls.route[0]).not.toHaveProperty("user");
  });

  it("替身判否时请求真的被拒（计数不够，还要看结论被采信）", async () => {
    const port = await getFreePort();
    const target = await getFreePort();
    const access = countingAccess({ target: { allowed: false, reason: "rate-limited", source: "engine" } });
    const runtime = createProxyRuntime({
      config: { host: "127.0.0.1", port, authEnabled: false, proxyMode: "server" },
      services: { access },
    });
    activeRuntimes.push(runtime);

    await runtime.start();
    const status = await absoluteGet(port, `127.0.0.1:${target}`).catch(() => 0);

    expect(access.calls.target.length).toBeGreaterThan(0);
    // 名单拒绝 → 403（`guardPreDial` 的 deny(STATUS_FORBIDDEN)）
    expect(status).toBe(403);
  });

  it("替身说直连时真的直连（checkRoute 的结论被采信，不只是被调用）", async () => {
    // 两个都「放行」的实现无法区分「checkRoute 被问了」与「被问了且结论被采信」：
    // 这一档让 checkRoute 说直连，并让 checkTarget 也说拒 —— 若路由结论没被采信，
    // 仍会走上游（并因 checkTarget 的拒而 403）。故两条同时断言才闭合。
    const origin = http.createServer((_req, res) => {
      res.writeHead(200, { "content-length": "2" });
      res.end("ok");
    });
    const originPort = await getFreePort();
    await new Promise<void>((resolve) => origin.listen(originPort, "127.0.0.1", resolve));
    const deadUpstream = await getFreePort();
    const port = await getFreePort();

    try {
      const access = countingAccess({ route: { direct: true } });
      const runtime = createProxyRuntime({
        config: {
          host: "127.0.0.1",
          port,
          authEnabled: false,
          proxyMode: "client",
          upstreamHost: "127.0.0.1",
          upstreamPort: deadUpstream,
          upstreamTimeout: 300,
        },
        services: { access },
      });
      activeRuntimes.push(runtime);
      await runtime.start();

      // checkRoute 说直连 → 真目标被拨（而不是那个死上游）
      const status = await absoluteGet(port, `127.0.0.1:${originPort}`).catch(() => 0);

      expect(access.calls.route.length).toBeGreaterThan(0);
      expect(status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. createFileAccessControl 的行为真值表
// ---------------------------------------------------------------------------

describe("createFileAccessControl：三个方法的行为真值表", () => {
  let dir: string;
  let snap: Record<string, unknown>;
  let access: AccessControl;

  beforeEach(() => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-port-"));
    access = createFileAccessControl(testConfig);
  });

  afterEach(() => {
    restoreConfig(snap);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 写 acl.json 并让 store 指向它；每例独立文件名，绕开 readJsonCached 的节流缓存复用 */
  function useAcl(name: string, acl: unknown): void {
    const p = path.join(dir, `${name}.json`);
    fs.writeFileSync(p, JSON.stringify(acl));
    set("aclFile", p);
  }

  it("checkClient：黑名单优先 / 白名单非空即默认拒 / 皆空放行 / unknown 遇白名单 fail-closed", () => {
    useAcl("a", { clientIp: { whitelist: ["1.2.3.4"], blacklist: ["1.2.3.4"] } });
    expect(access.checkClient({ client: "1.2.3.4" })).toEqual({
      allowed: false,
      reason: "blacklist",
    });

    useAcl("b", { clientIp: { whitelist: ["10.0.0.0/8"] } });
    expect(access.checkClient({ client: "10.1.2.3" })).toEqual({ allowed: true });
    expect(access.checkClient({ client: "9.9.9.9" })).toEqual({
      allowed: false,
      reason: "whitelist",
    });

    useAcl("c", {});
    expect(access.checkClient({ client: "8.8.8.8" })).toEqual({ allowed: true });
    expect(access.checkClient({ client: "unknown" })).toEqual({ allowed: true });

    useAcl("d", { clientIp: { whitelist: ["10.0.0.0/8"] } });
    expect(access.checkClient({ client: "unknown" })).toEqual({
      allowed: false,
      reason: "whitelist",
    });
  });

  it("checkTarget：两层合流（全局短路 + 个人层），放行档不写 source", () => {
    useAcl("t1", { target: { blacklist: ["*.evil.com"] } });
    expect(access.checkTarget({ host: "x.evil.com" })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "global",
    });
    expect(access.checkTarget({ host: "good.com" })).toEqual({ allowed: true });
    // 放行档**不写** reason/source（「哪一层放的」对放行没有意义）
    expect(Object.keys(access.checkTarget({ host: "good.com" })).sort()).toEqual(["allowed"]);

    useAcl("t2", { target: { whitelist: [HOST] } });
    expect(access.checkTarget({ host: HOST, user: "nobody" })).toEqual({ allowed: true });
  });

  it("checkRoute：动作与前两组相反（黑名单命中 → 直连），皆空 → 走上游", () => {
    useAcl("r1", {});
    expect(access.checkRoute({ host: "a.com" })).toEqual({ direct: false });

    useAcl("r2", { upstream: { whitelist: ["*.a.com"], blacklist: ["secret.a.com"] } });
    expect(access.checkRoute({ host: "secret.a.com" })).toEqual({
      direct: true,
      reason: "blacklist",
    });
    expect(access.checkRoute({ host: "sub.a.com" })).toEqual({ direct: false });
    expect(access.checkRoute({ host: "other.com" })).toEqual({
      direct: true,
      reason: "whitelist",
    });
  });

  it("三个方法都是**同步**的（端口的硬裁决：不许变成 async）", () => {
    // `checkRoute` 被四条入站通道在拨号前调用，其返回值要立刻喂进「选连接器 / 拒绝应答 /
    // 发 route 事件」这一整串**同步**控制流。改成 async 会级联重排整条转发链。
    // 断言写法刻意是「返回值不是 thenable」而不是「函数不是 async」——后者会被
    // 「async 函数但内部同步返回」骗过，前者不会。
    useAcl("s", {});
    for (const r of [
      access.checkClient({ client: "1.2.3.4" }),
      access.checkTarget({ host: HOST }),
      access.checkRoute({ host: HOST }),
    ]) {
      expect(r).not.toBeInstanceOf(Promise);
      expect(typeof (r as { then?: unknown }).then).toBe("undefined");
    }
  });

  it("工厂闭包捕获 config：换一份 accessor 就换一份判定（不串名单）", () => {
    useAcl("iso", { target: { blacklist: [HOST] } });
    expect(access.checkTarget({ host: HOST })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "global",
    });

    // 另一份 accessor 指向不存在的名单文件 → 恒放行
    const other = createFileAccessControl({
      get: <K extends ConfigKey>(key: K): AppConfig[K] =>
        (key === "aclFile" ? path.join(dir, "absent.json") : testConfig.get(key)) as AppConfig[K],
    });
    expect(other.checkTarget({ host: HOST })).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// 3. `access` **没有**缺省档（编译期强制）——这里锁的是「这个事实不许被悄悄改回去」
// ---------------------------------------------------------------------------

describe("ProxyOptions.access 必填：core 侧零缺省解析（access 没有 inert 档）", () => {
  /** 直构 core 并显式注入一份放行档 → 取归一后的那份（core 零二次解析，应原样同一对象） */
  function normalizedAccess(injected: AccessControl = openAccessControl()): AccessControl {
    const proxy = new HttpProxy({
      ctx: {
        config: testConfig,
        logger: testLogger,
        events: new EventHub({ onListenerError: () => undefined }),
      },
      host: "127.0.0.1",
      port: 0,
      access: injected,
    });
    return proxy.options.access;
  }

  it("显式注入的 access 原样落进 options（core 侧零 `??` 二次解析）", () => {
    // ⚠️ **core 侧没有「不注入 → 恒放行」的缺省档**：那个档让「忘注入」变成「配了名单却全放行、
    // 且零信号」，必须由编译期拦住，故 `ProxyOptions.access` 没有 `?`。
    // 本条锁的是剩下那一半不变式：**注入什么就用什么**（不许 core 悄悄换一份）。
    const access = countingAccess();
    expect(normalizedAccess(access)).toBe(access);
  });

  it("注入一份放行档 → 三方法恒放行、checkRoute 恒 { direct: false }（显式写出来的那个答案）", () => {
    const access = normalizedAccess();

    // `checkRoute` 恒 `{ direct: false }`（走上游）——**注意这不是「放行」**：它说的是
    // 「client 模式别回落直连」。不判名单，所以它不给出任何回落理由（无 reason）。
    expect(access.checkClient({ client: "203.0.113.9" })).toEqual({ allowed: true });
    expect(access.checkClient({ client: "unknown" })).toEqual({ allowed: true });
    expect(access.checkTarget({ host: HOST })).toEqual({ allowed: true });
    expect(access.checkTarget({ host: HOST, user: "anyone" })).toEqual({ allowed: true });
    expect(access.checkRoute({ host: HOST })).toEqual({ direct: false });
  });

  it("两个缺省档的语义各不相同：identity 缺省=不判人，traffic 缺省=不计量（access 没有缺省档）", () => {
    // 另两个端口的缺席读作**关闭一项功能**，所以各有一个语义明确的 inert 档；`access` 的缺席
    // 读作的是**取消防护**（全放行），方向相反，所以走「编译期必填」而不是「缺省档」那套。
    // 把三者混成同一个「关闭」正是本条要防的误读。
    const proxy = new HttpProxy({
      ctx: { config: testConfig, logger: testLogger, events: new EventHub({ onListenerError: () => undefined }) },
      host: "127.0.0.1",
      port: 0,
      access: openAccessControl(),
    });

    expect(proxy.options.identity.isEnabled).toBe(false);
    // 不计量：显式禁用档的 consume 恒 allow 且不累计（usage 恒零）
    expect(proxy.options.traffic.consume("nobody", "up", 1024).allow).toBe(true);
    expect(proxy.options.traffic.usage("nobody")).toEqual({ up: 0, down: 0 });
  });

  it("直构 core 时 identity 仍是同一个缺省档单例（access 侧已无此形态）", () => {
    // 顺带钉住 identity 侧的同构：直构 core 的默认身份是恒放行、恒不剥凭证的 inert 档。
    const a = new HttpProxy({
      ctx: { config: testConfig, logger: testLogger, events: new EventHub({ onListenerError: () => undefined }) },
      host: "127.0.0.1",
      port: 0,
      access: openAccessControl(),
    });
    const b = new HttpProxy({
      ctx: { config: testConfig, logger: testLogger, events: new EventHub({ onListenerError: () => undefined }) },
      host: "127.0.0.1",
      port: 0,
      access: openAccessControl(),
    });

    // `toBe` 而不是 `toEqual`：后者对「每次新建一个行为相同的新对象」照样通过，锁不住共享
    expect(a.options.identity).toBe(b.options.identity);
    expect(Object.isFrozen(a.options.identity)).toBe(true);
    expect(a.options.identity.isEnabled).toBe(false);
    expect(a.options.identity.kind).toBe("none");
    expect(noneIdentity().isEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3b. 源码级：`access` 不许被偷偷加回 `?`、缺省档不许复活
// ---------------------------------------------------------------------------

describe("源码级：`access` 的必填性与缺省档删除（防复活）", () => {
  it("ProxyOptions 的 `access` 声明行不带 `?`（编译期护栏的机器可读形态）", () => {
    // 这条是「`access` 必填」这个**事实**的源码级形态。类型面本身由 `pnpm typecheck`
    // 兜着（少一个 `?` 就有 20+ 处构造点立刻红），但「有人把 `?` 加回去、顺手把 20+ 处
    // 补成显式放行」是一次**能通过全部检查**的改动——只有本条会红。
    const code = codeOnly(sourceOf(path.join("core", "types", "proxy.ts")));
    const decl = code.split("\n").filter((l) => /^\s*access\s*:/.test(l));
    expect(decl, "types/proxy.ts 必须恰好一处 `access:` 顶层声明").toHaveLength(1);
    expect(decl[0]).toMatch(/^\s*access\s*:\s*AccessControl\s*;/);
    expect(decl[0], "`access` 不许带 `?`（缺席 = 取消防护，必须编译期强制）").not.toContain("?");
  });

  it("`src/core/server/base.ts` 零 `OPEN_ACCESS_CONTROL`（那个缺省档已整体删除）", () => {
    // ⚠️ **锚在符号名上会不会是恒真的空断言？** 不会：那个符号**今天还存在于本文件**，
    // 我们正要删它；一旦它被复活，本条立刻红。而「core 的 `access` 缺省解析」这件事
    // 删掉之后在运行期已无任何形态可测（编译器先拦住了），所以源码级是唯一有牙齿的判据。
    const raw = sourceOf(path.join("core", "server", "base.ts"));
    expect(codeOnly(raw), "缺省放行档（及任何提到它的注释）不许出现在 base.ts").not.toContain(
      "OPEN_ACCESS_CONTROL",
    );
    // 归一表达式也不许把 access 重新接回 `??`
    expect(codeOnly(raw)).toMatch(/access\s*:\s*options\.access\s*,/);
    expect(codeOnly(raw), "`access` 不许再有缺省解析").not.toMatch(/access\s*:\s*options\.access\s*\?\?/);
  });

  it("`createProxyRuntime` 路径恒解析出 access（故 `access` 必填不影响它）", () => {
    // 正向证据（防上面两条变成「把功能删了也算过」）：唯一组装根仍然解析默认实现。
    const code = codeOf("runtime", "services.ts");
    expect(code).toMatch(/overrides\.access\s*\?\?\s*createFileAccessControl\(/);
  });
});

// ---------------------------------------------------------------------------
// 4. 源码级：core 一律走端口
// ---------------------------------------------------------------------------

describe("源码级：core 一律经 AccessControl 端口判定（锚在今天仍存在的形状上）", () => {
  /** 递归列出 `src/core/**` 下所有 .ts */
  function coreSourceFiles(): string[] {
    const srcRoot = path.join(__dirname, "..", "..", "src", "core");
    return fs
      .readdirSync(srcRoot, { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".ts"))
      .map((f) => path.join("core", f));
  }

  /** 判定层自己（唯一持有实现的地方；它内部的 `function checkClient(` 是**定义**不是调用） */
  const JUDGEMENT_FILE = path.join("core", "access-control.ts");

  /**
   * 端口**类型**的声明处，与判定层同构地合法。
   *
   * @description 三个判定名在 `core/types/proxy.ts` 里出现，是因为那里声明 `AccessControl`
   * 这个**端口本身**的方法签名（`checkClient(input: AccessClientInput): AccessDecision;`）——
   * 那是接口声明，不是调用。**它与 `access-control.ts` 是同一组「合法的家」**：
   * 端口的类型声明处 + 端口的唯一内置实现处。`core/**` 里第三处出现这三个名字才是绕过端口。
   *
   * 逐条写明而不是「过滤掉就算了」——本仓既有纪律（`inbound-dispatch` 的第 ⑨ 条同款）。
   * 若哪天端口类型搬出 `types/proxy.ts`，本档会红，届时把这一条改成新位置或删掉。
   */
  const PORT_TYPE_FILE = path.join("core", "types", "proxy.ts");

  it("判定层工厂与三个判定：core/ 里零自造、零绕过端口的直调", () => {
    // ⚠️ **本条断言在本仓曾经恒真过**，必须先知道为什么（`tests/AGENTS.md` 的通用教训那一节）：
    // 旧版锚在 `checkClientIp` / `checkTargetHost` / `checkUpstreamRoute` 三个**已删除**的导出名上，
    // 而这三个名字在 `src/**` 的**全部命中都在注释里**（实测 13 处，逐条核过：11 处 JSDoc 的
    // `*` 行 + 1 处 `//` 行 + 1 处 `src/index.ts` 模块说明），`codeOnly` 把注释剥成空格之后
    // 「零调用」恒成立 —— 它看起来在保护「core 一律走端口」，实际已经不存在它要防的东西。
    // **这是本仓最危险的一类假绿。** 现在的锚点是**今天仍存在的形状**：
    // 判定层工厂 `createFileAccessControl` + 三个判定方法名。
    //
    // 变异测试记录（临时改 → 必须红 → 还原）：把 `checkTarget` 重新 `export` 并在
    // `helpers/predial.ts` 里改成无接收者直调 → 本条**红**（②号判据命中那一行），
    // 且同档的「import 出口白名单」那条**同时红**。两次变异后 `git status --porcelain src/`
    // 与开工基线逐字一致（sha256 亦已核对）。

    // ── 防假绿的正向面：先证明锚点真的存在，否则下面两条「零命中」没有指称对象 ──
    // （没有这一段，锚点哪天被改名/搬走，本条会安静地继续绿 —— 那正是它上一版的死法）
    const judgement = codeOnly(sourceOf("core", "access-control.ts"));
    expect(
      judgement,
      "锚点失效：判定层不再导出唯一出口 createFileAccessControl（core/ 的零调用断言随即失去指称对象）",
    ).toContain("export function createFileAccessControl(");
    for (const name of ["checkClient", "checkTarget", "checkRoute"] as const) {
      expect(judgement, `锚点失效：判定层不再有模块私有的 ${name} 实现`).toMatch(
        new RegExp(`function ${name}\\(`),
      );
    }

    const files = coreSourceFiles();
    expect(files.length).toBeGreaterThan(20);

    for (const rel of files) {
      if (rel === JUDGEMENT_FILE || rel === PORT_TYPE_FILE) {
        continue;
      }
      const code = codeOnly(sourceOf(...rel.split(path.sep)));

      // ① core 内部**不得自己造一份判定**：工厂的唯一合法调用点是唯一组装根
      //    `runtime/services.ts:buildDefaultServices`。core 里再造一份 = 「同一部署两套名单判定」。
      expect(
        offendingLines(code, /\bcreateFileAccessControl\s*\(/),
        `${rel} 不得自己造 AccessControl 判定：唯一组装根在 runtime/services.ts:buildDefaultServices`,
      ).toEqual([]);

      // ② core 内部**不得绕过端口直调判定函数**。
      //    判据刻意用**否定前置断言** `(?<!\.)` 而不是裸名字：`access.checkTarget({…})` 是
      //    **合法**的端口消费形态（`helpers/predial.ts` / `server/admission.ts` /
      //    `helpers/route.ts` 各一处），裸名字会把它们一起判红；而 `checkTarget({…})` 这种
      //    **无接收者**的调用，在 core 内部只可能来自「把这个判定从 access-control.ts 直接
      //    import 出来用」—— 那正是端口被绕过的形态（注入的替身只管一部分请求路径）。
      //    跨行也安全：`access\n  .checkTarget(` 的第二行仍以 `.` 开头，前置断言照样成立。
      //    （唯一被排除的合法出现是 `PORT_TYPE_FILE` 里的端口接口声明，理由见该常量注释。）
      for (const name of ["checkClient", "checkTarget", "checkRoute"] as const) {
        expect(
          offendingLines(code, new RegExp(`(?<!\\.)\\b${name}\\s*\\(`)),
          `${rel} 出现了无接收者的 ${name}(…) 调用：core 必须经 AccessControl 端口判定，`
            + "绕过端口等于「注入的替身只管一部分请求路径」",
        ).toEqual([]);
      }
    }
  });

  it("全 src/ 里 `createFileAccessControl(` 恰好两处：定义 + 唯一组装根（core/ 之外的版本）", () => {
    // 上一条的 ① 只覆盖 `core/**`。这条把它扩到**全 `src/**`**，抓的是另一种回流：
    // 有人在 `server/` 或 `runtime/` 里**第二个**组装点造一份判定（症状是「配了 acl.json 却
    // 名单时灵时不灵」——两份判定各读各的编译缓存）。合法命中恰好两条，位置写死：
    // 定义在 `core/access-control.ts`、唯一调用点在 `runtime/services.ts:buildDefaultServices`。
    //
    // 注意 `src/index.ts` 的 re-export **不算命中**：它是 `createFileAccessControl,`
    // （无调用括号），这正是判据要带 `(` 的原因 —— 只判名字会把合法的再导出一起判红。
    const srcRoot = path.join(__dirname, "..", "..", "src");
    const files = fs
      .readdirSync(srcRoot, { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".ts"));
    const hits: string[] = [];

    for (const rel of files) {
      const code = codeOnly(sourceOf(...rel.split(path.sep)));
      // 标签统一成 posix 分隔符：断言文本要跨平台可读（Windows 上 path.join 给的是 `\`）
      const label = rel.split(path.sep).join("/");
      for (const line of offendingLines(code, /\bcreateFileAccessControl\s*\(/)) {
        hits.push(`${label}: ${line}`);
      }
    }

    // 防假绿：真的扫到了，且两条都在预期位置
    expect(hits).toHaveLength(2);
    expect(hits.some((h) => h.startsWith("core/access-control.ts:"))).toBe(true);
    expect(
      hits.some((h) => h.startsWith("runtime/services.ts:")),
      `唯一调用点必须在 runtime/services.ts:buildDefaultServices，实际命中：\n${hits.join("\n")}`,
    ).toBe(true);
  });

  it("全 src/ 里 import 自 `@/core/access-control.js` 的**只有**端口与观察面两个出口", () => {
    // 判定面收成端口之后，从任何地方 import 这个模块的合法理由只剩两类：
    // ① 拿 `createFileAccessControl`（唯一组装根 `runtime/services.ts:buildDefaultServices`）；
    // ② 拿 `bindAclFileEvents`（订阅注册的唯一入口，同在 runtime 里）。
    // 任何第三个名字（尤其是裸判定函数）出现即红。
    //
    // 扫描范围是 `src/**` 而不是 `core/**` —— 因为按设计**core 内部零调用点**
    // （`admission.ts` / `forward/base.ts` 只经 `CoreServices` 拿端口，注释里提到
    // 「不再 import …/access-control.js」是散文不是 import）。这也正是它与上一条的分工：
    // 上一条钉「core 一律走端口」，本条钉「全仓只有那两个出口能 import 实现」。
    const srcRoot = path.join(__dirname, "..", "..", "src");
    const files = fs
      .readdirSync(srcRoot, { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".ts"));
    const names: string[] = [];

    for (const rel of files) {
      const code = codeOnly(sourceOf(...rel.split(path.sep)));
      for (const m of code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@\/core\/access-control\.js"/g)) {
        for (const n of (m[2] ?? "").split(",")) {
          const name = n.trim();
          if (name) {
            names.push(`${rel}: ${name}`);
          }
        }
      }
    }

    // 防假绿：真的扫到了东西，且那两个出口各自都在
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => n.endsWith(": createFileAccessControl"))).toBe(true);
    for (const entry of names) {
      expect(
        /: (createFileAccessControl|bindAclFileEvents)$/.test(entry),
        `${entry} 不是合法的访问控制出口：判定面只许经 AccessControl 端口`
          + "（createFileAccessControl），观察面只许经 bindAclFileEvents",
      ).toBe(true);
    }
  });

  it("判定面真的只有一个出口 `createFileAccessControl`（三个判定都是模块私有）", () => {
    const code = codeOnly(sourceOf("core", "access-control.ts"));

    expect(code).toContain("export function createFileAccessControl(");
    // 三个判定不带 export（藏进 class / 深层闭包会让「个人名单不越界」那组源码断言失去锚点）
    expect(code).toMatch(/function checkClient\(/);
    expect(code).toMatch(/function checkTarget\(/);
    expect(code).toMatch(/function checkRoute\(/);
    expect(code).not.toMatch(/export\s+function\s+checkClient/);
    expect(code).not.toMatch(/export\s+function\s+checkTarget/);
    expect(code).not.toMatch(/export\s+function\s+checkRoute/);
    // 工厂返回的是对象字面量（不是 class 实例）—— 保持三个判定体在模块级，锚点可切
    expect(code).toMatch(/return\s*\{\s*checkClient:\s*\(input\)/);
  });

  it("helpers 层对访问控制只 type-only（运行期零依赖边，工具层不压在策略层上面）", () => {
    // `route.ts` 与 `predial.ts` 是「helpers/ 不得反向依赖策略层」这条纪律的两个落点。
    // 它们要的是**端口类型**（`AccessControl` / `AccessRouteDecision`），不是实现。
    //
    // 断言用 `codeOnly`（去注释）而不是原文：`route.ts` 的文件头**故意**点名了
    // 「别在这里运行期 import `@/core/access-control.js`」——那是解释「为什么现在只剩
    // type-only」的历史记录，正是这类注释存在的理由。拿原文断言会让它变成「不许记录
    // 自己改过什么」，而正确动作恰恰相反。
    for (const f of ["route.ts", "predial.ts"] as const) {
      const code = codeOnly(sourceOf("core", "helpers", f));
      expect(code, `${f} 不得 import access-control 的实现`).not.toContain(
        "@/core/access-control.js",
      );
      expect(code, `${f} 必须 type-only 引端口类型`).toMatch(
        /import\s+type\s+\{[^}]*AccessControl/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. 自定义 reason 能表达（端口放宽的下游后果）
// ---------------------------------------------------------------------------

describe("自定义 reason 能一路走到公共事件面（不被静默丢掉）", () => {
  it("替身返回表外 reason `rate-limited` → access.target-denied 照常发布且逐字到达", async () => {
    const hub = new EventHub({ runtimeId: "runtime-access-port", onListenerError: () => undefined });
    const events: EventEnvelope<"access.target-denied">[] = [];
    hub.subscribe("access.target-denied", (e) => {
      events.push(e);
    });
    const access = countingAccess({ target: { allowed: false, reason: "rate-limited" } });
    const port = await getFreePort();
    const target = await getFreePort();

    const runtime = createProxyRuntime({
      config: { host: "127.0.0.1", port, authEnabled: false, proxyMode: "server" },
      events: hub,
      services: { access },
    });
    activeRuntimes.push(runtime);
    await runtime.start();

    const status = await absoluteGet(port, `127.0.0.1:${target}`).catch(() => 0);

    expect(status).toBe(403);
    expect(events).toHaveLength(1);
    // 逐字到达：既没被改写成名单语义，也没被静默丢事件
    expect(events[0].name).toBe("access.target-denied");
    expect(events[0].data.reason).toBe("rate-limited");
  });

  it("替身返回自定义 source 时也原样透传，但**绝不倒填成 global**", async () => {
    const hub = new EventHub({ runtimeId: "runtime-access-port-2", onListenerError: () => undefined });
    const events: EventEnvelope<"access.target-denied">[] = [];
    hub.subscribe("access.target-denied", (e) => {
      events.push(e);
    });
    // 有 source 但值不在内置引擎那对 {global,user} 里
    const access = countingAccess({
      target: { allowed: false, reason: "geo-blocked", source: "geoip" },
    });
    const port = await getFreePort();
    const target = await getFreePort();

    const runtime = createProxyRuntime({
      config: { host: "127.0.0.1", port, authEnabled: false, proxyMode: "server" },
      events: hub,
      services: { access },
    });
    activeRuntimes.push(runtime);
    await runtime.start();
    await absoluteGet(port, `127.0.0.1:${target}`).catch(() => undefined);

    expect(events).toHaveLength(1);
    const data = events[0].data;
    expect(data.reason).toBe("geo-blocked");
    expect(data.source).toBe("geoip");
    expect(data.source).not.toBe("global");
  });

  it("端口三条判定的 reason/source 类型是自由 string（替换实现能描述自己的结论）", () => {
    // 编译期断言：闭合集会让限速 / 地域封锁 / 订阅网关这些实现只能 `as never` 强转。
    // 代价（消费方不能再假设取值）由 `runtime/bridge.ts:passthroughReason` 与上面两条承担。
    const decision: AccessDecision = { allowed: false, reason: "rate-limited", source: "engine" };
    const route: AccessRouteDecision = { direct: true, reason: "geo-blocked" };

    expect(decision.reason).toBe("rate-limited");
    expect(route.reason).toBe("geo-blocked");
  });

  it("resolveRoute 把替身的 custom reason 带到回落直连上（emitRoute 依赖它才有 reason）", () => {
    // `forward/base:emitRoute` 的跳过条件是 `mode === "server" && !reason`；client 模式
    // 命中路由名单回落时那个 reason **必带**。这里证明表外 reason 同样带得动 ——
    // 若这里被收窄成「只认名单两个值」，自定义引擎的路由回落会凭空多发/少发 route 事件。
    const access = countingAccess({ route: { direct: true, reason: "rate-limited" } });
    const decision = resolveRoute({ host: HOST, port: 443 }, { access, mode: "client" });

    expect(decision).toEqual({ mode: "server", route: "direct", reason: "rate-limited" });
  });

  it("server 模式零开销短路：checkRoute 一次都不被问（替身记 0）", () => {
    // 短路不只是「省一次判定」：它保证 server 模式下「上游那组名单配错了也不会被读到」。
    const access = countingAccess();
    const decision = resolveRoute({ host: HOST, port: 443 }, { access, mode: "server" });

    expect(decision).toEqual({ mode: "server", route: "direct" });
    expect(decision).not.toHaveProperty("reason");
    expect(access.calls.route).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 经本地代理发一次 absolute-form GET，返回状态码（网络错误返回 0） */
function absoluteGet(
  proxyPort: number,
  authority: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://${authority}/`,
        headers: { ...headers, Connection: "close" },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}
