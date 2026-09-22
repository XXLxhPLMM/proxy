/**
 * @fileoverview SOCKS 握手缓冲读取器
 * @module core/forward/socks-reader
 * @description
 * 从 `forward/socks.ts` 剥离的独立握手 IO 工具：把「按需读满 / 读至 NUL / 剩余字节留给下一阶段」
 * 收敛到一个读取器，解决四个 SOCKS server 与 forwarder 共有的两类问题：
 * - TCP 分段：greeting / CONNECT 被拆成多次 `data` 时不再当非法请求断链；
 * - pipelining：greeting 与 CONNECT 同包到达时首包不丢，逐阶段消费。
 *
 * 设计：
 * - 内部维护一段 `buf`，每次 `data` 先追加再尝试匹配当前挂起的读取条件，命中即消费对应前缀，余量保留；
 * - 握手缓冲设上限（`maxBuffered`，默认 1024B），仅在「条件未满足且缓冲超限」时判失败并销毁，避免误杀正常流水线；
 * - 读超时用 `upstreamTimeout`（或显式 `timeout`）：超时销毁并回调 `onTimeout`；
 * - 正常移交下一阶段用 `takeBuffered()` 取走余量后 `dispose()`，读取器不再消费 socket。
 *
 * 依赖仅 `config/store`（读超时缺省）与 Duplex，**不感知转发器/事件**——server 层与 forwarder 各自构造使用。
 */

import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";

/**
 * 握手读取失败原因
 * @description `timeout` 读超时 / `overflow` 握手缓冲超限 / `closed` 对端关闭 / `error` 底层错误
 */
export type SocksReadFail = "timeout" | "overflow" | "closed" | "error";

/**
 * 握手读取器选项
 * @param maxBuffered - 握手缓冲上限（字节），超限即销毁，默认 1024，防慢速/畸形握手撑爆内存
 * @param timeout - 读超时毫秒，<=0 不限；缺省取 store 的 `upstreamTimeout`
 * @param onTimeout - 读超时回调（销毁前调用，供 `logClientTimeout` 记录）
 * @param onInvalid - 超限等非法回调（销毁前调用，供 bad-request 记录）
 */
export interface SocksHandshakeReaderOptions {
  maxBuffered?: number;
  timeout?: number;
  onTimeout?: (detail: string) => void;
  onInvalid?: (detail: string) => void;
}

/** 单次读取条件：读满 n 字节 / 读至分隔符（含） */
type ReadCond = { kind: "exact"; n: number } | { kind: "until"; delim: number };

/**
 * SOCKS 握手缓冲读取器
 *
 * 职责：把「按需读满 / 读至 NUL / 剩余字节留给下一阶段」收敛到一个读取器，
 * 解决四个 SOCKS server 与 forwarder 共有的两类问题：
 * - TCP 分段：greeting / CONNECT 被拆成多次 `data` 时不再当非法请求断链；
 * - pipelining：greeting 与 CONNECT 同包到达时首包不丢，逐阶段消费。
 *
 * 设计：
 * - 内部维护一段 `buf`，每次 `data` 先追加再尝试匹配当前挂起的读取条件，命中即消费对应前缀，余量保留；
 * - 握手缓冲设上限（`maxBuffered`，默认 1024B），仅在「条件未满足且缓冲超限」时判失败并销毁，避免误杀正常流水线；
 * - 读超时用 `upstreamTimeout`（或显式 `timeout`）：超时销毁并回调 `onTimeout`；
 * - 正常移交下一阶段用 `takeBuffered()` 取走余量后 `dispose()`，读取器不再消费 socket。
 */
export class SocksHandshakeReader {
  /** 尚未被消费的缓冲字节 */
  private buf: Buffer = Buffer.alloc(0);

  /** 当前挂起的读取条件与其决议句柄；握手串行，任意时刻至多一个 */
  private pending?: { cond: ReadCond; resolve: (v: Buffer | null) => void };

  /** 是否已终结（失败/移交/销毁），终结后不再接受新读取 */
  private settled = false;

  /** 读超时定时器 */
  private timer?: ReturnType<typeof setTimeout>;

  /** 缓冲上限（字节） */
  private readonly max: number;

  /** 读超时（毫秒），<=0 表示不限 */
  private readonly timeout: number;

  private readonly onTimeout?: (detail: string) => void;
  private readonly onInvalid?: (detail: string) => void;

