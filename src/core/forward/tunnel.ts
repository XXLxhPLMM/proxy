import type { Duplex } from "node:stream";
import http from "node:http";
import type { CoreContext } from "@/core/context.js";
import { parseAuthority, resolveRoute } from "@/core/helpers/index.js";
import {
  HTTP_200_CONNECTION_ESTABLISHED,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
} from "@/utils/constants/index.js";
import type { RequestScope } from "@/core/request-scope.js";
import type { TrafficAccount } from "@/core/traffic/index.js";
import { associateRequestTerminal } from "@/core/request-terminal.js";
import { connectorFor, directConnector } from "./connector/index.js";
import type { UpstreamConnector } from "./connector/index.js";
import { ForwarderBase } from "./base.js";

/**
 * 隧道转发器（CONNECT）
 * - server 直连目标（client 配置命中 upstream 路由名单同样回落直连）
 * - client 按 upstreamProtocol 选 http/https/socks 串联（判据 = resolveRoute 的有效模式）
 * - 「怎么到达 dest」由上游连接器层收口（`connector/index.js`），本类只管 CONNECT 通道的
 *   协议应答（200 / 拒绝透传）与桥接
 * - 拨号器继承自 {@link ForwarderBase}；事件一律经 `scope.emit` 发出
 */
export class TunnelForwarder extends ForwarderBase {
  /**
   * @param ctx - 依赖上下文，必须显式注入
   * @description 逐请求的事件槽与终态守卫经 {@link TunnelForwarder.handle} 的 `scope` 参数传入，
   * **不进构造期**：本实例由 `HttpProxy` 在服务构造期建一次、跨请求复用。
   */
  constructor(ctx: CoreContext, traffic: TrafficAccount) {
    super(ctx, traffic);
  }

  /**
   * 入口：解析 authority（非法回 400） → 自环/名单前置守卫 → 路由判定 → 按有效模式与上游协议分发
   * @param scope - 本次请求的作用域（事件出口 + 身份维度 + 终态守卫）：**逐次传入，绝不存字段**
   */
  handle(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    scope: RequestScope,
  ): void {
    const requestTerminal = scope.terminal;
    associateRequestTerminal(req, requestTerminal);

    const authority = req.url ?? "";
    const parsed = parseAuthority(authority);

    if (!parsed) {
      // 客户端 CONNECT 请求行非法（如 ":443"、裸 IPv6）属请求报文错误回 400，
      // 与 http/websocket 的解析失败语义一致（此前误回 502 把客户端错误算成网关错误）
      this.refuse(socket, STATUS_BAD_REQUEST);
      requestTerminal.reject("invalid-authority", "parse", STATUS_BAD_REQUEST);
      return;
    }

    const { hostname, port } = parsed;
    const target = { host: hostname, port };

    // 自环 + 目标名单在拨号前共用前置守卫：被禁目标直接 403 收尾（不消耗上游拨号资源）
    if (
      this.preDial(
        {
          req,
          dial: target,
          dest: target,
          deny: (status) => {
            this.refuse(socket, status);
            if (status === STATUS_BAD_REQUEST) {
              requestTerminal.reject("bad-request", "parse", status);
            } else if (status === STATUS_FORBIDDEN) {
              requestTerminal.reject("target-denied", "access", status);
            } else {
              requestTerminal.fail(new Error("proxy loop detected"), "dial");
            }
          },
        },
        scope,
      )
    ) {
      return;
    }

    // preDial 已过：client 配置恰发一条路由事件（server 配置在 emitRoute 内短路）
    const route = resolveRoute(target, this.config);
    this.emitRoute(target, route, scope);

    // 有效模式：配置 server 或 client 命中路由名单回落 → 直连
    if (route.route === "direct") {
      this.openUpstream(directConnector(this.ctx), socket, target, head, scope);
      return;
    }

    // 有效 client：按 upstreamProtocol 选代理型连接器（http/https/socks*，含 TLS 承载的 sockss*）。
    // 版本与 TLS 承载由 registry 在构造期钉死（见 connector/registry），本类不再自己推导。
    // 未知协议由 registry fail-closed 抛错：`upstreamProtocol` 经 FIELDS 的 parseEnum 校验，
    // 合法取值只有登记表内那六个，故该分支对任何经 loadConfig 的配置都不可达。
    this.openUpstream(
      connectorFor(this.config.get("upstreamProtocol"), this.ctx),
      socket,
      target,
      head,
      scope,
    );
  }

