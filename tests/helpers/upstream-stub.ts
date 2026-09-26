/**
 * 上游代理桩 - 串联矩阵专用的**可观测上游**（三种角色 × 明文/TLS 两种承载）
 *
 * 背景（为什么不能只靠 upstream-matrix.test.ts 里既有的桩）：
 * 既有桩只回固定 body（`upstream-ok:<url>` / 真隧道到源站回 `origin-ok:<path>`），
 * 能证明「链路通不通」，但**证明不了传输层与协议形态真的对**——把 `upstreamProtocol`
 * 从 `https` 改成 `socks4` 而端口指到同一个桩上，既有断言照样全绿。
 * 本文件在三个层面各留一份可断言的事实：
 * - 传输层：`transport`（tls/plain）、`protocol`/`cipher`/`servername`（SNI，空串 = 无 SNI）
 *   —— **刻意不暴露 `socket.authorized`**：`tls.createServer` 未开 `requestCert` 时它恒为
 *   `false`，与被测代理无关，写进断言只会误导读者以为在验客户端证书
 *   （mTLS 的护栏在 `tests/integration/tls-client-auth.test.ts`）
 * - 字节层：`firstBytes()`（每条连接的首字节）、`firstChunk`（应用层首包原文）
 * - 协议形态：`requestKind`（connect / absolute-form / socks4-connect / socks5-greeting）
 *   + `target`（CONNECT authority / absolute-form 目标 / SOCKS 目标 host:port）
 *   + `proxyAuthorization`（上游凭证注入）
 *
 * **`firstBytes()` 只在明文承载上可观测**（这是 Node 的硬事实，不是本文件的偷懒）：
 * `tls.Server` 一 accept 就把裸 socket 包成 TLSSocket，握手字节在 handle 层被 TLS 解析器
 * 吃掉，JS 侧挂 `data` 监听永远不触发。因此：
 * - **TLS 承载**的 TLS 证据 = `sessions()` 非空（只有握手完成才入表）+ `protocol`/`cipher`/`servername`；
 * - **ClientHello（0x16）的字节级证据**要反过来在**明文哑桩**上取：
 *   把 `sockss4`/`sockss5`/`https` 上游指向一个 `secure: false` 的桩，
 *   桩收到的首字节必然是 0x16（`rejectWithPlaintext` 让它回一段明文 HTTP 错误，
 *   制造经典的「对明文端发 ClientHello」握手失败，而不是干等 upstreamTimeout）。
 *
 * 角色（role）与承载（secure）是**两个正交轴**，6 种上游协议 = 3 角色 × 2 承载：
 *   https 明文 / https TLS / socks4 明文 / sockss4 / socks5 明文 / sockss5
 *
 * 设计约束：
 * - 零落盘日志（不 console、不写文件）；矩阵用例自身用 `silenceLogs()` 静音被测代理
 * - 端口一律 `getFreePort()` 取空闲端口（禁止硬编码：并行 fork / 同机多跑会撞）
 * - 生命周期归调用方：`close()` 幂等，必须在 `afterEach` / 用例 `finally` 里调用
 *
 * 关联：`helpers/certs.ts`（仓内测试 PKI）、`helpers/net.ts`（getFreePort/listen）
 */

import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { TEST_TLS_CERTS } from "./certs.js";
import { getFreePort, listen } from "./net.js";

/** 上游角色（协议身份，与承载无关） */
export type UpstreamRole = "https" | "socks4" | "socks5";

/** 承载形态 */
export type UpstreamTransport = "tls" | "plain";

/** 应用层请求形态（用于断言「上游收到的确实是本角色的协议报文」） */
export type UpstreamRequestKind =
  | "connect"
  | "absolute-form"
  | "socks4-connect"
  | "socks5-greeting";

