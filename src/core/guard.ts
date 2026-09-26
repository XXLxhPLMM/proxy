/**
 * @fileoverview 代理拨号守卫与响应头读取
 * @module core/guard
 * @description
 * 本文件从 `core/helpers/predial.ts` 剥离出的状态式守卫逻辑：
 * 拨号超时/错误/半关闭联动、响应头累积读取。
 *
 * 职责：
 * - 守卫域：`guardDialing`（为上下游 Duplex 绑定超时/错误/半关闭联动，提供未 established 前的 502/504 兜底回复；`clientLifetime: "independent"` 时**不做上游→客户端的存活联动**，见 `DialGuardOptions.clientLifetime`）、`socksUpstreamGuard`（SOCKS 上游拨号守卫选项工厂：空回复 + 保客户端 + 成因上抛 + 可选解耦）
 * - 读取域：`readResponseHead`（累积读取上游 HTTP 响应头，字节封顶 + CRLFCRLF 定位 + 状态码提取）、`awaitStatusLine`（等状态行的统一收口：失败时销毁上游，成因经回调上抛）
 *
 * 设计要点：
 * - 零日志：通过 `HelperEvent / HelperEventSink` 事件槽上抛，日志由 server 层落盘，避免转发层直接依赖 logger
 * - 依赖方向：`guard → utils/*` 单向，不依赖 `core/helpers`
 * - 常量收敛：所有协议常量（CRLF/状态行/默认端口/头名）均来自 `utils/constants/index.js`，禁止内联魔数
 *
 * 使用示例：
 * ```ts
 * import { guardDialing, readResponseHead } from "@/core/guard.js";
 *
 * // 1) 隧道守卫
 * const g = guardDialing(clientSocket, upstreamSocket, {
 *   target: "example.com:443",
 *   timeout: 10_000,
 *   onEvent: (e) => console.log(e.type, e.message),
 * });
 *
 * // 2) 读上游响应头
 * const res = await readResponseHead(upstream, { timeout: 0 });
 * if (res && res.statusCode === "200") { ... }
 * ```
 */

import type { Duplex } from "node:stream";
import {
  HTTP_502_BAD_GATEWAY,
  HTTP_504_GATEWAY_TIMEOUT,
  MAX_STATUS_LINE_BYTES,
  DOUBLE_CRLF_BUF,
  RE_HTTP_STATUS_LINE,
} from "@/utils/constants/index.js";
import { getSocketAddress } from "@/utils/ip.js";

/**
 * 助手事件（由 guardDialing 等工具产生，经 HelperEventSink 上抛）
 * @description 拨号守卫的内部事件形态，字段取自 `PipeEvent` 判别联合的对应变体
 * （dial / established / upstream-timeout / upstream-error / client-error），结构上是 `PipeEvent` 的子集，
 * 可直接透传进 `ForwarderBase.emit`（pipe 事件槽）而无需泛型转换。
 * @param message - 人类可读的描述（已含 [prefix] 前缀与路由信息）
 * @param err - 关联的原始异常（可选，仅 upstream-error / client-error）
 * @example { type: "upstream-timeout", message: "[tunnel] timeout 1.2.3.4 -> example.com:443" }
 */
export interface HelperEvent {
  type: "dial" | "established" | "upstream-timeout" | "upstream-error" | "client-error";
  message: string;
  err?: unknown;
}

/**
 * 助手事件汇（回调类型）
 * @example const sink: HelperEventSink = (e) => logger.warn(e.message);
 */
export type HelperEventSink = (e: HelperEvent) => void;

/**
 * 创建通用事件发射器（容错包装）
 * @description 对 `sink` 的调用包裹 try/catch，避免业务回调异常反噬主流程
 * @param sink - 事件汇回调，可能为 undefined
 * @returns 包装后的发射函数 `(e) => void`，内部吞掉回调异常
 * @example const emit = createEventEmitter<HelperEvent>(onEvent); emit({ type: "dial", message: "..." });
 */
export function createEventEmitter<T>(sink?: (e: T) => void): (e: T) => void {
  return (e) => {
    try {
      sink?.(e);
    } catch {}
  };
}

