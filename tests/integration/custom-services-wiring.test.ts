/**
 * @fileoverview 自定义服务接线的端到端护栏：`identity` / `access` / `connectors` 三项都能被替身整体接管
 *
 * @description
 * 身份可插值化之后，core 与四条入站通道只认**端口**，永不自己造实现：默认的文件驱动
 * 实现只在唯一组装根 `createProxyRuntime → buildDefaultServices` 解析一次。本档锁那条
 * 「显式注入优先」的承诺**在行为面真的成立**——不是查字段（那是 unit 档的活），而是
 * 起一个真 runtime、走真请求、观察真事件与真字节。
 *
 * 三条各占一个正交的面，缺一条就有一类替换没被证明：
 *
 * 1. **`access` 替身**：自定义实现拒掉一个目标 → 403 + `access.target-denied` 事件带
 *    **替身自己的 reason**。这条同时钉住两件事：替身真的被调（不是被默认实现遮蔽），
 *    以及**自由文本 reason 能穿过桥接层**——`AccessDecision.reason` 已从名单的
 *    `whitelist|blacklist` 闭合集放宽为 `string`，代价由消费方承担（`runtime/bridge.ts`
 *    的收窄逻辑只认闭合集，表外值**静默不发布**事件）。所以本档用一个**在闭合集之外**
 *    的 reason（`"quota-exceeded"`）并断言它**确实被发布**——若哪天有人把收窄改严、
 *    或把 reason 收回闭合集，这条立刻红。
 * 2. **`identity` 替身**：`kind: "apikey"`、`isOwnCredential` 只认 `ApiKey <secret>`
 *    这一种**自定义 scheme**（内置四模式谁都不认它，故「判据由插件给出」这件事是可证的）。
 *    断言两件相反方向的事同时成立：替身认的那个 `Authorization` **被剥掉**（不出站），
 *    而客户端给目标站的 `Authorization: Bearer …` **不被误剥**。后者是本档最要紧的一条——
 *    `isOwnCredential` 是必填无缺省的端口成员，判据由**插件自己**给出；若 core 仍在
 *    从 config 猜「哪个 Authorization 是本代理的」，自定义凭证形态必然失配，
 *    后果不是「剥多了」而是**代理自己的凭证被原样转发给目标站**（凭据泄漏）。
 *
 *    ⚠️ 凭证走**标准 `Authorization` 头 + 自定义 scheme**，不是自定义头名——这是端口的
 *    既定契约（`IdentityProvider.isOwnCredential` 的 JSDoc：「非 `authorization` 一律
 *    `false`」，`proxy-` 前缀由 `isProxyHeaderName` 那条独立宽规则管）。故凭证形态的
 *    可插值性体现在 **scheme 与值的形状**上，那才是本档要验的面。
 * 3. **`connectors` 替身**：`upstream()` 返回一个只认固定目标的连接器，`direct()` 恒抛错。
 *    断言 client 模式的请求**真的走了替身**（替身侧桩收到字节、配置里的上游桩零字节），
 *    证明「上游接入」整条链可换，而不只是字段透传。
 *
 * 全部用真代理 + 真源站 + 真事件总线，不用 mock。
 */

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { createProxyRuntime, type ProxyRuntime } from "@/runtime/index.js";
import type { EventSubscription } from "@/core/events/index.js";
import type { UpstreamConnector, ConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { AccessControl, AccessDecision, AccessRouteDecision, PipeEvent } from "@/core/types/proxy.js";
import type { IdentityContext, IdentityProvider, IdentityResult } from "@/core/types/identity.js";
import { EventHub } from "@/core/events/index.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { silenceLogs } from "../helpers/config.js";
import { testLogger } from "../helpers/config.js";

const RUNTIMES: ProxyRuntime[] = [];
const SERVERS: (http.Server | net.Server)[] = [];
const SUBS: EventSubscription[] = [];

afterEach(async () => {
  for (const s of SUBS.splice(0)) {
    s.dispose();
  }

  for (const r of RUNTIMES.splice(0)) {
    await r.stop().catch(() => undefined);
  }

  for (const s of SERVERS.splice(0)) {
    (s as http.Server).closeAllConnections?.();
    await new Promise<void>((r) => {
      s.close(() => r());
    });
  }
});

/** 真源站：回一个已知 body，并记录收到的请求头（判「哪些头真的出站了」） */
async function startOrigin(): Promise<{ port: number; headers: () => http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ ...req.headers });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("origin-ok");
  });
  const port = await getFreePort();
  await listen(server, port);
  SERVERS.push(server);
  return { port, headers: () => seen };
}

