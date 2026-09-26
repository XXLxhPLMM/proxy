/**
 * @fileoverview 三个「纯管道」转发器（tunnel / socks / websocket）的上游连接器接线护栏
 * @description
 * 这三条「拿到一条字节管道然后桥接」的路径全部经 `forward/upstream/connector` 统一层，
 * 本文件锁三件**一旦接线就可能悄悄漂移**的东西：
 *
 * 1. **守卫日志的 route 文本**：连接器不再各调用点自定义，统一按「信息最多的既有形态」给出
 *    （`[<prefix>] error <clientAddr> -> <dest>` 或 `... -> <dest> via socks<N> <upstream>`）。
 *    变强的那几处（socks 直连分支、socks 的 socks 上游分支、websocket 的 socks 上游分支，
 *    以及 websocket 的**有效 client 经 http(s) 上游**那条）的「短」是**各调点随手写出来的
 *    差异，不是契约**——**route 文本是逐字锁死的契约**，
 *    改它必须先改本文件并说明理由，否则「顺手调日志」会把排障线索抹掉。
 * 2. **`refusal` 透传**（tunnel 经 http(s) 上游）：上游 CONNECT 回非 200（如后级 407）时，
 *    **响应头 + 余量原样写给客户端再断链**（不断链语义——`Proxy-Authenticate` 必须送达客户端），
 *    绝不建隧、绝不回自己的 502/504。这是本切片最容易丢的行为，断言逐字节。
 * 3. **连接器选择**：有效路由是 direct 时必须走 `connectors.direct()` 而不是
 *    `connectors.upstream()`。判别靠「双桩互斥」——真目标桩与上游代理桩同时在跑，拨了谁
 *    一目了然；配 `upstream` 路由名单让 client 模式请求回落 direct，若误选 `upstream()`
 *    就会去拨上游桩，断言立刻抓住。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { readAcl } from "@/config/index.js";
import { TunnelForwarder } from "@/core/forward/channel/tunnel.js";
import { WsForwarder } from "@/core/forward/channel/upgrade.js";
import { inertTrafficAccount as INERT_TRAFFIC } from "@/core/traffic/index.js";
import { createFileAccessControl } from "@/core/access-control.js";
import { noneIdentity } from "@/core/identity.js";
import { createConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { CoreServices } from "@/core/types/proxy.js";
import type {
  ConnectorSource,
  OpenContext,
  OpenedUpstream,
  UpstreamConnector,
} from "@/core/forward/upstream/connector/index.js";
import { createRequestScope } from "@/core/request-scope.js";
import { RequestTerminal } from "@/core/request-terminal.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import type { EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { set, testConfig, testContext, testEvents } from "../helpers/config.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { withProxy } from "../helpers/proxy.js";
import { makeCollector, socks5ConnectIpv4, tcConnect } from "../helpers/socks-client.js";

/** 本文件涉及的配置键（逐键快照/恢复，不依赖生产全局 store） */
const KEYS = [
  "aclFile",
  "authEnabled",
  "authType",
  "host",
  "port",
  "proxyMode",
  "upstreamHost",
  "upstreamPort",
  "upstreamProtocol",
  "upstreamPassword",
  "upstreamTimeout",
  "upstreamUsername",
  "logLevel",
  "logFile",
] as const;

/** 起一个裸 TCP server 的可关闭句柄，并记录每条连接的远端地址（守卫 route 前半段同源） */
interface Tcp {
  port: number;
  close: () => Promise<void>;
  /** 收到的全部字节（判「上游桩到底有没有被碰过」） */
  received: () => Buffer;
}

async function startTcp(onConn?: (sock: net.Socket) => void): Promise<Tcp> {
  const chunks: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (c: Buffer) => chunks.push(c));
    onConn?.(sock);
  });

  const port = await getFreePort();

  await listen(server, port);

  return {
    port,
    received: () => Buffer.concat(chunks),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) {
          s.destroy();
        }
        server.close(() => r());
      }),
  };
}

/**
 * 造一条请求作用域：直构 core 时没有 runtime 注入的 publisher，terminal 退化为纯 guard。
 * 身份维度与 pipe 事件出口都在这条 scope 里（与 `HttpProxy.handleForward` 同形）。
 */