/**
 * 创建助手事件发射器
 * @description `createEventEmitter<HelperEvent>` 的语义别名，使调用点意图更清晰
 * @param s - 助手事件汇
 * @example const emit = createHelperEmitter(onEvent);
 */
export function createHelperEmitter(s?: HelperEventSink): (e: HelperEvent) => void {
  return createEventEmitter(s);
}

/**
 * 上游响应头读取结果
 * @param statusCode - 状态行三位码（`RE_HTTP_STATUS_LINE` 提取；无合法状态行时为空串）
 * @param head - 完整响应头（含结尾 CRLFCRLF 分隔符）
 * @param rest - 响应头之后的上游先发字节（server-speaks-first 协议首包等），方向为上游→客户端
 */
export interface ResponseHead {
  statusCode: string;
  head: Buffer;
  rest: Buffer;
}

/**
 * 读上游响应头的选项
 * @param timeout - 读超时毫秒；<=0 不自建定时器（超时职责交给调用方的拨号守卫，避免双定时器）
 * @param maxBytes - 缓冲上限（字节），默认 `MAX_STATUS_LINE_BYTES`；上游只发数据不发 CRLFCRLF 时按字节封顶（超时只兜时间不兜内存）
 * @param onTimeout - 超时回调（决议前调用，供调用方落盘成因）
 * @param onOverflow - 超限回调（决议前调用，供调用方落盘/应答）
 */
export interface ReadResponseHeadOptions {
  timeout: number;
  maxBytes?: number;
  onTimeout?: () => void;
  onOverflow?: () => void;
}

/**
 * 读上游 HTTP 响应头（CONNECT 200 判定 / Upgrade 101 判定 / SOCKS→HTTP 上游 + 建链协商共用）
 * @description
 * 收敛 forward 层三处逐字重复的「累积 → 字节封顶 → CRLFCRLF 定位 → 状态码提取 → 余量切分」：
 * tunnel.wait200 / websocket.relay / socks.connect(http 上游) 原先各写一份，差异仅在收尾动作；
 * 现分别收口在 `HttpConnectConnector.connectViaUpstream`（tunnel/socks 共用）与 `WsForwarder.relay`。
 * - 严格取状态行三位码（`RE_HTTP_STATUS_LINE`），避免响应头内 "200"/"101" 子串误判为成功
 * - 本函数**不销毁 socket、不写应答**：失败收尾（回 502/504、双向销毁、SOCKS 失败应答）全由调用方决定
 * - 返回/超时/超限后自动摘除 data 监听与定时器，只决议一次
 * - 若上游在读到完整响应头之前关闭，Promise 保持挂起（与改造前各调用点行为一致，由调用方超时兜底）
 * @param upstream - 上游连接
 * @param opts - 超时/缓冲上限与回调
 * @returns 命中返回 `{ statusCode, head, rest }`；超时或超限返回 null
 * @example
 * ```ts
 * const res = await readResponseHead(upstream, { timeout: 0 });
 * if (res && res.statusCode === "200") { ... }
 * ```
 */
export function readResponseHead(
  upstream: Duplex,
  opts: ReadResponseHeadOptions,
): Promise<ResponseHead | null> {
  const maxBytes = opts.maxBytes ?? MAX_STATUS_LINE_BYTES;

  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (v: ResponseHead | null): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      upstream.off("data", onData);
      resolve(v);
    };

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);

      // 上游只发数据不回 CRLFCRLF 时按字节封顶：timeout 只兜时间不兜内存
      if (buf.length > maxBytes) {
        opts.onOverflow?.();
        finish(null);
        return;
      }

      const idx = buf.indexOf(DOUBLE_CRLF_BUF);

      if (idx === -1) {
        return;
      }

      // 严格取状态行三位码：响应头里出现 "200" 子串（如 realm="200"）不得误判为建链成功
      const statusCode = RE_HTTP_STATUS_LINE.exec(buf.subarray(0, idx).toString())?.[1] ?? "";

      finish({
        statusCode,
        head: buf.subarray(0, idx + DOUBLE_CRLF_BUF.length),
        rest: buf.subarray(idx + DOUBLE_CRLF_BUF.length),
      });
    };

    if (opts.timeout > 0) {
      timer = setTimeout(() => {
        opts.onTimeout?.();
        finish(null);
      }, opts.timeout);
    }

    upstream.on("data", onData);
  });
}

