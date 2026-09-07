/**
 * HTTP(S) 服务端类型 - core/types 叶子模块
 * 职责：server 传输族（http/https/transport）的回调与选项类型（纯类型，无运行时依赖）
 */

import type http from "node:http";
import type { Duplex } from "node:stream";
import type { TlsKeyCert } from "@/utils/cert.js";

/** 普通 HTTP 请求回调 */
export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
/** CONNECT 隧道请求回调 */
export type ConnectHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
/** WebSocket/Upgrade 升级请求回调 */
export type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
/** 通用错误回调 */
export type ErrorHandler = (err: Error) => void;
/** 客户端错误回调（畸形包等），由上层决定日志与响应 */
export type ClientErrorHandler = (err: Error, socket: Duplex) => void;

export interface HttpServerOptions {
  host?: string;
  port?: number;
}

/** 实例化选项（HTTPS：证书缺省从 store 读取） */
export interface HttpsServerOptions extends HttpServerOptions {
  tls?: TlsKeyCert;
}
