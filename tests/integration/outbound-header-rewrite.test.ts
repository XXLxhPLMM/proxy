/**
 * @fileoverview 出站报文改写钩子（`OutboundHeaderRewriter`）这个可注入策略位的护栏
 * @module tests/integration/outbound-header-rewrite
 * @description
 * 这个端口解决的是「出站净化一路**只能剥、不能改**」：加头 / 换 UA / 注入 trace id / 改 Host
 * 这些最高频的自定义需求在它之前没有任何扩展位。本档锁它带来的全部**可观测后果**——不是
 * 「钩子被调用了」（那只是装配活），而是「上游真的收到了那个字节」与「客户端的字节真的没变」。
 *
 * ### 本档锁的六条契约（判据形状 → 怎么测出来的）
 *
 * | # | 契约 | 判据形状 |
 * |---|---|---|
 * | ① | **缺席 = 逐字节不变** | 两份出站报文**全等**（不是"关键头相等"） |
 * | ② | **加头生效**（http + upgrade 两条通道） | 源站桩收到的**头字典**里有那个键 |
 * | ③ | **改值 / 删头生效** | 改后的值 + 键的缺席，**外加一个未被触碰的正控头** |
 * | ④ | **次序：先剥 → 再改写 → 最后强制 `Connection: close`** | 钩子**入参**里没有 `proxy-*` 与本代理凭证；钩子对 `connection` 的改动在**出站报文**里被覆盖 |
 * | ⑤ | **抛错 = 不改写且请求照常成功** | 出站报文与 ① 的基线**全等**，且状态码是 200（不是 5xx） |
 * | ⑥ | **上下文传到位** | `channel`/`toProxy`/`target`/`user`/`client`/`requestId`/`connectionId` 逐字段，外加「同连接共享 connectionId、逐请求独立 requestId」与「`toProxy` 在经 http 上游那一档为 true」 |
 *
 * ### 为什么全部用**行为断言**（源站桩看真字节），一条源码断言都不写在这六条上
 *
 * 这六条的形态都是「**出站那几个字节长什么样**」，而字节不是源码属性：`headers[connection] =
 * "close"` 挪到 `sanitizeHeaders` 里、改成 `setHeader`、或者在 `http.request` 之前插一段序列化，
 * 源码断言可能照样绿，但线上行为已经变了。故判据一律落在**上游真的收到了什么**上，源站一律用
 * **裸 `net.Server`**（`http.Server` 会把畸形 request-target 也塞进 `req.url`，把缺陷藏住），
 * 客户端一律用裸 socket 手写报文行，断言的是**逐字节原文**（照 `http-forward-contract.test.ts`）。
 *
 * ### 变异测试：哪几种改动会让本档红（逐条已实测）
 *
 * 下面每条都**实测过**（改 → 跑 → 改回），不写「理论上会红」：
 *
 * - 注释掉 `http.ts` 里改写之后那行 `headers[HEADER_NAME_CONNECTION] = HEADER_VALUE_CLOSE;`
 *   → **恰好一条红**：次序②「钩子把 connection 改成 keep-alive 或整个删掉」（出站真的变成
 *   `keep-alive`）。其余 13 条全绿——**这正是本档要的形状**：那条契约只有它一处后果。
 * - 注释掉 `http.ts` 里 `applyOutboundRewrite(...)` 的整个调用（退回改动前的形状）
 *   → ②③④⑤⑥ 会成片红（钩子一次都不被调，上游拿不到新头、`user` 维度无处可取）。
 * - 钩子抛错那条若改成「把异常往外抛」→ ⑤ 红（请求变成 5xx / 连接被拆）。
 * - 把 `headers.ts` 里 `applyOutboundRewrite` 的 `if (rewriter === undefined) return headers;`
 *   短路去掉 → **13 条全绿，只有 ⑧ 的「缺席短路必须在」那条红**。原因是**原理上**如此：
 *   `rewriter(headers, context)` 在 `rewriter === undefined` 时抛 `TypeError`，而那个 throw 就发生在
 *   **同一个 `try` 里**、被**同一个 `catch`** 接住、返回**同一个引用**——删掉短路后的字节与不删
 *   **逐字节全等**。差别全在热路径上（每请求每出站白付一次异常构造 + 栈捕获）。这条短路因此
 *   **行为面上不可观测**，只能由 ⑧ 那条源码级护栏钉住（它已变异测试验证）。
 *
 * ### 一处**如实记账的覆盖缺口**（已实测，不是猜测）
 *
 * `upgrade.ts:buildUpgradeReq` 里那个「钩子缺席就早返回 `headerLines` 拼串」的分支，本档**测不到**：
 * 删掉它 → **14 条全绿**。原因是本档的 upgrade 用例（②的后半）**总是注入钩子**，于是那条早返回
 * 在测试里**恒不生效**；而「钩子缺席 + upgrade 通道」这一组合本档确实没有用例（①的缺席基线只在
 * http 通道上跑，upgrade 通道的缺席路径会**保留客户端原始头名大小写与重复头**，那是与 http 通道
 * **不同的字节形态**，本档刻意没去锁它）。**这是覆盖缺口，不是不存在**：真要有人把那条早返回删掉、
 * 恒走「小写字典 → 序列化」那条路，upgrade 通道的出站报文形态会静默变样（头名全变小写、重复头被
 * 合并）而本档全绿。补法是加一条「upgrade 通道 + 钩子缺席 → 报文里保留客户端的原始头名大小写」
 * 的用例；本档不写它是因为**没有行为后果的判据可写**（现有断言形态要么与它无关、要么恒真），
 * 写一条恒绿的断言正是本仓明令禁止的那种「伪装成护栏」的东西。
 *
 * ### 四条刻意**不给**断言的（如实记账，不留给下一个人自己撞上）
 *
 * 1. **「钩子加回来的代理凭证不会被再剥一次」不钉**。它是端口注释里**明写的自觉代价**（要先剥
 *    后改，就必然没有第二次剥离），但它也是一条**待裁决的形态**：将来真要收紧成「剥两次」，这里
 *    恰恰不该是拦住它的理由。钉死它只会把一次改进变成「先来改测试」。
 * 2. **「钩子就地改自己的入参再抛错」不钉**。`applyOutboundRewrite` 的 `catch` 返回的是**同一个
 *    引用**，所以这种钩子留下的就地改动**会**真的出站——而这与「纯函数」的端口约定相悖。要不要
 *    由 core 兜住（传副本 / catch 时返回副本）是一个**尚未裁决**的设计问题；本档的 ⑤ 刻意用
 *    「不碰入参、只 return」的钩子，于是它锁的是**返回值被丢弃**这条（那才是契约），对就地改动
 *    既不背书也不禁止。
 * 3. **上下文的 `protocol` 维度已被从端口上删掉**（本档起草时实测恒 `undefined`，属类型层面撒谎）。
 *    两个调用点都从 `terminal.snapshotContext()` 取，而 `RequestTerminal` 的初始关联上下文是
 *    `{ client, connectionId, requestId, target? }`、不含它——挂一个恒为 `undefined` 的可选字段只会
 *    诱使插件作者写一条永远走 false 的分支。故 `OutboundHeaderContext` **没有**这个字段，
 *    插件要判入站协议读 `channel` 即可（本端口只长在 http / upgrade 两条有 HTTP 头的通道上）。
 *    本档因此**没有**任何关于它的断言——它是缺席，不是不变式。
 * 4. **`client` 维度不与 `eventContext.client` 统一断言**。hook 拿到的是 `terminal` 那份
 *    （**TCP 对端**，准入/名单判定口径），而 `pipe` 事件 / `request.started` 用的
 *    `eventContext.client` 是 `getClientAddress(req)`（**XFF > X-Real-IP > Forwarded > socket**）。
 *    本档断言的是它此刻真是什么，并在 ⑥ 里用「客户端发了 XFF 而 `client` 仍是对端」把这份差异钉住；
 *    该不该统一是待裁决的口径问题。逐条说明见 ⑥ 第一条用例的注释。
 */