/**
 * 等上游状态行的判别结果
 * @param ok - true 命中状态行（含 `statusCode`/`head`/`rest`），false 超时或超限（含 `cause`）
 * @param cause - 失败成因：`timeout` 等状态行超时（调用方通常回 504），`overflow` 响应超限（回 502）
 */
export type StatusLineResult =
  | { ok: true; statusCode: string; head: Buffer; rest: Buffer }
  | { ok: false; cause: "timeout" | "overflow" };

/**
 * 等上游状态行：`readResponseHead` 的薄封装，tunnel/socks（经 `HttpConnectConnector.connectViaUpstream`）与
 * `WsForwarder.relay` 三条等待共用
 * @description
 * 统一收口语义：
 * - 定时器只归 `readResponseHead` 所有（本包装不另建定时器），`onTimeout`/`onOverflow` 先于返回触发；
 * - 失败（超时/超限）时由本包装销毁**上游 socket**——成因经回调上抛并进 `cause` 返回，
 *   客户端收尾（回 504/502、双毁）归调用方，避免各处再抄一段 destroy 与闭包变量
 * @param sock - 上游连接
 * @param opts - 读超时（必填，`<=0` 不建定时器）与超时/超限回调（调用方通常在此 emit 成因）
 * @returns 命中返回 `{ ok: true, statusCode, head, rest }`；超时或超限返回 `{ ok: false, cause }`（上游已销毁）
 */
export async function awaitStatusLine(
  sock: Duplex,
  opts: { timeout: number; onTimeout?: () => void; onOverflow?: () => void },
): Promise<StatusLineResult> {
  let cause: "timeout" | "overflow" = "timeout";

  const res = await readResponseHead(sock, {
    timeout: opts.timeout,
    onTimeout: () => {
      cause = "timeout";
      opts.onTimeout?.();
    },
    onOverflow: () => {
      cause = "overflow";
      opts.onOverflow?.();
    },
  });

  if (!res && !sock.destroyed) {
    sock.destroy();
  }

  if (res) {
    return { ok: true, statusCode: res.statusCode, head: res.head, rest: res.rest };
  }

  return { ok: false, cause };
}

/**
 * 入站客户端连接与本管道的**生命周期耦合形态**
 *
 * @description 两条方向相反的联动要不要成立，全由这一个判据说清：
 * - `linked`（**缺省**，隧道语义）：上下游是同一条隧道的两端，任一端死掉另一端必须跟着死。
 *   CONNECT / upgrade 101 之后 / SOCKS 会话都属于这一类。
 * - `independent`（请求语义）：上游 socket 是**每请求新建**的传输层，而入站客户端连接归
 *   Node 的 `http`/`tls` 服务所有（它的存活由客户端自己的 keep-alive 决定）。两者不是同一条
 *   生命周期，故上游关闭/超时/出错**不得**回敬客户端连接。
 */
export type ClientLifetime = "linked" | "independent";

/**
 * 拨号守卫选项
 * @description 分工：`onEvent` 为日志/审计汇（超时/错误必经，先于回调触发，异常被吞）；
 * `onTimeout/onError` 为业务额外动作（emit 之后调用，异常同样被吞，不影响兜底回写与双向销毁）
 * @param logPrefix - 日志前缀（默认 "tunnel"）
 * @param timeout - 超时毫秒数（>0 时为 upstream 设置 setTimeout）
 * @param timeoutReply - 超时时向客户端回复的 HTTP 报文（默认 504）
 * @param errorReply - 出错时向客户端回复的 HTTP 报文（默认 502）
 * @param target - 目标展示字符串（用于日志路由，如 "example.com:443"）
 * @param onEvent - 助手事件汇
 * @param onTimeout - 超时时的额外回调（可选）
 * @param onError - 出错时的额外回调（可选）
 * @example { target: "example.com:443", timeout: 10000, onEvent: (e)=>logger.warn(e.message) }
 */
