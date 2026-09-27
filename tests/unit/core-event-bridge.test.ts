import http from "node:http";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseProxy } from "@/core/server/base.js";
import { HttpProxy } from "@/core/server/http.js";
import { EventHub } from "@/core/events/index.js";
import type { EventContext, EventEnvelope, EventName } from "@/core/events/index.js";
import type { CoreContext } from "@/core/context.js";
import { createConfigContext, ConfigStore } from "@/config/index.js";
import { ProxyServer } from "@/server/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import type {
  IdentityContext,
  IdentityProvider,
  IdentityResult,
  PipeEvent,
  ProxyAuthEvent,
  ProxyOptions,
} from "@/core/types/proxy.js";
import { CoreEventBridge } from "@/runtime/bridge.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { testConfig, testLogger } from "../helpers/config.js";
import { getFreePort } from "../helpers/net.js";
import { withProxy } from "../helpers/proxy.js";
import { openAccessControl } from "../helpers/access.js";

/**
 * core 把请求期事实**直接发布**到注入的 `EventHub`，不经自带 EventEmitter 中转。
 * 本文件因此分成两类断言：
 * - 「core 直发」：`auth.decided` / `request.started` 由 `BaseProxy.authorize` 与
 *   `HttpProxy.handleForward` 直接发布，走真实代理或真实 `authorize()` 驱动；
 * - 「bridge 仍桥接」：`pipe` 的三条映射、缺失即跳过、观察者隔离、终态接线与 dispose。
 *
 * 6 个 core 直发事实
 * （`forward.error`/`server.error`/`server.client-error`/`server.listening`/`server.closed`/`pipe`）
 * 全部纳入「公共事件面全集」，用于「不该发的没发」的反向断言。
 *
 * ## 四条事件面的归属与分层决策（本档锁的是这四条）
 *
 * **① `auth.decided` 的 `tag` 放 data、不放 context。** 被否掉的是「放 context」：`tag` 是「本次判定
 * 独有的事实」，不是跨事件复用的关联维度；放进 context 会让**每个**事件的 context 都背上它。
 * 锁点：「core 直发 auth.decided：payload 与 context（client/target/user/tag）齐全」那两条
 * **逐字 `toEqual`** ——`data` 恰是 `{ passed, user, attempted, reason, tag }`、`context` 恰是
 * `{ runtimeId, protocol, client, user, target, requestId, connectionId }`。任何一侧挪动
 * `tag`（或给 data/context 增删一个键）都同时红两档，故这条是**真断言**而不是「至少 tag 在
 * 某一处」。身份维度（client / target / user）进 context 是另一半：订阅方要靠它跨事件串联同一
 * 个请求，而 `data` 里只留一个 `passed` 什么也串不起来。
 *
 * **② `request.started` 走 core 直发、不经 bridge，且它是公共事件面上唯一的非终态请求级事件。**
 * 被否掉的是「started 也走 bridge」与「不发」。终态三件套是**结果**、`started` 是**过程**；
 * 缺过程的结果不可诊断：`auth.decided` 要开了鉴权才有、`route.selected` 要 client 模式才有，
 * 所以在**server 模式直连 + 关闭鉴权**这个最常见部署下，一次请求只剩终态，慢上游/长连接无法
 * 判断卡在哪一步。锁点：本档「core 直发 request.started：唯一的非终态请求级事件，
 * requestId 可与终态串联」那条（payload 只留通道类型 `kind`，身份维度全走 context），以及
 * `tests/integration/request-scope-ids.test.ts` 的
 * `expect(events.map((e) => e.name)).toEqual(["request.started", "request.completed"])`
 * —— 那一条正面证明「在这个部署下中间确实没有别的锚点」，所以「唯一」不是自称。
 *
 * **③ 关联 id 由 pipe 载荷派生、core 自己写进 `EventContext`；缺失即不带，桥接器不臆造。**
 * 被否掉的是「让 core 造一个通用事件包装器」——那是**第三个事件槽**与第二条发布路径。
 * 锁点：「pipe 未带 requestId 时不臆造：仍发映射事件，但 context 不含该维度」——
 * `expect(events[0].context.requestId).toBeUndefined()` 且
 * `expect(events[0].context.connectionId).toBeUndefined()`。**桥接器可以臆造的唯一后果是
 * 「把不同请求串成同一个」**，那是比字段缺失更坏的事：宁可让订阅者知道「未知」。
 *
 * **④ 入站头的展示掩码与出站头剥离是两套方向相反的判据，不许「顺手统一」；且掩码必须在 publish
 * 之前完成。** 被否掉的是「把入站掩码放进 `helpers/headers.ts`（出站判定那一套）」。出站那套
 * 全部导出都是**出站**判定（`proxy-` 前缀无条件剥、其余每个头名 × 值问身份插件），而入站展示
 * 掩码是**入站**判定：同一个 `Authorization: Bearer` **出站要保留、日志里必须掩码**。混在一处
 * 迟早被统一掉而放大泄漏面。归属判据是「core 事实 → 可展示形态」而非「日志文本拼装」，故它
 * 就近住在 `core/server/http.ts`、不进公共导出面。
 *   锁点（本档「core 直发 forward.request-headers：敏感头已掩码，事件里看不到任何原值」那条）：
 *   - `expect(serialized).not.toContain(basic)` / `not.toContain("target-token-xyz")` /
 *     `not.toContain(cookie)` —— **整份载荷**里不得出现任何一段原值（含未被列入敏感表的头的值），
 *     而不只是「敏感表里那几个」。**「掩码在 publish 之前完成」是这条的前提**：事件总线对库调用方
 *     可见（不是 CLI 私有通道），原始值一旦跨过去就是凭证泄漏。
 *   - 键仍在（就地掩码，不是删键）：`expect(proxyAuth).toBeDefined()` 且
 *     `expect(proxyAuth).not.toContain(basic)`。
 *   - **掩码不得误伤**：`expect(headerOf(data.headers, "x-trace")).toBe("trace-1")`。
 *   - 断言只锁「值不再是原值」而**不锁掩码串的形状**：将来文案改成 `***redacted***` 不该让本护栏变红。
 *   - 出站那一侧的判据在 `tests/unit/identity-credential-seam.test.ts`（头注释第 ② 条：协议规则与
 *     凭证规则分开、顺序不可换），两档合起来才是「两套方向相反的判据」这句话的全部含义。
 *   - ⚠️ `core/log-events.ts` 是 `[event-code]` **文本**层（编一个假的 `LogEvent` 码会改掉
 *     `[http] headers` 的 msg 文本），`@/utils/logger/sanitize.ts` 才是**渲染**层（值 → 文本）
 *     ——判据是「谁拥有事件词汇」。
 *
 * **⑤ 桥接**缺失即跳过、绝不臆造**；但**表外 `reason` 原样透传**（这两半是一对，方向相反）。**
 * - `reason` **缺失 / 空串 → 整条不发布**。载荷里没有 `reason` 就没有「为什么被拒」这条事实，
 *   倒填一个（哪怕默认成 `blacklist`）等于**编造一条安全审计记录**。
 *   牙齿（本档「reason 缺失/空串时跳过发布：拒绝事实宁缺毋造」那条）：
 *   `expect(events).toEqual([])` ——五条样本（缺 `reason` / 空串 `reason` / `target-denied` 缺 `reason` /
 *   空串 / `target-denied` **缺 `host`**）**一条都不许发**。同档还把「`host` 缺失有正当的跳过理由」
 *   （公共契约必填，缺了没法复述这次拒绝）钉在一起。
 * - `source` **缺失不倒填 `global`** ——会把「个人名单拒的」伪装成「全局拒的」，运维去改错文件。
 *   牙齿（本档「ip-denied / target-denied 桥成…」那条）：
 *   `expect(events[0].data).toEqual({ client: "10.0.0.9", reason: "blacklist" })`
 *   ——`toEqual` 是**逐键**比较，倒填一个 `source: "global"` 当场红。
 * - `reason` **表外值（如 `rate-limited`）必须原样透传发布**，不得落到跳过那一个 `return`。
 *   访问控制变成可注入端口后，替换实现可能判出 `"rate-limited"` / `"geo-blocked"` 这类自由字符串；
 *   整条不发布等于「每一次这样的拒绝都不会在事件面上留痕迹」——**静默丢事件比字段缺失更坏**。
 *   牙齿（本档「表外 reason 原样透传发布」那条）：
 *   `expect(events[0].data).toEqual({ client: "10.0.0.9", reason: "rate-limited" })` 与
 *   `expect(events[1].data).toEqual({ host: "api.example", target: "api.example:443", reason: "geo-blocked", source: "geoip" })`。
 * - `pipe: target-unresolved` **刻意不桥接** — 它的事实已由协议入口的
 *   `requestTerminal.reject(..., "parse", 400)` 发布过一次，bridge 再桥一遍会在同一请求上造出
 *   第二条重复拒绝。牙齿（本档「target-unresolved 不经 bridge 桥接」那条）：
 *   `expect(events).toHaveLength(0)`。
 *   **新增任何 pipe 变体前先确认它没有已由终态 publisher 发布过**（变体清单是契约，见
 *   `tests/unit/pipe-event.test.ts`）。
 *
 * **⑥ 桥接器**只认 pipe 载荷、完全重建 context**（忽略 core 已写进 context 的身份维度）。**
 * 同一维度两个来源会让订阅方无法判断「哪个是权威」。牙齿（本档「ip-denied / target-denied 桥成…」那条）：
 * `expect(events[0].context).toEqual({ runtimeId: "runtime-bridge", protocol: "http", client: "10.0.0.9" })`
 * 与 `expect(events[1].context).toEqual({ runtimeId: "runtime-bridge", protocol: "http", target: "blocked.example:443", user: "alice" })`
 * ——**逐字相等**：`protocol` 恒取桥接器构造期的那个（不是载荷里 `protocol: "socks5"` 那个），
 * 多带任何一个 core 写进 context 的维度都红。身份提取 DI 只在**已映射变体发布前**且事件自带字段
 * 缺失时发生，不在桥接这一层。
 */

