/**
 * 会话字节计量 - 「一次 forward 的字节增量」归属到本次会话的身份
 * @fileoverview core/forward/meter
 * @description
 * 流量配额的**计量侧**（判定侧在 `plugins/usage-store.ts`）。本模块只做一件事：
 * 回答「本次会话搬了多少字节，该记到谁头上」。
 *
 * ## 口径（唯一来源，不许在别处再写一遍）
 *
 * **客户端 socket 的 `bytesRead + bytesWritten` 增量**。选它的三个理由：
 * - 覆盖**全部三条传输策略 × 四种入站**（`http-request` 的 `pipe` 与裸流的 `bridge`
 *   都不必改一个字——计量完全在入站侧，不进字节搬运路径）
 * - 是 **TLS 解密后的明文字节**（`TLSSocket` 暴露的是解密后计数），与「客户端消耗了多少」
 *   的语义一致；用上游 socket 计数则会把代理自己的开销算进用户头上
 * - Node 内核维护的计数器，**不在 `data` 回调里累加**（那会给每个 chunk 加一次热路径税）
 *
 * ## 桶的边界必须是「一次 forward」，不是「一条连接」
 *
 * HTTP keep-alive 下**同一个 TCP 连接会承载多个请求，且每个请求都重新鉴权**
 * （`core/server/http.ts:handleForward` 逐请求跑闸门）——所以**同一 socket 上前后两个请求
 * 可能是不同用户**。按连接累计必然串号。
 *
 * 因此本模块取「创建时记基线 → 终结时算差值」：桶的边界是一次转发，请求 1 记 `H1+B1`、
 * 请求 2 记 `H2+B2`，**既不重复计也不串号**。
 *
 * ## 记账时机
 *
 * 挂在**下游流的 `close`** 上（不是 `forward()` 的 resolve —— `http-request` 载荷下
 * `incoming.pipe(res)` 还在流式跑，resolve 时字节根本没传完）。同时挂客户端 socket 的
 * `close` 兜底（裸流上游先死、客户端半开时 `res` 永不结束）。两者都经同一个幂等
 * `commit()` 收口，先到者生效。
 *
 * 无身份（未鉴权 / `AUTH_ENABLED=false`）时 `commit` 是 no-op：流量无法归属到任何人，
 * 硬记到一个「匿名」桶只会造出一个没人能查的假账本。
 */
import type { UsageProvider } from "@/plugins/contracts.js";

/**
 * 字节计数的来源（鸭子类型）
 * @description `net.Socket` / `tls.TLSSocket` 都有这两个**单调递增**的计数器。
 * 同 `utils/net/socket.ts:getSocketLocalBinding` 的鸭子类型先例：事实只存在于 socket 上，
 * 拿不到时由调用方决定回落，而不是让本模块抛错或返回哨兵值。
 * @param bytesRead - 从对端读入的累计字节
 * @param bytesWritten - 已写给对端的累计字节
 */
export interface ByteSource {
  readonly bytesRead?: number;
  readonly bytesWritten?: number;
}

/**
 * 承载终结钩子的流（鸭子类型）
 * @description `Duplex`（裸流通道的 socket）与 `http.ServerResponse`（http 通道）都满足
 * 只挂一个 `once("close")` 的需求。
 * @param event - 事件名（恒为 `close`）
 * @param listener - 监听器
 */
export interface MeterStream {
  once(event: "close", listener: () => void): unknown;
}

/**
 * 计量来源 - 客户端 socket
 * @description 它**同时**是字节计数器与 `close` 事件的发出者，所以两个能力合成一个类型，
 * 调用点不需要「字节源 + 流」两个字段，也就不需要任何强制转换。
 * `net.Socket` 与 `tls.TLSSocket` 都天然满足。
 */
export interface MeterSource extends ByteSource, MeterStream {}

/**
 * 会话计量桶
 * @description 桶在**入站侧**创建（那里才知道身份与下游流形态），随 `ForwardPlan` 之外
 * 的会话上下文传下去；传输策略**不感知**它（本设计的要点：字节搬运路径零改动）。
 */
export interface TransferMeter {
  /**
   * 结束本次会话的计量：把字节增量归属到该身份
   * @description 幂等（`close` 与 socket `close` 可能都触发，先到者生效）。
   * 无身份时是 no-op。**永不抛错** —— 计量失败绝不能反噬数据面。
   */
  commit(): void;
}

/** 取字节源的累计字节总数（缺字段按 0 计：拿不到的事实不猜、不抛错） */
function totalBytes(source: ByteSource): number {
  return (source.bytesRead ?? 0) + (source.bytesWritten ?? 0);
}

/** 创建会话计量桶的参数 */
export interface TransferMeterOptions {
  /** 已鉴权用户名；无身份时**不计量**（字节无法归属给任何人） */
  readonly user: string | undefined;
  /** 计量来源：客户端 socket（`bytesRead + bytesWritten` 增量，同时也是兜底收口点） */
  readonly source: MeterSource;
  /** 终结钩子的首选挂载对象（http 通道为 `res`，裸流通道即客户端 socket 本身） */
  readonly stream: MeterStream;
  /** 记账出口（本实例的配额实现） */
  readonly usage: UsageProvider;
}

/**
 * 创建会话计量桶
 * @description 现在就取基线（此刻之前已传输的字节不属于本次会话），并把幂等收口挂到
 * `stream.close` 与 `fallback.close` 上。
 * @param options - 见 {@link TransferMeterOptions}
 * @returns 计量桶；`user` 为空时返回的桶其 `commit()` 是 no-op（不分配任何累计状态）
 * @example
 * ```ts
 * const meter = createTransferMeter({
 *   user: "alice", source: req.socket, stream: res, usage,
 * });
 * // 会话结束后 meter.commit() 已自动把字节记到 alice 名下
 * ```
 */
export function createTransferMeter(options: TransferMeterOptions): TransferMeter {
  const { user, source, stream, usage } = options;

  if (!user) {
    // 无身份：不取基线、不挂钩子（热路径上零开销）
    return { commit: () => {} };
  }

  const baseline = totalBytes(source);
  let committed = false;

  const commit = (): void => {
    if (committed) {
      return;
    }
    committed = true;
    try {
      const delta = totalBytes(source) - baseline;
      if (delta > 0) {
        usage.settle(user, delta);
      }
    } catch {
      // 计量异常就地吞掉：数据面的成败由协议应答决定，账本记错不该让请求失败
    }
  };

  stream.once("close", commit);

  // 兜底：客户端 socket 关闭时也收口（http 通道的 `res` 在上游先死、响应没收完的路径上
  // 可能迟迟不 close；裸流通道两者本就是同一个对象，identity 比对避免挂两遍）
  if (source !== (stream as unknown)) {
    source.once("close", commit);
  }

  return { commit };
}