export interface DialGuardOptions {
  logPrefix?: string;
  timeout?: number;
  timeoutReply?: string;
  errorReply?: string;
  target?: string;
  onEvent?: HelperEventSink;
  onTimeout?: () => void;
  onError?: (e: Error) => void;
  /**
   * 拨号失败（未建链）时把客户端交给调用方收尾
   *
   * @description
   * 置位后守卫只销毁上游 socket，并且**不因上游 close 连带销毁客户端**，
   * 于是调用方能在 catch 里回自己的失败应答（SOCKS 失败应答 / HTTP 502）再收尾。
   * 不置位时沿用旧语义：能回 HTTP 报文就回，否则双向销毁（裸 socket 场景由调用方自建收尾）。
   * 与 `errorReply: ""` 的区别：空串只表示「守卫不许写 HTTP 报文」，不代表调用方会写。
   */
  keepClientOnFailure?: boolean;
  /**
   * 上下游**是否同生命周期**（缺省 `"linked"` = 隧道语义，见 {@link ClientLifetime}）
   *
   * @description
   * ⚠️ **只给「传输层归调用方所有」的通道置 `"independent"`，不要给隧道路径置。**
   *
   * 唯一当前使用方是 **http 普通请求通道**（`forward/channel/http.ts` → `connector.transport()` →
   * `http.request({ createConnection })`）：那里的上游 socket 是**每请求新建**的传输层，
   * 而入站客户端连接是 Node `http`/`tls` 服持有的**长连接**（客户端 keep-alive）。两者不是
   * 同一资源的两端，把「上游关了就毁客户端」搬过来会让「源站关掉自己的连接」直接打死
   * 客户端的入站 keep-alive——客户端每请求被迫重连（实测 `reusedSocket` 恒 false），
   * 而这跟客户端能不能连上上游毫无关系，是把「隧道语义」漏进了「请求语义」。
   *
   * 置位后本守卫对客户端**只读不写**：不发 HTTP 报文、不销毁客户端（客户端侧只保留
   * 「客户端先出事 → 毁上游」这一个方向，那条方向本来就是对的）。客户端与响应的收尾
   * 全部归调用方（`http.ts` 的 `fail()` / `RequestTerminal`）。
   *
   * **不要**反过来给 CONNECT / upgrade / SOCKS 置它：那些通道里 `ctx.client` 与管道确实是
   * 同一资源的两端（`bridge()` 双向 pipe），解耦会让「上游已死、客户端还在等字节」变成挂死。
   */
  clientLifetime?: ClientLifetime;
}

/**
 * SOCKS 上游拨号守卫选项工厂
 * @description
 * 四个 `Dialer.dialSocks` 调用点（tunnel.viaSocks / http.dialViaSocksAndForward /
 * websocket.viaSocks / socks.connect）此前手写同一组选项且 websocket 漏了
 * `keepClientOnFailure`（守卫连带销毁客户端，调用方的失败收尾写不出去）——收敛到此一处
 * （2b-2b 起四个调用点已全部改为经 `connector/socks4|socks5.open()` 走本工厂）：
 * - 空回复：守卫绝不向客户端写 HTTP 报文（SOCKS 语境会被 502/504 污染，Upgrade 语境由调用方写状态行）；
 * - `keepClientOnFailure`：拨号失败只销毁上游，客户端留给调用方 catch 回自己的失败应答；
 * - `onEvent`：超时/错误成因必经，上抛到日志（各 catch 只覆盖拨号异常，静默吞守卫事件会让 502 无因可查）。
 * @param logPrefix - 日志前缀（`[<prefix>] timeout <route>`）
 * @param onEvent - 助手事件汇
 * @param clientLifetime - 上下游是否同生命周期；**省略即 `"linked"`（隧道语义）**，只有
 *   「传输层归调用方所有」的通道（如 http 请求路径）才显式传 `"independent"`
 * @returns 守卫选项（调用方可再 spread 补 `target` 等调用点专属字段）
 */