function requestScope(): ReturnType<typeof createRequestScope> {
  return createRequestScope({ ctx: testContext, terminal: new RequestTerminal() });
}

/**
 * 转发器构造期收的三样（ctx / services / connectors）在本文件就地造。
 *
 * 形状与 `createProxyRuntime → BaseProxy` 的归一结果逐字同形：
 * - `identity` 取显式 inert 档：本文件全部用例都不走鉴权，直构转发器更是拿不到准入层；
 * - `access` **必须是真名单判定**：本文件有「上游路由名单命中 → 回落直连」与「目标名单」两条护栏
 *   走 `preDial` / `routePolicy`，接上放行档等于把它们静默废掉；
 * - `traffic` 取显式禁用档。
 *
 * ⚠️ 这两个工厂**本应**住在 `tests/helpers/proxy.ts`（紧邻 `withProxy`）：`CoreServices` 与
 * `ConnectorSource` 都是全必填、形状固定的装配物，抄到每个文件里就是「同一个真相抄 N 份」。
 * 它就地定义而没有放进 `tests/helpers/**`（登记在 `tests/AGENTS.md`，待收口）。
 */
function testServices(): CoreServices {
  return {
    identity: noneIdentity(),
    access: fileAccess,
    traffic: INERT_TRAFFIC(),
  };
}

/**
 * 文件驱动的访问控制（转发器直构与 `withProxy` 直构 core 两处共用同一份）。
 *
 * @description
 * `ProxyOptions.access` 是**必填**的（`access: AccessControl`，无 `?`）：core 侧**零缺省解析**
 * ⚠️ **`ProxyOptions.access` 必填、无缺省档**：全仓不存在 `OPEN_ACCESS_CONTROL` 那个「恒放行」符号，缺席即全放行，所以必须编译期拦。
 * 本文件既直构转发器又经
 * `withProxy` 直构 core，两条路都必须显式注入，否则「upstream 路由名单命中 → 回落直连」
 * 与「目标名单」两条护栏整条消失。
 *
 * ⚠️ 本应住在 `tests/helpers/proxy.ts` 紧邻 `withProxy`（那里是所有直构 core 的汇聚点）；
 * 它就地定义而没有放进 `tests/helpers/**`（登记在 `tests/AGENTS.md`，待收口）。
 */
const fileAccess = createFileAccessControl(testContext.config);

/**
 * 连接器源：**现读** `upstreamProtocol` 的那份。
 *
 * 生产默认实现 `createConnectorSource(ctx)` 把「走上游」记忆在一份 source 上，这正确性挂在
 * 「`UPSTREAM_PROTOCOL` 是 startup 相位、accessor 对它读冻结值」这条不变式上——真实 runtime
 * 里一份 source 终身只对应一份协议。本文件**逐用例 `set("upstreamProtocol", …)`**（http / socks5
 * 两档轮换），那个前提不成立：沿用记忆化那份会让第一个走上游的用例把协议粘住，后续档位拿到的
 * 是上一档的连接器，route 文本断言直接测到别的东西。
 *
 * 故这里每次问都现造一份。`ConnectorSource` 是**端口**，「记忆化」只是默认实现的一个选择，
 * 不是端口契约——本文件实现的是同一端口的另一个合法选择（现读档）。这与「每请求现读协议」那条
 * 每请求 `connectorFor(protocol, config)` 的行为逐字同形，也就是本文件这些断言原本观察的语义。
 */
function testConnectors(): ConnectorSource {
  return {
    direct: () => createConnectorSource(testContext).direct(),
    upstream: () => createConnectorSource(testContext).upstream(),
  };
}

