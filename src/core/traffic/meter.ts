/**
 * @fileoverview 计量**落点**：在源流上挂被动 `data` 监听器计数
 * @module core/traffic/meter
 * @description
 * ## 唯一正确的落点是「建链完成之后、`client ↔ upstream` 这对流上流动的真实字节」
 *
 * 本文件是那对流上唯一的计量点，形态刻意是**被动计数**：在**源流**上挂一个 `data` 监听器，
 * 累加 `chunk.length`，然后交还控制权。
 *
 * ### 为什么是被动计数，绝不插 Transform / 改 pipe / pause-resume
 *
 * 1. **插 Transform 会与既有流控纠缠**：建链收尾走 `ForwarderBase.bridgeWithBuffered` →
 *    `Dialer.bridge`（双向 `pipe`），而 pipe 两侧还挂着 `guardDialing` 的半关闭联动
 *    （客户端半关闭 → 销毁上游、上游出错 → 双关）。在中间插一个 Transform 就等于给这条
 *    已经调好的链路再加一级背压，而**背压必然要 `pause()`/`resume()`**——`pause()` 会
 *    立刻改变半关闭联动的时序（`readable`/`writable` 各自的 'end'），把一个已验证的收尾语义
 *    变成要重新验证的东西。
 * 2. **被动计数零结构改动**：Node 允许多个 `data` 监听器并存（`pipe` 内部也是一个
 *    `data` 监听器），我们加的监听器只读 `chunk.length`、不 `push`、不 `pause`、
 *    不 `resume`、不改 `pipe` 的任何一个端点。数据流与背压行为**逐字节不变**。
 * 3. **顺带白拿建隧后的首批载荷**：`head` / `rest` / 流水线余量这些「建链那一刻已经在手上」
 *    的字节不经 `data` 事件（它们是被 HTTP 解析器或握手读取器摘走、我们再直接 write 出去的），
 *    故由调用点用 {@link chargeBuffered} 显式补记——**它们是真实载荷，必须计入**。
 *
 * ### 哪些字节**不**计入（建链协议字节）
 *
 * `CONNECT` 请求行、`200 Connection Established`、`101 Switching Protocols`、
 * SOCKS 握手与应答、鉴权往返——**都不是用户流量**，且它们**天然不会**经过我们挂的监听器：
 * - HTTP 请求行/请求头：被 Node 的 HTTP 解析器从 socket 上摘走，`head` 之外的部分不会再触发
 *   socket 的 `data` 事件；我们是在解析器摘完之后才挂监听器的。
 * - `200` / `101` 应答头：由**我们** `write()` 出去（出站方向），出站不产生本流 `data` 事件。
 * - SOCKS 握手：由 `SocksHandshakeReader` 逐段读走，并在 `detach()` 里 `pause()` 后交给我们。
 *
 * 护栏：`tests/integration/traffic-quota.test.ts` 的「建链协议字节未被计入」那条用例，
 * 用真实 CONNECT / SOCKS5 往返证明 `usage` 里只有载荷。
 *
 * ### 已知不对称（诚实记录，不假装对称）
 *
 * - **隧道 / SOCKS / WebSocket 走裸 socket**：客户端首包与响应余量都经过 socket，
 *   加上上面的 `data` 计数与 {@link chargeBuffered} 的首批补记，**两个方向都精确**。
 * - **HTTP 普通转发**：`up` 的源流是 `req`、`down` 的源流是 `upRes`，而 Node 的
 *   `IncomingMessage` 流**只覆盖消息体**——请求行+请求头、状态行+响应头都是 Node 直接写进
 *   socket 的，不经过请求/响应对象。因此 HTTP 路径**两个方向各少算一个 HTTP 头**：
 *   `up` 少算请求行+请求头（典型 GET 约 90–200B），`down` 少算状态行+响应头
 *   （典型 200 响应约 60–150B）。**这不是可以「顺手补上」的不对称**：补它就得在 core 里
 *   凭空合成 Node 已经写出去的字节，那不是被动计量了。护栏按「显式说明的误差」断言：
 *   HTTP 路径断言的是**消息体字节数逐字节相等**，头字节的差额在用例注释与本文件里写明。
 *
 * ### 无身份即不计量
 *
 * `user === undefined`（未鉴权 / 鉴权未通过）时**一个监听器都不挂**：没有身份就没有归属，
 * 整个配额机制不生效。这既是产品决策（见 `src/core/AGENTS.md`），也是零开销路径——
 * 关鉴权的部署不会为计量付任何代价。
 */

import type { Duplex } from "node:stream";
import type { TrafficAccount, TrafficDirection, TrafficVerdict } from "./types.js";

/** 放行常量：与 `memory.ts` 同源（同一个「绝大多数路径」的单例，避免每次判定都分配）。 */
const ALLOW: TrafficVerdict = Object.freeze({ allow: true });

