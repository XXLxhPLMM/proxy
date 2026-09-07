import tls from "node:tls";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { getLogger } from "@/utils/logger.js";
import { loadCerts, type LoadedTlsCerts } from "@/utils/cert.js";
import { SocksForwarder } from "@/core/forward/socks.js";
import { SOCKS4_REPLY_FAILURE } from "@/utils/constants.js";

export class Sockss4Proxy extends BaseProxy
{
  protected readonly log = getLogger("Sockss4Proxy");

  protected server: tls.Server | null = null;

  private certs?: LoadedTlsCerts;

  constructor(o: ProxyOptions = {})
  {
    super("sockss4", o);
  }

  async onBeforeStart(): Promise<void>
  {
    if (!this.options.isWorker)
    {
      this.log.info(`[lifecycle] sockss4 loading certs`);
    }
    this.certs = loadCerts(this.options.tls, this.log, "SOCKSS4");
  }

  protected async doStart(): Promise<void>
  {
    if (!this.certs)
    {
      this.certs = loadCerts(this.options.tls, this.log, "SOCKSS4");
    }

    const { key, cert, ca } = this.certs;
    const pp = (this.options.tls?.passphrase as string) || undefined;

    const s = tls.createServer(
      {
        key,
        cert,
        passphrase: pp,
        ca: ca
          ? [ca]
          : undefined,
      },
      (sock) =>
      {
        this.onConn(sock as unknown as Duplex);
      },
    );

    await new Promise<void>((r, j) =>
    {
      s.once("error", j);
      s.listen(this.options.port, this.options.host, () =>
      {
        s.off("error", j);
        r();
      });
    });

    s.on("error", (e) =>
    {
      this.setState("error");
      this.log.error(`server error:`, e);
    });

    s.on("tlsClientError", () =>
    {
      // 忽略 TLS 握手异常，保持服务可用
    });

    this.server = s;
  }

  protected async doStop(): Promise<void>
  {
    if (!this.server)
    {
      return;
    }

    await new Promise<void>((r) =>
    {
      this.server!.close(() =>
      {
        r();
      });
    });

    this.server = null;
  }

  isRunning(): boolean
  {
    return !!this.server?.listening;
  }

  private async onConn(socket: Duplex): Promise<void>
  {
    socket.on("error", () =>
    {
      socket.destroy();
    });

    const ok = await this.authorize({
      protocol: this.protocol,
      req: { headers: {} },
      socket,
      authority: "sockss4",
    });

    if (!ok)
    {
      socket.write(SOCKS4_REPLY_FAILURE);
      socket.destroy();
      return;
    }

    new SocksForwarder((e) =>
    {
      this.emit("pipe", e as never);
    }).handle(socket, 4);
  }
}