import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import { FileAccountIdentity } from "@/core/identity.js";
import { HttpProxy } from "@/core/server/http.js";
import type {
  IdentityProvider,
  OutboundHeaderContext,
  OutboundHeaderRewriter,
  ProxyOptions,
} from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import { openAccessControl } from "../helpers/access.js";
import { restoreConfig, set, silenceLogs, snapshotConfig, testLogger } from "../helpers/config.js";
import { getFreePort } from "../helpers/net.js";
import { withProxy } from "../helpers/proxy.js";
import { blockAfter, codeOf } from "../helpers/source-scan.js";
import { makeCollector, tcConnect } from "../helpers/socks-client.js";
import { startUpstreamStub, type UpstreamStub } from "../helpers/upstream-stub.js";

/** 本文件涉及的配置键（逐键快照/恢复，不依赖生产全局 store） */
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

const ALICE = "alice";
const ALICE_PW = "pw1";

/** 源站应答：200 + 2 字节正文（裸 TCP 才能让畸形 request-target 现形） */
const REPLY_200 = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

/** 同一份应答但**不断链**：入站 keep-alive 下同一条 TCP 连接连发两个请求要用（验 connectionId 维度） */
const REPLY_200_KEEPALIVE = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok";

/** Upgrade 源站应答：裸 101（`relay` 只严格判三位状态码，不校验 Upgrade 头） */
const REPLY_101 = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n";

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** 不判身份的显式禁用档（本档不测鉴权，用例各自需要时再换成带账号表的那份） */
const NO_AUTH_IDENTITY: IdentityProvider = new FileAccountIdentity({ enabled: false });

/**
 * 带一张**内联**账号表的身份（basic 档）
 *
 * @description **为什么不用「临时 users.json + `createIdentityFromConfig`」那条更重的路**：
 * 本档要验的是 `RequestScope.user → OutboundHeaderContext.user` 这条**接线**，不是身份实现。
 * `handleForward` 把 `admission.authenticate()` 拿到的用户名交给 `scopeFor`，此后与身份是哪一族、
 * 账号表从哪来**完全无关**。走内联账号表省掉的是：文件 IO、`readJsonCached` 的 1s 节流
 * （`readAuthUsers({ force: true })` 才能绕开，而那正是同机并行跑时最易抖的一处）、以及一份
 * 「身份真的来自配置」这条与本档无关的耦合。它同时是**正控**：`FileAccountIdentity` 的
 * `isOwnCredential` 认得自己签发的那份 Basic 凭证，于是次序① 那条能真的验到「本代理凭证被剥掉」。
 */
