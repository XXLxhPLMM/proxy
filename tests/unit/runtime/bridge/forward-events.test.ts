/**
 * `runtime/bridge.ts`：**core 直发事实**那一半 —— `forward.request-headers` 的掩码**在 publish
 * 之前**完成（整份载荷看不到任何原值、键仍在、非敏感头不误伤）且它**有订阅者**（否则
 * `[{kind}] headers` 那行静默消失）；`request.started` 是公共事件面上唯一的非终态请求级事件，
 * 身份维度一律走 context，关联 id 缺失即不带。
 * ⚠️ 「入站展示掩码与出站头剥离是两套方向相反的判据」与桥接器只重建 context 的理由在
 * `./AGENTS.md`；名单拒绝那一半在 `deny-events`，边界与清理在 `lifecycle`。
 */
import http from "node:http";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore, createConfigContext } from "@/config/index.js";
import { EventHub } from "@/core/events/index.js";
import type { EventEnvelope } from "@/core/events/index.js";
import { HttpProxy } from "@/core/server/http.js";
import type { IdentityProvider, PipeEvent } from "@/core/types/proxy.js";
import { CoreEventBridge } from "@/runtime/bridge.js";
import { ProxyServer } from "@/server/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { getFreePort } from "../../../helpers/net.js";
import { withProxy } from "../../../helpers/proxy.js";
import { PROTOCOL, contextFor, newHub, recordAll } from "./_core-event-bridge.js";

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

/** 绝对形式 GET 走一次真实代理（目标为死端口，失败不影响事件的存在性） */
function absoluteGet(port: number, authority: string, headers?: Record<string, string>): Promise<number> {
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

describe("core 直发 forward.request-headers（诊断细节事实）", () => {
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
    // stop() 之后订阅必须随本轮观察面一起退订（且退订必须打在**同一条**总线上）
    expect(events.listenerCount("forward.request-headers")).toBe(0);
  });
});

describe("core 直发 request.started（HttpProxy.handleForward）", () => {
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
    // 库用户不必接受 utils/addr/inbound 的默认提取策略。
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