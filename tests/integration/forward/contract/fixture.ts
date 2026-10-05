/**
 * 五档共用的装配面：裸 TCP 源站 / 假 SOCKS5 上游、真 `HttpProxy` 起停、裸 socket 客户端、配置快照。
 *
 * 出站形态那张合同表与 `contract/` 锁住的三条决策**随 `../AGENTS.md` 住**，不在本模块：
 * 五个档各自逐字钉其中一行，而它们描述的是同一套装配的性质，抄进五份就是五份会各自漂的真相；
 * 且那三条决策**跨目录互相点名**（② 把逐字断言指到 `../connector-wiring/`，③ 把「超时 → 504」
 * 那一半指到平铺层的 `../http-via-socks.test.ts`），住在某个 fixture 的头里就是让另两处引用
 * 指不到家。
 *
 * ⚠️ **刻意住在 `tests/integration/forward/contract/` 而不是 `tests/helpers/`**：`external-network-scan.ts`
 * 的 `SCAN_DIRS` 排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` —— 搬进 `helpers/`
 * 等于让这里这一部分覆盖从零外网扫描里**静默消失**（`no-external-network.test.ts` 的两条
 * 下界断言照样绿）。
 *
 * @module tests/integration/forward/contract
 */
import { afterEach } from "vitest";
import net from "node:net";
import { FileAccountIdentity } from "@/core/identity.js";
import { HttpProxy } from "@/core/server/http.js";
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
import { getFreePort } from "../../../helpers/net.js";
import { openAccessControl } from "../../../helpers/access.js";

/** 本目录涉及的配置键（逐键快照/恢复） */
const KEYS = [
  "host",
  "port",
  "proxyMode",
  "upstreamProtocol",
  "upstreamHost",
  "upstreamPort",
  "upstreamCa",
  "upstreamInsecure",
  "upstreamUsername",
  "upstreamPassword",
  "upstreamTimeout",
  "logLevel",
  "logFile",
] as const;

export const UPSTREAM_USER = "up-user";
export const UPSTREAM_PASS = "up-pass";
export const UPSTREAM_BASIC = `Basic ${Buffer.from(`${UPSTREAM_USER}:${UPSTREAM_PASS}`).toString("base64")}`;

/** 裸 TCP 端点：记录收到的请求头原文，按需回一段固定应答 */
export interface Raw {
  port: number;
  /** 收到的全部字节（逐字节断言用） */
  received: () => Buffer;
  close: () => Promise<void>;
}

const RAWS: Raw[] = [];
const PROXIES: HttpProxy[] = [];
const SUBS: EventSubscription[] = [];
const CLIENTS: net.Socket[] = [];
let SNAP: Record<string, unknown> = {};

afterEach(async () => {
  for (const s of SUBS.splice(0)) {
    s.dispose();
  }

  for (const c of CLIENTS.splice(0)) {
    if (!c.destroyed) {
      c.destroy();
    }
  }

  await stopProxies();

  while (RAWS.length) {
    await (RAWS.pop() as Raw).close();
  }

  restoreConfig(SNAP);
});

/** 停掉本档已起的全部 `HttpProxy`（同一用例要在同一份配置上换一条上游时用） */
export async function stopProxies(): Promise<void> {
  while (PROXIES.length) {
    await (PROXIES.pop() as HttpProxy).stop().catch(() => undefined);
  }
}

