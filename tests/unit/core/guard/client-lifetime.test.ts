import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { guardDialing, socksUpstreamGuard, type HelperEvent } from "@/core/guard.js";

/**
 * `guardDialing` 的 `clientLifetime` 两种形态（生命周期是否联动）+ `socksUpstreamGuard` 第三参。
 *
 * 拨号守卫原本只有 `linked`（隧道两端同命）；http 请求路径引入 `independent` 后两种形态必须各自
 * 锁死，否则任何一边被「顺手统一」都会静默弄坏主路径。另锁「失败成因事件一个都不能少」
 * （解耦的是**存活联动**，不是可观测性）。⚠️ 本目录**只有这一档**故无 `AGENTS.md`：第三参那条
 * 决策的理由就地住在这里，档间共用的「端口级必填 vs 字段级可选项」见 `../AGENTS.md`。
 */

/** 让 destroy() 触发的 'close'（nextTick）跑完 */
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** 一对 Duplex 替身 + 事件收集器 */
function pair(): {
  client: PassThrough;
  upstream: PassThrough;
  events: HelperEvent[];
  collect: (e: HelperEvent) => void;
} {
  const events: HelperEvent[] = [];
  return {
    client: new PassThrough(),
    upstream: new PassThrough(),
    events,
    collect: (e) => events.push(e),
  };
}

describe("unit/guard clientLifetime=linked（缺省，隧道语义）", () => {
  it("上游关闭连带销毁客户端（既有语义，隧道两端同命）", async () => {
    const { client, upstream } = pair();
    guardDialing(client, upstream, { timeout: 0, keepClientOnFailure: true });

    upstream.destroy();
    await tick();

    expect(upstream.destroyed).toBe(true);
    expect(client.destroyed).toBe(true);
  });

  it("socksUpstreamGuard 产出的选项同样是 linked（省略第三参即隧道语义）", async () => {
    const { client, upstream } = pair();
    guardDialing(client, upstream, socksUpstreamGuard("tunnel"));

    upstream.destroy();
    await tick();

    expect(client.destroyed).toBe(true);
  });

  it("客户端侧监听不摘除：一个连接一条隧道只挂一次，没有累积问题", async () => {
    const { client, upstream } = pair();
    guardDialing(client, upstream, { timeout: 0 });

    upstream.destroy();
    await tick();

    // 刻意不摘：linked 形态下客户端与管道同生共死，摘了没有收益
    expect(client.listenerCount("close")).toBe(1);
    expect(client.listenerCount("error")).toBe(1);
  });
});

describe("unit/guard clientLifetime=independent（请求语义）", () => {
  it("上游关闭**不**销毁客户端：入站 keep-alive 的存活与上游无关", async () => {
    const { client, upstream } = pair();
    guardDialing(client, upstream, { timeout: 0, clientLifetime: "independent" });

    upstream.destroy();
    await tick();

    expect(upstream.destroyed).toBe(true);
    expect(client.destroyed).toBe(false);
  });

  it("客户端先死仍要毁上游（另一方向保留，否则上游 socket 泄漏）", async () => {
    const { client, upstream, events, collect } = pair();
    guardDialing(client, upstream, {
      timeout: 0,
      clientLifetime: "independent",
      onEvent: collect,
    });

    client.destroy();
    await tick();

    expect(upstream.destroyed).toBe(true);
    expect(events.some((e) => e.type === "client-error")).toBe(false);
  });

  it("客户端 error 仍发 client-error 事件并只毁上游", async () => {
    const { client, upstream, events, collect } = pair();
    guardDialing(client, upstream, {
      timeout: 0,
      clientLifetime: "independent",
      onEvent: collect,
    });

    client.emit("error", new Error("client boom"));
    await tick();

    expect(upstream.destroyed).toBe(true);
    expect(client.destroyed).toBe(false);
    expect(events.map((e) => e.type)).toContain("client-error");
  });

  it("建链后的上游超时只毁上游，且 upstream-timeout 事件照发", async () => {
    const { client, upstream, events, collect } = pair();
    const guard = guardDialing(client, upstream, {
      timeout: 1000,
      clientLifetime: "independent",
      onEvent: collect,
    });
    guard.established();

    upstream.emit("timeout");
    await tick();

    expect(upstream.destroyed).toBe(true);
    expect(client.destroyed).toBe(false);
    expect(events.map((e) => e.type)).toContain("upstream-timeout");
  });

  it("建链后的上游错误只毁上游，且 upstream-error 事件照发", async () => {
    const { client, upstream, events, collect } = pair();
    const guard = guardDialing(client, upstream, {
      timeout: 0,
      clientLifetime: "independent",
      onEvent: collect,
    });
    guard.established();

    upstream.emit("error", new Error("upstream boom"));
    await tick();

    expect(upstream.destroyed).toBe(true);
    expect(client.destroyed).toBe(false);
    expect(events.map((e) => e.type)).toContain("upstream-error");
  });

  it("未建链的拨号失败只毁上游、客户端留着（keepClientOnFailure 语义保留）", async () => {
    const { client, upstream, events, collect } = pair();
    guardDialing(client, upstream, {
      timeout: 0,
      ...socksUpstreamGuard("http", collect, "independent"),
    });

    upstream.emit("error", new Error("dial failed"));
    await tick();

    expect(upstream.destroyed).toBe(true);
    expect(client.destroyed).toBe(false);
    expect(events.map((e) => e.type)).toContain("upstream-error");
  });

  it("上游关闭后摘除客户端侧监听：入站长连接上不按请求累积监听器", async () => {
    const { client, upstream } = pair();
    guardDialing(client, upstream, { timeout: 0, clientLifetime: "independent" });

    expect(client.listenerCount("close")).toBe(1);
    expect(client.listenerCount("error")).toBe(1);

    upstream.destroy();
    await tick();

    expect(client.listenerCount("close")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("守卫装订时上游已死：立即摘除客户端侧监听（close 不会再来的极端形态）", async () => {
    const { client, upstream } = pair();
    upstream.destroy();
    await tick();

    guardDialing(client, upstream, { timeout: 0, clientLifetime: "independent" });

    expect(client.listenerCount("close")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
    expect(client.destroyed).toBe(false);
  });
});

describe("unit/guard socksUpstreamGuard 第三参", () => {
  it("省略即不产出 clientLifetime 键（缺省 linked，不让 undefined 混进守卫选项）", () => {
    expect("clientLifetime" in socksUpstreamGuard("tunnel")).toBe(false);
  });

  it("显式传入时逐字透传", () => {
    expect(socksUpstreamGuard("http", undefined, "independent").clientLifetime).toBe(
      "independent",
    );
  });

  it("既有三项语义不受第三参影响（空回复 + 保客户端 + 事件汇）", () => {
    const sink = (): void => {};
    expect(socksUpstreamGuard("http", sink, "independent")).toMatchObject({
      logPrefix: "http",
      timeoutReply: "",
      errorReply: "",
      keepClientOnFailure: true,
      onEvent: sink,
    });
  });
});