/** 单条上游连接的可断言事实 */
export interface UpstreamFacts {
  role: UpstreamRole;
  /** 承载形态：TLS 承载走 tls.Server（会话只可能在握手完成后入表），明文走 net.Server */
  transport: UpstreamTransport;
  /** 客户端 SNI；空串 = 客户端按 RFC6066 对 IP 目标置空 */
  servername: string;
  /** 协商出的 TLS 版本（如 TLSv1.3）；明文承载恒为 null */
  protocol: string | null;
  /** 协商出的 cipher；明文承载恒为 null */
  cipher: string | null;
  /** 应用层首包原始字节（明文应用层数据；未读到时为空） */
  firstChunk: Buffer;
  /** 应用层请求形态（未读到任何应用层字节时为空串） */
  requestKind: UpstreamRequestKind | "";
  /** https 角色：CONNECT / absolute-form 请求行原文 */
  requestLine: string;
  /** 转发目标：CONNECT authority / absolute-form 目标 / SOCKS 目标 host:port */
  target: string;
  /** 上游收到的 Proxy-Authorization 头（证明凭证注入；无则空串） */
  proxyAuthorization: string;
}

/** 一个上游桩句柄 */
export interface UpstreamStub {
  role: UpstreamRole;
  transport: UpstreamTransport;
  port: number;
  /** 已建立的会话（TLS 承载时**只含握手完成的**——这正是「TLS 真的通了」的证据） */
  sessions(): UpstreamFacts[];
  /** 最近一条会话（无则 undefined） */
  last(): UpstreamFacts | undefined;
  /** 建链数（**含**握手失败的连接——判定「TCP 建链发生过」要用它） */
  connections(): number;
  /**
   * 每条连接的首字节（每条连接只记一次）。
   * **仅明文承载可观测**：TLS 承载时握手字节在 handle 层被吃掉，本表恒为空（见文件头说明）。
   */
  firstBytes(): number[];
  /** 清空观测（供一个用例内多次请求分别断言） */
  reset(): void;
  /** 关服 + 销毁存量连接；幂等 */
  close(): Promise<void>;
}

/** 收头部里的 `Proxy-Authorization`（大小写不敏感） */
function headerOf(head: string, name: string): string {
  const lower = name.toLowerCase();

  for (const line of head.split("\r\n").slice(1)) {
    const idx = line.indexOf(":");

    if (idx === -1) {
      continue;
    }

    if (line.slice(0, idx).trim().toLowerCase() === lower) {
      return line.slice(idx + 1).trim();
    }
  }

  return "";
}

/** absolute-form 请求行 `GET http://host:port/p HTTP/1.1` → `host:port` */
function absoluteFormTarget(requestLine: string): string {
  const url = /^GET\s+(\S+)\s+HTTP\//i.exec(requestLine)?.[1] ?? "";

  try {
    const u = new URL(url);

    return `${u.hostname}:${u.port || 80}`;
  } catch {
    return "";
  }
}

/** 读满 HTTP 头（到 CRLFCRLF）并返回头文本 + 余量；数据不足返回 null */
function takeHead(buf: Buffer): { head: string; rest: Buffer } | null {
  const idx = buf.indexOf("\r\n\r\n");

  if (idx === -1) {
    return null;
  }

  return { head: buf.subarray(0, idx).toString(), rest: buf.subarray(idx + 4) };
}

/** SOCKS4a 哨兵（DSTIP ∈ 0.0.0.0/24）：规范全 0 与事实标准 0.0.0.1 都认 */
function isSocks4aSentinel(buf: Buffer): boolean {
  return buf[4] === 0 && buf[5] === 0 && buf[6] === 0 && (buf[7] === 0 || buf[7] === 1);
}

/**
 * 读服务端侧 TLSSocket 的 SNI，空串 = 客户端没发 SNI 扩展。
 *
 * 两个 Node 事实（踩过，别再写错）：
 * - 运行时确有该属性，但 `@types/node` 只在 `ConnectionOptions` 上声明、`TLSSocket` 上没声明
 *   → 最小结构断言；
 * - **没发 SNI 时 Node 把 `servername` 置为布尔 `false`**（不是空串），故必须 `|| ""` 归一，
 *   否则断言 `servername === ""` 拿到的是 `false`。
 */
function serverSideSni(sock: Duplex): string {
  const raw = (sock as Duplex & { servername?: string | boolean }).servername;
  return raw ? String(raw) : "";
}

/** 起上游桩的选项 */
export interface UpstreamStubOptions {
  /** 承载形态；缺省 true（`https`/`sockss4`/`sockss5` 三个 TLS 上游） */
  secure?: boolean;
  /**
   * 只配在**明文**桩上：收到任何字节立刻回一段明文 HTTP 错误并关闭。
   * 用来制造经典的「对明文端发 ClientHello」TLS 承载失配——客户端握手立刻失败（502），
   * 而不是干等 `upstreamTimeout`（504）。桩记录的 `requestKind` 恒为空串
   * （收到的 ClientHello 里没有 CRLFCRLF，凑不出一个 HTTP 头）。
   */
  rejectWithPlaintext?: boolean;
}

