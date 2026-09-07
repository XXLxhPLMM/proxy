/**
 * tunnel/types - 隧道层载体契约
 * 隧道 = 双向字节管道，载体可以是 直拨 / HTTP CONNECT / SOCKS 握手 / TLS
 * 每种上游协议一个文件实现此接口，forward/connect 薄分发层按模式+upstreamProtocol 委派
 */

import type { Duplex } from "node:stream";
import type { PipeEventSink } from "@/core/types/pipe.js";

export interface TunnelHandler {
  connect(
    clientSocket: Duplex,
    hostname: string,
    port: number,
    head: Buffer,
    onEvent?: PipeEventSink,
  ): void;
}