/** 裸 TCP 桩（源站 / 明文 http 上游通用） */
export async function startRaw(
  reply: string,
  onConn?: (sock: net.Socket) => void,
  host = "127.0.0.1",
): Promise<Raw> {
  const chunks: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (c: Buffer) => {
      chunks.push(c);
      // 只在收到完整请求头后应答一次
      if (Buffer.concat(chunks).includes("\r\n\r\n")) {
        sock.write(reply);
      }
    });
    onConn?.(sock);
  });
  // 直接 listen(0) 再读回实际端口：`getFreePort()`（先 listen(0) → close → 重绑）有 TOCTOU 竞态，
  // 并行跑全套时那个端口号可能已被别的监听抢走，表现为偶发 502（IPv6 用例尤其明显）。
  // 也因此不用 helpers/net 的 listen()：它恒绑 127.0.0.1，而 IPv6 用例要绑 ::1。
  await new Promise<void>((r) => server.listen(0, host, () => r()));
  const port = (server.address() as net.AddressInfo).port;

  const raw: Raw = {
    port,
    received: () => Buffer.concat(chunks),
    close: async () => {
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  RAWS.push(raw);
  return raw;
}

/** 登记一个自己手搓的裸 TCP 端点，交由模块级 `afterEach` 回收（`tls.Server` 那类 `startRaw` 覆盖不到的形态） */
export function trackRaw(raw: Raw): Raw {
  RAWS.push(raw);
  return raw;
}

/** 源站应答：200 + 2 字节正文 + close（裸 TCP 才能让畸形 request-target 现形） */
export const ORIGIN_REPLY = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

/**
 * 假 SOCKS5 上游：方法协商挑 0x00 → CONNECT 真隧道到目标
 *
 * @description CONNECT 的 ATYP 三种都要认（IPv4 字面量 / 域名 / **IPv6 字面量**）：
 * 本仓库的 SOCKS5 连接器对 IPv6 字面量用 ATYP=0x04 + 16 字节（域名型无 v6 语义），
 * 只按域名型解包会把 IPv6 用例的桩解错、误报成「目标拨不通」。
 */
export async function startSocks5Upstream(): Promise<Raw> {
  return startRaw("", (sock) => {
    let stage: "method" | "connect" = "method";

    sock.on("data", (req: Buffer) => {
      if (stage === "method") {
        stage = "connect";
        sock.write(Buffer.from([0x05, 0x00]));
        return;
      }

      const atyp = req[3];
      let host: string;
      let portAt: number;

      if (atyp === 0x01) {
        host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
        portAt = 8;
      } else if (atyp === 0x04) {
        const parts: string[] = [];

        for (let i = 0; i < 16; i += 2) {
          parts.push(((req[4 + i] << 8) | req[5 + i]).toString(16));
        }
        host = parts.join(":");
        portAt = 20;
      } else {
        const len = req[4];
        host = req.subarray(5, 5 + len).toString();
        portAt = 5 + len;
      }

      const port = req.readUInt16BE(portAt);
      // **必须摘掉 data 监听**：建隧后 `sock.pipe(target)` 会让隧内字节再次进入本回调，
      // 留着它等于把隧内的 HTTP 请求当成第二个 CONNECT 解包 → 桩自己把 socket 拆了，
      // 代理侧表现为偶发 502「socket hang up」（`upstream/matrix-*` 的桩同理）
      sock.removeAllListeners("data");

      const target = net.connect(port, host, () => {
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        sock.pipe(target);
        target.pipe(sock);
      });

      target.on("error", () => sock.destroy());
    });
  });
}

/** 起一个真 HttpProxy（server 模式，鉴权关闭；与名单无关 → 显式点名「不判名单」） */
export async function startProxy(): Promise<number> {
  const port = await getFreePort();
  const proxy = new HttpProxy({
    ctx: testContext,
    host: "127.0.0.1",
    port,
    identity: new FileAccountIdentity({ enabled: false }),
    access: openAccessControl(),
  });

  await proxy.start();
  PROXIES.push(proxy);
  return port;
}

/**
 * 裸 socket 发一段原始请求，读到对端关闭或超时；返回状态行与完整原文
 *
 * @description 客户端侧一律补 `Connection: close`（除调用方已自带时）：否则代理回完响应
 * 会把客户端连接留成 keep-alive，用例只能等 `ms` 超时兜底（既慢又不确定）。
 * 这只影响**入站**连接，与本目录断言的**出站**报文头无关。
 */
export function rawRequest(
  port: number,
  raw: string,
  ms = 5000,
): Promise<{ status: number; text: string }> {
  const head = raw.toLowerCase().includes("\r\nconnection:")
    ? raw
    : raw.replace("\r\n\r\n", "\r\nConnection: close\r\n\r\n");

  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(head);
    });

    CLIENTS.push(sock);

    let text = "";
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ status: Number(text.split(" ")[1]) || 0, text });
    }, ms);

    sock.on("data", (c: Buffer) => {
      text += c.toString();
    });
    sock.on("close", () => {
      clearTimeout(timer);
      resolve({ status: Number(text.split(" ")[1]) || 0, text });
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** 订阅共享测试总线上的 pipe 事实（core 直发，订阅源取注入的 ctx.events） */
export function collectPipe(): PipeEvent[] {
  const events: PipeEvent[] = [];

  SUBS.push(testEvents.subscribe("pipe", (e) => events.push(e.data)));
  return events;
}

/** 请求头字典（键小写，取首个值） */
export function headers(head: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const line of head.split("\r\n").slice(1)) {
    if (line === "") {
      break;
    }
    const idx = line.indexOf(":");
    out[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
  }

  return out;
}

/** 请求行（首行原文） */
export function requestLine(head: string): string {
  return head.split("\r\n")[0] ?? "";
}

export function setup(): void {
  SNAP = snapshotConfig(KEYS);
  silenceLogs();
  set("authEnabled", false);
  set("authType", "none");
  set("host", "127.0.0.1");
  // 哨兵端口：isSelfLoop 读配置里的 host/port，用 1 避免把测试内的随机端口误判成自环
  set("port", 1);
  set("upstreamUsername", "");
  set("upstreamPassword", "");
}