export function socksUpstreamGuard(
  logPrefix: string,
  onEvent?: HelperEventSink,
  clientLifetime?: ClientLifetime,
): DialGuardOptions {
  return {
    logPrefix,
    timeoutReply: "",
    errorReply: "",
    keepClientOnFailure: true,
    ...(clientLifetime ? { clientLifetime } : {}),
    onEvent,
  };
}

/**
 * 为上下游 Duplex 绑定拨号守卫
 * @description
 * - 为 upstream 绑定 `timeout` / `error` / `close`，为 client 绑定 `error` / `close`，实现双向联动销毁
 * - 未 `established()` 前的超时/错误会尝试向 client 回写 `timeoutReply` / `errorReply`（502/504）后再销毁
 * - 建链后（调用 `established()`）则直接双向销毁，不再回写 HTTP 报文（此时已进入隧道态）
 * - `keepClientOnFailure` 置位时，未建链的失败只销毁上游并把客户端留给调用方应答
 *   （SOCKS 失败应答 / 转发层 502），且上游 close 不连带销毁客户端
 * - `clientLifetime: "independent"` 置位时**只保留「客户端先出事 → 毁上游」这一个方向**：
 *   上游 close / 上游超时 / 上游错误一律只毁上游，客户端既不被销毁也不被写入任何字节；
 *   客户端侧那两个监听器随上游 socket 的 `close` 摘除（入站长连接上按请求挂监听会线性累积）
 *   （为什么需要它、以及为什么不能挪到隧道路径，见 `DialGuardOptions.clientLifetime`）
 * @param client - 客户端 Duplex（通常为入站 socket）
 * @param upstream - 上游 Duplex（dial 成功后的 socket）
 * @param opts - 守卫选项（含超时、回复报文、生命周期耦合形态与事件汇），**必填**
 *   （历史遗留的 `= {}` 已删：唯一生产调用点在 `Dialer.dialWith`，它恒传
 *   `socksUpstreamGuard(...)` + `target`；缺省会启用「向客户端写 502/504 原始报文」
 *   且上下游同生命周期那份缺省语义——没有调用方要它，而它恰好违反「连接器绝不向
 *   `ctx.client` 写任何字节」。**字段级**可选项保留：各调用点确实只设其中一部分）
 * @returns 守卫句柄 `{ established: () => void }`，建链成功后必须调用以切换至稳态
 * @example
 * const guard = guardDialing(client, upstream, { target: "example.com:443", timeout: 10000, onEvent });
 * upstream.on("connect", () => guard.established()); // 拨号方（Dialer.dialWith）在 open 回调里代为落定
 */