function authIdentity(): IdentityProvider {
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
const UPSTREAMS: UpstreamStub[] = [];
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
async function startOrigin(reply: string): Promise<Origin> {
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
function rawRequest(port: number, raw: string, ms = 5000): Promise<{ status: number; text: string }> {
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
async function upgradeOnce(port: number, raw: string): Promise<string> {
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
function absReq(originPort: number, extra: readonly string[] = []): string {
  return [`GET http://127.0.0.1:${originPort}/x HTTP/1.1`, "Host: client-host.example", ...extra, "", ""].join(
    "\r\n",
  );
}

/** client 模式那档用的请求：目标写死 `127.0.0.1:8080`（**拨不到**，真上游是替身桩） */
const UPSTREAM_ABS_REQ = absReq(8080);

/** origin-form 的 Upgrade 握手（真实客户端形态：目标在 Host 头里） */
function upgradeReq(originPort: number, extra: readonly string[] = []): string {
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
function dictOf(head: string): Record<string, string> {
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
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** 钩子的一次调用事实（入参**必须在钩子内拷贝**：core 在钩子返回后还会就地写 `connection`） */
interface HookCall {
  headers: Record<string, string | string[] | undefined>;
  context: OutboundHeaderContext;
}

function recorder(rewriter?: OutboundHeaderRewriter): {
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
 * @description `access` **显式点名** `openAccessControl()`：本档全部用例都与名单无关，用缺省那份
 * 真名单判定只会把 `acl.json` 变成第二个真相源（「忘了点名」与「有意放行」在字节上无法区分）。
 * `outboundHeaders` 只在给了钩子时出现在选项里——**不给就是不给**，不写 `outboundHeaders: undefined`
 * （那会让「缺席」变成一句仪式，而 ① 要验的正是「键压根不在」）。
 */
function proxyOpts(rewriter?: OutboundHeaderRewriter, identity?: IdentityProvider): Partial<ProxyOptions> {
  return {
    access: openAccessControl(),
    identity: identity ?? NO_AUTH_IDENTITY,
    ...(rewriter === undefined ? {} : { outboundHeaders: rewriter }),
  };
}

/** 逐例配置基线：server 模式 + 直连源站；`port: 1` 是自环判定的哨兵值 */
function setup(): void {
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

// ---------------------------------------------------------------------------
// ① 缺席 = 逐字节不变
// ---------------------------------------------------------------------------

describe("integration/outbound-header-rewrite ① 缺席 = 逐字节不变", () => {
  /**
   * 锁「钩子缺席时出站报文与本次改动之前**完全一致**」
   *
   * @description 判据是**两份报文全等**，不是「关键头相等」——后者放过重排、放过大小写、放过
   * 少一个不影响解析的头，而那正是「顺手统一序列化」时最常见的漂移。取等的两侧必须是**同一个
   * 源站端口**（Host 头会回写成 `127.0.0.1:<port>`，端口不同则报文必然不同），故两次跑的是同
   * 一个源站、两次请求逐字节相同。
   */
  it("缺席：出站报文与「注入恒等钩子」的那一份逐字节相同，钩子的有无不许改变任何字节", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const req = absReq(origin.port, ["User-Agent: baseline-ua", "X-Keep-Me: kept"]);

    await withProxy(HttpProxy, proxyOpts(), async (port, proxy) => {
      expect(
        proxy.options.outboundHeaders,
        "缺席时归一值就是 undefined（**不是**一份恒等替身：那会让每请求多一次热路径委派）",
      ).toBeUndefined();
      expect((await rawRequest(port, req)).status).toBe(200);
    });
    const withoutHook = origin.requests();

    const rec = recorder();
    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port, proxy) => {
      expect(proxy.options.outboundHeaders, "注入的那份必须原样透传到归一后的选项上").toBe(rec.rewriter);
      expect((await rawRequest(port, req)).status).toBe(200);
    });
    const withIdentityHook = origin.requests();

    expect(withoutHook, "源站确实收到了请求（排除「压根没转发」那种假绿）").toHaveLength(1);
    expect(withIdentityHook, "恒等钩子也只该产生一份报文").toHaveLength(2);
    expect(
      withIdentityHook[1],
      "恒等钩子（逐字节返回入参）产出的出站报文必须与「完全不注入」的那一份全等",
    ).toBe(withoutHook[0]);

    // 顺带把「缺席时的字节」逐条锁死：它是所有后续用例的基线，漂了就说明出站形态被动过
    const head = withoutHook[0];
    expect(head.split("\r\n")[0], "直连源站 → request-target 归一为 origin-form").toBe("GET /x HTTP/1.1");
    const d = dictOf(head);
    expect(d.host, "客户端的 bogus Host 被回写为真实目标 authority").toBe(`127.0.0.1:${origin.port}`);
    expect(d.connection, "出站强制 close（不变量 2）与钩子无关").toBe("close");
    expect(d["user-agent"], "客户端的头原样透传（缺席 ≠ 少发东西）").toBe("baseline-ua");
    expect(d["x-keep-me"], "自定义头原样透传").toBe("kept");
  });
});

// ---------------------------------------------------------------------------
// ② 加头生效（两条通道）
// ---------------------------------------------------------------------------

describe("integration/outbound-header-rewrite ② 加头生效（http + upgrade 两条通道）", () => {
  /** 锁「http 普通转发的出站报文里真的有钩子加的那个键」 */
  it("HTTP 普通转发：钩子新增的头真的出现在源站收到的报文里", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder((h) => ({ ...h, "x-trace-id": "t-1" }));

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      expect((await rawRequest(port, absReq(origin.port))).status).toBe(200);
    });

    expect(rec.calls, "钩子恰好被调一次").toHaveLength(1);
    const d = dictOf(origin.requests()[0]);
    expect(d["x-trace-id"], "钩子加的头必须真的出站（不是只改了入参）").toBe("t-1");
    // 正控：加头不许牵连别的头
    expect(d.host).toBe(`127.0.0.1:${origin.port}`);
    expect(d.connection).toBe("close");
  });

  /**
   * 锁「Upgrade 握手的出站报文里真的有钩子加的那个键」
   *
   * @description 这一条覆盖的是**另一条调用点**（`upgrade.ts:buildUpgradeReq`），它的序列化形态与
   * http 侧刻意不同：钩子缺席走 `rawHeaders` 原样拼串（保留客户端原始头名大小写），钩子在场才切
   * 到「小写字典 → 改写 → 按原名映射回大小写 → 序列化」。所以「钩子加的**新**键」在这条路径上
   * 没有原名可映射，落到线上就是**小写**——断言按小写收，不去猜它该是哪种大小写。
   */
  it("Upgrade 握手：钩子新增的头真的出现在源站收到的握手报文里，且 Connection: Upgrade 仍活着", async () => {
    setup();
    const origin = await startOrigin(REPLY_101);
    const rec = recorder((h) => ({ ...h, "x-ws-tag": "ws-1" }));

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      const text = await upgradeOnce(port, upgradeReq(origin.port));
      expect(text, "101 证明握手报文真送到了源站并被桥接回来").toContain("101");
    });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].context.channel, "这条走的是 upgrade 通道").toBe("upgrade");
    const head = origin.requests()[0];
    expect(head.split("\r\n")[0], "对端是源站 → request-target 用 origin-form").toBe("GET /ws HTTP/1.1");
    const d = dictOf(head);
    expect(d["x-ws-tag"], "钩子加的头必须真的写进握手报文").toBe("ws-1");
    // 走字典 + 序列化那一路不许把握手必需的头弄丢：`Connection: Upgrade` 是 101 的前提
    expect(d.connection, "改写路径不得毁掉握手必需的 Connection: Upgrade").toBe("Upgrade");
    expect(d.upgrade).toBe("websocket");
    expect(d.host, "Host 按真实目标回写").toBe(`127.0.0.1:${origin.port}`);
  });
});

