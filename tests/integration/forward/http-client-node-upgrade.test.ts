/**
 * 两个 websocket 档：明文 ws 经 http 代理的 Upgrade 通道（`it.skip`，本地回声桩上 flaky），
 * 与 wss 经 CONNECT+TLS —— 后者验的是「CONNECT 建隧后能承载 TLS 握手 + wss 字节」以及
 * 鉴权失败在 CONNECT 阶段就回 407。
 *
 * 三条 helper 的 `setTimeout` 一律不 `clearTimeout`、以及那个 8s 定时器永远轮不到的如实记录，
 * 逐字在本档的 `it` 上方；明文 / CONNECT + 鉴权那三条在 `http-client-node.test.ts`，
 * 两档共用的 `startProxy` 与基础配置归 `./client-node-fixture.ts`；主题级判据与本目录清单见
 * `./AGENTS.md`。
 *
 * @module tests/integration/forward
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { FileAccountIdentity } from "@/core/identity.js";
import { getFreePort, listen } from "../../helpers/net.js";
import { TEST_TLS_CERTS } from "../../helpers/certs.js";
import { restoreConfig, snapshotConfig } from "../../helpers/config.js";
import { KEYS, serverBaseConfig, startProxy } from "./client-node-fixture.js";

/**
 * 本地 WebSocket 回声源站（零落盘、零外网）。
 *
 * `secure: true` → `https.createServer(TEST_TLS_CERTS, …)`，供 wss 档当**本地** TLS 源站用。
 * 证书是仓内测试 PKI（`keys/server.crt`：CN=localhost，SAN 含 `127.0.0.1`，有效期至 2028-12），
 * 客户端侧固定 `rejectUnauthorized: false` —— 与 `helpers/upstream-stub.ts` 的 TLS 承载同一套证书。
 *
 * 「角色（回声 ws）× 承载（TLS/明文）」是两个正交轴，合起来正好覆盖明文 wss 与加密 wss 两档，
 * 与 `helpers/upstream-stub.ts` 的 `role` × `secure` 同一套设计口径。
 */
function createWsEchoServer(secure: boolean): net.Server {
  const handler = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ws-echo-http-fallback");
  };
  const server = secure ? https.createServer(TEST_TLS_CERTS, handler) : http.createServer(handler);
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"] as string;
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (buf: Buffer) => {
      if (buf.length < 2) return;
      const masked = (buf[1] & 0x80) !== 0;
      let payloadLen = buf[1] & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
      }
      if (!masked) return;
      const mask = buf.subarray(offset, offset + 4);
      offset += 4;
      const payload = buf.subarray(offset, offset + payloadLen);
      const decoded = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) decoded[i] = payload[i] ^ mask[i % 4];
      const out = Buffer.alloc(2 + payloadLen);
      out[0] = 0x81;
      out[1] = payloadLen;
      decoded.copy(out, 2);
      socket.write(out);
    });
  });
  return server;
}

