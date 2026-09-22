import { describe, expect, it } from "vitest";
import net from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import { set } from "@/config/store.js";
import { Dialer } from "@/core/forward/dial.js";
import { restoreConfig, snapshotConfig } from "../helpers/config.js";

/**
 * 假 SOCKS5 上游：
 * - 方法协商应答逐字节拆开发送（模拟 TCP 分段）
 * - CONNECT 应答末 2 字节与目标首包（server-speaks-first）同包发送
 */
function startFakeSocks5(): Promise<{ server: net.Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});

    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);

      // 方法协商 [0x05,0x01,0x00] → 拆成 [0x05] 与 [0x00] 两次写
      if (chunk.length === 3 && chunk[0] === 0x05 && chunk[1] === 0x01) {
        socket.write(Buffer.from([0x05]));
        setTimeout(() => socket.write(Buffer.from([0x00])), 10);
        return;
      }

      // CONNECT → 前 8 字节逐字节写，末 2 字节与目标首包同包写
      if (chunk.length >= 5 && chunk[1] === 0x01) {
        const head = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0]);

        head.forEach((b, i) => setTimeout(() => socket.write(Buffer.from([b])), i * 5));
        setTimeout(
          () =>
            socket.write(Buffer.concat([Buffer.from([0, 0]), Buffer.from("SSH-2.0-fake\r\n")])),
          head.length * 5 + 10,
        );
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port, received });
    });
  });
}

describe("core/forward/dial 上游 SOCKS5 握手", () => {
  it("应答跨 TCP 分段拆包也能建链，且与应答同包的余量不丢", async () => {
    const { server, port, received } = await startFakeSocks5();
    const prev = snapshotConfig(["upstreamHost", "upstreamPort"]);

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", port);

      const client = new PassThrough() as unknown as Duplex;
      const upstream = await new Dialer().dialSocks(client, "target.example", 22, 5, false, {
        timeout: 3000,
        timeoutReply: "",
        errorReply: "",
      });

      // 握手余量（目标首包）必须回灌到 socket，而不是被握手读取吞掉
      const banner = await new Promise<string>((resolve) =>
        upstream.once("data", (c: Buffer) => resolve(c.toString())),
      );

      expect(banner).toContain("SSH-2.0-fake");

      // 上游应收到域名型 CONNECT：ATYP=0x03 + 域名 + 端口 0x0016
      const sent = Buffer.concat(received);
      const domain = Buffer.from("target.example");

      expect(
        sent.includes(
          Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]), domain]),
        ),
      ).toBe(true);
      expect(sent.subarray(sent.length - 2).equals(Buffer.from([0x00, 0x16]))).toBe(true);

      upstream.destroy();
      client.destroy();
    } finally {
      restoreConfig(prev);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * 要求用户名/密码的上游：挑选 0x02，校验 RFC1929 子协商（错凭证即掐链）
 */
function startAuthSocks5(
  expectedUser: string,
  expectedPass: string,
): Promise<{ server: net.Server; port: number; authed: { ok: boolean } }> {
  const authed = { ok: false };
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    let stage: "method" | "subneg" | "connect" = "method";

    socket.on("data", (chunk: Buffer) => {
      if (stage === "method") {
        // 客户端应同时提供 0x00 与 0x02（有上游账号时）
        if (!chunk.includes(Buffer.from([0x02]))) {
          socket.destroy();
          return;
        }
        stage = "subneg";
        socket.write(Buffer.from([0x05, 0x02]));
        return;
      }

      if (stage === "subneg") {
        const ulen = chunk[1];
        const user = chunk.subarray(2, 2 + ulen).toString();
        const plen = chunk[2 + ulen];
        const pass = chunk.subarray(3 + ulen, 3 + ulen + plen).toString();

        if (chunk[0] !== 0x01 || user !== expectedUser || pass !== expectedPass) {
          socket.write(Buffer.from([0x01, 0x01]));
          socket.destroy();
          return;
        }

        authed.ok = true;
        stage = "connect";
        socket.write(Buffer.from([0x01, 0x00]));
        return;
      }

      // CONNECT 成功应答（ATYP=IPv4 全零）
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port, authed });
    });
  });
}

describe("core/forward/dial 上游 SOCKS5 用户密码认证", () => {
  it("配置上游账号即走 0x02 子协商，凭证正确建链", async () => {
    const { server, port, authed } = await startAuthSocks5("upstream-admin", "upstream-secret");
    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamUsername", "upstreamPassword"]);

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", port);
      set("upstreamUsername", "upstream-admin");
      set("upstreamPassword", "upstream-secret");

      const client = new PassThrough() as unknown as Duplex;
      const upstream = await new Dialer().dialSocks(client, "target.example", 80, 5, false, {
        timeout: 3000,
        timeoutReply: "",
        errorReply: "",
      });

      expect(authed.ok).toBe(true);

      upstream.destroy();
      client.destroy();
    } finally {
      restoreConfig(prev);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("凭证错误即建链失败（上游掐链）", async () => {
    const { server, port, authed } = await startAuthSocks5("upstream-admin", "upstream-secret");
    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamUsername", "upstreamPassword"]);

    try {
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", port);
      set("upstreamUsername", "upstream-admin");
      set("upstreamPassword", "wrong-pass");

      const client = new PassThrough() as unknown as Duplex;

      await expect(
        new Dialer().dialSocks(client, "target.example", 80, 5, false, {
          timeout: 3000,
          timeoutReply: "",
          errorReply: "",
        }),
      ).rejects.toThrow();

      expect(authed.ok).toBe(false);

      client.destroy();
    } finally {
      restoreConfig(prev);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
