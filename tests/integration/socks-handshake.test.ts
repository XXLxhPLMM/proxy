import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { set } from "@/config/store.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import { Socks4Proxy } from "@/core/server/socks4.js";
import { Sockss4Proxy } from "@/core/server/sockss4.js";
import { Sockss5Proxy } from "@/core/server/sockss5.js";
import { Auth } from "@/core/auth.js";
import { getFreePort, sleep } from "../helpers/net.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";
import { TEST_TLS_PATHS } from "../helpers/certs.js";
import { withProxy } from "../helpers/proxy.js";
import {
  makeCollector,
  rfc1929,
  socks4aRequest,
  socks5ConnectIpv4,
  tcConnect,
  tlsConnect,
  writeSplit,
} from "../helpers/socks-client.js";

describe("integration/socks-handshake", () => {
  let echoPort = 0;
  let echo: net.Server | null = null;
  const prev = snapshotConfig(["host", "port", "proxyMode", "logLevel", "logFile"]);

  beforeAll(async () => {
    echoPort = await getFreePort();
    set("host", "127.0.0.1");
    set("proxyMode", "server");
    silenceLogs();
    echo = net.createServer((sock) => {
      sock.on("data", (d) => sock.write(d));
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => echo!.listen(echoPort, "127.0.0.1", r));
  });

  afterAll(async () => {
    await new Promise<void>((r) => echo?.close(() => r()));
    restoreConfig(prev);
  });

  it("socks5: greeting 分两次写 → 隧道建立并回显", async () => {
    await withProxy(Socks5Proxy, { auth: new Auth({ enabled: false }) }, async (port) => {
      const sock = await tcConnect(port);
      const acc = makeCollector(sock);
      try {
        // greeting VER/NMETHODS 先发，METHODS 后发（模拟 TCP 分段）
        await writeSplit(sock, Buffer.from([0x05, 0x01]), Buffer.from([0x00]));
        await acc.waitFor((b) => b.length >= 2 && b[0] === 0x05 && b[1] === 0x00);

        sock.write(socks5ConnectIpv4("127.0.0.1", echoPort));
        await acc.waitFor((b) => b.includes(Buffer.from([0x05, 0x00, 0x00, 0x01])));

        sock.write(Buffer.from("ping"));
        const got = await acc.waitFor((b) => b.includes(Buffer.from("ping")));
        expect(got.includes(Buffer.from("ping"))).toBe(true);
      } finally {
        sock.destroy();
      }
    });
  });

  it("socks5: greeting+CONNECT 同一次写（pipelined）→ 隧道建立并回显", async () => {
    await withProxy(Socks5Proxy, { auth: new Auth({ enabled: false }) }, async (port) => {
      const sock = await tcConnect(port);
      const acc = makeCollector(sock);
      try {
        // greeting 与 CONNECT 同包
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), socks5ConnectIpv4("127.0.0.1", echoPort)]));
        await acc.waitFor((b) => b.includes(Buffer.from([0x05, 0x00, 0x00, 0x01])));

        sock.write(Buffer.from("pong"));
        const got = await acc.waitFor((b) => b.includes(Buffer.from("pong")));
        expect(got.includes(Buffer.from("pong"))).toBe(true);
      } finally {
        sock.destroy();
      }
    });
  });

  it("socks5: 域名长度超短包（05 01 00 03 FF ...）→ 干净关闭/失败应答，进程不崩", async () => {
    await withProxy(Socks5Proxy, { auth: new Auth({ enabled: false }) }, async (port, proxy) => {
      const sock = await tcConnect(port);
      const acc = makeCollector(sock);
      try {
        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        await acc.waitFor((b) => b.length >= 2 && b[0] === 0x05 && b[1] === 0x00);

        // 10 字节：VER CMD RSV ATYP=03 LEN=0xFF + 5 填充，域名+端口字节远不齐
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, 0xff]), Buffer.alloc(5)]));
        sock.end();

        // 必须干净关闭（或收到失败应答），且不得抛未捕获异常
        await acc.waitClose(3000);
        expect(proxy.isRunning()).toBe(true);
      } finally {
        sock.destroy();
      }
    });
  });

  it("socks4: 首包分两次写（SOCKS4a 域名型）→ 隧道建立并回显", async () => {
    await withProxy(Socks4Proxy, { auth: new Auth({ enabled: false }) }, async (port) => {
      const sock = await tcConnect(port);
      const acc = makeCollector(sock);
      try {
        // 拆在 USERID 中间：先 8 字节头 + "te"，再 "st"+NUL + 域名+NUL
        const req = socks4aRequest("test", "127.0.0.1", echoPort);
        const cut = 8 + 2;
        await writeSplit(sock, req.subarray(0, cut), req.subarray(cut));

        await acc.waitFor((b) => b.length >= 2 && b[0] === 0x00 && b[1] === 0x5a);

        sock.write(Buffer.from("ping4"));
        const got = await acc.waitFor((b) => b.includes(Buffer.from("ping4")));
        expect(got.includes(Buffer.from("ping4"))).toBe(true);
      } finally {
        sock.destroy();
      }
    });
  });

  it("socks4a: 规范哨兵 DSTIP=0.0.0.0 → 识别为4a，域名建隧且回显无残渣", async () => {
    await withProxy(Socks4Proxy, { auth: new Auth({ enabled: false }) }, async (port) => {
      const sock = await tcConnect(port);
      const acc = makeCollector(sock);
      try {
        sock.write(socks4aRequest("test", "127.0.0.1", echoPort, [0, 0, 0, 0]));

        await acc.waitFor((b) => b.length >= 2 && b[0] === 0x00 && b[1] === 0x5a);

        sock.write(Buffer.from("ping4a0"));
        const all = await acc.waitFor((b) => b.includes(Buffer.from("ping4a0")));
        // SOCKS4 回复固定 8 字节，其后必须紧跟载荷本身：
        // 若全 0 被误判成纯4，域名字段会残留在握手缓冲并先被回灌进隧道，这里就会看到 "127.0.0.1\0"
        expect(all.subarray(8).equals(Buffer.from("ping4a0"))).toBe(true);
      } finally {
        sock.destroy();
      }
    });
  });

  it("stop(): 有 idle 存量连接时能在 3s 内 resolve", async () => {
    const port = await getFreePort();
    set("port", port);
    const proxy = new Socks5Proxy({ host: "127.0.0.1", port, auth: new Auth({ enabled: false }) });
    await proxy.start();

    const sock = await tcConnect(port);
    const acc = makeCollector(sock);
    // 完成 greeting，停在等待 CONNECT，制造 idle 连接
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    await acc.waitFor((b) => b.length >= 2 && b[0] === 0x05 && b[1] === 0x00);

    const started = Date.now();
    const result = await Promise.race([
      proxy.stop().then(() => "stopped" as const),
      sleep(3000).then(() => "timeout" as const),
    ]);
    const elapsed = Date.now() - started;

    expect(result).toBe("stopped");
    expect(elapsed).toBeLessThan(3000);

    sock.destroy();
  });

  it("sockss5 + Auth(basic): 正确账密成功 / 错误账密失败", async () => {
    const tlsOpts = { tls: TEST_TLS_PATHS };

    await withProxy(
      Sockss5Proxy,
      {
        auth: new Auth({ enabled: true, type: "basic", accounts: [{ username: "u", password: "p" }], enableLogging: false }),
        ...tlsOpts,
      },
      async (port) => {
        // 正确账密
        const ok = await tlsConnect(port);
        const okAcc = makeCollector(ok);
        try {
          ok.write(Buffer.from([0x05, 0x01, 0x02]));
          await okAcc.waitFor((b) => b.length >= 2 && b[0] === 0x05 && b[1] === 0x02);

          ok.write(rfc1929("u", "p"));
          await okAcc.waitFor((b) => b.length >= 4 && b[2] === 0x01 && b[3] === 0x00);

          ok.write(socks5ConnectIpv4("127.0.0.1", echoPort));
          await okAcc.waitFor((b) => b.includes(Buffer.from([0x05, 0x00, 0x00, 0x01])));

          ok.write(Buffer.from("secure"));
          const got = await okAcc.waitFor((b) => b.includes(Buffer.from("secure")));
          expect(got.includes(Buffer.from("secure"))).toBe(true);
        } finally {
          ok.destroy();
        }

        // 错误账密
        const bad = await tlsConnect(port);
        const badAcc = makeCollector(bad);
        try {
          bad.write(Buffer.from([0x05, 0x01, 0x02]));
          await badAcc.waitFor((b) => b.length >= 2 && b[0] === 0x05 && b[1] === 0x02);

          bad.write(rfc1929("u", "wrong"));
          const reply = await badAcc.waitFor((b) => b.length >= 4 && b[2] === 0x01 && b[3] === 0x01);
          expect(reply[3]).toBe(0x01);
        } finally {
          bad.destroy();
        }
      },
    );
  });

  it("sockss4 + Auth(uid): USERID token 正确成功 / 错误失败", async () => {
    const tlsOpts = { tls: TEST_TLS_PATHS };

    await withProxy(
      Sockss4Proxy,
      { auth: new Auth({ enabled: true, type: "uid", accounts: [{ username: "test", password: "" }], enableLogging: false }), ...tlsOpts },
      async (port) => {
        // 正确 USERID
        const ok = await tlsConnect(port);
        const okAcc = makeCollector(ok);
        try {
          ok.write(socks4aRequest("test", "127.0.0.1", echoPort));
          await okAcc.waitFor((b) => b.length >= 2 && b[0] === 0x00 && b[1] === 0x5a);

          ok.write(Buffer.from("s4"));
          const got = await okAcc.waitFor((b) => b.includes(Buffer.from("s4")));
          expect(got.includes(Buffer.from("s4"))).toBe(true);
        } finally {
          ok.destroy();
        }

        // 错误 USERID
        const bad = await tlsConnect(port);
        const badAcc = makeCollector(bad);
        try {
          bad.write(socks4aRequest("wrong", "127.0.0.1", echoPort));
          const reply = await badAcc.waitFor((b) => b.length >= 2 && b[0] === 0x00 && b[1] === 0x5b);
          expect(reply[1]).toBe(0x5b);
        } finally {
          bad.destroy();
        }
      },
    );
  });
});