/** 只需 `data` 事件的最小流形状（`Duplex` / `IncomingMessage` / `ClientResponse` 都满足）。 */
export interface ByteSource {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
}

/**
 * 建隧后的首批载荷（`head` / `rest` / SOCKS 流水线余量）的显式补记端口
 * @description 由 {@link openLinkMeter} 产出，调用点在**写出去之前**调它：
 * 判定不通过就别写（写进已销毁的 socket 会抛 `ERR_STREAM_DESTROYED`）。
 */
export interface BufferedCharge {
  /** 累加并判定这批字节；返回判定结果。 */
  charge(dir: TrafficDirection, bytes: number): TrafficVerdict;
  /** 无身份（未鉴权）时为 true：既不挂监听器也不补记。 */
  readonly inert: boolean;
}

/** 只读流已挂载的计数器（摘除用；用于测试与将来可能的动态停机）。 */
export interface StreamMeter {
  /** 摘掉本监听器（幂等）。链路过期后由 socket 自身回收，这里只是给调用方一个显式出口。 */
  detach(): void;
}

/**
 * 耗尽回调：`dir` 由监听器自己带出，**绝不从 `verdict.scope` 反推**
 * @description 撞上 `total` 上限时两个方向都可能导致耗尽，反推出来的 `dir` 会有一半是假的，
 * 而 `dir` 是事件载荷的必填项——假的比没有更糟。故方向由挂点如实上报。
 */
export type QuotaExceededHandler = (dir: TrafficDirection, verdict: TrafficVerdict) => void;

/**
 * 在一条源流上挂**被动**计数：只读 `chunk.length`，不 push / 不 pause / 不 resume / 不改 pipe
 * @description
 * `bytes <= 0` 时实现侧直接放行且**不**调用 `onExceeded`（空 chunk 不是「耗尽」）。
 * 判定不通过时把方向与 verdict 如实交给调用方——**本函数不做任何协议收尾**
 * （回 507 还是 destroy 由各协议的收尾形态决定；core 零日志、协议语义不同）。
 * @param account - 配额端口
 * @param user - 已鉴权用户名；`undefined` → **不挂监听器**（无身份即不计量）
 * @param dir - 该流承载的方向
 * @param stream - 源流（被计数的字节从这里读出来）
 * @param onExceeded - 判定不通过时调用（**每次调用点自带「恰好一次」闭锁**）
 */
export function meterStream(
  account: TrafficAccount,
  user: string | undefined,
  dir: TrafficDirection,
  stream: ByteSource,
  onExceeded: QuotaExceededHandler,
): StreamMeter {
  if (user === undefined) {
    return { detach: () => undefined };
  }
  const onData = (chunk: Buffer): void => {
    const verdict = account.consume(user, dir, chunk.length);
    if (!verdict.allow) {
      onExceeded(dir, verdict);
    }
  };
  stream.on("data", onData);
  return {
    detach: () => {
      (stream as unknown as { off(event: "data", listener: (c: Buffer) => void): unknown }).off(
        "data",
        onData,
      );
    },
  };
}

/**
 * 建链完成后给「一对流」开计量：客户端侧计 `up`、上游侧计 `down`
 * @description
 * 这是**唯一**成对使用 {@link meterStream} 的地方（隧道 / SOCKS / WebSocket 共用）。
 * `user` 只活在本闭包里，**不存进任何跨请求的转发器字段**（沿用 `RequestScope` 的身份铁律：
 * 四个转发器实例跨请求/跨会话复用，身份逐次从 `scope.user` 传进来）。
 * @param account - 配额端口
 * @param user - 已鉴权用户名；`undefined` → 两个监听器都不挂
 * @param client - 客户端侧双工流（`up` 方向的源流）
 * @param upstream - 上游侧双工流（`down` 方向的源流）
 * @param onExceeded - 耗尽回调；**调用点自带「恰好一次」闭锁**（本函数不代劳：谁负责收尾谁负责去重）
 * @returns 建隧后首批载荷的补记端口
 */
export function openLinkMeter(
  account: TrafficAccount,
  user: string | undefined,
  client: Duplex,
  upstream: Duplex,
  onExceeded: QuotaExceededHandler,
): BufferedCharge {
  if (user === undefined) {
    return { charge: () => ALLOW, inert: true };
  }
  meterStream(account, user, "up", client, onExceeded);
  meterStream(account, user, "down", upstream, onExceeded);
  return {
    inert: false,
    charge: (dir: TrafficDirection, bytes: number): TrafficVerdict => {
      const verdict = account.consume(user, dir, bytes);
      if (!verdict.allow) {
        onExceeded(dir, verdict);
      }
      return verdict;
    },
  };
}