/**
 * 「隧道中继型」连接器替身：`kind:"https"` + `targetForm:"origin"` + `upstreamAuthHeader() === undefined`
 *
 * @description
 * 这个形状**编译期就合法**，而且合法得刺眼：`UpstreamConnector.kind`（逻辑协议身份）与
 * `targetForm`（对端是代理还是源站）是**两个互不约束的独立声明式字段**，端口从没规定
 * 「`kind` 是什么 `targetForm` 就必须是什么」。它描述的形态完全合理：中间有一跳中继网关
 * （所以 `kind` 是 https/带握手的形态），但**终点是真实目标站**（所以 `targetForm` 是 `origin`、
 * 且中继自己的认证走它自己的机制、不该由 `Proxy-Authorization` 携带）。
 *
 * **它就是「按 `kind` 推对端身份」那条判据的毒样本**：
 * - `isSocksTunnel(替身)` === false（`kind` 不是 socks4/5）→ 旧判据
 *   `mode === "client" && !viaSocksTunnel` 判成 **true**（=「对端是代理」）
 * - 而 `targetForm === "absolute"` 判成 **false**（=「对端是源站」）
 * - 且 `upstreamAuthHeader()` 恒 `undefined`（连接器明说「本次不该给凭证」）
 *
 * 于是只要通道侧的判据还在读 `kind` / 读 config 而不是问端口，这条链路就会用
 * **absolute-form** 把 `UPSTREAM_USERNAME`/`UPSTREAM_PASSWORD` 的 Basic 凭证
 * **发给一个不是 HTTP 代理的对端**。
 *
 * ⚠️ **今天不可达只因巧合**：内置四个连接器恰好满足「`kind === "direct"` ⟹ server 模式」
 * 且「SOCKS 的 `targetForm` 恒 `origin`」，两判据在**内置集合上**恒等价。
 * 那是巧合不是契约，`kind` 与 `targetForm` 谁也没约束过谁。
 *
 * `transport()` 朴素地直拨 `dest`（中继自己的路由不是本用例的被测对象——本用例只看**出站报文的形态**）。
 */
function tunnelRelayConnector(): UpstreamConnector {
  const relay = (ctx: OpenContext): Promise<Duplex> =>
    new Promise((resolve, reject) => {
      const sock = net.connect(ctx.dest.port, ctx.dest.host);

      sock.once("connect", () => resolve(sock));
      sock.once("error", reject);
    });

  return {
    kind: "https",
    targetForm: "origin",
    peerTarget: (dest) => ({ host: dest.host, port: dest.port }),
    // 对端是源站 → 中继自己的认证不在这条 HTTP 报文里，绝不注入
    upstreamAuthHeader: () => undefined,
    // 中继网关有自己的回环判据，本替身不参与（返回 undefined 即「跳过预检」）
    selfLoopTarget: () => undefined,
    open: async (ctx): Promise<OpenedUpstream> => ({ sock: await relay(ctx), rest: Buffer.alloc(0) }),
    transport: (ctx) => relay(ctx),
  };
}

/**
 * 转发器实例**在模块加载时建一次**、跨所有用例与连接复用
 * @description
 * 与 `HttpProxy` 构造期组装转发器的形态刻意同形：转发器无请求态，逐请求数据全在 `scope` 里，
 * 所以「建一次、多连接复用」是合法的（也正是 `integration/forwarder-instance-reuse.test.ts`
 * 锁的那条不变性）。`testContext` 是常量，故这里可以安全地提到模块级。
 */
const tunnelFwd = new TunnelForwarder(testContext, testServices(), testConnectors());
const wsFwd = new WsForwarder(testContext, testServices(), testConnectors());

/**
 * 本地转发器：把每条连接 socket 原样交给 forward（模拟 HttpProxy 的 connect/upgrade 委派），
 * forward 内部按当前 store 配置拨上游
 */
async function startForwarder(
  forward: (req: unknown, socket: net.Socket, head: Buffer) => void,
  fakeReq: unknown,
): Promise<Tcp> {
  return startTcp((sock) => {
    forward(fakeReq, sock, Buffer.alloc(0));
  });
}

/** CONNECT 伪请求：`parseAuthority` 只认 url */
function connectReq(host: string, port: number): unknown {
  return { url: `${host}:${port}`, headers: {}, method: "CONNECT" };
}

/** Upgrade 伪请求：目标在 Host 头（origin-form 形态，与真实客户端一致） */
function upgradeReq(host: string, port: number): unknown {
  return {
    url: "/ws",
    method: "GET",
    httpVersion: "1.1",
    headers: { host: `${host}:${port}` },
    rawHeaders: ["Host", `${host}:${port}`, "Upgrade", "websocket", "Connection", "Upgrade"],
  };
}

