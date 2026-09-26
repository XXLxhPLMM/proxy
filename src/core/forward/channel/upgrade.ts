import http from "node:http";
import type { Duplex } from "node:stream";
import type { CoreContext } from "@/core/context.js";
import {
  formatAuthority,
  isStrippableOutboundHeader,
  resolveForwardTargets,
  type TargetParts,
} from "@/core/helpers/index.js";
import { awaitStatusLine } from "@/core/guard.js";
import {
  CRLF,
  DOUBLE_CRLF,
  HEADER_NAME_HOST_LOWER,
  HEADER_NAME_HOST_TITLE,
  HEADER_NAME_PROXY_AUTHORIZATION,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_GATEWAY_TIMEOUT,
  STATUS_SWITCHING_PROTOCOLS,
} from "@/utils/constants/index.js";
import type { RequestScope } from "@/core/request-scope.js";
import { associateRequestTerminal } from "@/core/request-terminal.js";
import type { BufferedCharge } from "@/core/traffic/index.js";
import type { CoreServices, IdentityProvider } from "@/core/types/proxy.js";
import type {
  ConnectorSource,
  UpstreamConnector,
} from "@/core/forward/upstream/connector/index.js";
import { DialTimeoutError } from "@/core/forward/upstream/dial.js";
import { ForwarderBase } from "@/core/forward/base.js";

/**
 * 本条链路是不是「SOCKS 隧道」
 *
 * @description
 * **唯一判据是连接器身份**（`connector.kind`，由 registry 构造期钉死），**不再从
 * `upstreamProtocol` 二次推导** —— 那正是连接器层要消灭的第二真相源。
 *
 * **它现在只服务一件事：拨号失败日志的 `"via socks "` 尾巴**（`upgradeOver` 的 catch）。
 * 报文形态（request-target 形态与是否注入上游凭证）**早已不再由它决定**——那两件事收归
 * `connector.targetForm` / `connector.upstreamAuthHeader()`，与 {@link HttpForwarder} 逐字同源。
 *
 * ⚠️ **这里有一条「巧合撑着的契约」，改之前必须读懂**：内置 SOCKS 连接器的
 * `targetForm` 是 `"origin"`（隧道直达源站），所以「`isSocksTunnel` 为真」与
 * 「`targetForm !== "absolute"`」在**内置四个连接器上恒等价**——**报文形态看起来没变**。
 * 但那**只是巧合**：`kind` 与 `targetForm` 是两个独立的声明式字段，端口对它们的取值
 * **没有任何约束**。改判据之前，这条通道读的是 `mode === "client" && !viaSocksTunnel`
 * （有效模式 + 连接器身份）而 http 通道读的是 `targetForm === "absolute"`（对端身份），
 * **两份判据**；一份插件连接器（`kind:"https"` + `targetForm:"origin"`，即「隧道中继型」：
 * 中间有一跳但终点是源站）就能让两者分叉，那时 upgrade 会把上游 Basic 凭证注入给真实目标站。
 * 端口收口之后**同一个字段说了算**，巧合不再是承重结构。
 *
 * 注意 `targetForm` **判不出「是否经 SOCKS 隧道」**：直连与 SOCKS 同为 `"origin"`（对端都是源站），
 * 区别只在「中间是否有一次 SOCKS 握手」——而日志文案只需要后者，故仍用 `kind`。
 */
function isSocksTunnel(connector: UpstreamConnector): boolean {
  return connector.kind === "socks4" || connector.kind === "socks5";
}

