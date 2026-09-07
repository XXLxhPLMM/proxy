/**
 * HTTPS 服务端 - 同构 HTTP，差别仅多一步证书加载
 * 用法：赋值 onRequest/onConnect 后 start()；HttpsProxy 持有 ProxyHttpServer 接口
 * 注意：本层零日志（不记日志，证书失败抛带路径的错，由 HttpsProxy.doStart 记），
 *       只抛事件
 */

import https from "node:https";
import { loadCerts } from "@/utils/cert.js";
import type { HttpsServerOptions } from "../types/server.js";
import { HttpTransport, type BareServer } from "./transport.js";

/** HTTPS 服务端：同构，差别仅多一步证书加载（本层不记日志，失败抛带路径的错） */
export class HttpsServer extends HttpTransport {
  constructor(options?: HttpsServerOptions) {
    const tls = options?.tls ?? {};
    let certs;
    try {
      certs = loadCerts(tls);
    } catch (e) {
      const k = (tls as { key?: string }).key ?? "";
      const c = (tls as { cert?: string }).cert ?? "";
      const ca = (tls as { ca?: string }).ca;
      throw new Error(
        `HTTPS 证书加载失败 key=${k} cert=${c}${ca ? ` ca=${ca}` : ""}: ${(e as Error).message}`,
      );
    }
    const raw = https.createServer({
      key: certs.key,
      cert: certs.cert,
      ca: certs.ca ? [certs.ca] : undefined,
      passphrase: certs.passphrase,
    }) as unknown as BareServer;
    super(raw, options);
  }
}