const PROTOCOL = "http";

/** 本文件里 bridge 仍会发布的公共事件（core 直发的那几类不在其中）。 */
const BRIDGED: readonly EventName[] = [
  "access.client-denied",
  "access.target-denied",
  "route.selected",
  "request.rejected",
];

/** `AppEventMap` 全集：用于断言「core 事实没有溢出成本波边界」。 */
const ALL_EVENT_NAMES: readonly EventName[] = [
  "runtime.starting",
  "runtime.started",
  "runtime.stopping",
  "runtime.stopped",
  "runtime.error",
  "runtime.dependencies-changed",
  "lifecycle.changed",
  "config.loaded",
  "config.changed",
  "config.restart-required",
  "config.file-error",
  "config.file-recovered",
  "config.file-reloaded",
  "auth.decided",
  "access.client-denied",
  "access.target-denied",
  "route.selected",
  "request.started",
  "request.completed",
  "request.rejected",
  "request.failed",
  "forward.error",
  "server.error",
  "server.client-error",
  "server.listening",
  "server.closed",
  "pipe",
];

/** 拆成「core 直发的事实」：它们进公共面，但不会被任何桥接映射再翻译一次。 */
const CORE_FACTS: ReadonlySet<EventName> = new Set<EventName>([
  "forward.error",
  "server.error",
  "server.client-error",
  "server.listening",
  "server.closed",
]);