/** 从事件流里取第一条 `type === "upstream-error"` 且 message 带指定前缀的事件文本 */
function guardError(events: PipeEvent[], prefix: string): string {
  for (const e of events) {
    if (e.type === "upstream-error" && typeof e.message === "string" && e.message.startsWith(prefix)) {
      return e.message;
    }
  }

  throw new Error(
    `未找到前缀为 "${prefix}" 的 upstream-error 事件；实得：${JSON.stringify(
      events.map((e) => [e.type, "message" in e ? e.message : ""]),
    )}`,
  );
}

/** 读满 n 字节才 resolve（跨 TCP 分段安全；只用于 SOCKS 握手这种定长应答） */
function readBytes(sock: net.Socket, n: number, ms = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const acc: Buffer[] = [];
    let len = 0;

    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("error", onError);
    };

    const onData = (c: Buffer): void => {
      acc.push(c);
      len += c.length;

      if (len < n) {
        return;
      }

      cleanup();
      resolve(Buffer.concat(acc).subarray(0, n));
    };

    const onError = (e: Error): void => {
      cleanup();
      reject(e);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`readBytes 超时：只读到 ${len}/${n} 字节`));
    }, ms);

    sock.on("data", onData);
    sock.on("error", onError);
  });
}

/** 轮询等待条件成立，超时抛错（避免固定 sleep 抖动） */
async function waitUntil(cond: () => boolean, timeoutMs = 3000, label = ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (cond()) {
      return;
    }

    await sleep(10);
  }

  throw new Error(`waitUntil 超时${label ? `：${label}` : ""}`);
}

// ---------------------------------------------------------------------------

