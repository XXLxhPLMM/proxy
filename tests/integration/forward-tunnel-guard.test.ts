/**
 * @fileoverview forwardTunnel / forwardUpgrade 守卫与首包方向回归
 * @description
 * 直击两个转发器的真实缺陷：
 * - tunnel：client→http 上游的 CONNECT 隧道，200 建链后守卫定时器必须清除，
 *   否则存活超过 upstreamTimeout 会被误写 504 拆链；上游非 200 需原样回透并断链；
 *   客户端 CONNECT authority 非法（`:443`）属请求报文错误，回 400 而非 502。
 * - websocket：Upgrade 必须严格解析状态行判 101，`302` + `Content-Length: 1010`
 *   之类子串不得被当成升级成功而误桥接。
 *
 * 形态：进程内真实 TunnelForwarder/WsForwarder（forwardTunnel/forwardUpgrade），
 * store 显式 set 配置，本地 net.Server 承接客户端 socket，假上游为 raw net.Server。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { set } from "@/config/store.js";
import { forwardTunnel } from "@/core/forward/tunnel.js";
import { forwardUpgrade } from "@/core/forward/websocket.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";

/** 可关闭句柄：销毁存活连接后再关监听，避免测试悬挂 */
interface Handle {
  port: number;
  close: () => Promise<void>;
}

/**
 * 假上游：读到首个 `\r\n\r\n`（建链/升级请求）后执行 respond，
 * respond 内自行决定回 200/407/302 及后续回显
 */
function startFakeUpstream(respond: (sock: net.Socket) => void): Promise<Handle> {
  return startTcpServer((sock) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.indexOf("\r\n\r\n") === -1) {
        return;
      }
      sock.off("data", onData);
      respond(sock);
    };
    sock.on("data", onData);
  });
}

/**
 * 本地转发器：把每条连接 socket 原样交给 forward（模拟 HttpProxy 的 connect/upgrade 委派），
 * forward 内部按当前 store 配置拨上游
 */
function startLocalForwarder(
  forward: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void,
  fakeReq: http.IncomingMessage,
): Promise<Handle> {
  return startTcpServer((socket) => {
    forward(fakeReq, socket, Buffer.alloc(0));
  });
}

/** 通用 net.Server 启动器：跟踪连接，close 时先销毁存活 socket 再关监听 */
function startTcpServer(onConn: (sock: net.Socket) => void): Promise<Handle> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      sock.on("error", () => {});
      onConn(sock);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) {
              s.destroy();
            }
            server.close(() => r());
          }),
      });
    });
  });
}

/** 客户端连接：累积接收文本 + 记录是否已关闭 */
interface ClientProbe {
  socket: net.Socket;
  text: () => string;
  closed: () => boolean;
}

function connectClient(port: number): Promise<ClientProbe> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    let closed = false;
    socket.on("data", (c: Buffer) => {
      text += c.toString("latin1");
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      closed = true;
    });
    socket.once("connect", () => resolve({ socket, text: () => text, closed: () => closed }));
    socket.once("error", reject);
  });
}