interface Recorded {
  name: EventName;
  data: unknown;
  context: EventContext;
}

function recordAll(hub: EventHub, names: readonly EventName[] = BRIDGED): Recorded[] {
  const events: Recorded[] = [];
  for (const name of names) {
    hub.subscribe(name, (event) => {
      events.push({ name: event.name, data: event.data, context: event.context });
    });
  }
  return events;
}

function fakeReq(init: {
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
  method?: string;
  remoteAddress?: string;
}): http.IncomingMessage {
  const req = {
    headers: init.headers ?? {},
    url: init.url,
    method: init.method,
    socket: { remoteAddress: init.remoteAddress },
  };
  return req as unknown as http.IncomingMessage;
}

/** 依赖上下文：配置/日志用测试共享实例（setup-env 已钉死名单与账号路径），总线每例独立。 */
function contextFor(hub: EventHub): CoreContext {
  return Object.freeze({ config: testConfig, logger: testLogger, events: hub });
}

function newHub(): EventHub {
  return new EventHub({ runtimeId: "runtime-bridge", onListenerError: () => undefined });
}

/** 最小 BaseProxy：只为驱动真实的 `authorize()`（core 直发 `auth.decided` 的唯一入口）。 */
class AuthEmittingProxy extends BaseProxy {
  constructor(options: ProxyOptions) {
    super(PROTOCOL, options);
  }

  /** 暴露 protected `authorize` 供断言驱动 */
  async tryAuthorize(ctx: IdentityContext): Promise<IdentityResult> {
    return (this as unknown as { authorize(ctx: IdentityContext): Promise<IdentityResult> }).authorize(
      ctx,
    );
  }

  protected async doStart(): Promise<void> {}

  protected async doStop(): Promise<void> {}
}

/**
 * 审计事件替身：按给定序列触发 `onAuthEvent`（内置身份插件的真实行为形状）。
 * `isOwnCredential` 是**必填**端口成员（没有默认实现、也不许返回 undefined）——
 * 「自定义身份插件漏实现出站凭证判据」必须在编译期红，而不是运行期默默把凭证转发出去。
 */
function auditingIdentity(events: readonly ProxyAuthEvent[], result: IdentityResult): IdentityProvider {
  return {
    kind: "stub",
    isEnabled: true,
    isOwnCredential: () => false,
    identify: async (ctx: IdentityContext): Promise<IdentityResult> => {
      for (const event of events) {
        ctx.onAuthEvent?.(event);
      }
      return result;
    },
  };
}

function identityContext(scope?: {
  requestId?: string;
  connectionId?: string;
}): IdentityContext {
  return {
    protocol: PROTOCOL,
    req: { headers: {} },
    socket: {} as IdentityContext["socket"],
    authority: "example.com:443",
    ...scope,
  };
}

const authAllow: ProxyAuthEvent = {
  passed: true,
  tag: "tunnel",
  client: "1.2.3.4",
  target: "example.com:443",
  user: "alice",
};

const authDeny: ProxyAuthEvent = {
  passed: false,
  tag: "tunnel",
  client: "1.2.3.4",
  target: "example.com:443",
  attempted: "bob",
  reason: "no-token",
};

const activeRuntimes: ProxyRuntime[] = [];

afterEach(async () => {
  const runtimes = activeRuntimes.splice(0);
  for (const runtime of runtimes) {
    await runtime.stop().catch(() => undefined);
  }
});