/**
 * 构建 Upgrade 请求（剔除 proxy-* 头，重写 Host）
 * @param req - 原始 Upgrade 请求
 * @param host - 握手 Host 回写主机（客户端请求的目标）
 * @param port - 握手 Host 回写端口
 * @param path - origin-form 请求目标（对端是源站时使用：直连 / SOCKS 隧道 / 隧道中继型连接器）
 * @param toUpstreamProxy - **对端是不是 HTTP 代理**：true（`connector.targetForm === "absolute"`）
 *   时 request-target 保留客户端的 absolute-form——上游代理收到 origin-form 的 `GET /ws` 会当成
 *   「发给代理自身的请求」而不会转发升级；false 时用 origin-form，因为对端是**真实目标站**，
 *   发 absolute-form 等于让源站收到一个畸形 request-target
 * @param identity - 身份插件，出站凭证判据（`isStrippableOutboundHeader`）的唯一来源；
 *   必须显式注入——**不再从 config 猜**（猜错的方向是「代理自己的凭证被原样发给目标站」）
 * @param upstreamAuth - **已由连接器算好的上游凭证头值**（`connector.upstreamAuthHeader()`）：
 *   本函数**只判有没有**、不再自己算。判据归连接器（见 `connector/types.ts:upstreamAuthHeader`
 *   与 {@link HttpForwarder} 那一侧的逐字同源写法）——本函数曾经自己调 `upstreamAuthValue(config)`，
 *   那是**绕过端口的第二判据**：它既不看对端是不是代理、也不问连接器该不该给凭证，
 *   于是「隧道中继型」连接器（`targetForm:"origin"` + `upstreamAuthHeader() === undefined`）
 *   在 client 模式下会拿到**发给真实目标站的 `Proxy-Authorization`**
 * @description Host 回写走 `formatAuthority`：解析侧已剥去 IPv6 方括号，
 *   拼装侧必须补回（否则 `::1:80` 是畸形 authority，上游/源站无法解析）
 */
function buildUpgradeReq(
  req: http.IncomingMessage,
  host: string,
  port: number,
  path: string,
  toUpstreamProxy: boolean,
  identity: IdentityProvider,
  upstreamAuth: string | undefined,
): string {
  const target = toUpstreamProxy ? (req.url ?? path) : path;
  const requestLine = `${req.method} ${target} HTTP/${req.httpVersion}${CRLF}`;

  const headerLines: string[] = [];

  const raw = req.rawHeaders ?? [];

  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];

    // 出站净化与 sanitizeHeaders 同谓词：任意 proxy- 前缀 + 命中代理凭证的 authorization
    if (isStrippableOutboundHeader(name, value, identity)) {
      continue;
    }

    if (name.toLowerCase() === HEADER_NAME_HOST_LOWER) {
      headerLines.push(`${HEADER_NAME_HOST_TITLE}: ${formatAuthority(host, port)}`);
    } else {
      headerLines.push(`${name}: ${value}`);
    }
  }

  // 上游凭证：**注入与否只由连接器声明**（`upstreamAuthHeader()`），与 `http.ts` 逐字同源。
  // 直连 / SOCKS / 隧道中继型连接器恒返回 `undefined`（SOCKS 的凭证在握手里、不走 HTTP 头）
  if (upstreamAuth) {
    headerLines.push(`${HEADER_NAME_PROXY_AUTHORIZATION}: ${upstreamAuth}`);
  }

  return `${requestLine}${headerLines.join(CRLF)}${DOUBLE_CRLF}`;
}

