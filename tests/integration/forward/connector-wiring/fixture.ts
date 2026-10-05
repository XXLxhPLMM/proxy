/**
 * 五档共用的装配面：转发器实例、连接器源替身、裸 TCP 桩、共享事件订阅与配置 hook。
 *
 * 三条「拿到一条字节管道然后桥接」的路径全部经 `forward/upstream/connector` 统一层，本目录锁
 * 三件**一旦接线就可能悄悄漂移**的东西：守卫日志的 route 文本（逐字契约）、`refusal` 透传
 * （tunnel 经 http(s) 上游）、连接器选择（有效路由 direct ⟺ `connectors.direct()`）。
 * 五条目录级决策 ①–⑤ 与判据为什么长这样**随 `../AGENTS.md` 住**（它们跨目录点名 `../contract/`
 * 的 ②③ 两条），本模块只提供这一套装配符号。
 *
 * ⚠️ **刻意住在 `tests/integration/forward/connector-wiring/` 而不是 `tests/helpers/`**：
 * `external-network-scan.ts` 的 `SCAN_DIRS` 排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` ——
 * 搬进 `helpers/` 等于让这里这一部分覆盖从零外网扫描里**静默消失**（`no-external-network.test.ts`
 * 的两条下界断言照样绿）。
 *
 * @module tests/integration/forward/connector-wiring
 */