  /**
   * 构造读取器并挂载 socket 数据监听
   * @param socket - 客户端双工流
   * @param opts - 缓冲上限、读超时与超时/非法回调
   */
  constructor(
    private readonly socket: Duplex,
    opts: SocksHandshakeReaderOptions = {},
  ) {
    this.max = opts.maxBuffered ?? 1024;
    this.timeout = opts.timeout ?? (get("upstreamTimeout") as number);
    this.onTimeout = opts.onTimeout;
    this.onInvalid = opts.onInvalid;

    if (socket.destroyed) {
      this.settled = true;
      return;
    }

    socket.on("data", this.handleData);
    socket.once("end", this.handleEnd);
    socket.once("close", this.handleEnd);
    socket.once("error", this.handleError);
  }

  /**
   * 读满 n 字节；失败/超时/超限/关闭返回 null（socket 已销毁）
   * @param n - 期望字节数，<=0 立即返回空 Buffer
   */
  readExactly(n: number): Promise<Buffer | null> {
    if (n <= 0) {
      return Promise.resolve(Buffer.alloc(0));
    }

    return this.await({ kind: "exact", n });
  }

  /**
   * 读至分隔符（含）；返回分隔符之前的字节（可能为空），失败返回 null
   * @param delim - 单字节分隔符（如 SOCKS4 的 0x00）
   */
  readUntil(delim: number): Promise<Buffer | null> {
    return this.await({ kind: "until", delim });
  }

  /**
   * 取走当前缓冲余量（不清除已挂起读取；供握手成功后把流水线残留交给桥接）
   * @returns 残余字节（可能为空 Buffer）
   */
  takeBuffered(): Buffer {
    const b = this.buf;

    this.buf = Buffer.alloc(0);

    return b;
  }

  /**
   * 终结读取器：停止消费 socket、清定时器；不销毁 socket（移交桥接用），幂等
   */
  dispose(): void {
    this.settled = true;
    this.clearTimer();
    this.detach();
    this.pending = undefined;
  }

  /** 发起一次读取，挂起条件并在数据到达时尝试满足 */
  private await(cond: ReadCond): Promise<Buffer | null> {
    if (this.settled || this.pending) {
      return Promise.resolve(null);
    }

    return new Promise<Buffer | null>((resolve) => {
      this.pending = { cond, resolve };
      this.armTimer();
      this.tryResolve();
    });
  }

  /** 尝试用当前缓冲满足挂起条件；命中即消费前缀并决议 */
  private tryResolve(): void {
    const p = this.pending;

    if (!p || this.settled) {
      return;
    }

    let out: Buffer | null = null;

    if (p.cond.kind === "exact") {
      if (this.buf.length >= p.cond.n) {
        out = this.buf.subarray(0, p.cond.n);
        this.buf = this.buf.subarray(p.cond.n);
      }
    } else {
      const idx = this.buf.indexOf(p.cond.delim);

      if (idx !== -1) {
        out = this.buf.subarray(0, idx);
        this.buf = this.buf.subarray(idx + 1);
      }
    }

    if (out === null) {
      return;
    }

    this.pending = undefined;
    this.clearTimer();
    p.resolve(out);
  }

  /** 数据到达：追加缓冲 → 尝试匹配 → 未满足且超限则判失败 */
  private readonly handleData = (chunk: Buffer): void => {
    if (this.settled) {
      return;
    }

    this.buf = Buffer.concat([this.buf, chunk]);
    this.tryResolve();

    if (this.settled) {
      return;
    }

    if (this.pending && this.buf.length > this.max) {
      this.fail("overflow");
    }
  };

  /** 对端关闭（end/close）：若有挂起读取则一并终结 */
  private readonly handleEnd = (): void => {
    this.fail("closed");
  };

  /** 底层错误：终结读取器 */
  private readonly handleError = (): void => {
    this.fail("error");
  };

  /** 失败收尾：清定时器/解绑/销毁 socket/决议挂起读取为 null */
  private fail(reason: SocksReadFail): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.clearTimer();
    this.detach();

    const p = this.pending;

    this.pending = undefined;

    if (reason === "timeout") {
      this.onTimeout?.(`socks handshake read timeout after ${this.timeout}ms`);
    } else if (reason === "overflow") {
      this.onInvalid?.(`socks handshake buffer overflow > ${this.max}B`);
    }

    if (!this.socket.destroyed) {
      this.socket.destroy();
    }

    p?.resolve(null);
  }

  /** 解绑 socket 监听（幂等） */
  private detach(): void {
    this.socket.off("data", this.handleData);
    this.socket.off("end", this.handleEnd);
    this.socket.off("close", this.handleEnd);
    this.socket.off("error", this.handleError);
  }

  /** 挂读超时定时器（unref 不阻塞进程退出） */
  private armTimer(): void {
    if (this.timeout <= 0) {
      return;
    }

    this.clearTimer();
    this.timer = setTimeout(() => {
      this.fail("timeout");
    }, this.timeout);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** 清除读超时定时器 */
  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