// ---------------------------------------------------------------------------
// ③ 改值 / 删头
// ---------------------------------------------------------------------------

describe("integration/outbound-header-rewrite ③ 改值 / 删头生效", () => {
  /**
   * 锁「改值与删头都真的生效」
   *
   * @description **必须带一个未被触碰的正控头**：只断言「改对了 / 删掉了」的话，钩子把整份头换成
   * 一份只含那两个键的字典也会全绿——那不是契约，是「整份替换」被顺手当成了改写。正控头证明的是
   * 「其余头原样带过去」。
   */
  it("HTTP：改值与删头都生效，且未被触碰的头原样带过去（不许被顺手当成整份替换）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder((h) => {
      // 显式标注成端口的返回类型：否则 `{ ...h, "user-agent": … }` 会被推断成一个**只含该键的字面量
      // 对象类型**，`delete next["x-drop-me"]` 就编译不过（而「删头」正是本条要验的另一半）
      const next: Record<string, string | string[] | undefined> = { ...h, "user-agent": "rewritten-ua" };
      delete next["x-drop-me"];
      return next;
    });

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      expect((await rawRequest(port, absReq(origin.port, ["X-Drop-Me: gone", "X-Keep-Me: kept"]))).status).toBe(
        200,
      );
    });

    const d = dictOf(origin.requests()[0]);
    expect(d["user-agent"], "钩子改的值必须真的出站").toBe("rewritten-ua");
    expect(d["x-drop-me"], "钩子删的头必须真的不出站").toBeUndefined();
    expect(d["x-keep-me"], "正控：未被触碰的头原样带过去（不许整份替换）").toBe("kept");
    expect(d.host, "正控：Host 不受牵连").toBe(`127.0.0.1:${origin.port}`);
    expect(d.connection, "正控：强制 close 不受牵连").toBe("close");
  });
});

// ---------------------------------------------------------------------------
// ④ 次序：先剥 → 再改写 → 最后强制 Connection: close
// ---------------------------------------------------------------------------