describe("core 直发 auth.decided（BaseProxy.authorize）", () => {
  it("core 直发 auth.decided：payload 与 context（client/target/user/tag）齐全", () => {
    // 保护：库用户订阅 auth.decided 能拿到「谁、从哪、访问哪、判过没有」四项事实，
    // 且身份维度进 context（供跨事件的请求串联），不是只在 data 里留一个 passed。
    const hub = newHub();
    const events = recordAll(hub, ["auth.decided"]);
    const proxy = new AuthEmittingProxy({
      ctx: contextFor(hub),
      identity: auditingIdentity([authAllow, authDeny], { passed: false }),
      // 只验鉴权事件的载荷/身份维度，与名单无关 → 显式点名「不判名单」
      access: openAccessControl(),
    });

    void proxy.tryAuthorize(identityContext({ requestId: "req-1", connectionId: "conn-1" }));

    expect(events).toHaveLength(2);
    expect(events[0].name).toBe("auth.decided");
    expect(events[0].data).toEqual({
      passed: true,
      user: "alice",
      attempted: undefined,
      reason: undefined,
      tag: "tunnel",
    });
    expect(events[0].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      client: "1.2.3.4",
      user: "alice",
      target: "example.com:443",
      requestId: "req-1",
      connectionId: "conn-1",
    });

    // 拒绝分支：attempted/reason 必带，未通过的请求 context 不该凭空出现 user
    expect(events[1].data).toEqual({
      passed: false,
      user: undefined,
      attempted: "bob",
      reason: "no-token",
      tag: "tunnel",
    });
    expect(events[1].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      client: "1.2.3.4",
      target: "example.com:443",
      requestId: "req-1",
      connectionId: "conn-1",
    });
  });
});

describe("runtime/bridge 名单拒绝事件", () => {
  it("ip-denied / target-denied 桥成 access.client-denied / access.target-denied", () => {
    // 保护：ACL 拒绝是安全事实，必须原样可见。内置引擎出的 reason 仍是 whitelist/blacklist
    // 那一对（`createFileAccessControl` 逐字未变），但 bridge 这一侧**不再收窄**——见下一条。
    const hub = newHub();
    const events = recordAll(hub);
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));

    hub.publish(
      "pipe",
      {
        type: "ip-denied",
        client: "10.0.0.9",
        reason: "blacklist",
        protocol: "socks5",
      } satisfies PipeEvent,
      { protocol: PROTOCOL },
    );
    hub.publish(
      "pipe",
      {
        type: "target-denied",
        host: "blocked.example",
        target: "blocked.example:443",
        reason: "whitelist",
        user: "alice",
      } satisfies PipeEvent,
      { protocol: PROTOCOL },
    );

    expect(events.map((event) => event.name)).toEqual([
      "access.client-denied",
      "access.target-denied",
    ]);
    expect(events[0].data).toEqual({ client: "10.0.0.9", reason: "blacklist" });
    expect(events[0].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      client: "10.0.0.9",
    });
    expect(events[1].data).toEqual({
      host: "blocked.example",
      target: "blocked.example:443",
      reason: "whitelist",
    });
    expect(events[1].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      target: "blocked.example:443",
      user: "alice",
    });
  });

  it("reason 缺失/空串时跳过发布：拒绝事实宁缺毋造（这半条纪律没被动过）", () => {
    // 保护：缺失 reason 时**不允许**默认成 blacklist——那会把「未知原因」伪装成确定的名单命中。
    // 4B2 把「表外值也跳过」那一半改成了原样透传，但**「缺失即跳过」这一半刻意保留**：
    // 载荷里没有 reason 就没有「为什么被拒」这条事实，倒填一个等于编造一条安全审计记录。
    const hub = newHub();
    const events = recordAll(hub);
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));

    hub.publish("pipe", { type: "ip-denied", client: "10.0.0.9" } satisfies PipeEvent);
    hub.publish("pipe", { type: "ip-denied", client: "10.0.0.9", reason: "" } satisfies PipeEvent);
    hub.publish("pipe", { type: "target-denied", target: "a.example:443" } satisfies PipeEvent);
    hub.publish(
      "pipe",
      {
        type: "target-denied",
        target: "a.example:443",
        reason: "",
      } satisfies PipeEvent,
    );
    // `target-denied` 的 `host` 缺失同样跳过（公共契约必填项，缺了没法复述这次拒绝）
    hub.publish(
      "pipe",
      { type: "target-denied", target: "a.example:443", reason: "blacklist" } satisfies PipeEvent,
    );

    expect(events).toEqual([]);
  });

  it("表外 reason（如 rate-limited）原样透传发布：访问控制端口放开后安全事实不许消失", () => {
    // 4B2 之前这里是**相反**的断言：reason 不在 {whitelist, blacklist} 闭合集内就整条不发布。
    // 那在「配置即身份真相源」的世界里成立；访问控制一旦变成可注入端口，替换实现可能是限速 /
    // 地域封锁 / 订阅网关——它们判出的 reason 是 "rate-limited" 这类自由字符串，而
    // AccessDecision.reason 已经是 string，于是**每一次这样的拒绝都不会在事件面上留痕迹**。
    // 静默丢事件比字段缺失更坏：字段缺失至少还有一条已发布事件可查，整条不发布连「发生过
    // 拒绝」都没了，且没有任何报错提示。锚点见 src/runtime/bridge.ts:passthroughReason。
    const hub = newHub();
    const events = recordAll(hub);
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));

    hub.publish(
      "pipe",
      { type: "ip-denied", client: "10.0.0.9", reason: "rate-limited" } satisfies PipeEvent,
      { protocol: PROTOCOL },
    );
    hub.publish(
      "pipe",
      {
        type: "target-denied",
        host: "api.example",
        target: "api.example:443",
        reason: "geo-blocked",
        source: "geoip",
      } satisfies PipeEvent,
      { protocol: PROTOCOL },
    );

    // 逐字到达：既不改写成名单语义，也不丢字段
    expect(events.map((event) => event.name)).toEqual([
      "access.client-denied",
      "access.target-denied",
    ]);
    expect(events[0].data).toEqual({ client: "10.0.0.9", reason: "rate-limited" });
    expect(events[1].data).toEqual({
      host: "api.example",
      target: "api.example:443",
      reason: "geo-blocked",
      // `source` 同样原样透传（不再只认 {global, user}）
      source: "geoip",
    });
  });
});