  /**
   * 建隧收尾：回 200 Connection Established → 回灌余量 + 双向桥接（协议无关半边见基类 `bridgeWithBuffered`）
   * @description direct / viaHttp / viaSocks 三条成功路径共用（命名对齐 socks.establish）：
   * 两侧余量方向不同——`head` 是客户端发来已读的首包（写给上游，计 `up`），`rest` 是上游先发字节
   * （写给客户端，计 `down`）
   *
   * **计量**：应答（`200 Connection Established`）是协议字节、不计量；应答之后的 `head` / `rest`
   * 是**真实载荷**、必须计入，故由基类 `bridgeWithBuffered` 显式补记。耗尽即双端 `destroy()`
   * （应答早已发出、改不了——硬切是裁决，理由见 `core/traffic/meter.ts` 文件头）。
   * @param client - 客户端双工流
   * @param upstream - 已建链的上游
   * @param scope - 本次请求的作用域：计量只从它读一次 `user`，**不落实例字段**
   * @param opts.head - 客户端首包（CONNECT 请求行之后的字节），空则不写
   * @param opts.rest - 上游响应头之后的先发字节（server-speaks-first），空则不写
   */
  private establishTunnel(
    client: Duplex,
    upstream: Duplex,
    scope: RequestScope,
    opts: { head?: Buffer; rest?: Buffer } = {},
  ): void {
    const meter = this.openTunnelMeter(client, upstream, scope);
    client.write(HTTP_200_CONNECTION_ESTABLISHED);
    scope.terminal.complete(200);
    this.bridgeWithBuffered(client, upstream, meter, opts.head, opts.rest);
  }

  /**
   * 三条支路（直连 / 经 http(s) 上游 CONNECT / 经 SOCKS 上游握手）共用的「拿一条字节管道」接线：
   * 上游自环预检 → `connector.open()` → 拒绝透传 / 建隧桥接；失败统一由 catch 按成因回 504/502
   *
   * @description
   * 「怎么到达 dest」全部收在连接器里，本方法只保留 CONNECT 通道自己的协议应答与桥接：
   * - `selfLoopTarget()` 为 `undefined`（直连）即**跳过**上游自环预检——真实目标的自环已由
   *   {@link preDial} 判过，而直连本来就没有「上游指回自身监听地址」可判；返回 `{host, port}`
   *   时才拿它判（client 模式下拨的是上游）
   * - 连接器**绝不向 `client` 写任何字节**（守卫一律 `keepClientOnFailure`），故成败应答全归本方法，
   *   catch 不会与守卫双写
   * - `refusal` 存在即「上游拒绝建链」（仅 http-connect 的非 200 应答）：`sock` 照常返回但**不得建隧**
   * @param connector - 目标连接器（直连或按 upstreamProtocol 选的代理型连接器）
   * @param client - 客户端双工流
   * @param dest - 真实目标（客户端 CONNECT 请求的目标）
   * @param head - 客户端首包（CONNECT 请求行之后的字节），建隧时回灌上游
   * @param scope - 本次请求的作用域（事件出口 + 身份维度 + 终态守卫）
   */
  private openUpstream(
    connector: UpstreamConnector,
    client: Duplex,
    dest: { host: string; port: number },
    head: Buffer,
    scope: RequestScope,
  ): void {
    const terminal = scope.terminal;
    const loop = connector.selfLoopTarget();

    // 上游自环：client 模式下拨的是上游，上游指回自身监听地址会成环（真实目标的自环已在上方判过）
    if (
      loop &&
      this.denyUpstreamLoop(
        loop.host,
        loop.port,
        () => {
          this.refuse(client, STATUS_BAD_GATEWAY);
          terminal.fail(new Error("upstream proxy loop detected"), "dial");
        },
        scope,
      )
    ) {
      return;
    }

    connector
      .open({
        client,
        dest,
        // 事件槽原样透传（身份已在 scope 闭包里注好）：拨号守卫事件（HelperEvent）本就没有
        // user 维度，与本通道其它 pipe 事件共用同一个 emit，server 层按 type 统一分派
        onEvent: scope.emit,
        logPrefix: "tunnel",
      })
      .then(({ sock, rest, refusal }) => {
        // 非 200（如后级 407）：原样回透上游响应（含 Proxy-Authenticate），不断链语义；
        // 状态码已由 readResponseHead 严格提取（响应头里 "200" 子串不会误判为建链成功）
        if (refusal) {
          client.write(Buffer.concat([refusal.head, refusal.rest]));
          client.end();
          sock.destroy();
          terminal.fail(new Error(`upstream CONNECT returned ${refusal.statusCode}`), "forward");
          return;
        }

        // rest 属上游发往客户端方向（如服务端先说话的协议首包），回写 client 而非 upstream
        this.establishTunnel(client, sock, scope, { head, rest });
      })
      .catch((e: unknown) => {
        // 拨号/握手/等状态行失败：超时（DialTimeoutError）回 504、其余回 502
        this.refuseByCause(client, e);
        terminal.fail(e, "dial");
      });
  }
}