describe("integration/outbound-header-rewrite ④ 次序：先剥 → 再改写 → 最后强制 close", () => {
  /**
   * 锁「钩子看到的是**已净化**的头」（次序的前半）
   *
   * @description 两次请求构成一组**对照**，缺任何一半都不成立：客户端在两次里都发
   * `Proxy-Authorization`（① 必被 `proxy-` 前缀规则剥掉，恒定），而 `Authorization` 一次是
   * **本代理自己签发的那份**（被 `isOwnCredential` 剥掉）、一次是**目标的**（`Bearer …`，必须留）。
   * 只断言「`authorization` 不在入参里」的话，一个「无差别删掉所有 `authorization`」的退化实现
   * 也会全绿，而那会把目标站要的头也吃掉；只断言「`authorization` 在」的话，剥离彻底没跑也会全绿。
   *
   * 身份走**内联账号表**那份（理由见 `authIdentity()` 的注释）：被测的是接线，不是身份族。
   */
  it("钩子入参里没有 proxy-* 头、没有本代理凭证，而目标的 Authorization 原样保留（两次请求对照）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder();
    const creds = basicAuth(ALICE, ALICE_PW);

    await withProxy(HttpProxy, proxyOpts(rec.rewriter, authIdentity()), async (port) => {
      // ① `Authorization` 是本代理的凭证（basic 档）
      const a = await rawRequest(
        port,
        absReq(origin.port, [`Proxy-Authorization: ${creds}`, `Authorization: ${creds}`]),
      );
      expect(a.status, "凭据认得出来 → 鉴权通过").toBe(200);
      // ② `Authorization` 是目标的 Bearer 令牌（不是本代理的形态）
      const b = await rawRequest(
        port,
        absReq(origin.port, ["Proxy-Authorization: " + creds, "Authorization: Bearer target-secret"]),
      );
      expect(b.status).toBe(200);
    });

    expect(rec.calls, "两次请求各调一次钩子").toHaveLength(2);

    // ① 本代理的凭证：两层规则都已被执行，钩子入参里什么都不该剩
    const own = rec.calls[0].headers;
    expect(Object.keys(own).some((k) => k.startsWith("proxy-")), "入参里不得残留任何 proxy-* 头").toBe(false);
    expect(own.authorization, "本代理自己签发的凭证必须已被剥掉（isOwnCredential 已跑过）").toBeUndefined();
    // 净化已发生：出站净化的另一样品（强制 close）在钩子之前就落好了
    expect(own.connection, "钩子跑在 sanitizeHeaders 之后 → 入参里 connection 已是 close").toBe("close");
    expect(own.host, "Host 回写也已完成 → 插件不必猜这个 Host 是谁写的").toBe(`127.0.0.1:${origin.port}`);

    // ② 目标的凭证：剥离是**按判据**走的，不是「把 authorization 一刀切掉」
    const target = rec.calls[1].headers;
    expect(target.authorization, "目标的 Authorization 不是本代理凭证，必须原样保留").toBe("Bearer target-secret");
    expect(Object.keys(target).some((k) => k.startsWith("proxy-")), "入参里同样不得有 proxy-* 头").toBe(false);

    // 线上那一侧同样逐条对上（不是只有钩子看得见）
    const wire1 = dictOf(origin.requests()[0]);
    const wire2 = dictOf(origin.requests()[1]);
    expect(wire1.authorization, "本代理凭证不许出站（最贵的那条泄漏路径）").toBeUndefined();
    expect(wire1["proxy-authorization"], "客户端的 proxy-* 头不许出站").toBeUndefined();
    expect(wire2.authorization, "目标的凭证必须真的送达源站").toBe("Bearer target-secret");
  });

  /**
   * 锁「钩子对 `connection` 的改动被覆盖掉」（次序的后半）
   *
   * @description `sanitizeHeaders` 里那一次同值写入是**冗余**的：省掉它就等于让钩子开上游
   * keep-alive，而那会与拨号守卫的收尾语义冲突。故真正的牙齿是**改写之后**那次无条件写入——
   * 本条把「改成别的值」与「整个删掉」两种最常见的绕法都试一遍，出站恒为 `close`。
   *
   * ⚠️ 这条**只在 http 通道成立**，Upgrade 通道不强制 close（`Connection: Upgrade` 是 101 的
   * 前提，强制成 close 等于把握手改坏）；所以它是 http 通道的契约，不许被推广到 upgrade 上。
   */
  it("钩子把 connection 改成 keep-alive 或整个删掉，出站都恒为 Connection: close", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    let mode: "keep" | "drop" = "keep";
    const rec = recorder((h) => {
      const next = { ...h };
      if (mode === "keep") {
        next.connection = "keep-alive";
      } else {
        delete next.connection;
      }
      return next;
    });

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      expect((await rawRequest(port, absReq(origin.port))).status).toBe(200);
      mode = "drop";
      expect((await rawRequest(port, absReq(origin.port))).status).toBe(200);
    });

    expect(rec.calls).toHaveLength(2);
    expect(dictOf(origin.requests()[0]).connection, "改成 keep-alive 会被覆盖回 close").toBe("close");
    expect(dictOf(origin.requests()[1]).connection, "整个删掉也会被补回 close").toBe("close");
  });
});

// ---------------------------------------------------------------------------
// ⑤ 抛错 = 不改写且请求照常成功
// ---------------------------------------------------------------------------

describe("integration/outbound-header-rewrite ⑤ 钩子抛错 = 不改写且请求照常成功", () => {
  /**
   * 锁「观察面抛错不得反噬协议收尾」
   *
   * @description 判据是**与 ① 的缺席基线逐字节全等** + **状态码 200**：前者钉「返回值被整体丢弃
   * （连同 hook 想改的 UA 与新加的头）」，后者钉「不得变成 5xx」。钩子刻意**不碰入参**（只构造
   * 一份带改动的字典再抛）——理由见文件头「两条刻意不给断言的」第 2 条：`catch` 返回的是同一个
   * 引用，就地改动会不会被兜住是一个**尚未裁决**的设计问题，本档不替它表态。
   */
  it("钩子抛错：出站报文与「完全不注入」的基线逐字节全等，且客户端拿到 200（不是 5xx）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const req = absReq(origin.port, ["User-Agent: baseline-ua"]);

    // 基线：完全不注入
    await withProxy(HttpProxy, proxyOpts(), async (port) => {
      expect((await rawRequest(port, req)).status).toBe(200);
    });
    const baseline = origin.requests()[0];

    const rec = recorder(() => {
      throw new Error("rewriter blew up");
    });

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      const r = await rawRequest(port, req);
      expect(r.status, "钩子抛错不得把请求变成 5xx").toBe(200);
      expect(r.text, "响应照常送达客户端").toContain("ok");
    });

    expect(rec.calls, "钩子确实被调过（否则这条是假绿）").toHaveLength(1);
    expect(
      origin.requests()[1],
      "抛错时出站报文必须与缺席基线逐字节全等（钩子想加的头 / 想改的值一条都不许生效）",
    ).toBe(baseline);
  });
});