import { afterEach, beforeEach } from "vitest";
import net from "node:net";
import type { Duplex } from "node:stream";
import { TunnelForwarder } from "@/core/forward/channel/tunnel.js";
import { WsForwarder } from "@/core/forward/channel/upgrade.js";
import { inertUsageAccount as INERT_TRAFFIC } from "@/datasource/quota/index.js";
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
import type { EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import {
  restoreConfig,
  set,
  silenceLogs,
  snapshotConfig,
  testContext,
  testEvents,
} from "../../../helpers/config.js";
import { getFreePort, listen, sleep } from "../../../helpers/net.js";

/** 本目录涉及的配置键（逐键快照/恢复，不依赖生产全局 store） */
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

/** 挂在共享测试总线上的 pipe 订阅，由模块级 `afterEach` 统一 dispose（共享总线不清理会跨用例累积） */
export const subs: EventSubscription[] = [];

let snap: Record<string, unknown> = {};

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

/** 起一个裸 TCP server 的可关闭句柄，并记录每条连接的远端地址（守卫 route 前半段同源） */
export interface Tcp {
  port: number;
  close: () => Promise<void>;
  /** 收到的全部字节（判「上游桩到底有没有被碰过」） */
  received: () => Buffer;
}

export async function startTcp(onConn?: (sock: net.Socket) => void): Promise<Tcp> {
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
export function requestScope(): ReturnType<typeof createRequestScope> {
  return createRequestScope({ ctx: testContext, terminal: new RequestTerminal() });
}

/**
 * 转发器构造期收的三样（ctx / services / connectors）在本目录就地造。
 *
 * 形状与 `createProxyRuntime → BaseProxy` 的归一结果逐字同形：
 * - `identity` 取显式 inert 档：本目录全部用例都不走鉴权，直构转发器更是拿不到准入层；
 * - `access` **必须是真名单判定**：本目录有「上游路由名单命中 → 回落直连」与「目标名单」两条护栏
 *   走 `preDial` / `routePolicy`，接上放行档等于把它们静默废掉；
 * - `traffic` 取显式禁用档。
 *
 * ⚠️ 这两个工厂**本应**住在 `tests/helpers/proxy.ts`（紧邻 `withProxy`）：`CoreServices` 与
 * `ConnectorSource` 都是全必填、形状固定的装配物，抄到每个文件里就是「同一个真相抄 N 份」。
 * 它就地定义而没有放进 `tests/helpers/**`（登记在 `tests/AGENTS.md`，待收口）。
 */
export function testServices(): CoreServices {
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
 * `ProxyOptions.access` 是**必填**的（`access: AccessControl`，无 `?`）：全仓不存在
 * `OPEN_ACCESS_CONTROL` 那个「恒放行」符号，**缺席即全放行**，所以必须编译期拦。
 * 本目录既直构转发器又经
 * `withProxy` 直构 core，两条路都必须显式注入，否则「upstream 路由名单命中 → 回落直连」
 * 与「目标名单」两条护栏整条消失。
 *
 * ⚠️ 本应与 `testServices` 共住在 `tests/helpers/proxy.ts` 紧邻 `withProxy`（那里是所有直构
 * core 的汇聚点）；债的登记见上面 `testServices` 那条。
 */
export const fileAccess = createFileAccessControl(testContext.config);

/**
 * 连接器源：**现读** `upstreamProtocol` 的那份。
 *
 * 生产默认实现 `createConnectorSource(ctx)` 把「走上游」记忆在一份 source 上，这正确性挂在
 * 「`UPSTREAM_PROTOCOL` 是 startup 相位、accessor 对它读冻结值」这条不变式上——真实 runtime
 * 里一份 source 终身只对应一份协议。本目录**逐用例 `set("upstreamProtocol", …)`**（http / socks5
 * 两档轮换），那个前提不成立：沿用记忆化那份会让第一个走上游的用例把协议粘住，后续档位拿到的
 * 是上一档的连接器，route 文本断言直接测到别的东西。
 *
 * 故这里每次问都现造一份。`ConnectorSource` 是**端口**，「记忆化」只是默认实现的一个选择，
 * 不是端口契约——本目录实现的是同一端口的另一个合法选择（现读档）。这与「每请求现读协议」那条
 * 每请求 `connectorFor(protocol, config)` 的行为逐字同形，也就是本目录这些断言观察的语义。
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
 * - `isSocksTunnel(替身)` === false（`kind` 不是 socks4/5）→ 按 `mode` 推的那条判据
 *   （`mode === "client" && !viaSocksTunnel`）判成 **true**（=「对端是代理」）
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
export function tunnelRelayConnector(): UpstreamConnector {
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
 * 所以「建一次、多连接复用」是合法的（也正是 `../instance-reuse.test.ts`
 * 锁的那条不变性）。`testContext` 是常量，故这里可以安全地提到模块级。
 */
export const tunnelFwd = new TunnelForwarder(testContext, testServices(), testConnectors());
export const wsFwd = new WsForwarder(testContext, testServices(), testConnectors());

/**
 * 本地转发器：把每条连接 socket 原样交给 forward（模拟 HttpProxy 的 connect/upgrade 委派），
 * forward 内部按当前 store 配置拨上游
 */
export async function startForwarder(
  forward: (req: unknown, socket: net.Socket, head: Buffer) => void,
  fakeReq: unknown,
): Promise<Tcp> {
  return startTcp((sock) => {
    forward(fakeReq, sock, Buffer.alloc(0));
  });
}

/** CONNECT 伪请求：`parseAuthority` 只认 url */
export function connectReq(host: string, port: number): unknown {
  return { url: `${host}:${port}`, headers: {}, method: "CONNECT" };
}

/** Upgrade 伪请求：目标在 Host 头（origin-form 形态，与真实客户端一致） */
export function upgradeReq(host: string, port: number): unknown {
  return {
    url: "/ws",
    method: "GET",
    httpVersion: "1.1",
    headers: { host: `${host}:${port}` },
    rawHeaders: ["Host", `${host}:${port}`, "Upgrade", "websocket", "Connection", "Upgrade"],
  };
}

/** 订阅共享测试总线上的 `pipe` 事实（core 直发，订阅源取注入的 ctx.events） */
export function collectPipe(sink: (e: PipeEvent) => void): EventSubscription {
  return testEvents.subscribe("pipe", (e) => sink(e.data));
}

/** 从事件流里取第一条 `type === "upstream-error"` 且 message 带指定前缀的事件文本 */
export function guardError(events: PipeEvent[], prefix: string): string {
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
export function readBytes(sock: net.Socket, n: number, ms = 3000): Promise<Buffer> {
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
export async function waitUntil(cond: () => boolean, timeoutMs = 3000, label = ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (cond()) {
      return;
    }

    await sleep(10);
  }

  throw new Error(`waitUntil 超时${label ? `：${label}` : ""}`);
}