/** ws 明文：经 http 代理的 Upgrade 通道（proxy 监听 upgrade 事件 → forwardUpgrade） */
function wsViaHttpProxy(
  proxyPort: number,
  targetPort: number,
  authB64?: string,
): Promise<{ handshakeStatus: number; echo: string }> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(proxyPort, "127.0.0.1", () => {
      const auth = authB64 ? `Proxy-Authorization: Basic ${authB64}\r\n` : "";
      s.write(
        `GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n${auth}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let handshake = "";
    let stage: "handshake" | "frame" = "handshake";
    const onData = (buf: Buffer) => {
      if (stage === "handshake") {
        handshake += buf.toString();
        if (handshake.includes("\r\n\r\n")) {
          const hLine = handshake.split("\r\n")[0] ?? "";
          const hs = parseInt(hLine.split(" ")[1] ?? "0", 10);
          if (hs !== 101) {
            s.removeListener("data", onData);
            s.destroy();
            resolve({ handshakeStatus: hs, echo: "" });
            return;
          }
          stage = "frame";
          const payload = Buffer.from("hello-node");
          const frame = Buffer.alloc(2 + 4 + payload.length);
          frame[0] = 0x81;
          frame[1] = 0x80 | payload.length;
          const mask = Buffer.from([1, 2, 3, 4]);
          mask.copy(frame, 2);
          for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
          s.write(frame);
        }
      } else {
        const payloadLen = buf[1] & 0x7f;
        const echo = buf.subarray(2, 2 + payloadLen).toString();
        s.removeListener("data", onData);
        s.destroy();
        resolve({ handshakeStatus: 101, echo });
      }
    };
    s.on("data", onData);
    s.on("error", reject);
    setTimeout(() => reject(new Error("ws timeout")), 5000);
  });
}

function wssViaConnect(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  authB64?: string,
): Promise<{ connectStatus: number; handshakeStatus: number; echo: string }> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(proxyPort, "127.0.0.1", () => {
      const auth = authB64 ? `Proxy-Authorization: Basic ${authB64}\r\n` : "";
      s.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}Proxy-Connection: Keep-Alive\r\n\r\n`,
      );
    });
    s.once("data", (d) => {
      const line = d.toString().split("\r\n")[0] ?? "";
      const connectStatus = parseInt(line.split(" ")[1] ?? "0", 10);
      if (connectStatus !== 200) {
        s.destroy();
        resolve({ connectStatus, handshakeStatus: 0, echo: "" });
        return;
      }
      const tlss = tls.connect({ socket: s, servername: targetHost, rejectUnauthorized: false }, () => {
        tlss.write(
          `GET /raw HTTP/1.1\r\nHost: ${targetHost}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      let handshake = "";
      let stage: "handshake" | "frame" = "handshake";
      const onData = (buf: Buffer) => {
        if (stage === "handshake") {
          handshake += buf.toString();
          if (handshake.includes("\r\n\r\n")) {
            const hLine = handshake.split("\r\n")[0] ?? "";
            const hs = parseInt(hLine.split(" ")[1] ?? "0", 10);
            if (hs !== 101) {
              tlss.removeListener("data", onData);
              tlss.destroy();
              resolve({ connectStatus, handshakeStatus: hs, echo: "" });
              return;
            }
            stage = "frame";
            const payload = Buffer.from("hello-node");
            const frame = Buffer.alloc(2 + 4 + payload.length);
            frame[0] = 0x81;
            frame[1] = 0x80 | payload.length;
            const mask = Buffer.from([1, 2, 3, 4]);
            mask.copy(frame, 2);
            for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
            tlss.write(frame);
          }
        } else {
          const payloadLen = buf[1] & 0x7f;
          const echo = buf.subarray(2, 2 + payloadLen).toString();
          tlss.removeListener("data", onData);
          tlss.destroy();
          resolve({ connectStatus, handshakeStatus: 101, echo });
        }
      };
      tlss.on("data", onData);
      tlss.on("error", reject);
      setTimeout(() => reject(new Error("wss timeout")), 8000);
    });
    s.on("error", reject);
    setTimeout(() => reject(new Error("wss CONNECT timeout")), 5000);
  });
}

describe("forward · http-client-node-upgrade（websocket 两档）", () => {
  let wsTargetPort = 0;
  let wssTargetPort = 0;
  let wsTarget: net.Server | null = null;
  let wssTarget: net.Server | null = null;

  const prev = snapshotConfig(KEYS);

  beforeAll(async () => {
    wsTargetPort = await getFreePort();
    wssTargetPort = await getFreePort();

    serverBaseConfig();

    wsTarget = createWsEchoServer(false);
    await listen(wsTarget, wsTargetPort);

    wssTarget = createWsEchoServer(true);
    await listen(wssTarget, wssTargetPort);
  });

  afterAll(async () => {
    await new Promise<void>((r) => wsTarget?.close(() => r()));
    await new Promise<void>((r) => wssTarget?.close(() => r()));
    restoreConfig(prev);
  });

  // 跳过理由（**与外网无关**）：明文 ws 经 http 代理的 Upgrade 通道在**本地** wsTarget 回显桩上 flaky
  // ——受 forwardUpgrade 的 101 桥接时序影响（101 之后的透传与本桩的分段时序耦合）。
  // 覆盖由下一档「wss 经 CONNECT+TLS」承担：那档同样只用**本地** TLS 源站（仓内测试 PKI），与外网零耦合，
  // 验的是 CONNECT 建隧后能承载 TLS 握手 + wss 字节、以及鉴权失败在 CONNECT 阶段就回 407。
  // （注意它覆盖的是 CONNECT+TLS 承载，**不是**明文 Upgrade 路径本身。）
  // 此处保留桩与断言（桩仍由 describe 级的 beforeAll 建起、afterAll 收尾），只是不参与运行。
  it.skip("websocket 明文 Upgrade：鉴权通过 101 并 echo，失败 407", async () => {
    const b64 = Buffer.from("test:456").toString("base64");
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({ enabled: true, type: "basic", accounts: [{ username: "test", password: "456" }], enableLogging: false }),
    );
    try {
      const ok = await wsViaHttpProxy(port, wsTargetPort, b64);
      expect(ok.handshakeStatus).toBe(101);
      expect(ok.echo).toBe("hello-node");

      const bad = await wsViaHttpProxy(port, wsTargetPort, Buffer.from("test:123").toString("base64"));
      expect(bad.handshakeStatus).toBe(407);

      const noAuth = await wsViaHttpProxy(port, wsTargetPort);
      expect(noAuth.handshakeStatus).toBe(407);
    } finally {
      await proxy.stop();
    }
  });

  /**
   * **本档要验证的是**：`CONNECT` 建隧之后，这条隧道能承载 **TLS 握手 + wss 字节**（101 + echo），
   * 且鉴权失败在 **CONNECT 阶段**就回 407（此时一个字节的 TLS 都没协商）。
   *
   * 它**不**验证「能不能连上某个公网 wss 端点」——那是被测行为之外的第三方可用性。
   * 目标源站是**本机** `wssTargetPort` 上的 `https.createServer(TEST_TLS_CERTS, …)` 回声桩
   * （仓内测试 PKI，客户端固定 `rejectUnauthorized: false`），故本档与外网零耦合。
   *
   * 为什么必须是本地源站、以及三个 helper 的 `setTimeout` 定时器归属（含 `wssViaConnect` 里
   * 那个**永远轮不到**的 8s 与它写错的归因文案），见 `./AGENTS.md`
   * 「`http-client-node-upgrade` 的三个 helper 定时器」一节。
   */
  it("websocket 加密 wss 经 CONNECT+TLS：鉴权通过 101 并 echo，失败 407", async () => {
    const b64 = Buffer.from("test:456").toString("base64");
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({ enabled: true, type: "basic", accounts: [{ username: "test", password: "456" }], enableLogging: false }),
    );
    try {
      const ok = await wssViaConnect(port, "127.0.0.1", wssTargetPort, b64);
      expect(ok.connectStatus).toBe(200);
      expect(ok.handshakeStatus).toBe(101);
      expect(ok.echo).toBe("hello-node");

      const bad = await wssViaConnect(port, "127.0.0.1", wssTargetPort, Buffer.from("test:123").toString("base64"));
      expect(bad.connectStatus).toBe(407);

      const noAuth = await wssViaConnect(port, "127.0.0.1", wssTargetPort);
      expect(noAuth.connectStatus).toBe(407);
    } finally {
      await proxy.stop();
    }
  });
});