// ---------------------------------------------------------------------------
// ⑥ 上下文
// ---------------------------------------------------------------------------

describe("integration/outbound-header-rewrite ⑥ 上下文维度", () => {
  /**
   * 锁「七个维度逐个传到位」
   *
   * @description `user` 在**未鉴权**时是 `undefined`（缺席即「没有身份」，不是空串）——见下一条带鉴权的用例。
   *
   * ⚠️ **`client` 断言的是 TCP 对端、不是 XFF 那一档**（本条曾按「XFF 优先」写，实测红）。原因是
   * 两个调用点都从 `terminal.snapshotContext().client` 取，而那个 `client` 是
   * `admission.ts:createInboundAdmission` 建 terminal 时给的 **`getSocketAddress(socket)`**——
   * **准入/名单判定那一档**。而 `http.ts:handleForward` 另建的 `eventContext.client`（`pipe` 事件、
   * `request.started` 用的那份）是 **`getClientAddress(req)`**（XFF > X-Real-IP > Forwarded > socket）。
   * **hook 拿到的是前者、事件面拿到的是后者**，两条注释都说「客户端地址」，读代码极易误以为是同一份。
   * 本档断言**它此刻真是什么**（TCP 对端），并在这里记下这个差异；它是不是该统一，同样是待裁决的口径
    * 问题，本档不替它拍板。
    *
    * ⚠️ **`protocol` 这一维已从端口上删掉**（本档起草时它还是个可选字段，实测两条通道都恒为
    * `undefined`——`terminal.snapshotContext()` 返回 `Partial<EventContext>`，而 `admission.ts`
    * 建 terminal 时给的那份只有 `{ client, connectionId, requestId, target? }`，SOCKS 之外无人补）。
    * 一个恒 `undefined` 的可选字段是**类型层面的撒谎**：插件作者会照它写分支、然后永远走 false
    * 那侧。留着比删掉更坏，故 `OutboundHeaderContext` 没有它，要判入站协议读 `channel`。
    * 本档因此对「protocol」**零断言**——它是缺席，不是不变式。
   */
  it("http 通道：channel/toProxy/target/client 与两个 id 全部传到位（未鉴权时 user 缺席）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder();

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      expect((await rawRequest(port, absReq(origin.port, ["X-Forwarded-For: 203.0.113.9"]))).status).toBe(200);
    });

    expect(rec.calls).toHaveLength(1);
    const ctx = rec.calls[0].context;
    expect(ctx.channel, "走的是哪条通道（落盘日志文本契约的字面量）").toBe("http");
    expect(ctx.toProxy, "对端是源站（直连）→ 不是代理").toBe(false);
    expect(ctx.target, "真实目标 authority，与 Host 回写同源").toBe(`127.0.0.1:${origin.port}`);
    // 客户端**显式发了 XFF**，而 `client` 维度仍是对端：它取的是 terminal 那份（TCP 对端），
    // 不是 `eventContext.client` 用的 `getClientAddress` 那一档。差异记在那条用例的注释里。
    expect(ctx.client, "TCP 对端（terminal 那份口径），刻意不受客户端自报的 XFF 影响").toBe("127.0.0.1");
    expect(typeof ctx.requestId, "requestId 必须传到位").toBe("string");
    expect(ctx.requestId, "requestId 非空").toBeTruthy();
    expect(typeof ctx.connectionId, "connectionId 必须传到位").toBe("string");
    expect(ctx.connectionId, "connectionId 非空").toBeTruthy();
    expect(ctx.requestId, "两个 id 是各自独立的维度，不许取同一个值").not.toBe(ctx.connectionId);
    expect(ctx.user, "未鉴权 → 没有身份维度（缺席即 undefined，不是空串）").toBeUndefined();
  });

  /**
   * 锁「鉴权通过时 `user` 维度等于账号名」
   *
   * @description 单独一条而不是并进上面那条：`user` 既是**可空维度**又要在**有值时精确**，
   * 一条用例同时断两半会让人分不清是哪半坏了。这里走**内联账号表**的 basic 身份（理由与取舍见
   * `authIdentity()` 的注释）：被测的是 `RequestScope.user → context.user` 这条接线，身份族与账号表
   * 来源与之无关，故不引入「临时 users.json + 1s 节流强制重读」那套更重的装配。
   */
  it("启鉴权后 user 维度等于账号名（basic 账号表经 Proxy-Authorization 鉴权通过）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder();

    await withProxy(HttpProxy, proxyOpts(rec.rewriter, authIdentity()), async (port) => {
      const r = await rawRequest(
        port,
        absReq(origin.port, [`Proxy-Authorization: ${basicAuth(ALICE, ALICE_PW)}`]),
      );
      expect(r.status, "凭据认得出来 → 鉴权通过").toBe(200);
    });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].context.user, "已鉴权用户名必须传到钩子上下文里").toBe(ALICE);
  });

  /**
   * 锁「`requestId` 逐请求独立、`connectionId` 按连接共享」
   *
   * @description 只断言「两个 id 都是非空字符串」的话，任何一个维度取错（两个都现算、两个都按连接
   * 缓存）都会全绿。故这条走**入站 keep-alive 的同一条 TCP 连接**连发两个请求：源站应答刻意带
   * `Connection: keep-alive`（否则代理回完就断链，两个请求会落在两条连接上，这条就白测了），
   * 然后断「同连接共享 connectionId」与「逐请求独立 requestId」两半。
   */
  it("同一入站连接上连发两个请求：connectionId 共享、requestId 各自独立", async () => {
    setup();
    const origin = await startOrigin(REPLY_200_KEEPALIVE);
    const rec = recorder();
    const req = absReq(origin.port);

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      const sock = await tcConnect(port);
      const c = makeCollector(sock);
      try {
        sock.write(req);
        await c.waitFor((b) => countOf(b.toString("latin1"), "\r\n\r\nok") >= 1, 5000);
        sock.write(req);
        await c.waitFor((b) => countOf(b.toString("latin1"), "\r\n\r\nok") >= 2, 5000);
      } finally {
        sock.destroy();
      }
    });

    expect(rec.calls, "两个请求各调一次钩子").toHaveLength(2);
    expect(origin.requests(), "两个请求都真的出站了").toHaveLength(2);
    expect(
      rec.calls[1].context.connectionId,
      "同一条入站 TCP 连接共享 connectionId（它取的是 socket 维度）",
    ).toBe(rec.calls[0].context.connectionId);
    expect(rec.calls[1].context.requestId, "requestId 是逐请求独立的").not.toBe(rec.calls[0].context.requestId);
  });

  /**
   * 锁「`toProxy` 在对端是代理时为 true，且上游凭证在钩子跑之前已注入」
   *
   * @description 这一档走 `client 模式 + http 上游`，用的是 `tests/helpers/upstream-stub.ts` 那份
   * 可观测上游桩（明文承载，3 角色 × 2 承载里取 https 角色的 plain 档：它逐字记下请求行与
   * `Proxy-Authorization`）。与上面几条「直连源站」档的区别正是 `toProxy` 这个维度，而它必须由
   * 连接器**声明**（`targetForm === "absolute"`）——插件要动 `host` 或凭证头时得先看它，绝不许
   * 从别处推。正控是同一次调用里的另外两条：Host **原样保留**（对端是代理，不做 §5.4 回写）、
   * 上游 Basic 凭证**已注入**（钩子不必自己算它该带什么）。
   */
  it("client 模式经 http 上游：toProxy 为 true，Host 原样保留且上游凭证在钩子跑之前已注入", async () => {
    setup();
    const upstream = await startUpstreamStub("https", { secure: false });
    UPSTREAMS.push(upstream);
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstream.port);
    set("upstreamUsername", "up-user");
    set("upstreamPassword", "up-pass");
    const rec = recorder();

    await withProxy(HttpProxy, proxyOpts(rec.rewriter), async (port) => {
      expect((await rawRequest(port, UPSTREAM_ABS_REQ)).status).toBe(200);
    });

    expect(rec.calls).toHaveLength(1);
    const ctx = rec.calls[0].context;
    expect(ctx.toProxy, "对端是 http 上游（targetForm === absolute）→ toProxy 为 true").toBe(true);
    expect(ctx.target, "target 是客户端请求的目标（不是上游地址）").toBe("127.0.0.1:8080");
    expect(rec.calls[0].headers.host, "对端是代理 → 客户端 Host 原样保留（不按 §5.4 回写）").toBe(
      "client-host.example",
    );
    expect(
      rec.calls[0].headers["proxy-authorization"],
      "上游凭证在改写**之前**已注入，插件不必猜该不该带、带什么",
    ).toBe(basicAuth("up-user", "up-pass"));

    // 上游那一侧：absolute-form 请求行 + 同样的凭证（源站桩逐字记的，证明改写链路上游照样通）
    const facts = upstream.last();
    expect(facts, "上游确实被拨到了（排除假绿）").toBeDefined();
    expect(facts?.requestLine, "对端是代理 → request-target 保留客户端的 absolute-form").toBe(
      "GET http://127.0.0.1:8080/x HTTP/1.1",
    );
    expect(facts?.proxyAuthorization, "上游确实收到了注入的 Basic 凭证").toBe(basicAuth("up-user", "up-pass"));
  });
});