export function guardDialing(
  client: Duplex,
  upstream: Duplex,
  opts: DialGuardOptions,
): { established: () => void } {
  const prefix = opts.logPrefix ?? "tunnel";
  const timeoutReply = opts.timeoutReply ?? HTTP_504_GATEWAY_TIMEOUT;
  const errorReply = opts.errorReply ?? HTTP_502_BAD_GATEWAY;
  const emit = createHelperEmitter(opts.onEvent);
  const clientAddr = getSocketAddress(client);
  const route = opts.target ? `${clientAddr} -> ${opts.target}` : clientAddr;
  // 上下游是否同一条生命周期：隧道（缺省）为 true，请求路径为 false（见 DialGuardOptions.clientLifetime）
  const linked = (opts.clientLifetime ?? "linked") === "linked";
  let live = false;
  // 拨号失败已把客户端交给调用方：上游 close 不得再连带销毁客户端（否则调用方的失败应答写不出去）
  let handedOff = false;
  const destroyBoth = (): void => {
    if (!client.destroyed) {
      client.destroy();
    }
    if (!upstream.destroyed) {
      upstream.destroy();
    }
  };
  const destroyUpstreamOnly = (): void => {
    handedOff = true;
    if (!upstream.destroyed) {
      upstream.destroy();
    }
  };
  const ups = upstream as Duplex & { setTimeout?(ms: number): void };
  if ((opts.timeout ?? 0) > 0) {
    ups.setTimeout?.(opts.timeout!);
  }
  // 未建链失败的公共收尾：成因上抛 → 额外回调 → 保客户端（只毁上游）→ 兜底回写 → 双毁；
  // timeout 与 error 仅在事件/回调/回复报文三处不同，其余分支逐字一致。
  // `!linked`（请求路径）提前收口在「只毁上游」：客户端连接归 Node 的 http/tls 服所有，
  // 守卫对它只读不写，回复报文与双向销毁都归调用方（http.ts 的 fail / RequestTerminal）。
  const fail = (kind: "timeout" | "error", err?: Error): void => {
    if (kind === "timeout") {
      emit({
        type: "upstream-timeout",
        message: `[${prefix}] timeout ${route}`,
      });
      try {
        opts.onTimeout?.();
      } catch {}
    } else {
      emit({
        type: "upstream-error",
        message: `[${prefix}] error ${route}`,
        err,
      });
      try {
        opts.onError?.(err as Error);
      } catch {}
    }
    if (!linked || (!live && opts.keepClientOnFailure)) {
      destroyUpstreamOnly();
      return;
    }
    const reply = kind === "timeout" ? timeoutReply : errorReply;
    if (!live && reply && (client as unknown as { writable: boolean }).writable) {
      client.end(reply);
      if (!upstream.destroyed) {
        upstream.destroy();
      }
      return;
    }
    destroyBoth();
  };
  upstream.on("timeout", () => {
    fail("timeout");
  });
  upstream.on("error", (err) => {
    fail("error", err as Error);
  });
  // 客户端侧监听抽成具名 handler：`independent` 形态下需要在「被保护的上游已死」时摘除它们
  const onClientError = (err: Error): void => {
    emit({
      type: "client-error",
      message: `[${prefix}] client error ${route}`,
      err,
    });
    // 客户端先出事 → 毁上游，这条方向在两种形态下都对（上游留着就是泄漏）
    if (linked) {
      destroyBoth();
    } else {
      destroyUpstreamOnly();
    }
  };
  const onClientClose = (): void => {
    if (!upstream.destroyed) {
      upstream.destroy();
    }
  };
  /**
   * 摘除客户端侧监听：只在 `independent`（请求路径）下调用
   *
   * @description
   * 这两个监听器存在的唯一意义是「客户端连接先死 → 别让上游 socket 泄漏」。而它保护的对象
   * 就是这条**每请求新建**的上游 socket：上游一死，它们就没有工作可做了。
   *
   * 必须摘除的原因：入站客户端连接是**长连接**（客户端 keep-alive），而每个请求都会新建
   * 一条上游 socket 并挂上一对监听。不摘的话，一条连接上跑 11 个请求就会触发 Node 的
   * `MaxListenersExceededWarning`，且闭包按请求线性累积（实测 20 请求 → 22 个 `close` 监听）。
   * 隧道形态没有这个问题（一个连接一条隧道、只挂一次），故那里不动。
   *
   * 挂在 `upstream` 的 `close` 上是可靠的：本通道的出站请求恒带 `Connection: close`
   * （`sanitizeHeaders` 强制），实测 Node 在响应收尾时**必定**销毁 `createConnection`
   * 提供的 socket——源站遵守或不遵守 `Connection: close` 都一样。
   */
  const detachClientWatch = (): void => {
    client.off("error", onClientError);
    client.off("close", onClientClose);
  };
  client.on("error", onClientError);
  client.on("close", onClientClose);
  upstream.on("close", () => {
    if (!linked) {
      // 请求路径：上游关闭**绝不**回敬客户端（入站 keep-alive 的存活与上游无关），
      // 只把客户端侧监听摘掉——它们保护的上游已经没了
      detachClientWatch();
      return;
    }
    if (!client.destroyed && !handedOff) {
      client.destroy();
    }
  });
  if (!linked && upstream.destroyed) {
    // 极端形态：守卫装订时上游已经死了（`close` 不会再有），立即摘除避免残留监听
    detachClientWatch();
  }
  const handle = {
    established: (): void => {
      live = true;
      // 关定时器：建立 socket 空闲超时（<=0 即禁用），隧道态不再被误判超时
      ups.setTimeout?.(0);
    },
  };

  return handle;
}