describe("runtime/bridge 路由与解析失败事件", () => {
  it("route 桥成 route.selected，保留 mode/route/reason", () => {
    // 保护：路由判定是「走直连还是走上游」的权威事实，必须与 core 的 route 事件 1:1 可见。
    const hub = newHub();
    const events = recordAll(hub);
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));

    hub.publish(
      "pipe",
      {
        type: "route",
        target: "example.com:80",
        mode: "client",
        route: "direct",
        reason: "blacklist",
      } satisfies PipeEvent,
    );
    hub.publish(
      "pipe",
      { type: "route", target: "example.com:80", mode: "client", route: "upstream" } satisfies
        PipeEvent,
    );

    expect(events.map((event) => event.name)).toEqual(["route.selected", "route.selected"]);
    expect(events[0].data).toEqual({ mode: "client", route: "direct", reason: "blacklist" });
    expect(events[0].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      target: "example.com:80",
    });
    expect(events[1].data).toEqual({ mode: "client", route: "upstream", reason: undefined });
  });

  it("target-unresolved 不经 bridge 桥接（请求终态只由 RequestTerminal 发一次）", () => {
    // 保护：协议入口（core/forward/channel/http.ts）在发这条 pipe 事件前已经
    // requestTerminal.reject(..., "parse", 400)，终态 publisher 会发布那唯一的一条
    // request.rejected。bridge 再桥一遍只会在同一请求上造出第二条重复拒绝。
    const hub = newHub();
    const events = recordAll(hub);
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));

    hub.publish("pipe", { type: "target-unresolved", url: "/no-host" } satisfies PipeEvent);

    expect(events).toHaveLength(0);
  });
});