/** 轮询等待条件成立，超时抛错（避免固定 sleep 造成的抖动） */
async function waitUntil(cond: () => boolean, timeoutMs = 3000, label = ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitUntil 超时${label ? `：${label}` : ""}`);
}

const CONNECT_REQ = {
  url: "example.com:80",
  headers: {},
  method: "CONNECT",
} as unknown as http.IncomingMessage;

const UPGRADE_REQ = {
  url: "/ws",
  method: "GET",
  httpVersion: "1.1",
  headers: { host: "example.com:80" },
  rawHeaders: ["Host", "example.com:80", "Upgrade", "websocket", "Connection", "Upgrade"],
} as unknown as http.IncomingMessage;

describe("integration/forward-tunnel-guard", () => {
  const prev = snapshotConfig(["proxyMode", "upstreamProtocol", "upstreamHost", "upstreamPort", "upstreamTimeout", "host", "port", "logLevel", "logFile"]);

  beforeAll(() => {
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamTimeout", 300);
    set("host", "127.0.0.1");
    // 哨兵端口：确保 isSelfLoop 不会把测试内随机临时端口误判为自环
    set("port", 1);
    silenceLogs();
  });

  afterAll(() => {
    restoreConfig(prev);
  });

  it("CONNECT 隧道：200 建链后存活超过 upstreamTimeout 仍可回显（回归 #1 定时器不清）", async () => {
    const upstream = await startFakeUpstream((sock) => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      sock.on("data", (c: Buffer) => sock.write(c));
    });
    const forwarder = await startLocalForwarder(forwardTunnel, CONNECT_REQ);
    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const client = await connectClient(forwarder.port);
      await waitUntil(
        () => client.text().includes("200 Connection Established"),
        3000,
        "隧道 200",
      );

      // 睡过 upstreamTimeout：修复前此时已被守卫定时器写入 504 并拆链
      await new Promise((r) => setTimeout(r, 800));
      expect(client.text()).not.toContain("504");

      client.socket.write("ping-after-timeout");
      await waitUntil(() => client.text().includes("ping-after-timeout"), 3000, "隧道回显");
      expect(client.text()).toContain("ping-after-timeout");

      client.socket.destroy();
    } finally {
      await forwarder.close();
      await upstream.close();
    }
  });

  it("CONNECT 隧道：上游回非 200（407）时客户端收到原样响应并断链", async () => {
    const upstream = await startFakeUpstream((sock) => {
      sock.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Proxy"\r\n\r\n',
      );
    });
    const forwarder = await startLocalForwarder(forwardTunnel, CONNECT_REQ);
    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const client = await connectClient(forwarder.port);
      await waitUntil(() => client.text().includes("407"), 3000, "407 响应");
      expect(client.text()).toContain("HTTP/1.1 407 Proxy Authentication Required");
      expect(client.text()).toContain("Proxy-Authenticate");

      await waitUntil(() => client.closed(), 2000, "非 200 断链");
      client.socket.destroy();
    } finally {
      await forwarder.close();
      await upstream.close();
    }
  });

  it("CONNECT：authority 非法（:443）回 400 并断链（回归误回 502）", async () => {
    // 解析失败发生在拨号之前，无需假上游；客户端报文非法应回 400，而不是网关错误 502
    const forwarder = await startLocalForwarder(
      forwardTunnel,
      { url: ":443", headers: {}, method: "CONNECT" } as unknown as http.IncomingMessage,
    );
    try {
      const client = await connectClient(forwarder.port);
      await waitUntil(() => client.text().includes("400"), 3000, "400 响应");
      expect(client.text()).toContain("HTTP/1.1 400 Bad Request");

      await waitUntil(() => client.closed(), 2000, "400 断链");
      client.socket.destroy();
    } finally {
      await forwarder.close();
    }
  });

  it("Upgrade：302 + Content-Length: 1010 不被误判为 101 桥接（回归 #4 子串匹配）", async () => {
    // 非 101 走「透传响应 + 按上游 EOF 收尾」：假上游必须 end()，客户端才会随上游结束而关闭
    const upstream = await startFakeUpstream((sock) => {
      sock.end("HTTP/1.1 302 Found\r\nLocation: /x\r\nContent-Length: 1010\r\n\r\nbody");
    });
    const forwarder = await startLocalForwarder(forwardUpgrade, UPGRADE_REQ);
    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const client = await connectClient(forwarder.port);
      await waitUntil(() => client.text().includes("body"), 3000, "302 原文");
      expect(client.text()).toContain("HTTP/1.1 302 Found");
      expect(client.text()).toContain("Content-Length: 1010");

      // 非 101 → 响应原文回透后随上游 EOF 收尾（修复前被当 101 桥接则连接保持打开）
      await waitUntil(() => client.closed(), 2000, "非 101 收尾");
      client.socket.destroy();
    } finally {
      await forwarder.close();
      await upstream.close();
    }
  });

  it("Upgrade：状态行非 101 但响应头内出现 101 子串仍不被误判（回归 #4）", async () => {
    const upstream = await startFakeUpstream((sock) => {
      sock.end("HTTP/1.1 200 OK\r\nContent-Length: 101\r\n\r\nok");
    });
    const forwarder = await startLocalForwarder(forwardUpgrade, UPGRADE_REQ);
    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", upstream.port);

      const client = await connectClient(forwarder.port);
      await waitUntil(() => client.text().includes("ok"), 3000, "200 原文");
      expect(client.text()).toContain("HTTP/1.1 200 OK");
      expect(client.text()).toContain("Content-Length: 101");

      await waitUntil(() => client.closed(), 2000, "非 101 收尾");
      client.socket.destroy();
    } finally {
      await forwarder.close();
      await upstream.close();
    }
  });
});