describe("integration/forwarder-connector-wiring", () => {
  let snap: Record<string, unknown>;
  /** 挂在共享测试总线上的 pipe 订阅，由 afterEach 统一 dispose（共享总线不清理会跨用例累积） */
  const subs: EventSubscription[] = [];

  beforeEach(() => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    set("authEnabled", false);
    set("authType", "none");
    set("host", "127.0.0.1");
    // 哨兵端口：确保 isSelfLoop 不会把测试内的随机临时端口误判为自环
    set("port", 1);
  });

  afterEach(() => {
    for (const s of subs.splice(0)) {
      s.dispose();
    }

    restoreConfig(snap);
  });

  // -------------------------------------------------------------------------
  // tunnel：三条支路的守卫 route 文本 + refusal 透传
  // -------------------------------------------------------------------------

  describe("forward/channel/tunnel", () => {
    it("直连：route 为 `<clientAddr> -> <host>:<port>`，不带任何上游尾巴", async () => {
      set("proxyMode", "server");
      const dead = await getFreePort();
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => tunnelFwd.handleConnect(req as never, socket, head, requestScope()),
        connectReq("127.0.0.1", dead),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[tunnel] error ")).toBe(
          `[tunnel] error 127.0.0.1 -> 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });

    it("经 http 上游：route 带 `via <upstreamHost>:<upstreamPort>`（与既有形态逐字一致）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "http");
      const dead = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => tunnelFwd.handleConnect(req as never, socket, head, requestScope()),
        connectReq("target.example", 8443),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[tunnel] error ")).toBe(
          `[tunnel] error 127.0.0.1 -> target.example:8443 via 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });

    it("经 socks5 上游：route 带 `via socks5 <upstreamHost>:<upstreamPort>`（与既有形态逐字一致）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      const dead = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => tunnelFwd.handleConnect(req as never, socket, head, requestScope()),
        connectReq("target.example", 8443),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[tunnel] error ")).toBe(
          `[tunnel] error 127.0.0.1 -> target.example:8443 via socks5 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });

    it("refusal 透传：上游 CONNECT 回 407 时响应头+余量逐字节写给客户端再断链（不断链语义）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "http");

      const head =
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="up"\r\n\r\n';
      const rest = "denied-by-upstream";
      // 假上游：读到完整 CONNECT 请求头后回 head+rest（rest 是响应头之后的先发字节）
      const upstream = await startTcp((sock) => {
        let buf = Buffer.alloc(0);
        const onData = (c: Buffer): void => {
          buf = Buffer.concat([buf, c]);

          if (buf.indexOf("\r\n\r\n") === -1) {
            return;
          }

          sock.off("data", onData);
          sock.write(head + rest);
        };
        sock.on("data", onData);
      });
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head2) => tunnelFwd.handleConnect(req as never, socket, head2, requestScope()),
        connectReq("target.example", 8443),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        // 逐字节：Proxy-Authenticate 必须送达客户端，且余量不得被吞
        await c.waitFor((b) => b.includes(Buffer.from(rest)), 3000);
        expect(c.bytes().toString()).toBe(head + rest);
        // refusal 不是建链成功：绝不能回 200，绝不能建隧
        expect(c.bytes().toString()).not.toContain("200 Connection Established");
        // 断链语义：写完即断
        await c.waitClose(2000);
        // refusal 不是拨号失败：不得回自己的 502/504，也不得发 upstream-error
        expect(c.bytes().toString()).not.toContain("502");
        expect(c.bytes().toString()).not.toContain("504");
        expect(events.filter((e) => e.type === "upstream-error")).toHaveLength(0);
        client.destroy();
      } finally {
        await fwd.close();
        await upstream.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // socks：三条上游支路的守卫 route 文本
  // -------------------------------------------------------------------------

  describe("forward/channel/socks", () => {
    /** 起一个真 Socks5Proxy，并把它的 pipe 事实收进数组 */
    async function withSocks5(
      fn: (port: number, events: PipeEvent[]) => Promise<void>,
    ): Promise<void> {
      const events: PipeEvent[] = [];

      subs.push(collectPipe((e) => events.push(e)));
      await withProxy(Socks5Proxy, {}, (port) => fn(port, events));
    }

    it("直连分支：route 文本带 `-> <host>:<port>` 目标尾巴", async () => {
      set("proxyMode", "server");
      const dead = await getFreePort();

      await withSocks5(async (port, events) => {
        const sock = await tcConnect(port);

        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await readBytes(sock, 2);
        sock.write(socks5ConnectIpv4("127.0.0.1", dead));
        await readBytes(sock, 10);

        await waitUntil(
          () => events.some((e) => e.type === "upstream-error"),
          3000,
          "socks 直连守卫事件",
        );
        expect(guardError(events, "[socks] error ")).toBe(`[socks] error 127.0.0.1 -> 127.0.0.1:${dead}`);
        sock.destroy();
      });
    });

    it("http 上游分支：route 带 `via <upstreamHost>:<upstreamPort>`（与既有形态逐字一致）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "http");
      const dead = await getFreePort();
      const dest = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);

      await withSocks5(async (port, events) => {
        const sock = await tcConnect(port);

        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await readBytes(sock, 2);
        sock.write(socks5ConnectIpv4("127.0.0.1", dest));
        await readBytes(sock, 10);

        await waitUntil(
          () => events.some((e) => e.type === "upstream-error"),
          3000,
          "socks http 上游守卫事件",
        );
        expect(guardError(events, "[socks] error ")).toBe(
          `[socks] error 127.0.0.1 -> 127.0.0.1:${dest} via 127.0.0.1:${dead}`,
        );
        sock.destroy();
      });
    });

    it("socks 上游分支：route 补上了 `-> <host>:<port> via socks5 <upstream>`（净改进）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      const dead = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);

      await withSocks5(async (port, events) => {
        const sock = await tcConnect(port);

        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await readBytes(sock, 2);
        sock.write(socks5ConnectIpv4("10.1.2.3", 8443));
        await readBytes(sock, 10);

        await waitUntil(
          () => events.some((e) => e.type === "upstream-error"),
          3000,
          "socks socks 上游守卫事件",
        );
        expect(guardError(events, "[socks] error ")).toBe(
          `[socks] error 127.0.0.1 -> 10.1.2.3:8443 via socks5 127.0.0.1:${dead}`,
        );
        sock.destroy();
      });
    });
  });

  // -------------------------------------------------------------------------
  // websocket：socks 早分支 + 主路径上游分流的守卫 route 文本
  // -------------------------------------------------------------------------

  describe("forward/channel/upgrade", () => {
    it("经 socks5 上游：route 补上了 `-> <host>:<port> via socks5 <upstream>`（净改进）", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      const dead = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => wsFwd.handleUpgrade(req as never, socket, head, requestScope()),
        upgradeReq("target.example", 8443),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[upgrade] error ")).toBe(
          `[upgrade] error 127.0.0.1 -> target.example:8443 via socks5 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });

    it("有效 client 经 http 上游（2c 改走 connector.transport()）：route 补上了 `-> <host>:<port> via <upstream>`（旧文本是各调点随手写的差异，非契约）", async () => {
      // 2c 之前这条路径**不走连接器层**（是 websocket 里唯一一处 `this.dialer.choose` 直拨上游），
      // 它的守卫 `target` 只有 `${targets.dial.host}:${targets.dial.port}`，也就是**上游地址本身**、
      // **没有 `via` 尾巴、也看不出客户端要访问谁**。别的调点早就统一成信息最多的形态了，
      // 这里「短」纯属各调点随手写出来的差异、不是契约——2c 随「改走
      // `HttpConnectConnector.transport()`」一并统一为 "<dest> via <upstream>" 全量形式。
      set("proxyMode", "client");
      set("upstreamProtocol", "http");
      const dead = await getFreePort();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => wsFwd.handleUpgrade(req as never, socket, head, requestScope()),
        upgradeReq("target.example", 8443),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[upgrade] error ")).toBe(
          `[upgrade] error 127.0.0.1 -> target.example:8443 via 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });

    it("主路径回落直连（server 模式）：route 为 `-> <host>:<port>`，无上游尾巴", async () => {
      set("proxyMode", "server");
      const dead = await getFreePort();
      const events: PipeEvent[] = [];
      subs.push(collectPipe((e) => events.push(e)));
      const fwd = await startForwarder(
        (req, socket, head) => wsFwd.handleUpgrade(req as never, socket, head, requestScope()),
        upgradeReq("127.0.0.1", dead),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        await c.waitFor((b) => b.includes(Buffer.from("502")), 3000);
        expect(guardError(events, "[upgrade] error ")).toBe(
          `[upgrade] error 127.0.0.1 -> 127.0.0.1:${dead}`,
        );
        client.destroy();
      } finally {
        await fwd.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 上游凭证的注入判据：只由 ConnectorSource 端口给（upgrade 侧曾绕过端口）
  // -------------------------------------------------------------------------

  describe("上游凭证的注入判据只认端口（两条通道逐字同源，都不读 config、不推 `kind`）", () => {
    it("「隧道中继型」连接器：Upgrade 报文必须是 origin-form，且绝不注入 Proxy-Authorization", async () => {
      set("proxyMode", "client");
      set("upstreamProtocol", "http");
      // **上游凭证配齐**：连接器替身明说「本次不给」（`upstreamAuthHeader() === undefined`），
      // 若通道侧仍绕过端口自己 `upstreamAuthValue(this.config)`，这条就会原样漏出去。
      // 配齐之后本用例才是真的在测「判据归谁」，而不是「恰好没配凭证所以看不见」。
      set("upstreamUsername", "upstream-user");
      set("upstreamPassword", "upstream-pass");
      // 有效的上游地址（永远拨不到：走上的是替身）——只为让 client 模式的 `dial` 有个值
      const dead = await getFreePort();

      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", dead);

      // 源站桩：回 101（顺带证明报文真的落到了「真实目标」并被桥接）
      const origin = await startTcp((sock) => {
        sock.on("data", (c: Buffer) => {
          if (c.includes(Buffer.from("\r\n\r\n"))) {
            sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
          }
        });
      });

      // ⚠️ 端口对 `kind` 与 `targetForm` **零约束**：这个替身**编译期就合法**（见替身注释）
      const relay = tunnelRelayConnector();
      const relayFwd = new WsForwarder(testContext, testServices(), {
        direct: () => createConnectorSource(testContext).direct(),
        upstream: () => relay,
      });

      // 客户端发 **absolute-form**（真实 client 模式客户端的形态）：这正是判据的分水岭——
      // 判成「对端是代理」就原样保留它，判成「对端是源站」就换成 origin-form。
      // 用 origin-form 的客户端请求写不出这两者的差别（两条分支产出同一串），所以必须绝对形态。
      const absoluteUrl = `http://127.0.0.1:${origin.port}/ws`;
      const req = {
        url: absoluteUrl,
        method: "GET",
        httpVersion: "1.1",
        headers: { host: `127.0.0.1:${origin.port}` },
        rawHeaders: [
          "Host",
          `127.0.0.1:${origin.port}`,
          "Upgrade",
          "websocket",
          "Connection",
          "Upgrade",
        ],
      };

      const fwd = await startForwarder(
        (r, socket, head) => relayFwd.handleUpgrade(r as never, socket, head, requestScope()),
        req,
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        client.write(
          `GET ${absoluteUrl} HTTP/1.1\r\nHost: 127.0.0.1:${origin.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
        );
        // 101 证明报文确实送到了「真实目标」并被桥接——排除「压根没转发」那种假绿
        await c.waitFor((b) => b.includes(Buffer.from("101")), 3000);
        await waitUntil(() => origin.received().length > 0, 3000, "源站收到 Upgrade 报文");

        const received = origin.received().toString();

        // ① request-target 是 **origin-form**（对端是源站，不是 HTTP 代理）
        expect(received.split("\r\n")[0], "对端是源站 → 请求行必须是 origin-form").toBe(
          "GET /ws HTTP/1.1",
        );
        expect(received, "报文里不得残留 absolute-form 的 URL").not.toContain(absoluteUrl);

        // ② **绝不注入上游 Basic 凭证**——凭据只由 `connector.upstreamAuthHeader()` 决定
        expect(
          received.toLowerCase(),
          "上游凭证绝不发给非代理对端（端口说 undefined 就是 undefined）",
        ).not.toContain("proxy-authorization");
        expect(received, "凭证的 base64 片段也不许出现").not.toContain(
          Buffer.from("upstream-user:upstream-pass").toString("base64"),
        );

        // ③ Host 回写为真实目标 authority（证明报文确实是按「对端是源站」那套规则写的）
        expect(received.toLowerCase()).toContain(`host: 127.0.0.1:${origin.port}`);

        client.destroy();
      } finally {
        await fwd.close();
        await origin.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 连接器选择：有效路由是 direct 时必须走 directConnector，绝不碰 connectorFor
  // -------------------------------------------------------------------------

  describe("连接器选择（有效路由 direct ⟺ directConnector）", () => {
    let dir: string;
    let aclPath: string;

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-connector-wiring-"));
      aclPath = path.join(dir, "acl.json");
    });

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    /** 写 acl.json 并强制重读（跳过 1s 节流，等价于节流窗口已过） */
    function writeAcl(acl: unknown): void {
      set("aclFile", aclPath);
      fs.writeFileSync(aclPath, JSON.stringify(acl));
      readAcl({ config: testConfig, force: true });
    }

    /**
     * 造「真目标桩 + 上游代理桩」一对：拨了谁由 `received()` 判别。
     * 上游桩刻意选 sockss5 承载的 `sockss5` 协议：它是**代理型**连接器，
     * 若接线误用 `connectorFor` 就一定会去拨它（明文握手首字节 0x05 一眼可辨）。
     */
    async function startPair(): Promise<{ target: Tcp; upstream: Tcp }> {
      const target = await startTcp();
      const upstream = await startTcp((sock) => {
        // 假 SOCKS5 上游：应请求就应答（这样「误走上游」会表现为真目标没收到任何字节）
        let stage: "method" | "connect" = "method";
        sock.on("data", () => {
          if (stage === "method") {
            stage = "connect";
            sock.write(Buffer.from([0x05, 0x00]));
            return;
          }

          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        });
      });

      return { target, upstream };
    }

    it("CONNECT：client 模式 + upstream 路由名单命中 → 直拨真目标，上游桩零字节", async () => {
      writeAcl({ upstream: { blacklist: ["127.0.0.1"] } });
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      const { target, upstream } = await startPair();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const fwd = await startForwarder(
        (req, socket, head) => tunnelFwd.handleConnect(req as never, socket, head, requestScope()),
        connectReq("127.0.0.1", target.port),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        client.write("probe-through-tunnel");
        await c.waitFor((b) => b.includes(Buffer.from("200 Connection Established")), 3000);
        // 探针经隧道到达真目标 = 走的是 directConnector
        await waitUntil(
          () => target.received().includes(Buffer.from("probe-through-tunnel")),
          3000,
          "真目标收到探针",
        );
        expect(target.received().length).toBeGreaterThan(0);
        // 上游桩一个字节都没收到 = 绝没有走 connectorFor
        expect(upstream.received().length).toBe(0);
        client.destroy();
      } finally {
        await fwd.close();
        await target.close();
        await upstream.close();
      }
    });

    it("WebSocket：client 模式 + upstream 路由名单命中 → 直拨真目标并等 101，上游桩零字节", async () => {
      writeAcl({ upstream: { blacklist: ["127.0.0.1"] } });
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      // 真目标会回 101（裸状态行 + CRLFCRLF 即可，relay 不校验 Upgrade 头）
      const target = await startTcp((sock) => {
        sock.on("data", (c: Buffer) => {
          if (c.includes(Buffer.from("\r\n\r\n"))) {
            sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
          }
        });
      });
      const upstream = await startTcp((sock) => {
        let stage: "method" | "connect" = "method";
        sock.on("data", () => {
          if (stage === "method") {
            stage = "connect";
            sock.write(Buffer.from([0x05, 0x00]));
            return;
          }

          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        });
      });
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const fwd = await startForwarder(
        (req, socket, head) => wsFwd.handleUpgrade(req as never, socket, head, requestScope()),
        upgradeReq("127.0.0.1", target.port),
      );

      try {
        const client = await tcConnect(fwd.port);
        const c = makeCollector(client);

        client.write("GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n\r\n");
        await c.waitFor((b) => b.includes(Buffer.from("101")), 3000);
        // origin-form + Host 回写真实目标（不是上游地址）
        await waitUntil(
          () => target.received().includes(Buffer.from("Host: 127.0.0.1")),
          3000,
          "真目标收到 Upgrade",
        );
        expect(target.received().toString().startsWith("GET /ws HTTP/1.1")).toBe(true);
        // 绝不带上游凭证头
        expect(target.received().toString().toLowerCase()).not.toContain("proxy-authorization");
        expect(upstream.received().length).toBe(0);
        client.destroy();
      } finally {
        await fwd.close();
        await target.close();
        await upstream.close();
      }
    });

    it("SOCKS：client 模式 + upstream 路由名单命中 → 直拨真目标并回成功应答，上游桩零字节", async () => {
      writeAcl({ upstream: { blacklist: ["127.0.0.1"] } });
      set("proxyMode", "client");
      set("upstreamProtocol", "socks5");
      const { target, upstream } = await startPair();
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const events: PipeEvent[] = [];

      subs.push(collectPipe((e) => events.push(e)));
      await withProxy(Socks5Proxy, { access: fileAccess }, async (port) => {
        const sock = await tcConnect(port);

        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await readBytes(sock, 2);
        sock.write(socks5ConnectIpv4("127.0.0.1", target.port));

        const reply = await readBytes(sock, 10);

        // 成功应答（REP=0x00）；误走 connectorFor 时真目标收不到任何字节
        expect(reply[1]).toBe(0x00);
        sock.write("probe-through-socks");
        await waitUntil(
          () => target.received().includes(Buffer.from("probe-through-socks")),
          3000,
          "真目标收到探针",
        );
        expect(upstream.received().length).toBe(0);
        sock.destroy();
      });
    });
  });
});

/** 订阅共享测试总线上的 `pipe` 事实（core 直发，订阅源取注入的 ctx.events） */
function collectPipe(sink: (e: PipeEvent) => void): EventSubscription {
  return testEvents.subscribe("pipe", (e) => sink(e.data));
}