/** 裸 TCP 桩：只记字节（判「配置里那个上游到底有没有被碰过」） */
async function startByteSink(): Promise<{ port: number; bytes: () => number }> {
  let bytes = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (c: Buffer) => {
      bytes += c.length;
      // content-length 必须与 body 逐字节相等：写错会让客户端在等 body 时挂到超时
      sock.write("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nsink-ok\n");
    });
  });
  const port = await getFreePort();
  await listen(server, port);
  Object.defineProperty(server, "closeAllConnections", {
    value: () => {
      for (const s of sockets) {
        s.destroy();
      }
    },
  });
  SERVERS.push(server);
  return { port, bytes: () => bytes };
}

/** 明文 HTTP 请求走代理（absolute-form，判响应状态码与 body） */
function requestViaProxy(
  proxyPort: number,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: url,
        headers: { Host: "127.0.0.1", ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

interface Started {
  port: number;
  pipes: () => PipeEvent[];
  publicEvents: () => { name: string; data: unknown }[];
}

async function startRuntime(
  overrides: {
    access?: AccessControl;
    identity?: IdentityProvider;
    connectors?: ConnectorSource;
    config?: Record<string, unknown>;
  } = {},
): Promise<Started> {
  silenceLogs();
  const port = await getFreePort();
  const bus = new EventHub({ onListenerError: () => undefined });
  const pipes: PipeEvent[] = [];
  const events: { name: string; data: unknown }[] = [];

  SUBS.push(bus.subscribe("pipe", (e) => pipes.push(e.data)));
  SUBS.push(
    bus.subscribe("access.target-denied", (e) => {
      events.push({ name: e.name, data: e.data });
    }),
  );

  const runtime = createProxyRuntime({
    config: {
      host: "127.0.0.1",
      port,
      proxyProtocol: "http",
      // 三条用例都显式注入身份/访问控制，故配置面一律关掉，避免默认实现抢戏
      authEnabled: false,
      authType: "none",
      ...overrides.config,
    } as never,
    events: bus,
    logger: testLogger,
    ...(overrides.access ? { services: { access: overrides.access } } : {}),
    ...(overrides.identity ? { services: { ...(overrides.access ? { access: overrides.access } : {}), identity: overrides.identity } } : {}),
    ...(overrides.connectors ? { connectors: overrides.connectors } : {}),
  });
  RUNTIMES.push(runtime);
  await runtime.start();

  return { port, pipes: () => pipes, publicEvents: () => events };
}

describe("integration/custom-services-wiring", () => {
  it("自定义 access 替身：拒掉目标 → 403，且 access.target-denied 带替身自己的 reason", async () => {
    const origin = await startOrigin();
    const deniedHost = "blocked.example";

    // 替身**只**认一个硬编码的拒答：名单语义完全在替身手里，代理本体不参与判定。
    // reason 刻意取闭合集（whitelist|blacklist）之外的 `"quota-exceeded"`：
    // `AccessDecision.reason` 已放宽为自由文本，而 `runtime/bridge.ts:aclReason`
    // 只认闭合集、表外值**静默不发布事件**——断言它仍被发布，就把「放宽的代价由消费方承担」
    // 这条契约钉在行为面上。
    const access: AccessControl = {
      checkClient: (): AccessDecision => ({ allowed: true }),
      checkTarget: (input): AccessDecision =>
        input.host === deniedHost
          ? { allowed: false, reason: "quota-exceeded", source: "custom" }
          : { allowed: true },
      checkRoute: (): AccessRouteDecision => ({ direct: true }),
    };

    const started = await startRuntime({ access });

    const denied = await requestViaProxy(started.port, `http://${deniedHost}:80/x`);
    const allowed = await requestViaProxy(started.port, `http://127.0.0.1:${origin.port}/y`);
    await sleep(60);

    // 替身真的被调：拒的那个 403、没被拒的那个 200
    expect(denied.status, "替身拒掉的目标必须 403").toBe(403);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toBe("origin-ok");

    // 恰好一条 target-denied，且 reason 是**替身自己那个**（不是名单语义的黑白名单）
    const deniedPipes = started.pipes().filter((e) => e.type === "target-denied");
    expect(deniedPipes).toHaveLength(1);
    expect(deniedPipes[0]?.reason).toBe("quota-exceeded");
    expect(deniedPipes[0]?.source).toBe("custom");

    // 公共事件面同样带替身的 reason（自由文本不被桥接层静默吞掉）
    const published = started.publicEvents();
    expect(published).toHaveLength(1);
    expect(published[0]?.name).toBe("access.target-denied");
    expect(published[0]?.data).toMatchObject({ reason: "quota-exceeded" });
  });

  it("自定义 identity 替身（apikey scheme）：只剥自己认的 ApiKey，客户端的 Bearer 原样出站", async () => {
    const origin = await startOrigin();
    const API_KEY = "custom-secret-key";
    /** 替身自己的凭证形态：自定义 scheme（内置四模式谁都不认它） */
    const OWN = `ApiKey ${API_KEY}`;

    const identity: IdentityProvider = {
      kind: "apikey",
      isEnabled: true,
      // 端口契约：只有 `authorization` 会转交到这里，其余头名一律 false
      isOwnCredential(name, value) {
        return name.toLowerCase() === "authorization" && value === OWN;
      },
      async identify(ctx: IdentityContext): Promise<IdentityResult> {
        // `Proxy-Authorization` 优先、`Authorization` 回退（RFC 7235，与内置插件同一条链）
        const raw = ctx.req.headers["proxy-authorization"] ?? ctx.req.headers.authorization;
        return typeof raw === "string" && raw === OWN
          ? { passed: true, username: "apikey-user" }
          : { passed: false };
      },
    };

    const started = await startRuntime({ identity });

    // 替身认的凭证：带对就放行，且**不得出站**（出站方向见下面的头快照）
    const ok = await requestViaProxy(started.port, `http://127.0.0.1:${origin.port}/ok`, {
      "Proxy-Authorization": OWN,
    });
    expect(ok.status, "替身认的凭证应放行").toBe(200);
    expect(ok.body).toBe("origin-ok");

    // 替身不认的凭证：拒（407）
    const noKey = await requestViaProxy(started.port, `http://127.0.0.1:${origin.port}/nokey`);
    expect(noKey.status, "缺替身凭证应 407").toBe(407);

    const seen = origin.headers();
    // 方向一：`Proxy-Authorization` 恒被 `proxy-` 宽规则剥掉（与替身无关）
    expect(seen[0]?.["proxy-authorization"], "proxy- 前缀头恒不出站").toBeUndefined();

    // 方向二（本档最要紧）：客户端给**目标站**的 `Authorization: Bearer …` 必须原样出站。
    // 凭证走 `Proxy-Authorization` 放行、`Authorization` 留给目标站——若 core 仍在从 config
    // 猜「哪个 Authorization 是本代理的」，这个 Bearer 会被误剥（目标站少收一个它要的头），
    // 反向失配则更糟：替身自己的凭证被原样转发给目标站（凭据泄漏）。
    const bearer = "Bearer target-site-token";
    const withAuth = await requestViaProxy(started.port, `http://127.0.0.1:${origin.port}/auth`, {
      "Proxy-Authorization": OWN,
      Authorization: bearer,
    });
    expect(withAuth.status).toBe(200);
    expect(seen.at(-1)?.authorization, "目标站的凭证不得被误剥").toBe(bearer);

    // 方向三：替身**自己**的 `Authorization`（未经 Proxy-Authorization 那条链）必须被剥掉。
    // 这是「`isOwnCredential` 由插件给出」的可证形态——内置四模式对 `ApiKey` scheme
    // 一律判否（jwt 只认 HS256、basic/uid 只认账号表），故这条命中只可能来自本替身。
    const ownInAuth = await requestViaProxy(started.port, `http://127.0.0.1:${origin.port}/own`, {
      Authorization: OWN,
    });
    expect(ownInAuth.status).toBe(200);
    expect(seen.at(-1)?.authorization, "替身自己的凭证不得出站").toBeUndefined();
  });

  it("自定义 connectors 替身：接管上游接入（替身桩收到字节、配置里的上游桩零字节）", async () => {
    const configured = await startByteSink();
    const injected = await startByteSink();
    const origin = await startOrigin();

    // 替身只认一个固定目标：任何请求都被导向 `injected.port`。
    // `direct()` 恒抛错——client 模式有效路由恒 upstream，direct 那一档被调即说明
    // 「路由判定没走到 connectors」或「用了别处造的那份连接器」。
    const connector: UpstreamConnector = {
      kind: "socks4",
      targetForm: "absolute",
      async open({ onEvent }) {
        const sock = net.connect(injected.port, "127.0.0.1");
        sock.on("error", (err) =>
          onEvent({ type: "client-error", message: "[custom] 替身连接器建链失败", err }),
        );
        return { sock, rest: Buffer.alloc(0) };
      },
      async transport() {
        return net.connect(injected.port, "127.0.0.1");
      },
      peerTarget: () => ({ host: "127.0.0.1", port: injected.port }),
      upstreamAuthHeader: () => undefined,
      selfLoopTarget: () => undefined,
    };
    const connectors: ConnectorSource = {
      direct: () => {
        throw new Error("custom ConnectorSource.direct() must not be reached in client mode");
      },
      upstream: () => connector,
    };

    const started = await startRuntime({
      connectors,
      config: {
        proxyMode: "client",
        upstreamProtocol: "http",
        upstreamHost: "127.0.0.1",
        upstreamPort: configured.port,
      },
    });

    const res = await requestViaProxy(started.port, "http://target.example/chain");

    expect(res.status, "替身接管的链路应转发成功").toBe(200);
    expect(injected.bytes(), "替身那一档的上游桩必须真的收到字节").toBeGreaterThan(0);
    expect(configured.bytes(), "配置里的上游桩必须零字节（证明没被默认 connectors 抢走）").toBe(0);
    // 源站没被碰：流量经替身桩回了一句固定 body，真源站零命中
    expect(origin.headers()).toHaveLength(0);
  });
});
