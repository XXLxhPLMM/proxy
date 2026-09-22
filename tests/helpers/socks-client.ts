import net from "node:net";
import tls from "node:tls";
import { sleep } from "./net.js";

/**
 * 缓冲采集器：把 socket 的 data 累积到内部 buffer，支持「等到某谓词成立」与「等到关闭」
 * 谓词必须单调（一旦成立后续仍成立），用于小报文断言足够
 */
export function makeCollector(sock: net.Socket): {
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
export function tcConnect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
}

/** TLS 连接（等到 secureConnect，自签证书跳过校验） */
export function tlsConnect(port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect(
      { host: "127.0.0.1", port, rejectUnauthorized: false, servername: "127.0.0.1" },
      () => resolve(s),
    );
    s.once("error", reject);
  });
}

/** 上下文无关的两段写：先用 gap 分开，确保服务端可能收到分片 */
export async function writeSplit(sock: net.Socket, a: Buffer, b: Buffer, gap = 30): Promise<void> {
  sock.write(a);
  await sleep(gap);
  sock.write(b);
}

/** 构造 SOCKS5 CONNECT（IPv4 字面量）请求 */
export function socks5ConnectIpv4(host: string, port: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x01]),
    Buffer.from(host.split(".").map(Number)),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]);
}

/**
 * 构造 SOCKS4a 请求：DSTIP 哨兵 + USERID + DOMAIN
 * @param dstip - 四字节哨兵；默认 `[0,0,0,1]`（curl/PySocks 的事实标准），传 `[0,0,0,0]` 覆盖规范全 0
 */
export function socks4aRequest(
  userid: string,
  domain: string,
  port: number,
  dstip: readonly number[] = [0, 0, 0, 1],
): Buffer {
  return Buffer.concat([
    Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff, ...dstip]),
    Buffer.from(userid),
    Buffer.from([0x00]),
    Buffer.from(domain),
    Buffer.from([0x00]),
  ]);
}

/** 构造 RFC1929 子协商报文 */
export function rfc1929(user: string, pass: string): Buffer {
  const u = Buffer.from(user);
  const p = Buffer.from(pass);
  return Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
}
