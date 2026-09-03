/**
 * core/types/connector - 上游连接器共享类型（纯类型，无运行时逻辑）
 * 职责：connectors/http|https|socks|tls 四协议共用拨号签名，由 types 桶文件统一出口
 */

import type { Duplex } from "node:stream";
import type { DialGuardOptions } from "@/utils/proxy-helpers.js";

/** 上游目标 */
export interface UpstreamTarget {
  host: string;
  port: number;
}

/** 建链成功句柄（guardDialing.established 的最小面） */
export interface DialHandle {
  established: () => void;
}

/** 建链成功回调 */
export type DialCallback = (upstreamSocket: Duplex, dial: DialHandle) => void;

/** 连接器拨号函数签名：各协议文件（http/https/socks/tls）统一实现此签名 */
export type ConnectorDial = (
  clientSocket: Duplex,
  host: string,
  port: number,
  onConnect: DialCallback,
  guardOpts?: DialGuardOptions,
) => void;
