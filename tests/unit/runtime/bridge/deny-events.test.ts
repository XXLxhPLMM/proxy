/**
 * `runtime/bridge.ts`：**名单拒绝事件**那一半 —— `auth.decided` 的 `tag` 放 data 不放 context、
 * 身份维度（client/target/user）进 context 供跨事件串联、`ip-denied`/`target-denied` 桥成两条
 * 拒绝事件、**缺失即跳过 / 表外 `reason` 原样透传**这一对方向相反的纪律、`target-unresolved` 不桥接。
 * 载荷与 context 的逐字形状在 `deny-events`，core 直发的诊断与过程事实在 `forward-events`，
 * 边界与隔离/清理在 `lifecycle`；主题级不变量在 `./AGENTS.md`。
 */
import { describe, expect, it } from "vitest";
import { BaseProxy } from "@/core/server/base.js";
import type {
  IdentityContext,
  IdentityProvider,
  IdentityResult,
  PipeEvent,
  ProxyAuthEvent,
  ProxyOptions,
} from "@/core/types/proxy.js";
import { CoreEventBridge } from "@/runtime/bridge.js";
import { openAccessControl } from "../../../helpers/access.js";
import { PROTOCOL, contextFor, newHub, recordAll } from "./_core-event-bridge.js";

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
    // 那一对（`createFileAccessControl` 逐字未变），但 bridge 这一侧**不收窄** reason——见下一条。
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
    // 载荷里没有 reason 就没有「为什么被拒」这条事实，倒填一个等于编造一条安全审计记录。
    // 只有「缺失 / 空串」才跳过；「表外值」是原样透传（见下面那条）。
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
    // 被否掉的是「reason 不在 {whitelist, blacklist} 闭合集内就整条不发布」。那在
    // 「配置即身份真相源」的世界里成立；访问控制一旦变成可注入端口，替换实现可能是限速 /
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