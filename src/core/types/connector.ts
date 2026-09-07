/**
 * core/types/connector - 上游连接器共享类型（纯类型，无运行时逻辑）
 * 职责：connectors/net|tls 两族共用拨号签名，由 types 桶文件统一出口
 */

import type { Duplex } from "node:stream";
import type { DialGuardOptions } from "@/core/proxy-helpers.js";

/** 上游目标 */
export interface UpstreamTarget {
  host: string;
  port: number;
}

/** 建链成功句柄（guardDialing.established 的最小面） */
export interface DialHandle {
  established: () => void;
}

/** 建链成功回调（存量兼容：Promise 化后内部转调，新代码请用 await） */
export type DialCallback = (upstreamSocket: Duplex, dial: DialHandle) => void;

/** 建链成功结果：上游 socket（net/tls 均为 Duplex）+ 守卫句柄 */
export interface DialResult {
  socket: Duplex;
  dial: DialHandle;
}

/** 连接器拨号函数签名：BaseUpstreamConnector.dial 的公开契约
 * Promise 语义：TCP/TLS 建链成功 resolve({socket, dial})，失败/超时 reject；
 * CONNECT 握手不归本层，见 forward/connect 的隧道转发流程
 * 新代码请用连接器实例（NetUpstreamConnector 等），本类型供函数式注入场景（结构兼容 .dial 方法） */
export type ConnectorDial = (
  clientSocket: Duplex,
  host: string,
  port: number,
  guardOpts?: DialGuardOptions,
) => Promise<DialResult>;