/**
 * HTTP `Upgrade` 转发器（**不实现 WebSocket 协议**）
 *
 * @description
 * **它为什么叫 `upgrade` 而不是 `websocket`**：本文件只做三件事——改写并写出 HTTP `Upgrade`
 * 握手报文、严格等一个 101 状态行、把 101 之后的余下字节**原样桥接**。**没有帧解析、没有分片重组、
 * 没有掩码、没有 ping/pong、没有 close 握手**（grep 全文可证：帧相关常量与词汇零命中）。
 * 那些是 WebSocket 协议本身的事，由客户端与目标站两端去做——代理站在 101 之后就该变成
 * 一条透传管道（{@link WsForwarder.relay} → 基类 `bridgeWithBuffered` → `Dialer.bridge`，
 * 两个方向的 `pipe` + 余量回灌，与对端是不是代理毫无关系）。
 * 叫 `websocket` 会让读代码的人以为「帧的处理归这里」，而那正是它不做、也不该做的事。
 * （`buildUpgradeReq` 的 request-target 形态按 `toUpstreamProxy` 判、是否注入上游凭证按连接器
 * 声明的 `upstreamAuth` 判，那说的是**上游对接**形态，同样不是 WebSocket 协议。）
 *
 * `Upgrade` 语义与 HTTP 类似，但需等 101 才桥接
 * - **单一路径**（与 http/tunnel/socks 同一形状）：「怎么到达 dest」一律经
 *   `forward/upstream/connector/` 的 `transport()`（直连回落直连、有效 client 经 http(s) 上游、
 *   经 SOCKS 隧道），本类不再直接拨号、**不再按 `upstreamProtocol` 分流**
 * - 事件一律经 `scope.emit` 发出（逐请求闭包，身份维度只在 `createRequestScope` 注一次）；
 *   `dialer` 只服务 {@link WsForwarder.relay} 的桥接
 * - 拒绝收尾统一写原始状态行报文（见基类 `refuse`）：407/403 同款形态，
 *   不再「名单拒绝写 403、拨号失败静默 destroy」两套语义并存
 * - 服务包（身份 / 访问控制 / 流量账本）与连接器源继承自 {@link ForwarderBase}；
 *   策略面（路由判定的 `policy`）与上游地址同样由基类拼装，本类**零裸读 `proxyMode`**
 */
export class WsForwarder extends ForwarderBase {
  /**
   * @param ctx - 依赖上下文，必须显式注入
   * @param services - 归一后的服务包（身份 / 访问控制 / 流量账本），必须显式注入
   * @param connectors - 装配期解析好的连接器源，必须显式注入
   * @description 逐请求的事件槽与终态守卫经 {@link WsForwarder.handleUpgrade} 的 `scope` 参数传入，
   * **不进构造期**：本实例由 `HttpProxy` 在服务构造期建一次、跨请求复用。
   */
  constructor(ctx: CoreContext, services: CoreServices, connectors: ConnectorSource) {
    super(ctx, services, connectors);
  }

