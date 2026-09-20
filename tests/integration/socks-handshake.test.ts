import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import tls from "node:tls";
import { set, get } from "@/config/store.js";
import type { ProxyCore, ProxyOptions } from "@/core/types/proxy.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import { Socks4Proxy } from "@/core/server/socks4.js";
import { Sockss4Proxy } from "@/core/server/sockss4.js";
import { Sockss5Proxy } from "@/core/server/sockss5.js";
import { Auth } from "@/core/auth.js";

/** 取一个空闲端口 */
function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 缓冲采集器：把 socket 的 data 累积到内部 buffer，支持「等到某谓词成立」与「等到关闭」
 * 谓词必须单调（一旦成立后续仍成立），用于小报文断言足够
 */
function makeCollector(sock: net.Socket): {
  bytes: () => Buffer;
  waitFor: (pred: (b: Buffer) => boolean, ms?: number) => Promise<Buffer>;
  waitClose: (ms?: number) => Promise<Buffer>;
} {
  let buf = Buffer.alloc(0);
  let closed = false;
  const subs = new Set<() => void>();

  sock.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    subs.forEach((f) => f());
  });
  sock.on("close", () => {
    closed = true;
    subs.forEach((f) => f());
  });
  sock.on("error", () => {});

  const wait = (pred: (b: Buffer) => boolean, ms: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const check = (): void => {
        if (settled || !pred(buf)) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        subs.delete(check);
        resolve(buf);
      };
      const timer = setTimeout(() => {
        settled = true;
        subs.delete(check);
        reject(new Error(`collector timeout; got ${buf.length} bytes`));
      }, ms);
      subs.add(check);
      check();
    });

  return {
    bytes: (): Buffer => buf,
    waitFor: (pred, ms = 3000): Promise<Buffer> => wait(pred, ms),
    waitClose: (ms = 3000): Promise<Buffer> => wait(() => closed, ms),
  };
}

/** 明文连接（等到 connect） */
function tcConnect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
}

/** TLS 连接（等到 secureConnect，自签证书跳过校验） */
function tlsConnect(port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect(
      { host: "127.0.0.1", port, rejectUnauthorized: false, servername: "127.0.0.1" },
      () => resolve(s),
    );
    s.once("error", reject);
  });
}

/** 上下文无关的两段写：先用 gap 分开，确保服务端可能收到分片 */
async function writeSplit(sock: net.Socket, a: Buffer, b: Buffer, gap = 30): Promise<void> {
  sock.write(a);
  await sleep(gap);
  sock.write(b);
}

/** 构造 SOCKS5 CONNECT（IPv4 字面量）请求 */
function socks5ConnectIpv4(host: string, port: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x01]),
    Buffer.from(host.split(".").map(Number)),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]);
}

/** 构造 SOCKS4a 请求：DSTIP=0.0.0.1 + USERID + DOMAIN */
function socks4aRequest(userid: string, domain: string, port: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff, 0x00, 0x00, 0x00, 0x01]),
    Buffer.from(userid),
    Buffer.from([0x00]),
    Buffer.from(domain),
    Buffer.from([0x00]),
  ]);
}

/** 构造 RFC1929 子协商报文 */
function rfc1929(user: string, pass: string): Buffer {
  const u = Buffer.from(user);
  const p = Buffer.from(pass);
  return Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
}

/** 在空闲端口起真代理，先 set host/port 再 new，运行完自动 stop */
async function withProxy(
  Cls: new (opts: ProxyOptions) => ProxyCore,
  opts: ProxyOptions,
  fn: (port: number, proxy: ProxyCore) => Promise<void>,
): Promise<void> {
  const port = await getFreePort();
  set("port", port);
  const p = new Cls({ host: "127.0.0.1", port, ...opts });
  await p.start();
  try {
    await fn(port, p);
  } finally {
    await p.stop().catch(() => {});
  }
}

describe("integration/socks-handshake", () => {
  let echoPort = 0;
  let echo: net.Server | null = null;
  const prev = {
    host: get("host"),
    port: get("port"),
    mode: get("proxyMode"),
    logLevel: get("logLevel"),
    logFile: get("logFile"),
  };

  beforeAll(async () => {
    echoPort = await getFreePort();
    set("host", "127.0.0.1");
    set("proxyMode", "server");
    set("logLevel", "silent");
    set("logFile", "");
    echo = net.createServer((sock) => {
      sock.on("data", (d) => sock.write(d));
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => echo!.listen(echoPort, "127.0.0.1", r));
  });

  afterAll(async () => {
    await new Promise<void>((r) => echo?.close(() => r()));
    set("host", prev.host);
    set("port", prev.port);
    set("proxyMode", prev.mode);
    set("logLevel", prev.logLevel);
    set("logFile", prev.logFile);
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
    const tlsOpts = { tls: { key: "keys/server.key", cert: "keys/server.crt" } };

    await withProxy(
      Sockss5Proxy,
      {
        auth: new Auth({ enabled: true, type: "basic", username: "u", password: "p", enableLogging: false }),
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
    const tlsOpts = { tls: { key: "keys/server.key", cert: "keys/server.crt" } };

    await withProxy(
      Sockss4Proxy,
      { auth: new Auth({ enabled: true, type: "uid", username: "test", enableLogging: false }), ...tlsOpts },
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