/** 明文失配时回的这段字节（对 TLS 客户端是非法记录，立刻握手失败） */
const PLAIN_HTTP_ERROR = Buffer.from("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");

/**
 * 起一个上游代理桩（3 角色 × 2 承载 = 6 种上游协议）
 * @param role - 上游角色（https / socks4 / socks5）
 * @param opts - `secure` 选承载（缺省 TLS）
 * @returns 句柄；调用方**必须**在 `afterEach` / `finally` 里 `close()`
 */
export async function startUpstreamStub(
  role: UpstreamRole,
  opts: UpstreamStubOptions = {},
): Promise<UpstreamStub> {
  const secure = opts.secure !== false;
  const transport: UpstreamTransport = secure ? "tls" : "plain";
  const port = await getFreePort();
  const sessions: UpstreamFacts[] = [];
  const firstBytesSeen: number[] = [];
  const live: net.Socket[] = [];
  const taken = new WeakSet<net.Socket>();
  let connCount = 0;

  /** 到真实目标开隧道并回指定成功应答（应答缺省为 CONNECT 200） */
  const tunnel = (sock: Duplex, leftover: Buffer, target: string, reply?: Buffer): void => {
    const [host, portStr] = target.split(":");
    const up = net.connect(Number(portStr), host, () => {
      sock.write(reply ?? Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"));

      if (leftover.length) {
        up.write(leftover);
      }

      sock.pipe(up);
      up.pipe(sock);
    });

    up.on("error", () => sock.destroy());
  };

  /** https 角色：CONNECT 开隧道 + absolute-form 直接回 body（与既有桩同 body 形态） */
  const handleHttp = (sock: Duplex, f: UpstreamFacts): void => {
    let buf = Buffer.alloc(0);

    sock.on("data", (d: Buffer) => {
      if (f.firstChunk.length === 0) {
        f.firstChunk = d;
      }

      if (f.requestKind) {
        return;
      }

      buf = Buffer.concat([buf, d]);
      const takenHead = takeHead(buf);

      if (!takenHead) {
        return;
      }

      f.requestLine = takenHead.head.split("\r\n")[0] ?? "";
      f.proxyAuthorization = headerOf(takenHead.head, "proxy-authorization");

      if (/^CONNECT\s/i.test(f.requestLine)) {
        f.requestKind = "connect";
        f.target = f.requestLine.split(" ")[1] ?? "";
        sock.removeAllListeners("data");
        tunnel(sock, takenHead.rest, f.target);
        return;
      }

      f.requestKind = "absolute-form";
      f.target = absoluteFormTarget(f.requestLine);
      const url = f.requestLine.split(" ")[1] ?? "";
      const body = `upstream-ok:${url}`;

      sock.removeAllListeners("data");
      sock.end(
        `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(
          body,
        )}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
  };

  /** socks4 角色：解析 CONNECT（含 4a 域名）后真隧道 */
  const handleSocks4 = (sock: Duplex, f: UpstreamFacts): void => {
    let buf = Buffer.alloc(0);

    sock.on("data", (d: Buffer) => {
      if (f.firstChunk.length === 0) {
        f.firstChunk = d;
      }

      if (f.requestKind) {
        return;
      }

      buf = Buffer.concat([buf, d]);

      // [0x04,0x01,port(2),ip(4),USERID\0] 至少 9 字节
      if (buf.length < 9) {
        return;
      }

      f.requestKind = "socks4-connect";
      const targetPort = buf.readUInt16BE(2);
      const rest = buf.subarray(8);
      const zero = rest.indexOf(0);

      if (zero === -1) {
        return;
      }

      let host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      let leftover = rest.subarray(zero + 1);

      if (isSocks4aSentinel(buf)) {
        const domEnd = leftover.indexOf(0);

        if (domEnd === -1) {
          return;
        }

        host = leftover.subarray(0, domEnd).toString();
        leftover = leftover.subarray(domEnd + 1);
      }

      f.target = `${host}:${targetPort}`;
      sock.removeAllListeners("data");
      tunnel(sock, leftover, f.target, Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
    });
  };

  /** socks5 角色：无鉴权 greeting → CONNECT（ATYP 1/3/4）后真隧道 */
  const handleSocks5 = (sock: Duplex, f: UpstreamFacts): void => {
    let stage = 0;
    let buf = Buffer.alloc(0);

    sock.on("data", (d: Buffer) => {
      if (f.firstChunk.length === 0) {
        f.firstChunk = d;
      }

      buf = Buffer.concat([buf, d]);

      // greeting [VER, NMETHODS, ...]：必须按 NMETHODS 整体消费，
      // 少消费一个字节会把后续 CONNECT 的 ATYP 读到残留 0x00
      if (stage === 0 && buf.length >= 2) {
        const need = 2 + buf[1];

        if (buf.length < need) {
          return;
        }

        f.requestKind = "socks5-greeting";
        buf = buf.subarray(need);
        sock.write(Buffer.from([0x05, 0x00]));
        stage = 1;
      }

      if (stage !== 1 || buf.length < 5) {
        return;
      }

      const atyp = buf[3];
      const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : buf[4];
      const need = atyp === 3 ? 5 + addrLen : 4 + addrLen;

      if (buf.length < need + 2) {
        return;
      }

      const targetPort = buf.readUInt16BE(need);
      const host =
        atyp === 1
          ? `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
          : buf.subarray(5, 5 + addrLen).toString();

      f.target = `${host}:${targetPort}`;
      stage = 2;
      sock.removeAllListeners("data");
      tunnel(
        sock,
        buf.subarray(need + 2),
        f.target,
        Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
      );
    });
  };

  const dispatch = (sock: Duplex, f: UpstreamFacts): void => {
    if (opts.rejectWithPlaintext) {
      sock.once("data", (d: Buffer) => {
        if (f.firstChunk.length === 0) {
          f.firstChunk = d;
        }

        sock.removeAllListeners("data");
        sock.end(PLAIN_HTTP_ERROR);
      });
      return;
    }

    if (role === "https") {
      handleHttp(sock, f);
    } else if (role === "socks4") {
      handleSocks4(sock, f);
    } else {
      handleSocks5(sock, f);
    }
  };

  const newFacts = (sock: Duplex): UpstreamFacts => ({
    role,
    transport,
    servername: secure ? serverSideSni(sock) : "",
    protocol: secure ? (sock as tls.TLSSocket).getProtocol() : null,
    cipher: secure ? ((sock as tls.TLSSocket).getCipher()?.name ?? null) : null,
    firstChunk: Buffer.alloc(0),
    requestKind: "",
    requestLine: "",
    target: "",
    proxyAuthorization: "",
  });

  /** TCP 层观测：每条连接首字节只记一次。TLS 握手失败（客户端拒证书）的连接也进这里，
   *  用来区分「TCP 没建链」与「建链了、发出 ClientHello、但零应用层字节」。 */
  const observe = (raw: net.Socket): void => {
    connCount += 1;
    live.push(raw);
    raw.on("error", () => undefined);
    raw.on("data", (c: Buffer) => {
      if (!taken.has(raw)) {
        taken.add(raw);
        firstBytesSeen.push(c[0]);
      }
    });
  };

  const server: net.Server = secure
    ? tls.createServer(TEST_TLS_CERTS, (sock) => {
        const f = newFacts(sock);
        sessions.push(f);
        sock.on("error", () => undefined);
        dispatch(sock, f);
      })
    : net.createServer((sock) => {
        observe(sock);
        const f = newFacts(sock);
        sessions.push(f);
        dispatch(sock, f);
      });

  if (secure) {
    server.on("connection", observe);
    server.on("tlsClientError", () => undefined);
  }

  server.on("error", () => undefined);
  await listen(server, port);

  let closed = false;

  return {
    role,
    transport,
    port,
    sessions: () => sessions.slice(),
    last: () => sessions[sessions.length - 1],
    connections: () => connCount,
    firstBytes: () => firstBytesSeen.slice(),
    reset: () => {
      sessions.length = 0;
      firstBytesSeen.length = 0;
      connCount = 0;
    },
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;

      for (const s of live) {
        if (!s.destroyed) {
          s.destroy();
        }
      }

      live.length = 0;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 500).unref?.();
      });
    },
  };
}
