/**
 * 四档共用的装配面：裸 TCP 源站桩、裸 socket 客户端、钩子调用记录器、注入选项、配置基线。
 *
 * ⚠️ **刻意住在 `tests/integration/forward/outbound-header-rewrite/` 而不是 `tests/helpers/`**：
 * `external-network-scan.ts` 的 `SCAN_DIRS = ["unit","integration","library"]` **排除 `helpers/`**，
 * 而 `walk()` 收目录下**全部** `.ts` —— 把含建链位或公网 host 字面量的东西搬进 `helpers/`
 * 就是让那部分覆盖从零外网扫描里**静默消失**，而 `no-external-network.test.ts` 的两条下界断言照样绿。
 *
 * @module tests/integration/forward/outbound-header-rewrite
 */
import { afterEach } from "vitest";
import net from "node:net";
import { FileAccountIdentity } from "@/core/identity.js";
import type {
  IdentityProvider,
  OutboundHeaderContext,
  OutboundHeaderRewriter,
  ProxyOptions,
} from "@/core/types/proxy.js";
import { openAccessControl } from "../../../helpers/access.js";
import { restoreConfig, set, silenceLogs, snapshotConfig } from "../../../helpers/config.js";
import { makeCollector, tcConnect } from "../../../helpers/socks-client.js";
import type { UpstreamStub } from "../../../helpers/upstream-stub.js";
/** 本目录涉及的配置键（逐键快照/恢复，不依赖生产全局 store） */
const KEYS = [
  "host",
  "port",
  "proxyMode",
  "upstreamProtocol",
  "upstreamHost",
  "upstreamPort",
  "upstreamUsername",
  "upstreamPassword",
  "upstreamTimeout",
  "authEnabled",
  "authType",
  "aclFile",
  "logLevel",
  "logFile",
] as const;

export const ALICE = "alice";
export const ALICE_PW = "pw1";

/** 源站应答：200 + 2 字节正文（裸 TCP 才能让畸形 request-target 现形） */
export const REPLY_200 = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

/** 同一份应答但**不断链**：入站 keep-alive 下同一条 TCP 连接连发两个请求要用（验 connectionId 维度） */
export const REPLY_200_KEEPALIVE = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok";

/** Upgrade 源站应答：裸 101（`relay` 只严格判三位状态码，不校验 Upgrade 头） */
export const REPLY_101 = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n";

export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** 不判身份的显式禁用档（本目录不测鉴权，用例各自需要时再换成带账号表的那份） */
export const NO_AUTH_IDENTITY: IdentityProvider = new FileAccountIdentity({ enabled: false });

/**
 * 带一张**内联**账号表的身份（basic 档）
 *
 * @description **为什么不用「临时 users.json + `createIdentityFromConfig`」那条更重的路**：
 * 本目录要验的是 `RequestScope.user → OutboundHeaderContext.user` 这条**接线**，不是身份实现。
 * `handleForward` 把 `admission.authenticate()` 拿到的用户名交给 `scopeFor`，此后与身份是哪一族、
 * 账号表从哪来**完全无关**。走内联账号表省掉的是：文件 IO、`readJsonCached` 的 1s 节流
 * （`readAuthUsers({ force: true })` 才能绕开，而那正是同机并行跑时最易抖的一处）、以及一份
 * 「身份真的来自配置」这条与本目录无关的耦合。它同时是**正控**：`FileAccountIdentity` 的
 * `isOwnCredential` 认得自己签发的那份 Basic 凭证，于是契约 ④ 的前半那条
 * （`ordering-and-throw.test.ts`）能真的验到「本代理凭证被剥掉」。
 */
export function authIdentity(): IdentityProvider {
  return new FileAccountIdentity({
    enabled: true,
    type: "basic",
    accounts: [{ username: ALICE, password: ALICE_PW }],
  });
}

/** 裸 TCP 源站桩：逐条记下收到的**请求头原文**（到 CRLFCRLF 为止），见到头就回一次固定应答 */
interface Origin {
  port: number;
  /** 按到达顺序记下的每个请求头原文（`latin1` 保字节，可做全等比对） */
  requests: () => string[];
  close: () => Promise<void>;
}

const ORIGINS: Origin[] = [];
export const UPSTREAMS: UpstreamStub[] = [];
let SNAP: Record<string, unknown> = {};

afterEach(async () => {
  while (ORIGINS.length) {
    await (ORIGINS.pop() as Origin).close();
  }

  while (UPSTREAMS.length) {
    await (UPSTREAMS.pop() as UpstreamStub).close();
  }

  restoreConfig(SNAP);
});

