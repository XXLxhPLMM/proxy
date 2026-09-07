/**
 * HTTPS 代理 - 直持 https.Server，复用 HttpProxy 逻辑
 */

import https from "node:https";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { HttpProxy } from "./http.js";
import { loadCerts } from "@/utils/cert.js";

export class HttpsProxy extends HttpProxy
{
  constructor(options: ProxyOptions = {})
  {
    super(options, "https");
  }

  protected override async doStart(): Promise<void>
  {
    let certs;
    try
    {
      certs = loadCerts(this.options.tls);
    }
    catch (e)
    {
      const err = new Error(
        `HTTPS 证书加载失败: ${(e as Error).message}`,
      );
      this.emit("serverError", {
        error: err,
        host: this.options.host,
        port: this.options.port,
      });
      throw err;
    }

    const server = https.createServer({
      key: certs.key,
      cert: certs.cert,
      ca: certs.ca
        ? [certs.ca]
        : undefined,
      passphrase: certs.passphrase,
    });

    this.bindServer(
      server as unknown as import("node:http").Server,
    );

    await new Promise<void>((resolve, reject) =>
    {
      server.once("error", reject);
      server.listen(
        this.options.port,
        this.options.host,
        () =>
        {
          server.off("error", reject);
          resolve();
        },
      );
    });

    this.server = server as unknown as import("node:http").Server;
  }
}

export function createHttpsProxy(options?: ProxyOptions): HttpsProxy
{
  return new HttpsProxy(options);
}
