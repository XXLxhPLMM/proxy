/**
 * HTTP 服务端 - 建裸服 + 事件直绑，无他
 * 用法：赋值 onRequest/onConnect 后 start()；HttpProxy 持有 ProxyHttpServer 接口
 * 注意：本层零日志，只抛事件
 */

import http from "node:http";
import type { HttpServerOptions } from "../types/server.js";
import { HttpTransport, type BareServer } from "./transport.js";

/** HTTP 服务端：建裸服 + 事件直绑，无他 */
export class HttpServer extends HttpTransport {
  constructor(options?: HttpServerOptions) {
    super(http.createServer() as unknown as BareServer, options);
  }
}