/** 起一个裸 TCP 源站桩并登记到 `afterEach` 统一清理 */
export async function startOrigin(reply: string): Promise<Origin> {
  const sockets = new Set<net.Socket>();
  const heads: string[] = [];
  let pending = Buffer.alloc(0);
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (c: Buffer) => {
      pending = Buffer.concat([pending, c]);
      const at = pending.indexOf("\r\n\r\n");
      if (at === -1) {
        return;
      }
      heads.push(pending.subarray(0, at).toString("latin1"));
      pending = pending.subarray(at + 4);
      sock.write(reply);
    });
  });
  // 直接 listen(0) 再读回端口：`getFreePort()`（先 listen(0) → close → 重绑）有 TOCTOU 竞态
  const port = await new Promise<number>((r) => {
    server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port));
  });

  const origin: Origin = {
    port,
    requests: () => heads.slice(),
    close: async () => {
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  ORIGINS.push(origin);
  return origin;
}

/** 裸 socket 发一段原始请求，读到对端关闭或超时；返回状态码与完整原文 */
export function rawRequest(port: number, raw: string, ms = 5000): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(raw);
    });
    let text = "";
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ status: Number(text.split(" ")[1]) || 0, text });
    }, ms);
    sock.on("data", (c: Buffer) => {
      text += c.toString("latin1");
    });
    sock.on("close", () => {
      clearTimeout(timer);
      resolve({ status: Number(text.split(" ")[1]) || 0, text });
    });
    sock.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** 裸 socket 发一段 Upgrade 握手，等 101（排除「压根没转发」那种假绿） */
export async function upgradeOnce(port: number, raw: string): Promise<string> {
  const sock = await tcConnect(port);
  const c = makeCollector(sock);
  try {
    sock.write(raw);
    await c.waitFor((b) => b.includes(Buffer.from("101")), 5000);
    return c.bytes().toString("latin1");
  } finally {
    sock.destroy();
  }
}

/** absolute-form GET（`http` 通道经代理的标准形态），`extra` 追加任意头行 */
export function absReq(originPort: number, extra: readonly string[] = []): string {
  return [`GET http://127.0.0.1:${originPort}/x HTTP/1.1`, "Host: client-host.example", ...extra, "", ""].join(
    "\r\n",
  );
}

/** client 模式那档用的请求：目标写死 `127.0.0.1:8080`（**拨不到**，真上游是替身桩） */
export const UPSTREAM_ABS_REQ = absReq(8080);

/** origin-form 的 Upgrade 握手（真实客户端形态：目标在 Host 头里） */
export function upgradeReq(originPort: number, extra: readonly string[] = []): string {
  return [
    "GET /ws HTTP/1.1",
    `Host: 127.0.0.1:${originPort}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    ...extra,
    "",
    "",
  ].join("\r\n");
}

/** 请求头字典（键小写，取首个值）；`head` 是到 CRLFCRLF 为止的原文 */
export function dictOf(head: string): Record<string, string> {
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

/** 子串出现次数（keep-alive 会话上数「几个响应体到齐了」） */
export function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** 钩子的一次调用事实（入参**必须在钩子内拷贝**：core 在钩子返回后还会就地写 `connection`） */
interface HookCall {
  headers: Record<string, string | string[] | undefined>;
  context: OutboundHeaderContext;
}

export function recorder(rewriter?: OutboundHeaderRewriter): {
  calls: HookCall[];
  /** 默认是恒等变换（**原样返回入参**，不改一个字） */
  rewriter: OutboundHeaderRewriter;
} {
  const calls: HookCall[] = [];
  return {
    calls,
    rewriter: (headers, context) => {
      calls.push({ headers: { ...headers }, context });
      return rewriter ? rewriter(headers, context) : headers;
    },
  };
}

/**
 * 直构 core 的注入面
 *
 * @description `access` **显式点名** `openAccessControl()`：本目录全部用例都与名单无关，用缺省那份
 * 真名单判定只会把 `acl.json` 变成第二个真相源（「忘了点名」与「有意放行」在字节上无法区分）。
 * `outboundHeaders` 只在给了钩子时出现在选项里——**不给就是不给**，不写 `outboundHeaders: undefined`
 * （那会让「缺席」变成一句仪式，而 ① 要验的正是「键压根不在」）。
 */
export function proxyOpts(rewriter?: OutboundHeaderRewriter, identity?: IdentityProvider): Partial<ProxyOptions> {
  return {
    access: openAccessControl(),
    identity: identity ?? NO_AUTH_IDENTITY,
    ...(rewriter === undefined ? {} : { outboundHeaders: rewriter }),
  };
}

/** 逐例配置基线：server 模式 + 直连源站；`port: 1` 是自环判定的哨兵值 */
export function setup(): void {
  SNAP = snapshotConfig(KEYS);
  silenceLogs();
  set("authEnabled", false);
  set("authType", "none");
  set("host", "127.0.0.1");
  // 哨兵端口：确保 isSelfLoop 不会把测试内的随机临时端口误判为自环
  set("port", 1);
  set("proxyMode", "server");
  set("upstreamProtocol", "http");
  set("upstreamHost", "");
  set("upstreamPort", 0);
  set("upstreamUsername", "");
  set("upstreamPassword", "");
}