describe("core 直发 forward.request-headers（诊断细节事实）", () => {
  /** 绝对形式 GET 走一次真实代理，可带任意请求头（目标为死端口，失败不影响事件存在性） */
  function absoluteGet(
    port: number,
    authority: string,
    headers: Record<string, string>,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: `http://${authority}/x`, headers },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.setTimeout(8000, () => req.destroy(new Error("timeout")));
      req.end();
    });
  }

  /** Node 会把入站头名小写化；这里仍按大小写不敏感取值，避免测试依赖 Node 的归一化细节 */
  function headerOf(headers: Record<string, string>, name: string): string | undefined {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name) {
        return value;
      }
    }
    return undefined;
  }

  it("core 直发 forward.request-headers：敏感头已掩码，事件里看不到任何原值", async () => {
    // 保护：这条 `[{kind}] headers` debug 行的数据源。掩码**必须在 core 侧 publish 之前**完成——
    // 事件总线对库调用方可见（不是 CLI 私有通道），原始 Proxy-Authorization / Authorization /
    // Cookie 一旦跨进去就是凭证泄漏。这里断言「看不到原值」而不是掩码串的形状：
    // 掩码文案将来改成 ***redacted*** 之类不该让本护栏变红，但**值不再是原值**必须变红。
    const hub = newHub();
    const captured: EventEnvelope<"forward.request-headers">[] = [];
    hub.subscribe("forward.request-headers", (event) => {
      captured.push(event);
    });
    const ctx = contextFor(hub);
    const deadPort = await getFreePort();
    const basic = Buffer.from("alice:s3cret").toString("base64");
    const cookie = "session=abc123";

    await withProxy(HttpProxy, { ctx }, async (port) => {
      await absoluteGet(port, `127.0.0.1:${deadPort}`, {
        "Proxy-Authorization": `Basic ${basic}`,
        Authorization: "Bearer target-token-xyz",
        Cookie: cookie,
        "X-Trace": "trace-1",
      });
    });

    expect(captured).toHaveLength(1);
    const { data, context } = captured[0];
    expect(data.kind).toBe("http");
    // 身份维度走 context（与 request.started 同源），不在 data 里
    expect(context.client).toBe("127.0.0.1");
    expect(context.user).toBeUndefined();

    // 敏感头：键仍在（就地掩码，不是删键），但值已经不是原值
    const proxyAuth = headerOf(data.headers, "proxy-authorization");
    const authorization = headerOf(data.headers, "authorization");
    const maskedCookie = headerOf(data.headers, "cookie");
    expect(proxyAuth).toBeDefined();
    expect(authorization).toBeDefined();
    expect(maskedCookie).toBeDefined();
    expect(proxyAuth).not.toContain(basic);
    expect(proxyAuth).not.toContain("alice");
    expect(authorization).not.toContain("target-token-xyz");
    expect(maskedCookie).not.toContain(cookie);

    // 整份载荷里不得出现任何一段原值（含未被列入敏感表的头的值）
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(basic);
    expect(serialized).not.toContain("target-token-xyz");
    expect(serialized).not.toContain(cookie);

    // 非敏感头原样保留：掩码不得误伤
    expect(headerOf(data.headers, "x-trace")).toBe("trace-1");
    expect(String(headerOf(data.headers, "host"))).toContain("127.0.0.1");
  });

  it("forward.request-headers 有订阅者：CLI 日志面会落 [{kind}] headers 行（防再次静默删除）", async () => {
    // 保护：这条事件一旦「只发不订阅」，`[{kind}] headers` debug 行就静默消失且无任何测试报警。
    // 故在此锁死「ProxyServer 启动后该事件必须有订阅者」——这正是 `log-structured` 落盘断言的
    // 结构化对应物（那边锁文本/等级/字段，这边锁订阅关系本身）。
    const events = new EventHub({ onListenerError: () => undefined });
    const port = await getFreePort();
    // 独立 store：不碰共享 testConfigStore 的 port，避免影响本文件其它用例
    const store = new ConfigStore({ host: "127.0.0.1", port, logLevel: "silent", logFile: "" });
    const server = new ProxyServer({
      context: createConfigContext({ store, configDir: os.tmpdir() }),
      events,
      logger: new LoggerImpl({ level: "silent" }),
      isWorker: true,
    });

    expect(events.listenerCount("forward.request-headers")).toBe(0);
    await server.start();
    try {
      expect(events.listenerCount("forward.request-headers")).toBe(1);
    } finally {
      await server.stop().catch(() => undefined);
    }
    // stop() 之后订阅必须随本轮观察面一起退订（且退订打在当初那条总线上）
    expect(events.listenerCount("forward.request-headers")).toBe(0);
  });
});

describe("core 直发 request.started（HttpProxy.handleForward）", () => {
  /** 绝对形式 GET 走一次真实代理（目标为死端口，失败不影响 request.started 的存在性） */
  function absoluteGet(port: number, authority: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: `http://${authority}/x` },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.setTimeout(8000, () => req.destroy(new Error("timeout")));
      req.end();
    });
  }

  it("core 直发 request.started：唯一的非终态请求级事件，requestId 可与终态串联", async () => {
    // 保护：server 模式直连（无 route.selected）下的公共事件面原本只剩终态，长连接/慢上游无法判断
    // 卡在哪一步。request.started 补上「过程」锚点——终态三件套是结果，started 是过程。
    // 身份维度（client/target/user/method）一律走 context：payload 只留通道类型 `kind`。
    const hub = newHub();
    const started: EventEnvelope<"request.started">[] = [];
    hub.subscribe("request.started", (event) => {
      started.push(event);
    });
    const ctx = contextFor(hub);
    const deadPort = await getFreePort();
    const identity: IdentityProvider = {
      kind: "stub",
      isEnabled: true,
      isOwnCredential: () => false,
      identify: async () => ({ passed: true, username: "alice" }),
    };

    let proxyPort = 0;
    await withProxy(HttpProxy, { ctx, identity }, async (port) => {
      proxyPort = port;
      await absoluteGet(port, `127.0.0.1:${deadPort}`);
    });

    expect(started).toHaveLength(1);
    // payload 只带通道类型；身份维度一律走 context，不塞进 data
    expect(started[0].data).toEqual({ kind: "http" });
    expect(started[0].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      client: "127.0.0.1",
      user: "alice",
      // target 与终态同源：非 CONNECT 只认 Host 头，absolute-form 下即客户端写来的代理自身 authority
      target: `127.0.0.1:${proxyPort}`,
      method: "GET",
      requestId: started[0].context.requestId,
      connectionId: started[0].context.connectionId,
    });
    // 与终态串联的前提：两个 id 必须真的存在
    expect(started[0].context.requestId).toBeTruthy();
    expect(started[0].context.connectionId).toBeTruthy();
  });

  it("pipe 未带 requestId 时不臆造：仍发映射事件，但 context 不含该维度", () => {
    // 保护：core 直构（无 handleForward 入口注入）时 id 就是没有。缺失即不带，桥接器不生成假 id。
    const hub = newHub();
    const events = recordAll(hub);
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));

    hub.publish(
      "pipe",
      { type: "route", target: "example.com:80", mode: "client", route: "upstream" } satisfies
        PipeEvent,
    );

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("route.selected");
    expect(events[0].data).toEqual({ mode: "client", route: "upstream", reason: undefined });
    expect(events[0].context.requestId).toBeUndefined();
    expect(events[0].context.connectionId).toBeUndefined();
  });

  it("req 携带身份时按注入的提取器补 client/target（DI 覆盖默认提取）", () => {
    // 保护：route/守卫类变体只带 target，client 要能从 req 兜底提取；提取器可注入，
    // 库用户不必接受 utils/ip 的默认提取策略。
    const hub = newHub();
    const events = recordAll(hub);
    const extractClient = vi.fn(() => "203.0.113.7");
    const extractTarget = vi.fn(() => "injected.example:8443");
    new CoreEventBridge({ hub, protocol: PROTOCOL, extractClient, extractTarget }).attach(
      contextFor(hub),
    );

    const req = fakeReq({ headers: { host: "example.com" }, method: "GET", url: "/x" });
    hub.publish(
      "pipe",
      {
        type: "target-denied",
        host: "example.com",
        reason: "blacklist",
        req,
      } satisfies PipeEvent,
    );

    expect(extractClient).toHaveBeenCalledWith(req);
    expect(extractTarget).toHaveBeenCalledWith(req);
    expect(events[0].name).toBe("access.target-denied");
    expect(events[0].context).toEqual({
      runtimeId: "runtime-bridge",
      protocol: "http",
      client: "203.0.113.7",
      target: "injected.example:8443",
    });
  });
});

