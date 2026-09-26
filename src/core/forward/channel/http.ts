import http from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { CoreContext } from "@/core/context.js";
import {
  absoluteFormAuthority,
  formatAuthority,
  resolveForwardTargets,
  sanitizeHeaders,
  type TargetParts,
} from "@/core/helpers/index.js";
import {
  HEADER_NAME_HOST_LOWER,
  REASON_BAD_GATEWAY,
  REASON_BAD_REQUEST,
  REASON_FORBIDDEN,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
} from "@/utils/constants/index.js";
import type { RequestScope } from "@/core/request-scope.js";
import { RequestTerminal, associateRequestTerminal } from "@/core/request-terminal.js";
import { meterStream, type TrafficAccount } from "@/core/traffic/index.js";
import type { UpstreamConnector } from "@/core/forward/upstream/connector/index.js";
import { ForwarderBase } from "@/core/forward/base.js";

/**
 * failEarly 状态码 → 响应正文：正文由状态码派生，杜绝「400 状态行 + 502 正文」错配。
 * 注意值是纯正文（REASON_*），不是预拼报文（HTTP_*）——res.writeHead 已发状态行，
 * 再 end 整份报文会把状态行重复写进 body。
 */
const EARLY_FAIL_BODY: Record<number, string> = {
  [STATUS_BAD_REQUEST]: REASON_BAD_REQUEST,
  [STATUS_FORBIDDEN]: REASON_FORBIDDEN,
  [STATUS_BAD_GATEWAY]: REASON_BAD_GATEWAY,
};

/**
 * HTTP 转发器
 *
 * **单一路径**（Phase 2b-2a）：「怎么到达 dest」全部收在 `forward/upstream/connector/`，
 * 本类不再按 `upstreamProtocol` 分发三条支路。原来三支路的差异只剩**声明式数据**
 * （`targetForm` / `kind` / `upstreamAuthHeader()` / `peerTarget()`），逐条对应如下：
 *
 * | 原支路 | 现在 | 差异从哪来 |
 * |---|---|---|
 * | `forwardViaRequest(secure=false)`（server 模式直连） | `DirectConnector` | — |
 * | `forwardViaRequest(secure=true/false)`（client 模式经 http(s) 上游） | `HttpConnectConnector` | TLS 三选项随建链搬进 `transport()`（`dialTls` 的 `upstreamTlsOptions`），本文件**不再注入任何 TLS 选项** |
 * | `forwardViaSocks`（经 SOCKS 隧道） | `Socks4/5Connector` | 隧道由 `transport()` 建，`http.request` 只复用这条 socket |
 *
 * 节点侧的职责不变：请求体分帧（chunked / Content-Length）、Expect/1xx、响应解析与头透传。
 * 拨号器继承自 {@link ForwarderBase}；事件一律经 `scope.emit` 发出。
 */
export class HttpForwarder extends ForwarderBase {
  /**
   * @param ctx - 依赖上下文，必须显式注入
   * @description 逐请求的事件槽与终态守卫经 {@link HttpForwarder.handleRequest} 的 `scope` 参数传入，
   * **不进构造期**：本实例由 `HttpProxy` 在服务构造期建一次、跨请求复用。
   */
  constructor(ctx: CoreContext, traffic: TrafficAccount) {
    super(ctx, traffic);
  }

