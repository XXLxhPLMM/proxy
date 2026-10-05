/**
 * 两档 `instance-reuse*` 共用的装配面：自建事件总线与 ctx、SOCKS5 探针子类、裸 TCP 回声桩、
 * 消费式读字节、absolute-form GET（带入站连接身份编号）与那份配置键表。
 *
 * 档级不变量（构造次数不随请求数增长 / 身份维度绝不串号各自的判据）归 `./AGENTS.md`，
 * 本模块只提供两档共用的那一套符号。**本模块不导出任何 hook** —— 两档的
 * `beforeAll` / `afterEach` / `afterAll` 三段各自要起不同的桩、留不同的订阅，
 * 只有「哨兵配置」那一段是逐字相同的，故只把那一段收成 {@link sentinelBaseConfig}。
 *
 * ⚠️ **刻意住在 `tests/integration/forward/` 而不是 `tests/helpers/`**：`external-network-scan.ts`
 * 的 `SCAN_DIRS` 排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` —— 搬进 `helpers/`
 * 等于让这里这一部分覆盖从零外网扫描里**静默消失**（`no-external-network.test.ts` 的两条
 * 下界断言照样绿）。
 *
 * @module tests/integration/forward
 */
import http from "node:http";
import net from "node:net";
import { Socks5Proxy } from "@/core/server/socks5.js";
import type { SocksForwarder } from "@/core/forward/channel/socks.js";
import { EventHub } from "@/core/events/index.js";
import type { CoreContext } from "@/core/context.js";
import { getFreePort, listen } from "../../helpers/net.js";
import { set, silenceLogs, testConfig, testLogger } from "../../helpers/config.js";

/** 本模块自建一条总线：往共享测试总线上挂长期订阅会跨用例累积 */
export const bus = new EventHub({ onListenerError: () => undefined });
export const ctx: CoreContext = { config: testConfig, logger: testLogger, events: bus };

/** 本模块涉及的配置键（逐键快照/恢复） */
export const KEYS = [
  "host",
  "port",
  "proxyMode",
  "upstreamProtocol",
  "upstreamHost",
  "upstreamPort",
  "upstreamTimeout",
  "logLevel",
  "logFile",
] as const;

/** 探针子类：把 `protected` 的转发器字段暴露给断言（不扩大生产代码的可观测面） */
export class ProbeSocks5Proxy extends Socks5Proxy {
  get socksForwarder(): SocksForwarder {
    return this.forwarder;
  }
}

/**
 * 两档 `beforeAll` 共用的那段基础配置
 *
 * @description
 * `set("port", 1)` 是**哨兵**：真实监听端口由每条用例自己取，而 `isSelfLoopAddr` 拿配置里的
 * `host` / `port` 当被环目标，哨兵值保证那些随机端口不会被误判成自环。
 */
export function sentinelBaseConfig(): void {
  silenceLogs();
  set("host", "127.0.0.1");
  // 哨兵端口：确保 isSelfLoop 不会把测试内的随机临时端口误判为自环
  set("port", 1);
  set("proxyMode", "server");
}

/** 跨用例存活的入站 socket 池：用例自己 push，回收统一走 {@link discardOpenSockets} */
export const openSockets: net.Socket[] = [];

/** 收干 socket 池（`afterEach` 的登记体；调用点自己补它那一档特有的清理） */
export function discardOpenSockets(): void {
  for (const s of openSockets.splice(0)) {
    s.destroy();
  }
}

/** 消费式读满 n 字节（跨 TCP 分段安全；**逐次消费**——累积缓冲的绝对下标在多段报文里会错位） */
export function readBytes(sock: net.Socket, n: number, ms = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = (): void => {
      sock.off("data", onData);
      sock.off("error", onError);
      clearTimeout(timer);
    };
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < n) {
        return;
      }
      cleanup();
      resolve(buf.subarray(0, n));
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(e);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`readBytes 超时：只读到 ${buf.length}/${n} 字节`));
    }, ms);
    sock.on("data", onData);
    sock.on("error", onError);
  });
}

/** 裸 TCP 桩的通用形态：给一段 `onConn`，回一个可关闭句柄 */
export async function startRaw(onConn: (sock: net.Socket) => void): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    onConn(sock);
  });
  const port = await getFreePort();
  await listen(server, port);

  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) {
          s.destroy();
        }
        server.close(() => r());
      }),
  };
}

/** 裸 TCP 回声桩：CONNECT / SOCKS 隧道的对端（绝不能给 http.Server，否则测到的会是协议解析） */
export async function startRawTarget(): Promise<{ port: number; close: () => Promise<void> }> {
  return startRaw((sock) => {
    sock.on("data", (c) => sock.write(c));
  });
}

/** 入站 socket 对象的身份编号：用来判「两个请求是不是同一条 TCP 连接」 */
const connIds = new Map<net.Socket, number>();
let nextConnId = 0;

/** 经代理发一个 absolute-form GET；返回 `conn`（入站连接身份，同一条连接上多次请求恒等） */
export function proxyGet(
  proxyPort: number,
  targetPort: number,
  path: string,
  opts: { agent?: http.Agent; headers?: Record<string, string> } = {},
): Promise<{ status: number; conn: number }> {
  return new Promise((resolve, reject) => {
    let conn = -1;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://127.0.0.1:${targetPort}${path}`,
        headers: { Host: `127.0.0.1:${targetPort}`, ...(opts.headers ?? {}) },
        ...(opts.agent ? { agent: opts.agent } : {}),
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, conn }));
      },
    );
    req.on("socket", (s) => {
      let id = connIds.get(s);
      if (id === undefined) {
        id = ++nextConnId;
        connIds.set(s, id);
      }
      conn = id;
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}
