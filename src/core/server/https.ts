/**
 * HTTPS 服务端 - 同构 HTTP，差别仅多一步证书加载
 * 用法：赋值 onRequest/onConnect 后 start()；HttpsProxy 持有 ProxyHttpServer 接口
 * 注意：本层零日志（不记日志，证书失败抛带路径的错，由 HttpsProxy.doStart 记），
 *       只抛事件
 */

import https from "node:https";
import { get } from "@/config/store.js";
import { loadTlsContext } from "@/utils/cert.js";
import type { HttpsServerOptions } from "../types/server.js";
import { HttpTransport, type BareServer } from "./transport.js";

/** HTTPS 服务端：同构，差别仅多一步证书加载（本层不记日志，失败抛带路径的错） */
export class HttpsServer extends HttpTransport {
  constructor(options?: HttpsServerOptions) {
    const tlsKey = options?.tls?.key ?? get("tlsKey");
    const tlsCert = options?.tls?.cert ?? get("tlsCert");
    const tlsCa = options?.tls?.ca ?? get("tlsCa");
    const tlsPassphrase = options?.tls?.passphrase ?? get("tlsPassphrase");

    let certs;
    try {
      certs = loadTlsContext({ key: tlsKey, cert: tlsCert, ca: tlsCa, passphrase: tlsPassphrase });
    } catch (e) {
      throw new Error(
        `HTTPS 证书加载失败 key=${tlsKey} cert=${tlsCert}${tlsCa ? ` ca=${tlsCa}` : ""}: ${(e as Error).message}`,
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