describe("runtime/bridge 本波边界", () => {
  it("core 直发 forward.error / server.error / server.client-error，其余 pipe 变体一律不发公共事件", () => {
    // 保护：这三类低层错误事实由 core **直接**发布到公共面（它们本身不是请求级终态），
    // 但桥接器不得把它们再翻成 request.rejected/failed——那会造出第二条终态。
    // 错误类的请求级 rejected/failed 只由协议 guard 经终态 publisher 经 ErrorBoundary 发布。
    // `pipe` 的 10 个未映射变体则一条公共事件都不许有。
    const hub = newHub();
    // 刻意不订阅 `pipe` 本身：本用例断言的是「这 10 个变体在公共面上**一条派生事件都没有**」，
    // 它们自己是被发布的事实，不该混进「派生」计数里。
    const events = recordAll(hub, ALL_EVENT_NAMES.filter((name) => name !== "pipe"));
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));

    const forwardError = { kind: "http", error: new Error("boom") } as const;
    const serverError = { error: new Error("listen failed"), host: "127.0.0.1", port: 1080 };
    const clientError = { error: new Error("bad request") };

    hub.publish("forward.error", forwardError, { protocol: PROTOCOL });
    hub.publish("server.error", serverError, { protocol: PROTOCOL });
    hub.publish("server.client-error", clientError, { protocol: PROTOCOL });
    for (const event of [
      { type: "socks", message: "socks5 connect ok" },
      { type: "dial", target: "example.com:443" },
      { type: "established", target: "example.com:443" },
      { type: "upstream-error", target: "example.com:443", err: new Error("ECONNREFUSED") },
      { type: "upstream-timeout", target: "example.com:443" },
      { type: "upstream-refused", target: "example.com:443", statusLine: "HTTP/1.1 403" },
      { type: "loop-detected", target: "127.0.0.1:1080" },
      { type: "bad-request", message: "malformed" },
      { type: "client-error", err: new Error("reset") },
      { type: "debug", message: "trace" },
    ] satisfies PipeEvent[]) {
      hub.publish("pipe", event, { protocol: PROTOCOL });
    }

    // 三条 core 事实原样到达公共面（身份/载荷一字不加工）
    expect(events.map((event) => event.name)).toEqual([
      "forward.error",
      "server.error",
      "server.client-error",
    ]);
    expect(events[0].data).toEqual(forwardError);
    expect(events[1].data).toEqual(serverError);
    expect(events[2].data).toEqual(clientError);
    // 边界是「不派生」而不是「不观察」：这 10 个 pipe 变体与三类错误事实
    // 一条派生事件都不许有（尤其 request.rejected/failed —— 终态唯一来源是 RequestTerminal）
    expect(events.filter((event) => !CORE_FACTS.has(event.name))).toEqual([]);
  });
});