// ---------------------------------------------------------------------------
// ⑦ 库调用方的注入路径
// ---------------------------------------------------------------------------

describe("integration/outbound-header-rewrite ⑦ 库调用方的注入路径", () => {
  /**
   * 锁「`createProxyRuntime({ services: { outboundHeaders } })` 真的落到 core 并真的被调用」
   *
   * @description 前面六条走的是直构 core（`ProxyOptions.outboundHeaders`），库调用方走的是另一条
   * 路：`RuntimeServices.outboundHeaders` → `runtime.options` → `ProxyOptions` → `CoreServices`。
   * 那条链上任何一环漏传，症状都是**静默的不改写**（请求照常 200，只是新头没出去）——本条因此同时
   * 断**同一性**（`runtime.options` / `core.options` 上就是注入的那一个函数）与**行为**（源站真的
   * 收到了新头）两半。
   *
   * `configDir` 显式给到临时目录：本档不跑 `loadConfig`，所有路径类字段的缺省会按 cwd（= 仓库根）
   * 绝对化，`authUsersFile` / `aclFile` / `quotaLedgerDir` 就会指向仓库的 `cfg/`。这不是洁癖：
   * 仓库里真的躺着 `cfg/users.json` 与 `cfg/acl.json`。
   */
  it("services.outboundHeaders 原样透传到 options 与 core，且真的被调用（静默漏传会红）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder((h) => ({ ...h, "x-trace-id": "lib-1" }));
    const port = await getFreePort();
    const runtime = createProxyRuntime({
      config: { host: "127.0.0.1", port },
      configDir: os.tmpdir(),
      logger: testLogger,
      services: { outboundHeaders: rec.rewriter, access: openAccessControl(), identity: NO_AUTH_IDENTITY },
    });

    try {
      await runtime.start();
      expect(runtime.services.outboundHeaders, "注入的那份原样落在 services 上").toBe(rec.rewriter);
      expect(runtime.options.outboundHeaders, "并一路透传到归一后的 options 上").toBe(rec.rewriter);
      expect(
        runtime.getProxy().options.outboundHeaders,
        "core 侧拿到的也是同一个实例（漏传在这里会红，而症状是静默的不改写）",
      ).toBe(rec.rewriter);

      const r = await rawRequest(port, absReq(origin.port));
      expect(r.status).toBe(200);
      expect(rec.calls, "库路径下钩子真的被调了").toHaveLength(1);
      expect(dictOf(origin.requests()[0])["x-trace-id"], "库路径下加的头也真的出站").toBe("lib-1");
    } finally {
      await runtime.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// ⑧ applyOutboundRewrite 的职责边界（源码级：这半条在行为面上原理不可观测）
// ---------------------------------------------------------------------------

describe("integration/outbound-header-rewrite ⑧ applyOutboundRewrite 的职责边界（源码级）", () => {
  const body = blockAfter(codeOf("core", "helpers", "headers.ts"), "export function applyOutboundRewrite(");

  /**
   * 锁「`applyOutboundRewrite` 体内零剥离、零强制头」
   *
   * @description 这条**只能是源码级**：它在问「某个职责长在哪个函数里」，而「改写这一步有没有顺带
   * 剥凭证 / 有没有顺手把 `connection` 钉死」在行为面上的投影是**空的**——即使这个函数真做了那些
   * 事，线上字节也可能一模一样（`sanitizeHeaders` 已经先剥过了、调用点随后又强制了一次
   * `Connection: close`）。所以「两半职责不许合并」这件事只能钉在源码形状上。
   *
   * 判据锚在**今天仍存在的调用点与常量**上（不是某个被删掉的符号名）：`isProxyHeaderName` /
   * `isStrippableOutboundHeader` / `isOwnCredential` / `HEADER_PREFIX_PROXY` 是剥离那半的入口，
   * `HEADER_VALUE_CLOSE` / 字面量 `connection` 是强制头那半的入口。任何一个被挪进来，这条立刻红。
   */
  it("改写这一步里不许长出剥离规则或强制头（两半职责分离）", () => {
    expect(
      body,
      "applyOutboundRewrite 只做「缺席/抛错 → 原样返回」这一个判定；"
        + "任何剥离判据（proxy- 前缀规则、isOwnCredential 委派）挪进来，就等于让「改写」重新长出安全职责。",
    ).not.toMatch(/isStrippableOutboundHeader|isProxyHeaderName|isOwnCredential|HEADER_PREFIX_PROXY/);
    expect(
      body,
      "`Connection: close` 的最终裁决归调用点（`channel/http.ts` 改写之后那次无条件写入）；"
        + "长进这个函数就等于把「插件能不能开上游 keep-alive」这件事的决定权交出去了。",
    ).not.toMatch(/HEADER_VALUE_CLOSE|connection/);
  });

  /**
   * 锁「缺席短路是承重的」（**已变异测试验证：删掉它 → 本条红，其余六条一条都不红**）
   *
   * @description 这条同样是原理不可观测的：`rewriter(headers, context)` 在 `rewriter === undefined`
   * 时会抛 `TypeError`，而那个 throw 就发生在**同一个 `try` 里**、被**同一个 `catch`** 接住、返回
   * **同一个引用**——删掉短路之后的字节与不删**逐字节全等**。区别全在热路径上：每个请求的每次出站
   * 都白付一次「构造异常对象 + 栈捕获 + 抛 + 捕」，而这条路径是每请求必经的。
   *
   * 判据是**肯定式**的（锚在今天存在的那段字面量上，`rewriter` 形参名一旦消失也会红），不是
   * 「某个符号不许出现」那种负向断言——后者在符号被删掉之后会**恒真**，伪装成「护栏在生效」。
   * 判据跨行，故先把空白折成单空格再比整段。
   */
  it("缺席短路必须在（删掉它字节等价，但每请求白付一次 throw/catch）", () => {
    expect(
      body.replace(/\s+/g, " "),
      "`undefined` 是这个策略位的完整语义（不改写 = 保持现状），缺席必须走「一次判定就返回」那条路；"
        + "走 catch 分支在字节上等价、在热路径上却是每请求一次异常构造。",
    ).toContain("if (rewriter === undefined) { return headers; }");
  });
});
