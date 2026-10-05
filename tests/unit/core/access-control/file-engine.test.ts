/**
 * `createFileAccessControl` 内置引擎：三个方法的行为真值表 + **自定义 reason / source 走得通**
 *
 * 这一族锁的是「判定层自己的答案」：表里每个 `toEqual` 都是逐字断言（含**键的集合**，
 * 放行恒只有 `["allowed"]`），以及端口放宽成自由 `string` 之后下游会不会静默丢掉新取值。
 * 端口的六条硬裁决、源码级判据口径与防假绿自检归 `./AGENTS.md`。
 *
 * @module tests/unit/core/access-control/file-engine
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileAccessControl } from "@/core/access-control.js";
import { EventHub } from "@/core/events/index.js";
import type { EventEnvelope } from "@/core/events/index.js";
import { resolveRoute } from "@/core/helpers/index.js";
import type { AccessControl, AccessDecision, AccessRouteDecision } from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { AppConfig, ConfigKey } from "@/config/index.js";
import { getFreePort } from "../../../helpers/net.js";
import { restoreConfig, set, silenceLogs, snapshotConfig, testConfig } from "../../../helpers/config.js";
import { HOST, absoluteGet, activeRuntimes, countingAccess } from "./_access-control-port.js";

const KEYS = ["aclFile", "authUsersFile", "proxyMode", "logLevel", "logFile"] as const;

/**
 * 账本目录**必须逐处显式钉**：`createProxyRuntime` 的内联 config 不经 `loadConfig`，
 * 于是 `setup-env.ts` 那两个钉值（`process.env.QUOTA_USAGE_DIR` 与 `set(...)`）两侧全落空，
 * 而 `quotaUsageDir` 的 FIELDS 缺省是相对路径 `cfg/usage`、按 `configDir`（缺省 = `cwd`
 * = 仓库根）绝对化 —— 加上用量数据源的 `open()` 在 `start()` 里就跑（与是否真计量无关），
 * 一条字节都没传的用例照样会在仓库里留下账本。基准形状见 `tests/setup-env.ts`。
 */
const LEDGER_DIR = path.join(os.tmpdir(), "proxy-test-access-engine-ledger");

afterEach(async () => {
  for (const r of activeRuntimes.splice(0)) {
    await r.stop().catch(() => undefined);
  }
});

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
      config: {
        host: "127.0.0.1",
        port,
        authEnabled: false,
        proxyMode: "server",
        quotaUsageDir: LEDGER_DIR,
      },
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
      config: {
        host: "127.0.0.1",
        port,
        authEnabled: false,
        proxyMode: "server",
        quotaUsageDir: LEDGER_DIR,
      },
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