describe("runtime/bridge 隔离与清理", () => {
  it("公共事件观察者抛错不打断 core 事件回调，其它桥接事件照常发布", () => {
    // 保护：桥接是旁路。观察者异常绝不能顺着 core 的发布反向打断鉴权/转发主流程。
    const onListenerError = vi.fn();
    const hub = new EventHub({ runtimeId: "runtime-bridge", onListenerError });
    hub.subscribe("access.client-denied", () => {
      throw new Error("observer failed");
    });
    const routes: string[] = [];
    hub.subscribe("route.selected", (event) => {
      routes.push(event.data.route);
    });
    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));

    expect(() =>
      hub.publish(
        "pipe",
        { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
      ),
    ).not.toThrow();
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), "access.client-denied");
    expect(() =>
      hub.publish(
        "pipe",
        {
          type: "route",
          target: "example.com:80",
          mode: "client",
          route: "upstream",
        } satisfies PipeEvent,
      ),
    ).not.toThrow();
    expect(routes).toEqual(["upstream"]);
  });

  it("subscription.dispose() 幂等：解绑 pipe 订阅后不再发布，attach 也不再复活", () => {
    // 保护：runtime.stop() 之后既没有悬挂的 core 订阅，也没有「dispose 后又被 attach 挂回去」的漏洞。
    const hub = newHub();
    const events = recordAll(hub);
    const bridge = new CoreEventBridge({ hub, protocol: PROTOCOL });
    bridge.attach(contextFor(hub));

    expect(hub.listenerCount("pipe")).toBe(1);
    expect(bridge.subscription.disposed).toBe(false);

    hub.publish(
      "pipe",
      { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
    );
    expect(events).toHaveLength(1);

    bridge.subscription.dispose();
    expect(bridge.subscription.disposed).toBe(true);
    expect(hub.listenerCount("pipe")).toBe(0);

    hub.publish(
      "pipe",
      { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
    );
    expect(events).toHaveLength(1);

    expect(() => {
      bridge.attach(contextFor(hub));
      bridge.subscription.dispose();
    }).not.toThrow();
    expect(hub.listenerCount("pipe")).toBe(0);
    hub.publish(
      "pipe",
      { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
    );
    expect(events).toHaveLength(1);
  });

  it("attach 只多挂一个观察者：既有 listener 顺序与次数不变，publish 逐个送达", () => {
    // 保护：桥接只加观察者，不改事件投递语义（顺序、次数）——core 的发布行为与
    // 其它观察者是共同的契约，桥接不得插队或吞事件。
    const hub = newHub();
    const events = recordAll(hub);
    const order: string[] = [];
    hub.subscribe("pipe", () => {
      order.push("before-attach");
    });

    new CoreEventBridge({ hub, protocol: PROTOCOL }).attach(contextFor(hub));
    hub.subscribe("pipe", () => {
      order.push("after-attach");
    });

    hub.publish(
      "pipe",
      {
        type: "route",
        target: "example.com:80",
        mode: "client",
        route: "upstream",
      } satisfies PipeEvent,
    );
    expect(order).toEqual(["before-attach", "after-attach"]);
    // 桥接只**多挂一个**观察者：总线自己的 2 个 listener 一个不少、顺序不变
    expect(hub.listenerCount("pipe")).toBe(3);
    expect(events).toHaveLength(1);
  });
});

describe("runtime 桥接接线", () => {
  it("createProxyRuntime 桥接 pipe 事实；stop() 解绑但保留外部 EventHub", async () => {
    // 保护：库用户只通过 runtime.events 观察——桥接必须真的接线到 runtime，
    // 且 stop() 的解绑顺序是「先摘 core 订阅、后清 hub」，不留悬挂订阅。
    const events = new EventHub({ onListenerError: () => undefined });
    const seen: string[] = [];
    const port = await getFreePort();
    const runtime = createProxyRuntime({
      config: { host: "127.0.0.1", port },
      events,
    });
    activeRuntimes.push(runtime);

    const subscription = events.subscribe("access.client-denied", (event) => {
      seen.push(`${event.context.protocol ?? "?"}:${event.data.reason}`);
    });

    // bridge 只在 start 轮次建立，构造期不能提前观察 core 事实。
    expect(events.listenerCount("pipe")).toBe(0);
    await runtime.start();
    expect(events.listenerCount("pipe")).toBeGreaterThan(0);
    events.publish(
      "pipe",
      { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
      { protocol: PROTOCOL },
    );
    expect(seen).toEqual(["http:blacklist"]);

    await runtime.stop();

    // stop() 之后总线上不再有桥接订阅；外部 hub 归调用方，订阅不能被 runtime 清空。
    expect(events.listenerCount("pipe")).toBe(0);
    expect(subscription.disposed).toBe(false);
    expect(events.listenerCount()).toBe(1);

    const afterStop: string[] = [];
    const afterStopSubscription = events.subscribe("access.client-denied", (event) => {
      afterStop.push(event.data.reason);
    });
    events.publish(
      "pipe",
      { type: "ip-denied", client: "10.0.0.9", reason: "blacklist" } satisfies PipeEvent,
      { protocol: PROTOCOL },
    );
    expect(afterStop).toEqual([]);
    subscription.dispose();
    afterStopSubscription.dispose();
  });
});