  /**
   * 入口（入站事件 `request`）：解析目标 + 路由判定 → 前置守卫 → 选连接器 → 单一路径转发
   *
   * @description
   * 任意协议的 client 都可转发到任意上游：http 入站也能走 socks 上游、server 模式
   * 直连……判据全部是 `resolveRoute` 的**有效模式**（`route.route`），本方法不裸读 `proxyMode`。
   * 方法名与 `InboundKind` 的 `"request"` 逐字对齐（入站派发表 `core/server/http.ts` 的
   * 三项各指向一个**互不相同**的方法名）——所以「哪种事件走哪个转发器的哪个方法」
   * 一眼能从派发表读出来，不必去猜同名方法背后是哪个类。
   * @param scope - 本次请求的作用域（事件出口 + 身份维度 + 终态守卫）：**逐次传入，绝不存字段**
   */
  handleRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    scope: RequestScope,
  ): void {
    const requestTerminal = scope.terminal;
    associateRequestTerminal(clientReq, requestTerminal);

    // 拨号目标（dial）与客户端请求的目标（dest）成对给出 + 有效模式判定，收敛在一处
    const targets = resolveForwardTargets(
      clientReq.url,
      clientReq.headers.host as string,
      this.config,
    );

    if (!targets) {
      // 请求终态只由 RequestTerminal 发布（唯一的 request.rejected(stage=parse)/400）；
      // 下面的 pipe 事件只服务日志面（[target-unresolved] warn），不再被桥接成第二条公共拒绝。
      requestTerminal.reject("target-unresolved", "parse", STATUS_BAD_REQUEST);
      scope.emit({ type: "target-unresolved", url: clientReq.url, req: clientReq });
      this.failEarly(clientRes, STATUS_BAD_REQUEST);
      return;
    }

    // 拒绝收尾（403 名单 / 502 自环）与其终态发布共用一个闭包：两条 preDial 完全同形
    const deny = (status: number): void => {
      this.failEarly(clientRes, status);
      this.settleDenied(status, scope);
    };

    // ① 前置守卫：自环看**有效拨号地址**（client 模式即上游，名单命中回落直连时即真实目标），
    //    名单看客户端请求的目标——语义与事件/拒绝收尾收敛在基类 preDial
    if (this.preDial({ req: clientReq, dial: targets.dial, dest: targets.dest, deny }, scope)) {
      return;
    }

    // preDial 已过：client 配置的请求每请求恰发一条路由事件（server 配置在 emitRoute 内短路）
    this.emitRoute(targets.dest, targets.route, scope);

    // ② 选连接器（唯一写法在基类 connectorForRoute：direct ⟺ 该拨真实目标；
    //    命中 upstream 路由名单回落直连的请求必须走 directConnector，绝不碰 connectorFor。
    //    未登记的上游协议由 registry fail-closed 抛错，绝不静默回落直连——那是流量旁路）
    const connector = this.connectorForRoute(targets.route);

    // ③ **传输对端**与①判过的地址不同才补判自环：判据与理由见基类 preDialPeerTarget
    const { peer, denied } = this.preDialPeerTarget(
      clientReq,
      connector,
      targets,
      deny,
      scope,
    );

    if (denied) {
      return;
    }

    this.forwardViaTransport(clientReq, clientRes, connector, targets.dest, peer, scope);
  }

  /**
   * 单一出站路径：plan 头与 request-target → `connector.transport()` → `http.request`（复用该 socket）
   *
   * @description
   * 三支路合并后的全部逻辑都在这里，且**没有一个字节级的行为差异**：
   * - request-target 与 Host 的两种判据见下（刻意并存，不统一）；
   * - 出站净化与 `Connection: close` 由 `sanitizeHeaders` **统一**承担（原先 SOCKS 分支那句
   *   显式 `connection = close` 是它的重复，删掉不改变任何字节——三条支路都经过 sanitizeHeaders）；
   * - 上游失败统一由 {@link wireClientToUpstream} / 下方 catch 按成因分流 502/504；
   * - **TLS 三选项整体消失**：连接由连接器建（`HttpConnectConnector.transport` 内的 `dialTls`
   *   已带 `upstreamTlsOptions`），`http.request` 拿到的是握手完成的 socket，不再需要自己协商。
   *
   * @param connector - 已选定的连接器（决定 request-target 形态、是否注入上游凭证、Host 回写判据）
   * @param dest - 客户端请求的真实目标（request-target / Host / 名单判定对象）
   * @param peer - 传输对端（`connector.peerTarget(dest)`）：给 `http.request` 的 host/port 与失败日志路由
   * @param scope - 本次请求的作用域（事件出口 + 身份维度 + 终态守卫）
   */
  private forwardViaTransport(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    connector: UpstreamConnector,
    dest: TargetParts,
    peer: { host: string; port: number },
    scope: RequestScope,
  ): void {
    const terminal = scope.terminal;
    // 对端是代理（http/https 上游）还是源站（直连 / SOCKS 隧道）：全部下游判据的唯一来源
    const toProxy = connector.targetForm === "absolute";

    const headers = sanitizeHeaders(req.headers as never, this.config);

    // 上游凭证：注入与否**只由连接器声明**（`upstreamAuthHeader()`），本方法不再自己判形态——
    // 直连与 SOCKS 连接器恒返回 `undefined`（它们的凭证在 SOCKS 握手里、不走 HTTP 头），
    // http/https 上游才返回值。条件收在连接器里，才不会出现「本文件判一次、连接器再判一次」。
    const auth = connector.upstreamAuthHeader();

    if (auth) {
      (headers as Record<string, unknown>)["proxy-authorization"] = auth;
    }

    // request-target：对端是代理 → 保留客户端原始形态（absolute-form，代理需要完整 URL 才能转发）；
    // 对端是源站 → 用解析后的 origin-form（客户端发 absolute-form 时原样交给 request 会把
    // `GET http://host/path` 写进请求行，源站收到畸形 request-target）
    const path = toProxy ? req.url! : dest.path;

    // Host：**两套判据并存，刻意不统一**。
    //   ① `toProxy`（对端是代理）：客户端 Host 头**原样保留**——absolute-form 请求行的
    //      权威值已经是「客户端要访问谁」，改写 Host 会与请求行自相矛盾（RFC 7230 §5.4
    //      的回写规则只适用于**代理转发给源站**时，不适用于把请求交给另一个代理）。
    //   ② 直连源站：客户端发的是 absolute-form 时按 §5.4 回写为 request-target 的权威值
    //      （虚拟主机/ACL/缓存键混淆）；origin-form 则原样保留。
    //   ③ 经 SOCKS 隧道：request-target 已被本代理改写成 origin-form，客户端的 Host 未必与该
    //      origin 一致（客户端可能把代理自身 authority 写进了 Host），故**无条件**回写为
    //      真实目标 authority（IPv6 经 `formatAuthority` 补回方括号，避免 `::1:80` 畸形报文）。
    // ②③ 都是「对端是源站」，判据却不同（条件回写 vs 无条件回写）——**这是既有的两种判据，
    // 不是同一个东西抄了两遍**：②的触发条件是「客户端的 Host 与 request-target 冲突」，
    // ③的前提是「request-target 已被本代理改写、客户端的 Host 不可信」。**不要统一它们。**
    if (!toProxy) {
      if (connector.kind === "direct") {
        const authority = absoluteFormAuthority(req.url ?? "");

        if (authority) {
          (headers as Record<string, unknown>)[HEADER_NAME_HOST_LOWER] = authority;
        }
      } else {
        (headers as Record<string, unknown>)[HEADER_NAME_HOST_LOWER] = formatAuthority(
          dest.host,
          dest.port,
        );
      }
    }

    connector
      .transport({
        client: req.socket as unknown as Duplex,
        dest: { host: dest.host, port: dest.port },
        onEvent: scope.emit,
        logPrefix: "http",
        // **请求路径必须与上游解耦**：本通道的上游 socket 是每请求新建的传输层，交给
        // `http.request({ createConnection })` 拥有（响应解析/收尾全在 Node 手里）；而
        // `req.socket` 是入站**长连接**，它的存活由客户端自己的 keep-alive 决定，与上游
        // 连不连得上毫无关系。故显式申报 `"independent"`：守卫只保留「客户端先出事 →
        // 毁上游」这一个方向，绝不因上游关闭/超时/出错回敬客户端连接。
        //
        // 不申报的后果（真实回归，已修）：源站响应后关掉自己的连接 → 守卫的
        // `upstream.on("close") → client.destroy()` 打死入站 keep-alive → 客户端每个请求
        // 都被迫重连（实测 `reusedSocket` 恒 false、入站 TCP 连接数 = 请求数）。
        //
        // **不要**把这行挪到隧道路径：CONNECT / upgrade / SOCKS 的 `client` 与管道确实是
        // 同一资源的两端（`bridge()` 双向 pipe），那里解耦会让「上游已死、客户端还在等
        // 字节」变成挂死。详见 `DialGuardOptions.clientLifetime`。
        clientLifetime: "independent",
      })
      .then((sock) => {
        // 端口按 `Duplex` 声明返回值（免得把连接器锁死成某一种流），但四个实现一律经
        // `Dialer.dialWith` 产出 `net.Socket` / `tls.TLSSocket`（后者是前者的子类），
        // 而空闲超时要用到 socket 独有的 `setTimeout` —— 故此处做一次**有注释的收窄**，
        // 而不是把端口签名改成 `net.Socket`（那会让「返回什么形状」变成端口契约的一部分）。
        const transport = sock as Socket;

        // 复用连接器建好的传输层：Node 负责请求分帧/响应解析，我们只给「连到哪 + 请求什么」。
        // host/port 取**传输对端**（代理型即上游），与「请求里去哪」（dest）刻意是两件事。
        //
        // 计量装配顺序有个真实的循环依赖：耗尽时要中止**出站请求**，而出站请求由 `http.request`
        // 产出；而 `up` 计量必须挂在 `req` 上、且与 `down` 共用同一个「恰好一次」闭锁，闭锁又要在
        // 挂 `up` 之前建好。用一个**惰性 destroy 包装**（可变绑定 + 闭包）打破它：`proxy` 在同一轮
        // 同步执行内就定型，而闭包只在之后的事件回调里才被调用，因此读到的一定是已赋值的实例。
        const out = { request: undefined as http.ClientRequest | undefined };
        const expire = this.openHttpQuotaGate(scope, res, transport, {
          destroy: () => out.request?.destroy(),
        });
        // `up` 计量挂在**客户端请求对象**上（不是 `req.socket`：入站 socket 被 keep-alive 的多个
        // 请求共享，在它上面计数会把上一个请求的字节算到这个用户头上 = 账本串号）。
        meterStream(this.traffic, scope.user, "up", req, (dir, verdict) => expire(dir, verdict));

        const proxy = http.request(
          {
            host: peer.host,
            port: peer.port,
            method: req.method,
            path,
            headers: headers as never,
            createConnection: () => transport,
          },
          (upRes) => {
            this.observeResponseTerminal(res, upRes, terminal);
            // 无状态行归属 502：上游未给有效响应即网关无应答
            if (upRes.statusCode === undefined) {
              terminal.fail(new Error("upstream response has no status"), "forward");
            }
            res.writeHead(upRes.statusCode ?? STATUS_BAD_GATEWAY, upRes.headers);
            // `down` 计量挂在**上游响应对象**上（不是 `transport` 裸 socket：那会把经上游代理
            // 时的 CONNECT 应答也计进来，那是协议字节不是用户流量；也不是 `res`：那是出站方向）。
            // 只覆盖消息体——状态行+响应头由 `writeHead` 直接写进 socket，不经过本对象（不对称
            // 已量化记录，见 `core/traffic/meter.ts` 文件头）。
            meterStream(this.traffic, scope.user, "down", upRes, (dir, verdict) =>
              expire(dir, verdict),
            );
            upRes.pipe(res);
          },
        );
        out.request = proxy;

        this.wireClientToUpstream(req, res, proxy, scope, {
          errorLabel: `[http] upstream error ${peer.host}:${peer.port}`,
          transport,
        });
      })
      .catch((err: Error) => {
        // 拨号/握手失败：成因必须落盘（TLS 校验失败/拒绝连接在日志里无痕是最难查的一类）
        scope.emit({
          type: "upstream-error",
          message: `[http] upstream error ${peer.host}:${peer.port}: ${err.message}`,
          err,
        });
        this.settleDialFailure(() => this.fail(res), err, scope);
      });
  }

  /**
   * 上游请求收尾统一下挂：error / 空闲超时 / 客户端中断 / 请求体泵送
   * - error：上报 upstream-error（含成因）后回 502 —— 此前静默 502，TLS 校验失败与连接拒绝无法区分
   * - 空闲超时：只 destroy，具体 502 由 error 兜底统一回
   * - 客户端中断：销毁上游请求避免悬挂至超时；一并销毁我们自己建的那条传输层
   * @param opts.errorLabel - 上游失败日志前缀（形态取自传输对端，故三条支路同一句式）
   * @param opts.transport - 连接器建的那条 socket；客户端中断时需一并销毁
   *   （`proxy.destroy()` 也会毁它，这里显式再毁一次只是幂等兜底，不改变行为）
   */
  private wireClientToUpstream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    proxy: http.ClientRequest,
    scope: RequestScope,
    opts: { errorLabel: string; transport: Socket },
  ): void {
    const terminal = scope.terminal;

    // `upstreamTimeout` 的**空闲**计时器必须自行装订：Node **不会**把
    // `http.request({ timeout })` 应用到 `createConnection` 提供的 socket 上
    // （实测传了 `timeout` 后 `socket.timeout` 恒为 undefined，`req.on("timeout")` 永不触发）。
    // 装在 **socket** 上而不是 `proxy.setTimeout()`：后者是「从请求起算的一次性」定时器，
    // 会把耗时超过 upstreamTimeout 的慢速大响应误杀，而本路径要保持的语义是**空闲**超时
    // （与改造前 agent 路径的 socket 空闲超时一致）。`<= 0` 即禁用（同 `socket.setTimeout(0)`）。
    const timeout = this.config.get("upstreamTimeout");
    opts.transport.setTimeout(timeout);
    opts.transport.once("timeout", () => {
      terminal.fail(new Error("upstream request timeout"), "forward");
      proxy.destroy();
    });

    proxy.on("error", (err: Error) => {
      scope.emit({
        type: "upstream-error",
        message: `${opts.errorLabel}: ${err.message}`,
        err,
      });
      this.fail(res);
      terminal.fail(err, "forward");
    });

    // 客户端中断：销毁上游请求，避免悬挂至超时
    res.on("close", () => {
      if (!res.writableEnded) {
        proxy.destroy();

        if (!opts.transport.destroyed) {
          opts.transport.destroy();
        }
        terminal.fail(new Error("client response closed before completion"), "forward");
      }
    });

    req.pipe(proxy);
  }

  /**
   * 观察响应的真实结束点：headers 到达不等于请求完成，只有 response finish 才发 completed。
   * 上游源流错误/客户端提前 close 只补 failed，guard 会与 finish/error 竞态收口。
   */
  private observeResponseTerminal(
    res: http.ServerResponse,
    upstream: http.IncomingMessage,
    terminal: RequestTerminal,
  ): void {
    res.once("finish", () => {
      terminal.complete(res.statusCode);
    });
    res.once("close", () => {
      if (!res.writableEnded) {
        terminal.fail(new Error("client response closed before completion"), "forward");
      }
    });
    upstream.once("error", (error: Error) => {
      terminal.fail(error, "forward");
    });
  }

  /**
   * 转发前的早失败回写：目标解析失败（400）、名单拒绝（403）与自环（502）共用
   * @description 终态由基类 `settleDenied` 结算（403 → `target-denied`/access，其余 → 自环 `fail`），
   * 本方法只管 `ServerResponse` 这一种应答形态。
   * @param status - 状态码（STATUS_BAD_REQUEST / STATUS_FORBIDDEN / STATUS_BAD_GATEWAY）
   */
  private failEarly(res: http.ServerResponse, status: number): void {
    if (!res.headersSent) {
      res.writeHead(status);
    }

    res.end(EARLY_FAIL_BODY[status] ?? REASON_BAD_REQUEST);
  }

  /**
   * 网关错误回写：响应未开始时回 502；已开始流式或已销毁则只销毁连接
   * - 避免把 502 文本追加进已流式的 body（协议污染）
   */
  private fail(res: http.ServerResponse): void {
    if (res.headersSent || res.destroyed || res.writableEnded) {
      res.destroy();
      return;
    }

    res.writeHead(STATUS_BAD_GATEWAY);
    res.end(REASON_BAD_GATEWAY);
  }
}