  /**
   * 入口（入站事件 `upgrade`）：**单一路径** —— 解析目标 + 路由判定 → 前置守卫 → 选连接器 →
   * 经连接器取传输层 → 写 Upgrade 报文并等 101
   *
   * @description
   * 方法名与 `InboundKind` 的 `"upgrade"` 逐字对齐（入站派发表的三项各指向一个**互不相同**的
   * 方法名）。形状与 `handleRequest` / `handleConnect` / socks 的 `connect` 一致：任何上游协议
   * （http/https/socks4/sockss4/socks5/sockss5）都只由 `resolveForwardTargets` 出的
   * **有效路由**决定，**本方法不再读 `proxyMode`、不再按 `upstreamProtocol` 分流**。
   * **本方法零协议分支**：三处差异全部是连接器的声明式数据 —— `targetForm`（request-target 形态，
   * 在 `upgradeOver` 内经 `toUpstreamProxy` 生效）、`upstreamAuthHeader()`（是否注入上游凭证，
   * **判据的唯一来源**）、`peerTarget()`（传输对端，补判自环用）；`kind` 只剩「是否 SOCKS 隧道」
   * 这一项，且**只服务失败日志文案**。
   * @param req 握手请求 @param socket 下游 @param head 已读半包
   * @param scope - 本次请求的作用域（事件出口 + 身份维度 + 终态守卫）：**逐次传入，绝不存字段**
   */
  handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    scope: RequestScope,
  ): void {
    const requestTerminal = scope.terminal;
    associateRequestTerminal(req, requestTerminal);

    // 拨号目标与客户端请求的目标成对解析（名单判 dest、拨号用 dial、route 判路由），见 resolveForwardTargets。
    // 策略面与上游地址都由基类拼装——本方法不裸读 `proxyMode`/`upstreamHost`/`upstreamPort`
    const targets = resolveForwardTargets(req.url, req.headers.host as string, this.routePolicy(), {
      upstream: this.upstreamEndpoint(),
    });

    if (!targets) {
      this.refuse(socket, STATUS_BAD_REQUEST);
      requestTerminal.reject("invalid-target", "parse", STATUS_BAD_REQUEST);
      return;
    }

    // 拒绝收尾（403 名单 / 502 自环）与其终态共用一个闭包：两条 preDial 完全同形；
    // 终态映射由基类 settleDenied 收口（403 → target-denied/access、502 → 自环 fail）
    const deny = (status: number): void => {
      this.refuse(socket, status);
      this.settleDenied(status, scope);
    };

    // ① 前置守卫：自环看**有效拨号地址**（client 模式即上游 → 上游自环由这一次判掉）、
    //    名单看客户端请求的目标，与 http/tunnel/socks 共用同一前置守卫
    if (this.preDial({ req, dial: targets.dial, dest: targets.dest, deny }, scope)) {
      return;
    }

    // preDial 已过：client 配置恰发一条路由事件（server 配置在 emitRoute 内短路）
    this.emitRoute(targets.dest, targets.route, scope);

    // 有效模式（client 配置 + 名单命中回落 server），后续分支一律用它、不再裸读 proxyMode
    const route = targets.route;

    // ② 选连接器（唯一写法在基类 connectorForRoute：direct ⟺ 该拨真实目标，
    //    命中 upstream 路由名单回落直连的请求必须走 `connectors.direct()`，绝不碰 `connectors.upstream()`。
    //    未登记的上游协议由 registry fail-closed 抛错，绝不静默回落直连——那是流量旁路）
    const connector = this.connectorForRoute(route);

    // ③ **传输对端 ≠ 有效拨号地址**才补判一次守卫 —— 这一步是**保住「真实目标自环」判定**：
    //    判据、为什么不能无脑判两遍、以及「短路掉它就是一个真实自环漏洞」的完整论证，
    //    都在基类 `preDialPeerTarget`（http 通道那处逐字同源，现已收成同一份）
    const { denied } = this.preDialPeerTarget(req, connector, targets, deny, scope);

    if (denied) {
      return;
    }

    // ④ 单一路径：三类连接器的 `transport()` 都是「本通道要的那条链路」，随后由本通道
    //    写 Upgrade 握手报文并等 101（**绝不能**先发 CONNECT，见 transportVia 的说明）
    //    **只传 `connector` 本身**：request-target 形态与上游凭证都由它声明（`targetForm` /
    //    `upstreamAuthHeader()`），本方法**不再**传「有效模式 + 是否 SOCKS 隧道」这两个
    //    由 core 自己推出来的判据——那是绕过端口的第二真相源（论证见 `isSocksTunnel` 的注释）
    this.upgradeOver(
      req,
      socket,
      head,
      targets.dest,
      this.transportVia(connector, socket, targets.dest, scope),
      connector,
      scope,
    );
  }

  /**
   * 经连接器取一条可写字节的链路 → {@link upgradeOver} 期望的 `Promise<Duplex>`
   *
   * @description
   * **唯一调用点**（`handle` 的第 ④ 步）：「用哪个连接器」由 `resolveForwardTargets` 的
   * 有效路由决定，本方法**一个协议都不判**——直连回落、有效 client 经
   * http(s) 上游（`connectorFor` → `HttpConnectConnector`）、经 SOCKS 隧道（`connectorFor`
   * → SOCKS 连接器）三类都从这里取同一条链路。
   *
   * **守卫前缀恒为 `"upgrade"`**：三条路径的守卫 route 文本是**锁死的契约**
   * （`tests/integration/forwarder-connector-wiring.test.ts` 逐字断言
   * `[upgrade] error <clientAddr> -> <dest> [via …]`），故**不得**按连接器身份改前缀。
   * 「是否经 SOCKS 隧道」只影响**报文形态与失败文案**（{@link upgradeOver} 的
   * `viaSocksTunnel`），不影响守卫前缀。
   *
   * **刻意用 `transport()` 而不是 `open()`**（这是本通道与 tunnel/socks 的唯一语义差别）：
   * Upgrade 通道的「先发字节」是**本通道自己写的 Upgrade 握手报文**（对端要的是完整请求，
   * 不是裸字节流），故 http(s) 上游这一档**不能先发 CONNECT**——那会把上游代理的协议状态机
   * 带偏（它先回 200 再等 CONNECT，而本通道随即就等 101 → 死锁）。三类连接器的
   * `transport()` 恰好都是「要的那条链路」：直连与 SOCKS 的 `transport()` 就是
   * `open().sock`（**含** SOCKS 握手，直连没有握手可做），http/https 的只拨号到上游。
   *
   * 顺带因此**取不到也不需要** `OpenedUpstream` 的 `rest`/`refusal`：前者三个 `transport()`
   * 都不产余量（余量只在 CONNECT 应答头之后才有），后者只属 `open()` 的非 200 形态。
   *
   * @param connector - 目标连接器（要 `transport()`：传输层，不含 CONNECT 隧道）
   * @param client - 客户端双工流
   * @param dest - 拨号目标（= 有效模式为 server 时的真实目标；client 模式下是客户端请求的目标，
   *   只进守卫 route 文本的 `<dest>` 段，传输对端由连接器按 `upstreamHost`/`upstreamPort` 定）
   * @param scope - 本次请求的作用域（事件出口 + 身份维度）
   */
  private transportVia(
    connector: UpstreamConnector,
    client: Duplex,
    dest: TargetParts,
    scope: RequestScope,
  ): Promise<Duplex> {
    return connector.transport({
      client,
      dest,
      // 事件槽原样透传（身份已在 scope 闭包里注好）
      onEvent: scope.emit,
      logPrefix: "upgrade",
    });
  }

  /**
   * 拨号成功后接管 Upgrade：写握手报文（剔 proxy 头 + 重写 Host）→ 回灌已读半包 → 等 101 桥接；
   * 失败落盘并按成因写 504（超时）/502（其余）收尾（与拒绝路径的 403 同款写报文语义）
   * @param target - 客户端请求的目标（握手报文 Host 按它回写；直拨与 socks 上游即建链目标，
   *                 client 模式经 http/https 上游时它是上游的服务器上真正要访问的站点，与拨号地址不同）
   * @param upstreamDial - 上游拨号 Promise
   * @param connector - 本次请求选中的连接器：**报文形态与凭证面的唯一真相源**
   *   （`targetForm` 决定 request-target 形态、`upstreamAuthHeader()` 决定是否注入上游凭证，
   *   与 {@link HttpForwarder.forwardViaTransport} 逐字同源）
   * @param scope - 本次请求的作用域（事件出口 + 身份维度 + 终态守卫）
   * **本方法只收 `connector`、不收 `mode` 与 `viaSocksTunnel`**：报文形态与凭证面一律由
 *   `targetForm` / `upstreamAuthHeader()` 说了算。**自己再判一次「对端是不是代理」是错的**——
 *   第三方注入自定义 `ConnectorSource` 时（`kind` 与 `targetForm` 是两个独立声明式字段、
 *   端口对二者无约束）那样的判据会把「隧道中继型」连接器（`kind:"https"` /
 *   `targetForm:"origin"` / `upstreamAuthHeader() === undefined`）误判成代理型，
 *   **用 absolute-form 把 `UPSTREAM_USERNAME`/`UPSTREAM_PASSWORD` 的 Basic 凭证发给真实目标站**。
 *   收口之后**同一个字段说了算**，且凭证仍然只经 `upstreamAuthHeader()` 出端口。
   *
   * `"via socks "` 那个失败日志尾巴仍由 {@link isSocksTunnel}（`connector.kind`）给，
   * **逐字不变**（`forwarder-connector-wiring` 逐字断言那一族 `[upgrade] error …`）。
   */
  private upgradeOver(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: TargetParts,
    upstreamDial: Promise<Duplex>,
    connector: UpstreamConnector,
    scope: RequestScope,
  ): void {
    // 拨号失败日志尾巴：只有经 SOCKS 隧道才带（逐字锁死的日志文本契约，与报文形态无关）
    const viaSocksTunnel = isSocksTunnel(connector);

    upstreamDial
      .then((upstream) => {
        // 对端是代理（`targetForm === "absolute"`，即 http/https 上游）→ 保留客户端的
        // absolute-form + 按连接器声明注入上游凭证；对端是源站（直连 / SOCKS 隧道 /
        // 隧道中继型）→ origin-form 且不注入任何上游凭证。**判据与 http 通道逐字同源**
        const toUpstreamProxy = connector.targetForm === "absolute";

        upstream.write(
          buildUpgradeReq(
            req,
            target.host,
            target.port,
            target.path,
            toUpstreamProxy,
            // 出站头剥离的判据来自身份插件（它才知道自己的凭证形态）
            this.services.identity,
            // 上游凭证**只由连接器声明**，本方法不再读配置、也不再自己算
            connector.upstreamAuthHeader(),
          ),
        );

        // **计量**：Upgrade 握手请求与 101 应答都是协议字节（由本通道自己 write 出去，不经
        // `data` 事件，天然不计量）；`head`（客户端握手头之后的首包）是**真实载荷**、必须计入。
        // 计量器在握手报文写完之后才开：那时两条流已是「建链完成后流动的真实字节」。
        const meter = this.openTunnelMeter(socket, upstream, scope);
        if (head.length) {
          // ⚠️ **必须判 `allow`**：WebSocket 的首批载荷走的是**本通道自己的写入路径**
          // （`upgradeOver` 在 `relay` 之前直接 `upstream.write(head)`），**不经过**
          // `bridgeWithBuffered` 的补记判定——四个补记调用点里只有这里不判。
          //
          // 语义与 `bridgeWithBuffered` 的 `if (!meter.charge(dir, n).allow) return` 逐字同源：
          // 判定不通过时**收尾已经在 `charge` 内部做完了**（`openTunnelMeter` 的
          // `onExceeded`：发恰好一条 `traffic.quota-exceeded` + 双端 `destroy`），
          // 调用方要做的**只有「不写」并中止本条链路**——既不要自己再 destroy 一次，
          // 也不要写协议应答（101 还没等到，此刻写任何字节都是凭空造状态）。
          //
          // **实测（别凭直觉把判定删掉，也别把危害说大）**：不判 `allow` 时那句
          // `upstream.write(head)` **并不会真把字节送出去**——`charge` 内部已同步把两条流
          // `destroy()` 了，写进已销毁的 socket 会被 Node 丢弃（实测上游桩收到的载荷恒为
          // 0 字节，所以「漏一个数据块」这个说法是错的）。真实损害是另外两条，更阴：
          // ① `relay` 仍被调用 → `awaitStatusLine` 在**我们自己销毁的**流上一直等到
          //    `upstreamTimeout`，然后补出两条**根本没发生过的事实**：`upstream-error`
          //    （`[upgrade] upstream response timeout`，落 warn）与 `request.failed`；
          // ② 每个被耗尽掐死的 upgrade 都要挂着 relay + 定时器直到超时窗口走完。
          // 护栏：`integration/traffic-quota.test.ts` 的「耗尽⑤」两条（行为面 + 源码面）。
          if (!meter.charge("up", head.length).allow) {
            return;
          }
          upstream.write(head);
        }

        void this.relay(socket, upstream, `${target.host}:${target.port}`, meter, scope);
      })
      .catch((err: Error) => {
        // 拨号失败成因必须落盘（守卫 keepClientOnFailure 留了客户端），随后按成因写状态行收尾
        scope.emit({
          type: "upstream-error",
          message: `[upgrade] upstream error ${viaSocksTunnel ? "via socks " : ""}${target.host}:${target.port}: ${err.message}`,
          err,
        });
        this.settleDialFailure(() => this.refuseByCause(socket, err), err, scope);
      });
  }

  /**
   * 等 101 桥接：严格解析状态行判 101；非 101 原样回透响应后按上游 EOF 语义收尾
   * - 状态行用 RE_HTTP_STATUS_LINE 提取三位码严格比对，避免 `302` + `Content-Length: 1010`
   *   之类子串被 `includes("101")` 误判为升级成功
   * - 等待收口在 `awaitStatusLine`：定时器归其所有（缺省 upstreamTimeout），上游失败时由它销毁，
   *   超时/超限成因经 upstream-error 上抛，客户端按成因写 504/502 收尾（不再静默双毁）
   * - 非 101 不再截断：首包（`head` + `rest`）写完后继续把上游剩余 body relay 给客户端，
   *   否则 `Content-Length` 大于首包时客户端挂等；上游错误/关闭的收尾归 `guardDialing` 既有 handler
   *
   * **计量**：`101 Switching Protocols` 应答头是协议字节、由本通道 write 出去，**不计量**；
   * 应答头之后的 `res.rest`（建隧后的首批载荷）计 `down`，经 `bridgeWithBuffered` 补记。
   * 非 101 分支**不计量**（没有建隧成功，这次转发没有可归属的隧道）。
   * @param addr - 目标地址（失败日志路由）
   * @param meter - 计量端口（由 `upgradeOver` 在握手报文写完后开出）
   * @param scope - 本次请求的作用域（事件出口 + 身份维度 + 终态守卫）
   */
  private async relay(
    client: Duplex,
    upstream: Duplex,
    addr: string,
    meter: BufferedCharge,
    scope: RequestScope,
  ): Promise<void> {
    const terminal = scope.terminal;
    const res = await awaitStatusLine(upstream, {
      timeout: this.config.get("upstreamTimeout") as number,
      onTimeout: () => {
        scope.emit({
          type: "upstream-error",
          message: `[upgrade] upstream response timeout ${addr}`,
        });
      },
      onOverflow: () => {
        scope.emit({
          type: "upstream-error",
          message: `[upgrade] upstream response overflow ${addr}`,
        });
      },
    });

    if (!res.ok) {
      // 超时/超限：上游已由 awaitStatusLine 销毁、成因已落盘；客户端按成因写 504/502 后收尾
      const error =
        res.cause === "timeout"
          ? new DialTimeoutError(`upgrade response timeout ${addr}`)
          : new Error(`upgrade response overflow ${addr}`);
      this.refuse(client, res.cause === "timeout" ? STATUS_GATEWAY_TIMEOUT : STATUS_BAD_GATEWAY);
      terminal.fail(error, "forward");
      return;
    }

    // 严格取状态码：仅 101 视为升级成功，杜绝 `302` + `Content-Length: 1010` 之类子串误判
    if (res.statusCode === String(STATUS_SWITCHING_PROTOCOLS)) {
      client.write(res.head);
      terminal.complete(101);

      // `res.head` 是 101 应答（协议字节，不计量）；`res.rest` 是应答之后的真实载荷，计 `down`。
      // 两者都写出去再桥接：桥接经基类 `bridgeWithBuffered`，余量的计量与写入收在一处
      // （终态仍先于桥接发布——次序是契约）。
      this.bridgeWithBuffered(client, upstream, meter, undefined, res.rest);
    } else {
      client.write(Buffer.concat([res.head, res.rest]));
      terminal.fail(new Error(`upgrade expected 101, got ${res.statusCode}`), "forward");

      // 非 101：响应体可能超出首包（Content-Length 大于已读字节），继续 relay 剩余 body。
      // 必须保留 readableEnded 分支：上游若在同一轮读取里 push 了 EOF（响应 + Connection: close
      // 的常见形态），'end' 可能早于本续体挂 pipe 之前发出，直接 pipe 会漏掉 end → 客户端挂死。
      // 上游错误/关闭的收尾归 guardDialing 既有 handler，这里不额外 destroy
      if (upstream.readableEnded) {
        client.end();
      } else {
        upstream.pipe(client);
      }
    }
  }
}
